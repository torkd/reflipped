import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

// FT-40: the bulk actions of the armament list and the unit growth screen (equipment/bulk_upgrade,
// equipment/bulk_sell_stack, character/bulk_over_limit, expod/bulk_stack_to_exp), selling items (item/sell), locking
// units (character/set_protection) and the new rates of the single melt and conversion routes.

const apiPrefix = "/latest/api/index.php"
const WRIGHTPIECE = 100000
const STAR_SPECK = 990008

// armaments: portal ones (they give Star Specks when melted), ones without Star Specks, and unmeltable ones
const PORTAL_3 = 3010007 // awakening 15, melt 3 Wrightpieces + 1 Star Speck
const PORTAL_4 = 4010010 // awakening 20, melt 4 Wrightpieces + 5 Star Specks
const PORTAL_5 = 5010028 // awakening 25, melt 5 Wrightpieces + 15 Star Specks
const NO_STAR_1 = 1010001 // 1*, awakening 5, melt 1 Wrightpiece
const NO_STAR_2 = 2010002 // 2*, awakening 10, melt 2 Wrightpieces
const NO_STAR_3 = 3010006 // 3* in equipmentWithoutStarGrain
const UNMELTABLE_3 = 3010023
const UNMELTABLE_5 = 5010005
// units: portal ones and ones without Star Specks (max uncap: 1* 12, 2* 10, 3* 8, 4* 6, 5* 4)
const UNIT_5 = 111001 // 5*, portal
const UNIT_4 = 211001 // 4*, portal
const UNIT_3 = 311001 // 3*, portal
const UNIT_3_NO_STAR = 311003 // 3*, charactersWithoutStarGrain
const UNIT_1 = 512001 // 1*, charactersWithoutStarGrain
// items: a sellable item (5 mana), a sold-out one (period ended 2021), one not on sale yet, an ability core (500 mana)
const SELLABLE_ITEM = 1
const EXPIRED_ITEM = 40210
const FUTURE_ITEM = 70003
const ABILITY_CORE = 5020022
const UNSELLABLE_ITEM = 100000

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let giveUnit: typeof import("../src/lib/character").givePlayerCharacterSync

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    giveUnit = (await import("../src/lib/character")).givePlayerCharacterSync
})

after(async () => {
    await cleanup()
})

interface Player extends TestPlayer { playerId: number }

async function signUp(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    return { ...player, playerId: data.getViewerPlayerIdSync(player.viewerId)! }
}

async function post(player: Player, route: string, body: Record<string, unknown> = {}) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, ...body })
    })
    return { status: response.statusCode, body: response.statusCode === 200 ? decodeGameBody(response.body) : null, raw: response.body }
}

function setItem(playerId: number, itemId: number, amount: number) {
    if (data.getPlayerItemSync(playerId, itemId) === null) data.givePlayerItemSync(playerId, itemId, amount)
    else data.updatePlayerItemSync(playerId, itemId, amount)
}

const items = (playerId: number, ...ids: number[]) => ids.map(id => data.getPlayerItemSync(playerId, id) ?? 0)

function setEquipment(playerId: number, id: number, level: number, stack: number, protection = false) {
    if (data.getPlayerEquipmentSync(playerId, id) === null) data.insertPlayerEquipmentSync(playerId, id, { level, enhancementLevel: 0, protection, stack })
    else data.updatePlayerEquipmentSync(playerId, id, { level, stack, protection })
}

function setUnit(playerId: number, id: number, overLimitStep: number, stack: number, protection = false) {
    giveUnit(playerId, id)
    data.updatePlayerCharacterSync(playerId, id, { overLimitStep, stack, protection })
}

/** Everything the actions below may change, to show that a refused request leaves it as it was. */
function snapshot(playerId: number, equipment: number[], units: number[], itemIds: number[]) {
    const player = data.getPlayerSync(playerId)!
    return JSON.stringify({
        equipment: equipment.map(id => data.getPlayerEquipmentSync(playerId, id)),
        units: units.map(id => { const c = data.getPlayerCharacterSync(playerId, id); return c && { step: c.overLimitStep, stack: c.stack, protection: c.protection } }),
        items: itemIds.map(id => data.getPlayerItemSync(playerId, id)),
        freeMana: player.freeMana,
        expPool: player.expPool
    })
}

describe("equipment/bulk_upgrade (Awaken All)", () => {
    test("awakens each armament with its duplicates, paying Wrightpieces and giving cores", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 1000)
        setEquipment(p.playerId, PORTAL_3, 1, 3)  // +3 levels (stack-limited), 45 Wrightpieces
        setEquipment(p.playerId, PORTAL_5, 3, 4)  // +2 levels (max level 5), 50 Wrightpieces, 2 duplicates stay
        setEquipment(p.playerId, NO_STAR_1, 2, 2) // +2 levels, 10 Wrightpieces
        setItem(p.playerId, PORTAL_3, 4) // existing cores
        const { status, body } = await post(p, "equipment/bulk_upgrade", { equipment_ids: [PORTAL_3, PORTAL_5, NO_STAR_1] })
        assert.equal(status, 200)

        assert.deepEqual(data.getPlayerEquipmentSync(p.playerId, PORTAL_3), { level: 4, enhancementLevel: 0, protection: false, stack: 0 })
        assert.deepEqual(data.getPlayerEquipmentSync(p.playerId, PORTAL_5), { level: 5, enhancementLevel: 0, protection: false, stack: 2 })
        assert.deepEqual(data.getPlayerEquipmentSync(p.playerId, NO_STAR_1), { level: 4, enhancementLevel: 0, protection: false, stack: 0 })
        assert.deepEqual(items(p.playerId, WRIGHTPIECE, PORTAL_3, PORTAL_5, NO_STAR_1), [1000 - 45 - 50 - 10, 4 + 3, 2, 2])

        assert.equal(body.data.equipment_list.length, 3)
        const reply = Object.fromEntries(body.data.equipment_list.map((e: any) => [e.equipment_id, e]))
        assert.equal(reply[PORTAL_3].level, 4)
        assert.equal(reply[PORTAL_3].stack, 0)
        assert.equal(reply[PORTAL_5].level, 5)
        assert.equal(reply[PORTAL_5].stack, 2)
        assert.deepEqual(body.data.item_list, { [WRIGHTPIECE]: 895, [PORTAL_3]: 7, [PORTAL_5]: 2, [NO_STAR_1]: 2 })
    })

    test("the cost is by rarity: 5, 10, 15, 20 and 25 Wrightpieces a level", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 100)
        const ids = [NO_STAR_1, NO_STAR_2, PORTAL_3, PORTAL_4, PORTAL_5]
        for (const id of ids) setEquipment(p.playerId, id, 1, 1)
        const { status } = await post(p, "equipment/bulk_upgrade", { equipment_ids: ids })
        assert.equal(status, 200)
        assert.deepEqual(items(p.playerId, WRIGHTPIECE), [100 - (5 + 10 + 15 + 20 + 25)])
        for (const id of ids) assert.deepEqual(data.getPlayerEquipmentSync(p.playerId, id), { level: 2, enhancementLevel: 0, protection: false, stack: 0 })
    })

    test("a repeated id is awakened once", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 100)
        setEquipment(p.playerId, NO_STAR_1, 1, 2)
        const { status } = await post(p, "equipment/bulk_upgrade", { equipment_ids: [NO_STAR_1, NO_STAR_1] })
        assert.equal(status, 200)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, NO_STAR_1)!.level, 3)
        assert.deepEqual(items(p.playerId, WRIGHTPIECE), [90])
    })

    test("an armament that is not owned, has no duplicates or is at max level refuses everything", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 1000)
        setEquipment(p.playerId, PORTAL_3, 1, 3)
        const ids = [PORTAL_3, NO_STAR_1, PORTAL_4, PORTAL_5]
        const watched = [PORTAL_3, NO_STAR_1, PORTAL_4, PORTAL_5]
        for (const [label, setup] of [
            ["not owned", () => { }],
            ["no duplicates", () => setEquipment(p.playerId, PORTAL_5, 1, 0)],
            ["at max level", () => { setEquipment(p.playerId, PORTAL_5, 5, 2) }]
        ] as [string, () => void][]) {
            setup()
            if (label === "not owned") setEquipment(p.playerId, NO_STAR_1, 1, 1) // a good one; PORTAL_4 and PORTAL_5 are not owned
            if (label !== "not owned") setEquipment(p.playerId, PORTAL_4, 1, 1)
            const before = snapshot(p.playerId, watched, [], [WRIGHTPIECE, ...watched])
            const { status } = await post(p, "equipment/bulk_upgrade", { equipment_ids: ids })
            assert.equal(status, 400, label)
            assert.equal(snapshot(p.playerId, watched, [], [WRIGHTPIECE, ...watched]), before, `${label}: nothing changed`)
        }
    })

    test("too few Wrightpieces refuses everything", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 29) // 15 + 15 needed
        setEquipment(p.playerId, PORTAL_3, 1, 1)
        setEquipment(p.playerId, PORTAL_3 + 1, 1, 1)
        const watched = [PORTAL_3, PORTAL_3 + 1]
        const before = snapshot(p.playerId, watched, [], [WRIGHTPIECE, ...watched])
        assert.equal((await post(p, "equipment/bulk_upgrade", { equipment_ids: watched })).status, 400)
        assert.equal(snapshot(p.playerId, watched, [], [WRIGHTPIECE, ...watched]), before)
        // with exactly enough it works
        setItem(p.playerId, WRIGHTPIECE, 30)
        assert.equal((await post(p, "equipment/bulk_upgrade", { equipment_ids: watched })).status, 200)
        assert.deepEqual(items(p.playerId, WRIGHTPIECE), [0])
    })

    test("a body without equipment_ids is refused", async () => {
        const p = await signUp()
        assert.equal((await post(p, "equipment/bulk_upgrade", {})).status, 400)
    })
})

describe("equipment/bulk_sell_stack (Melt Down All)", () => {
    test("melts every duplicate: cores, Wrightpieces, and Star Specks only for portal armaments", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 10)
        setItem(p.playerId, STAR_SPECK, 100)
        setEquipment(p.playerId, PORTAL_3, 1, 2)  // 6 WP, 2 SS
        setEquipment(p.playerId, PORTAL_4, 5, 3)  // 12 WP, 15 SS
        setEquipment(p.playerId, PORTAL_5, 1, 1)  // 5 WP, 15 SS
        setEquipment(p.playerId, NO_STAR_2, 1, 4) // 8 WP, no SS
        setEquipment(p.playerId, NO_STAR_3, 1, 2) // 3-star, 6 WP, no SS (equipmentWithoutStarGrain)
        const ids = [PORTAL_3, PORTAL_4, PORTAL_5, NO_STAR_2, NO_STAR_3]
        const { status, body } = await post(p, "equipment/bulk_sell_stack", { equipment_ids: ids })
        assert.equal(status, 200)
        for (const id of ids) assert.equal(data.getPlayerEquipmentSync(p.playerId, id)!.stack, 0, String(id))
        assert.equal(data.getPlayerEquipmentSync(p.playerId, PORTAL_4)!.level, 5, "levels stay")
        assert.deepEqual(items(p.playerId, WRIGHTPIECE, STAR_SPECK), [10 + 6 + 12 + 5 + 8 + 6, 100 + 2 + 15 + 15])
        assert.deepEqual(items(p.playerId, PORTAL_3, PORTAL_4, PORTAL_5, NO_STAR_2, NO_STAR_3), [2, 3, 1, 4, 2])
        assert.equal(body.data.equipment_list.length, 5)
        assert.deepEqual(body.data.item_list, {
            [WRIGHTPIECE]: 47, [STAR_SPECK]: 132,
            [PORTAL_3]: 2, [PORTAL_4]: 3, [PORTAL_5]: 1, [NO_STAR_2]: 4, [NO_STAR_3]: 2
        })
        for (const e of body.data.equipment_list) assert.equal(e.stack, 0)
    })

    test("refuses an armament that is not owned, locked, unmeltable or without duplicates, and changes nothing", async () => {
        const p = await signUp()
        setEquipment(p.playerId, PORTAL_3, 1, 2)
        const good = [PORTAL_3]
        const watched = [PORTAL_3, PORTAL_4, NO_STAR_1, UNMELTABLE_3, UNMELTABLE_5]
        const watchedItems = [WRIGHTPIECE, STAR_SPECK, ...watched]
        const cases: [string, () => void][] = [
            ["not owned", () => { }],
            ["locked", () => setEquipment(p.playerId, PORTAL_4, 1, 2, true)],
            ["no duplicates", () => { setEquipment(p.playerId, PORTAL_4, 1, 0); }],
            ["unmeltable", () => { setEquipment(p.playerId, PORTAL_4, 1, 2); setEquipment(p.playerId, UNMELTABLE_3, 1, 2) }]
        ]
        const bad: Record<string, number> = { "not owned": PORTAL_4, "locked": PORTAL_4, "no duplicates": PORTAL_4, "unmeltable": UNMELTABLE_3 }
        for (const [label, setup] of cases) {
            setup()
            const before = snapshot(p.playerId, watched, [], watchedItems)
            const { status } = await post(p, "equipment/bulk_sell_stack", { equipment_ids: [...good, bad[label]] })
            assert.equal(status, 400, label)
            assert.equal(snapshot(p.playerId, watched, [], watchedItems), before, `${label}: nothing changed`)
        }
        setEquipment(p.playerId, UNMELTABLE_5, 1, 3)
        assert.equal((await post(p, "equipment/bulk_sell_stack", { equipment_ids: [UNMELTABLE_5] })).status, 400)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, UNMELTABLE_5)!.stack, 3)
    })

    test("an empty list does nothing", async () => {
        const p = await signUp()
        const { status, body } = await post(p, "equipment/bulk_sell_stack", { equipment_ids: [] })
        assert.equal(status, 200)
        assert.deepEqual(body.data.equipment_list, [])
    })

    test("a body without equipment_ids is refused", async () => {
        const p = await signUp()
        assert.equal((await post(p, "equipment/bulk_sell_stack", {})).status, 400)
    })
})

describe("equipment/sell_stack (single melt, new rates)", () => {
    test("one 1* duplicate gives a core and one Wrightpiece, no Star Specks (docs/routes/equipment_sell_stack.md)", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 7)
        setEquipment(p.playerId, NO_STAR_1, 1, 3)
        const { status, body } = await post(p, "equipment/sell_stack", { equipment_list: [{ equipment_id: NO_STAR_1, number: 1 }], api_count: 6 })
        assert.equal(status, 200)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, NO_STAR_1)!.stack, 2)
        assert.deepEqual(items(p.playerId, WRIGHTPIECE, STAR_SPECK, NO_STAR_1), [8, 0, 1])
        assert.equal(body.data.item_list[WRIGHTPIECE], 8)
        assert.equal(body.data.item_list[STAR_SPECK], undefined)
    })

    test("a portal 4* duplicate gives 4 Wrightpieces and 5 Star Specks; an armament without Star Specks gives none", async () => {
        const p = await signUp()
        setEquipment(p.playerId, PORTAL_4, 1, 2)
        setEquipment(p.playerId, NO_STAR_3, 1, 2)
        assert.equal((await post(p, "equipment/sell_stack", { equipment_list: [{ equipment_id: PORTAL_4, number: 2 }], api_count: 1 })).status, 200)
        assert.deepEqual(items(p.playerId, WRIGHTPIECE, STAR_SPECK), [8, 10])
        assert.equal((await post(p, "equipment/sell_stack", { equipment_list: [{ equipment_id: NO_STAR_3, number: 2 }], api_count: 2 })).status, 200)
        assert.deepEqual(items(p.playerId, WRIGHTPIECE, STAR_SPECK), [14, 10])
    })

    test("more than the stack, or an unmeltable armament, is refused", async () => {
        const p = await signUp()
        setEquipment(p.playerId, NO_STAR_1, 1, 1)
        setEquipment(p.playerId, UNMELTABLE_3, 1, 2)
        assert.equal((await post(p, "equipment/sell_stack", { equipment_list: [{ equipment_id: NO_STAR_1, number: 2 }], api_count: 1 })).status, 400)
        assert.equal((await post(p, "equipment/sell_stack", { equipment_list: [{ equipment_id: UNMELTABLE_3, number: 1 }], api_count: 2 })).status, 400)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, NO_STAR_1)!.stack, 1)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, UNMELTABLE_3)!.stack, 2)
    })
})

describe("equipment/sell_equipment (melting an armament with its duplicates)", () => {
    const CAPTURED = 2040001 // docs/routes/equipment_sell_equipment.md: a 2* armament without duplicates

    test("the captured case: one core, two Wrightpieces, no Star Specks, and the armament is gone", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 10)
        setEquipment(p.playerId, CAPTURED, 1, 0)
        const { status, body } = await post(p, "equipment/sell_equipment", { equipment_list: [{ equipment_id: CAPTURED }], api_count: 5 })
        assert.equal(status, 200)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, CAPTURED), null)
        assert.deepEqual(items(p.playerId, CAPTURED, WRIGHTPIECE, STAR_SPECK), [1, 12, 0])
        assert.deepEqual(body.data.item_list, { [CAPTURED]: 1, [WRIGHTPIECE]: 12 })
    })

    test("duplicates are melted too: a portal 4* with a stack of 2 gives 3 cores, 12 Wrightpieces and 15 Star Specks", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 5)
        setItem(p.playerId, STAR_SPECK, 100)
        setItem(p.playerId, PORTAL_4, 2) // existing cores
        setEquipment(p.playerId, PORTAL_4, 3, 2)
        const { status, body } = await post(p, "equipment/sell_equipment", { equipment_list: [{ equipment_id: PORTAL_4 }], api_count: 1 })
        assert.equal(status, 200)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, PORTAL_4), null)
        assert.deepEqual(items(p.playerId, PORTAL_4, WRIGHTPIECE, STAR_SPECK), [2 + 3, 5 + 12, 100 + 15])
        assert.deepEqual(body.data.item_list, { [PORTAL_4]: 5, [WRIGHTPIECE]: 17, [STAR_SPECK]: 115 })
    })

    test("a portal 3* and a 5* each pay by rarity; several armaments in one request add up", async () => {
        const p = await signUp()
        setEquipment(p.playerId, PORTAL_3, 1, 0) // 3 WP, 1 SS
        setEquipment(p.playerId, PORTAL_5, 1, 1) // 2 copies: 10 WP, 30 SS
        const { status, body } = await post(p, "equipment/sell_equipment", { equipment_list: [{ equipment_id: PORTAL_3 }, { equipment_id: PORTAL_5 }], api_count: 1 })
        assert.equal(status, 200)
        assert.deepEqual(items(p.playerId, PORTAL_3, PORTAL_5, WRIGHTPIECE, STAR_SPECK), [1, 2, 13, 31])
        assert.deepEqual(body.data.item_list, { [PORTAL_3]: 1, [PORTAL_5]: 2, [WRIGHTPIECE]: 13, [STAR_SPECK]: 31 })
        assert.equal(data.getPlayerEquipmentSync(p.playerId, PORTAL_3), null)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, PORTAL_5), null)
    })

    test("an armament without Star Specks gives none, however many copies", async () => {
        const p = await signUp()
        setEquipment(p.playerId, NO_STAR_3, 1, 2) // 3* in equipmentWithoutStarGrain: 3 copies, 9 WP
        const { status, body } = await post(p, "equipment/sell_equipment", { equipment_list: [{ equipment_id: NO_STAR_3 }], api_count: 1 })
        assert.equal(status, 200)
        assert.equal(data.getPlayerEquipmentSync(p.playerId, NO_STAR_3), null)
        assert.deepEqual(items(p.playerId, NO_STAR_3, WRIGHTPIECE, STAR_SPECK), [3, 9, 0])
        assert.equal(body.data.item_list[STAR_SPECK], undefined)
    })

    test("a 1* gives one Wrightpiece a copy", async () => {
        const p = await signUp()
        setEquipment(p.playerId, NO_STAR_1, 1, 3)
        assert.equal((await post(p, "equipment/sell_equipment", { equipment_list: [{ equipment_id: NO_STAR_1 }], api_count: 1 })).status, 200)
        assert.deepEqual(items(p.playerId, NO_STAR_1, WRIGHTPIECE, STAR_SPECK), [4, 4, 0])
    })

    test("an armament that is not owned, unmeltable or locked is refused and nothing changes", async () => {
        const p = await signUp()
        const watched = [PORTAL_3, PORTAL_4, UNMELTABLE_3, UNMELTABLE_5]
        const watchedItems = [WRIGHTPIECE, STAR_SPECK, ...watched]
        setItem(p.playerId, WRIGHTPIECE, 7)
        setEquipment(p.playerId, UNMELTABLE_3, 1, 2)
        setEquipment(p.playerId, UNMELTABLE_5, 1, 0)
        setEquipment(p.playerId, PORTAL_4, 1, 2, true) // locked
        const cases: [string, number][] = [["not owned", PORTAL_3], ["unmeltable (3*)", UNMELTABLE_3], ["unmeltable (5*)", UNMELTABLE_5], ["locked", PORTAL_4]]
        for (const [label, id] of cases) {
            const before = snapshot(p.playerId, watched, [], watchedItems)
            const { status } = await post(p, "equipment/sell_equipment", { equipment_list: [{ equipment_id: id }], api_count: 1 })
            assert.equal(status, 400, label)
            assert.equal(snapshot(p.playerId, watched, [], watchedItems), before, `${label}: nothing changed`)
        }
    })

    test("a bad armament after a good one changes nothing, not even the good one", async () => {
        const p = await signUp()
        setItem(p.playerId, WRIGHTPIECE, 7)
        setEquipment(p.playerId, PORTAL_5, 1, 1)
        setEquipment(p.playerId, PORTAL_4, 1, 0, true) // locked
        setEquipment(p.playerId, UNMELTABLE_3, 1, 0)
        const watched = [PORTAL_3, PORTAL_4, PORTAL_5, UNMELTABLE_3]
        const watchedItems = [WRIGHTPIECE, STAR_SPECK, ...watched]
        for (const bad of [PORTAL_3 /* not owned */, PORTAL_4 /* locked */, UNMELTABLE_3]) {
            const before = snapshot(p.playerId, watched, [], watchedItems)
            const { status } = await post(p, "equipment/sell_equipment", { equipment_list: [{ equipment_id: PORTAL_5 }, { equipment_id: bad }], api_count: 1 })
            assert.equal(status, 400, String(bad))
            assert.equal(snapshot(p.playerId, watched, [], watchedItems), before, `${bad}: nothing changed`)
        }
        assert.deepEqual(data.getPlayerEquipmentSync(p.playerId, PORTAL_5), { level: 1, enhancementLevel: 0, protection: false, stack: 1 })
    })

    test("a body without equipment_list is refused", async () => {
        const p = await signUp()
        assert.equal((await post(p, "equipment/sell_equipment", { api_count: 1 })).status, 400)
    })
})

describe("character/bulk_over_limit (Uncap All)", () => {
    test("every unit with duplicates below its max uncap uses them; only changed units are listed", async () => {
        const p = await signUp()
        setUnit(p.playerId, UNIT_5, 1, 5)        // max 4: +3, 2 left
        setUnit(p.playerId, UNIT_4, 0, 2)        // max 6: +2, 0 left
        setUnit(p.playerId, UNIT_1, 3, 4)        // max 12: +4
        setUnit(p.playerId, UNIT_3, 4, 0)        // no duplicates: unchanged
        setUnit(p.playerId, UNIT_3_NO_STAR, 8, 3) // already at max 8: unchanged
        const { status, body } = await post(p, "character/bulk_over_limit")
        assert.equal(status, 200)
        const state = (id: number) => { const c = data.getPlayerCharacterSync(p.playerId, id)!; return [c.overLimitStep, c.stack] }
        assert.deepEqual(state(UNIT_5), [4, 2])
        assert.deepEqual(state(UNIT_4), [2, 0])
        assert.deepEqual(state(UNIT_1), [7, 0])
        assert.deepEqual(state(UNIT_3), [4, 0])
        assert.deepEqual(state(UNIT_3_NO_STAR), [8, 3])

        const list: any[] = body.data.character_list
        assert.deepEqual(list.map(c => c.character_id).sort(), [UNIT_5, UNIT_4, UNIT_1].sort())
        const byId = Object.fromEntries(list.map(c => [c.character_id, c]))
        assert.equal(byId[UNIT_5].over_limit_step, 4)
        assert.equal(byId[UNIT_5].stack, 2)
        assert.equal(byId[UNIT_1].over_limit_step, 7)
        assert.equal(byId[UNIT_1].stack, 0)
        for (const c of list) {
            assert.ok("join_time" in c && "update_time" in c && "create_time" in c)
        }
    })

    test("locked units are uncapped too, and each unit stops at its max by rarity", async () => {
        const p = await signUp()
        setUnit(p.playerId, UNIT_5, 0, 10, true)     // max 4 -> 4, 6 left
        setUnit(p.playerId, UNIT_4, 0, 10)           // max 6
        setUnit(p.playerId, UNIT_3, 0, 10)           // max 8
        setUnit(p.playerId, UNIT_1, 0, 20)           // max 12
        const { status } = await post(p, "character/bulk_over_limit")
        assert.equal(status, 200)
        const c = (id: number) => data.getPlayerCharacterSync(p.playerId, id)!
        assert.deepEqual([c(UNIT_5).overLimitStep, c(UNIT_5).stack, c(UNIT_5).protection], [4, 6, true])
        assert.deepEqual([c(UNIT_4).overLimitStep, c(UNIT_4).stack], [6, 4])
        assert.deepEqual([c(UNIT_3).overLimitStep, c(UNIT_3).stack], [8, 2])
        assert.deepEqual([c(UNIT_1).overLimitStep, c(UNIT_1).stack], [12, 8])
    })

    test("with nothing to uncap the reply has an empty list", async () => {
        const p = await signUp()
        setUnit(p.playerId, UNIT_5, 4, 3)
        const before = snapshot(p.playerId, [], [UNIT_5], [])
        const { status, body } = await post(p, "character/bulk_over_limit")
        assert.equal(status, 200)
        assert.deepEqual(body.data.character_list, [])
        assert.equal(snapshot(p.playerId, [], [UNIT_5], []), before)
    })
})

describe("expod/bulk_stack_to_exp (Convert All to EXP)", () => {
    test("converts the duplicates of every fully uncapped unit at the master's rates", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, expPool: 1000 })
        setItem(p.playerId, STAR_SPECK, 50)
        setUnit(p.playerId, UNIT_5, 4, 2)          // 2 x 10000 EXP, 2 x 30 SS
        setUnit(p.playerId, UNIT_4, 6, 3)          // 3 x 2000, 3 x 10
        setUnit(p.playerId, UNIT_3, 8, 4)          // 4 x 500, 4 x 2
        setUnit(p.playerId, UNIT_3_NO_STAR, 8, 1)  // 1 x 500, no SS
        setUnit(p.playerId, UNIT_1, 12, 5)         // 5 x 100, no SS
        const notMaxed = 111002 // 5*, uncap 3 of 4: unchanged
        setUnit(p.playerId, notMaxed, 3, 9)
        const expected = 2 * 10000 + 3 * 2000 + 4 * 500 + 500 + 5 * 100
        const specks = 2 * 30 + 3 * 10 + 4 * 2
        const { status, body } = await post(p, "expod/bulk_stack_to_exp")
        assert.equal(status, 200)
        assert.equal(expected, 29000)
        assert.equal(data.getPlayerSync(p.playerId)!.expPool, 1000 + expected)
        assert.equal(data.getPlayerItemSync(p.playerId, STAR_SPECK), 50 + specks)
        for (const id of [UNIT_5, UNIT_4, UNIT_3, UNIT_3_NO_STAR, UNIT_1]) assert.equal(data.getPlayerCharacterSync(p.playerId, id)!.stack, 0, String(id))
        assert.equal(data.getPlayerCharacterSync(p.playerId, notMaxed)!.stack, 9)
        assert.equal(body.data.user_info.exp_pool, 1000 + expected)
        assert.equal(body.data.converted_exp_info.add_exp, expected)
        assert.equal(body.data.item_list[STAR_SPECK], 50 + specks)
        const listed = body.data.character_list.map((c: any) => c.character_id).sort()
        assert.deepEqual(listed, [UNIT_5, UNIT_4, UNIT_3, UNIT_3_NO_STAR, UNIT_1].sort())
        for (const c of body.data.character_list) assert.equal(c.stack, 0)
    })

    test("locked units are converted too (as the client lists them)", async () => {
        const p = await signUp()
        setUnit(p.playerId, UNIT_3, 8, 2, true)
        const { status, body } = await post(p, "expod/bulk_stack_to_exp")
        assert.equal(status, 200)
        assert.equal(body.data.converted_exp_info.add_exp, 1000)
        assert.equal(data.getPlayerCharacterSync(p.playerId, UNIT_3)!.stack, 0)
    })

    test("with nothing to convert, nothing changes and item_list still carries Star Specks", async () => {
        const p = await signUp()
        setItem(p.playerId, STAR_SPECK, 7)
        setUnit(p.playerId, UNIT_5, 3, 4) // not at max uncap
        const before = snapshot(p.playerId, [], [UNIT_5], [STAR_SPECK])
        const { status, body } = await post(p, "expod/bulk_stack_to_exp")
        assert.equal(status, 200)
        assert.equal(body.data.converted_exp_info.add_exp, 0)
        assert.deepEqual(body.data.character_list, [])
        assert.equal(body.data.item_list[STAR_SPECK], 7)
        assert.equal(snapshot(p.playerId, [], [UNIT_5], [STAR_SPECK]), before)
    })
})

describe("expod/stack_to_exp (single conversion, new rates)", () => {
    const convert = (p: Player, characterId: number, number: number) => post(p, "expod/stack_to_exp", { character_id: characterId, number, api_count: 1 })

    test("1* gives 100 EXP per duplicate and no Star Specks", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, expPool: 0 })
        setUnit(p.playerId, UNIT_1, 12, 3)
        const { status, body } = await convert(p, UNIT_1, 2)
        assert.equal(status, 200)
        assert.equal(body.data.converted_exp_info.add_exp, 200)
        assert.equal(data.getPlayerSync(p.playerId)!.expPool, 200)
        assert.equal(data.getPlayerCharacterSync(p.playerId, UNIT_1)!.stack, 1)
        assert.equal(data.getPlayerItemSync(p.playerId, STAR_SPECK) ?? 0, 0)
    })

    test("3* gives 500 EXP and 2 Star Specks per duplicate (none for a unit without Star Specks)", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, expPool: 0 })
        setUnit(p.playerId, UNIT_3, 8, 2)
        setUnit(p.playerId, UNIT_3_NO_STAR, 8, 2)
        const first = await convert(p, UNIT_3, 1)
        assert.equal(first.status, 200)
        assert.equal(first.body.data.converted_exp_info.add_exp, 500)
        assert.equal(first.body.data.item_list[STAR_SPECK], 2)
        assert.equal(data.getPlayerSync(p.playerId)!.expPool, 500)
        assert.equal((await convert(p, UNIT_3_NO_STAR, 2)).status, 200)
        assert.equal(data.getPlayerSync(p.playerId)!.expPool, 1500)
        assert.equal(data.getPlayerItemSync(p.playerId, STAR_SPECK), 2)
    })

    test("2*, 4* and 5* rates: 300, 2000 and 10000 EXP", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, expPool: 0 })
        setUnit(p.playerId, UNIT_5, 4, 1)
        setUnit(p.playerId, UNIT_4, 6, 1)
        assert.equal((await convert(p, UNIT_5, 1)).body.data.converted_exp_info.add_exp, 10000)
        assert.equal((await convert(p, UNIT_4, 1)).body.data.converted_exp_info.add_exp, 2000)
        assert.equal(data.getPlayerItemSync(p.playerId, STAR_SPECK), 30 + 10)
    })

    test("a locked unit is refused and unchanged", async () => {
        const p = await signUp()
        setUnit(p.playerId, UNIT_3, 8, 2, true)
        const before = snapshot(p.playerId, [], [UNIT_3], [STAR_SPECK])
        assert.equal((await convert(p, UNIT_3, 1)).status, 400)
        assert.equal(snapshot(p.playerId, [], [UNIT_3], [STAR_SPECK]), before)
    })

    test("more than the stack is refused", async () => {
        const p = await signUp()
        setUnit(p.playerId, UNIT_3, 8, 1)
        assert.equal((await convert(p, UNIT_3, 2)).status, 400)
        assert.equal(data.getPlayerCharacterSync(p.playerId, UNIT_3)!.stack, 1)
    })
})

describe("item/sell", () => {
    const sell = (p: Player, item_id: number, sell_number: number) => post(p, "item/sell", { item_id, sell_number })

    test("sells an item for mana (price x number)", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, freeMana: 1000 })
        setItem(p.playerId, SELLABLE_ITEM, 10)
        const { status, body } = await sell(p, SELLABLE_ITEM, 4)
        assert.equal(status, 200)
        assert.equal(data.getPlayerSync(p.playerId)!.freeMana, 1000 + 4 * 5)
        assert.equal(data.getPlayerItemSync(p.playerId, SELLABLE_ITEM), 6)
        assert.equal(body.data.user_info.free_mana, 1020)
        assert.deepEqual(body.data.item_list, { [SELLABLE_ITEM]: 6 })
        // all of it
        assert.equal((await sell(p, SELLABLE_ITEM, 6)).status, 200)
        assert.equal(data.getPlayerItemSync(p.playerId, SELLABLE_ITEM), 0)
        assert.equal(data.getPlayerSync(p.playerId)!.freeMana, 1050)
    })

    test("refuses an item that can't be sold, more than owned, and numbers below 1", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, freeMana: 1000 })
        setItem(p.playerId, SELLABLE_ITEM, 3)
        setItem(p.playerId, UNSELLABLE_ITEM, 3)
        const before = snapshot(p.playerId, [], [], [SELLABLE_ITEM, UNSELLABLE_ITEM])
        assert.equal((await sell(p, UNSELLABLE_ITEM, 1)).status, 400, "not in sell rules")
        assert.equal((await sell(p, 123456789, 1)).status, 400, "unknown item")
        assert.equal((await sell(p, SELLABLE_ITEM, 4)).status, 400, "more than owned")
        assert.equal((await sell(p, SELLABLE_ITEM, 0)).status, 400, "zero")
        assert.equal((await sell(p, SELLABLE_ITEM, -1)).status, 400, "negative")
        assert.equal(snapshot(p.playerId, [], [], [SELLABLE_ITEM, UNSELLABLE_ITEM]), before)
    })

    test("an item outside its sale period answers 200 with result code 2054 and changes nothing", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, freeMana: 1000 })
        setItem(p.playerId, EXPIRED_ITEM, 5)
        setItem(p.playerId, FUTURE_ITEM, 5)
        const before = snapshot(p.playerId, [], [], [EXPIRED_ITEM, FUTURE_ITEM])
        for (const id of [EXPIRED_ITEM, FUTURE_ITEM]) {
            const { status, body } = await sell(p, id, 1)
            assert.equal(status, 200, String(id))
            assert.equal(body.data_headers.result_code, 2054, String(id))
        }
        assert.equal(snapshot(p.playerId, [], [], [EXPIRED_ITEM, FUTURE_ITEM]), before)
    })

    test("ability cores keep at least 3", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, freeMana: 0 })
        setItem(p.playerId, ABILITY_CORE, 5)
        assert.equal((await sell(p, ABILITY_CORE, 3)).status, 400, "would leave 2")
        assert.equal(data.getPlayerItemSync(p.playerId, ABILITY_CORE), 5)
        const { status, body } = await sell(p, ABILITY_CORE, 2)
        assert.equal(status, 200)
        assert.equal(data.getPlayerItemSync(p.playerId, ABILITY_CORE), 3)
        assert.equal(body.data.user_info.free_mana, 1000)
        assert.equal((await sell(p, ABILITY_CORE, 1)).status, 400, "would leave 2")
    })

    test("a sale that would pass the mana cap is refused", async () => {
        const p = await signUp()
        data.updatePlayerSync({ id: p.playerId, freeMana: 999_999_989 })
        setItem(p.playerId, SELLABLE_ITEM, 10)
        assert.equal((await sell(p, SELLABLE_ITEM, 3)).status, 400, "15 mana would pass the cap")
        assert.equal(data.getPlayerItemSync(p.playerId, SELLABLE_ITEM), 10)
        assert.equal(data.getPlayerSync(p.playerId)!.freeMana, 999_999_989)
        assert.equal((await sell(p, SELLABLE_ITEM, 2)).status, 200, "exactly to the cap")
        assert.equal(data.getPlayerSync(p.playerId)!.freeMana, 999_999_999)
    })
})

describe("character/set_protection", () => {
    test("locks and unlocks units, skipping ids the player doesn't own", async () => {
        const p = await signUp()
        setUnit(p.playerId, UNIT_5, 0, 0, false)
        setUnit(p.playerId, UNIT_4, 0, 0, true)
        setUnit(p.playerId, UNIT_3, 0, 0, true)
        const { status, body } = await post(p, "character/set_protection", {
            protect_character_ids: [UNIT_5, 999999999],
            unprotect_character_ids: [UNIT_4]
        })
        assert.equal(status, 200)
        assert.deepEqual(body.data, [])
        const locked = (id: number) => data.getPlayerCharacterSync(p.playerId, id)!.protection
        assert.equal(locked(UNIT_5), true)
        assert.equal(locked(UNIT_4), false)
        assert.equal(locked(UNIT_3), true, "not mentioned: unchanged")
        assert.equal(data.getPlayerCharacterSync(p.playerId, 999999999), null, "nothing was created")
    })

    test("empty lists are fine", async () => {
        const p = await signUp()
        assert.equal((await post(p, "character/set_protection", { protect_character_ids: [], unprotect_character_ids: [] })).status, 200)
    })

    test("a locked unit is refused by the single conversion until unlocked", async () => {
        const p = await signUp()
        setUnit(p.playerId, UNIT_1, 12, 2)
        await post(p, "character/set_protection", { protect_character_ids: [UNIT_1], unprotect_character_ids: [] })
        const convert = () => post(p, "expod/stack_to_exp", { character_id: UNIT_1, number: 1, api_count: 1 })
        assert.equal((await convert()).status, 400)
        await post(p, "character/set_protection", { protect_character_ids: [], unprotect_character_ids: [UNIT_1] })
        assert.equal((await convert()).status, 200)
    })
})
