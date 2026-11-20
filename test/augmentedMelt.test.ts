// FT-57: melting an augmented or equipped armament. The client refuses to melt the armament itself
// (`getSellableStatus`: `EquipmentEnhancedAndNoStack`, "Cannot melt down ::name::", and the equipped one, "You cannot
// melt down equipped armaments"); its duplicates can still be melted, and the augmentation stays.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
// a 5★ armament with an augment chain (assets/equipment_enhancement.json)
const ARMAMENT = 5020042
// a second armament, never augmented
const OTHER = 2010002

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

after(async () => {
    await cleanup()
})

type Player = TestPlayer & { playerId: number }

async function newPlayer(armament: { enhancementLevel: number, stack: number }): Promise<Player> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    data.insertPlayerEquipmentSync(playerId, ARMAMENT, { level: 5, protection: false, ...armament })
    return { ...player, playerId }
}

async function post(player: Player, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null }
}

test("an augmented armament can't be melted itself, with or without duplicates", async () => {
    for (const stack of [0, 2]) {
        const player = await newPlayer({ enhancementLevel: 30, stack })
        const { status } = await post(player, "equipment/sell_equipment", { equipment_list: [{ equipment_id: ARMAMENT }] })
        assert.equal(status, 400)
        const kept = data.getPlayerEquipmentSync(player.playerId, ARMAMENT)
        assert.equal(kept?.enhancementLevel, 30)
        assert.equal(kept?.stack, stack)
        assert.equal(data.getPlayerItemSync(player.playerId, 100000) ?? 0, 0)
    }
})

test("melting an augmented armament's duplicates keeps its augmentation", async () => {
    const player = await newPlayer({ enhancementLevel: 30, stack: 2 })
    const { status, body } = await post(player, "equipment/sell_stack", { equipment_list: [{ equipment_id: ARMAMENT, number: 2 }] })
    assert.equal(status, 200)
    const [entry] = body.data.equipment_list
    assert.equal(entry.equipment_id, ARMAMENT)
    assert.equal(entry.enhancement_level, 30)
    assert.equal(entry.stack, 0)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)?.enhancementLevel, 30)
    assert.ok((body.data.item_list["100000"] ?? 0) > 0)
})

test("an armament that isn't augmented still melts", async () => {
    const player = await newPlayer({ enhancementLevel: 0, stack: 0 })
    const { status } = await post(player, "equipment/sell_equipment", { equipment_list: [{ equipment_id: ARMAMENT }] })
    assert.equal(status, 200)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT), null)
})

// puts armaments in the first slots of the player's first party (the captured party/edit request)
async function equip(player: Player, equipmentIds: (number | null)[]) {
    const request = readCapturedRoute("party_edit").requestBody as { party_info_list: Record<string, unknown>[] }
    const party = { ...request.party_info_list[0], equipment_ids: [...equipmentIds, null, null, null].slice(0, 3) }
    const { status } = await post(player, "party/edit", { ...request, party_info_list: [party] })
    assert.equal(status, 200)
}

test("a request for more than an augmented armament's duplicates deletes nothing", async () => {
    const player = await newPlayer({ enhancementLevel: 30, stack: 2 })
    for (const number of [3, 99]) {
        const { status } = await post(player, "equipment/sell_stack", { equipment_list: [{ equipment_id: ARMAMENT, number }] })
        assert.equal(status, 400)
        const kept = data.getPlayerEquipmentSync(player.playerId, ARMAMENT)
        assert.equal(kept?.enhancementLevel, 30)
        assert.equal(kept?.stack, 2)
    }
})

test("Melt Down All melts an augmented armament's duplicates and keeps it", async () => {
    const player = await newPlayer({ enhancementLevel: 30, stack: 3 })
    const { status } = await post(player, "equipment/bulk_sell_stack", { equipment_ids: [ARMAMENT] })
    assert.equal(status, 200)
    const kept = data.getPlayerEquipmentSync(player.playerId, ARMAMENT)
    assert.equal(kept?.enhancementLevel, 30)
    assert.equal(kept?.stack, 0)
})

test("an armament equipped in a party can't be melted itself, with or without duplicates", async () => {
    for (const stack of [0, 2]) {
        const player = await newPlayer({ enhancementLevel: 0, stack })
        await equip(player, [ARMAMENT])
        const { status } = await post(player, "equipment/sell_equipment", { equipment_list: [{ equipment_id: ARMAMENT }] })
        assert.equal(status, 400)
        assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT)?.stack, stack)
        assert.equal(data.getPlayerItemSync(player.playerId, 100000) ?? 0, 0)
    }
})

test("a party armament's duplicates can be melted, and the armament melts once it is out of the party", async () => {
    const player = await newPlayer({ enhancementLevel: 0, stack: 2 })
    await equip(player, [null, null, ARMAMENT])
    const stack = await post(player, "equipment/sell_stack", { equipment_list: [{ equipment_id: ARMAMENT, number: 2 }] })
    assert.equal(stack.status, 200)
    assert.equal((await post(player, "equipment/sell_equipment", { equipment_list: [{ equipment_id: ARMAMENT }] })).status, 400)
    await equip(player, [])
    assert.equal((await post(player, "equipment/sell_equipment", { equipment_list: [{ equipment_id: ARMAMENT }] })).status, 200)
    assert.equal(data.getPlayerEquipmentSync(player.playerId, ARMAMENT), null)
})

test("a refused armament in a request melts none of the others", async () => {
    for (const refused of ["augmented", "equipped"]) {
        const player = await newPlayer({ enhancementLevel: refused === "augmented" ? 30 : 0, stack: 0 })
        data.insertPlayerEquipmentSync(player.playerId, OTHER, { level: 1, protection: false, enhancementLevel: 0, stack: 0 })
        if (refused === "equipped") await equip(player, [ARMAMENT])
        const { status } = await post(player, "equipment/sell_equipment", { equipment_list: [{ equipment_id: OTHER }, { equipment_id: ARMAMENT }] })
        assert.equal(status, 400, refused)
        assert.notEqual(data.getPlayerEquipmentSync(player.playerId, OTHER), null, refused)
        assert.equal(data.getPlayerItemSync(player.playerId, 100000) ?? 0, 0, refused)
    }
})
