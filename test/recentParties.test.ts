// FT-50: suggested parties. A won battle keeps the player's party as their latest for the quest, and
// quest/get_recent_other_player_party lists other players' latest parties, newest first, in the shape the client checks
// field by field (QuestGetRecentOtherPlayerPartyRemote).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const PRACTICE = 15 // Practice Combat: battles without stamina, handy here
const QUEST = 1
const ARMAMENT = 5010004

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let giveCharacter: typeof import("../src/lib/character").givePlayerCharacterSync
let giveEquipment: typeof import("../src/lib/equipment").givePlayerEquipmentSync

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    giveCharacter = (await import("../src/lib/character")).givePlayerCharacterSync
    giveEquipment = (await import("../src/lib/equipment")).givePlayerEquipmentSync
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

type Player = TestPlayer & { playerId: number }

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

/** A player owning units 111001-111003 and armament 5010004. */
async function newPlayer(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    const playerId = data.getViewerPlayerIdSync(player.viewerId)!
    for (const id of [111001, 111002, 111003]) giveCharacter(playerId, id)
    giveEquipment(playerId, ARMAMENT, 1)
    return { ...player, playerId }
}

function statistics(characters: (number | null)[], unisons: (number | null)[] = [111002, null, null], equipments: (number | null)[] = [ARMAMENT, null, null],
    souls: (number | null)[] = [7, null, null]) {
    const slot = (id: number | null) => id === null ? null : { id }
    return {
        clear_phase: 0,
        party: {
            characters: characters.map(slot), unison_characters: unisons.map(slot), equipments: equipments.map(slot),
            ability_soul_ids: souls
        }
    }
}

async function battle(player: Player, stats: ReturnType<typeof statistics>, won = true, questId = QUEST, partyId = 1) {
    const start = await post(player, "single_battle_quest/start", {
        quest_id: questId, category: PRACTICE, party_id: partyId,
        use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: false, api_count: 1, play_id: "test"
    })
    assert.equal(start.statusCode, 200, start.body)
    const route = won ? "single_battle_quest/finish" : "single_battle_quest/abort"
    const finish = await post(player, route, {
        quest_id: questId, category: PRACTICE, score: 100, add_mana: 0, elapsed_time_ms: 60000, finish_kind: 1,
        is_accomplished: won, is_restored: false, continue_count: 0, api_count: 2, play_id: "test", statistics: stats
    })
    assert.equal(finish.statusCode, 200, finish.body)
}

async function suggested(player: Player, questId = QUEST, category = PRACTICE): Promise<Record<string, unknown>[]> {
    const response = await post(player, "quest/get_recent_other_player_party", { category, quest_id: questId, api_count: 3 })
    assert.equal(response.statusCode, 200, response.body)
    const parties = decodeGameBody(response.body).data.recent_other_player_party
    assert.ok(Array.isArray(parties))
    return parties
}

/** Every field the client reads, with the types it accepts (party_name and power required, the rest Int or null). */
function assertClientShape(entry: Record<string, unknown>) {
    assert.equal(typeof entry.party_name, "string")
    assert.ok(Number.isInteger(entry.power))
    for (const n of [1, 2, 3]) {
        for (const key of [`character_id_${n}`, `unison_character_id_${n}`, `equipment_id_${n}`, `ability_soul_id_${n}`,
            `evolution_img_level_${n}`, `unison_evolution_img_level_${n}`]) {
            assert.ok(key in entry, key)
            assert.ok(entry[key] === null || Number.isInteger(entry[key]), `${key}: ${entry[key]}`)
        }
    }
}

test("another player's won battle is listed with its party; the player's own isn't", async () => {
    const a = await newPlayer()
    const b = await newPlayer()
    // party 1 holds the battle's main units, so its name goes with it
    const party = data.getPlayerPartyGroupListSync(a.playerId)
    const groupParty = Object.values(party).flatMap(group => Object.entries(group.list)).find(([slot]) => slot === "1")![1]
    data.updatePlayerPartySync(a.playerId, 1, { ...groupParty, name: "Thunder Squad", characterIds: [111001, null, 111003] })

    await battle(a, statistics([111001, null, 111003]))
    assert.deepEqual(await suggested(a), [])

    const [entry, ...rest] = await suggested(b)
    assert.equal(rest.length, 0)
    assertClientShape(entry)
    assert.equal(entry.party_name, "Thunder Squad")
    // src/lib/partyPower.ts: slot 1, 111001 (53/11) + int(0.25 * 111002's 56/9) + armament 5010004 (340/132):
    // int(407 * 0.2 + 145) = 226; slot 3, 111003 (51/10): int(51 * 0.2 + 10) = 20
    assert.equal(entry.power, 246)
    assert.deepEqual([entry.character_id_1, entry.character_id_2, entry.character_id_3], [111001, null, 111003])
    assert.deepEqual([entry.unison_character_id_1, entry.unison_character_id_2], [111002, null])
    assert.equal(entry.equipment_id_1, ARMAMENT)
    assert.equal(entry.evolution_img_level_1, 0)
    assert.equal(entry.evolution_img_level_2, null)
    // 7 isn't an Ability Core
    assert.equal(entry.ability_soul_id_1, null)
})

test("one party per player and quest, the latest; newest players first", async () => {
    const a = await newPlayer()
    const b = await newPlayer()
    const viewer = await newPlayer()
    await battle(a, statistics([111001, null, null]), true, 2)
    await battle(b, statistics([111002, null, null]), true, 2)
    await battle(a, statistics([111003, null, null]), true, 2)

    const parties = await suggested(viewer, 2)
    assert.deepEqual(parties.map(party => party.character_id_1), [111003, 111002])
    // the party name is left empty when the battle's units aren't the stored party's
    assert.equal(parties[0].party_name, "")
})

test("lost battles, other quests and unowned or unknown units", async () => {
    const a = await newPlayer()
    const viewer = await newPlayer()
    await battle(a, statistics([111001, null, null]), false, 3)
    assert.deepEqual(await suggested(viewer, 3), [])

    // units and armaments the player doesn't own, or the game doesn't have, are left out
    await battle(a, statistics([111004, 111001, 99999999], [99999999, null, null], [5999999, null, null]), true, 3)
    const [entry] = await suggested(viewer, 3)
    assert.deepEqual([entry.character_id_1, entry.character_id_2, entry.character_id_3], [null, 111001, null])
    assert.equal(entry.unison_character_id_1, null)
    assert.equal(entry.equipment_id_1, null)

    // a party with no main unit left isn't kept
    const c = await newPlayer()
    await battle(c, statistics([111004, null, null]), true, 11)
    assert.deepEqual(await suggested(viewer, 11), [])

    // another quest, another category, a quest that doesn't exist
    assert.deepEqual(await suggested(viewer, 4), [])
    assert.deepEqual(await suggested(viewer, 3, 1), [])
    assert.deepEqual(await suggested(viewer, 987654321), [])
})

test("Ability Cores the player owns and the game has are sent", async () => {
    const OWNED_CORE = 2020001, UNOWNED_CORE = 3020003
    const a = await newPlayer()
    const viewer = await newPlayer()
    data.givePlayerItemSync(a.playerId, OWNED_CORE, 1)
    // 10002 is an item (4★ Astral Gem) but not a core: the client would stop on it with C8601
    data.givePlayerItemSync(a.playerId, 10002, 1)
    await battle(a, statistics([111001, null, null], undefined, undefined, [OWNED_CORE, UNOWNED_CORE, 10002]), true, 31)
    const [entry] = await suggested(viewer, 31)
    assertClientShape(entry)
    assert.deepEqual([entry.ability_soul_id_1, entry.ability_soul_id_2, entry.ability_soul_id_3], [OWNED_CORE, null, null])
})

test("a deleted player's parties go with them, and the request needs a quest", async () => {
    const a = await newPlayer()
    const viewer = await newPlayer()
    await battle(a, statistics([111001, null, null]), true, 21)
    assert.equal((await suggested(viewer, 21)).length, 1)
    data.deletePlayerSync(a.playerId)
    assert.deepEqual(await suggested(viewer, 21), [])

    const response = await post(viewer, "quest/get_recent_other_player_party", { category: PRACTICE })
    assert.equal(response.statusCode, 400)
})
