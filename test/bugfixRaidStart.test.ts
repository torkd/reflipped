// FT-76: a raid set is 3 parties (Main, Sub 1, Sub 2) with no unit twice, 6 sets numbered 1-18 like the master
// player/player_party_raid_event. The client plays every party of the chosen set in the battle and refuses a set with
// a unit in two parties, so the old sets (copies of the normal groups: 10 parties each, the starting unit in all of
// them) kept Start disabled, and a 10-party set rebuilt with Recommended made the battle fail (U_b13d0e).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
const RAID = 23
// raid 4 (Sagas of Conquest), Novice
const NOVICE = 4001
const DURING = "2025-05-14T03:00:00Z"
const RAID_CATEGORY = 3

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let giveCharacter: typeof import("../src/lib/character").givePlayerCharacterSync

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    giveCharacter = (await import("../src/lib/character")).givePlayerCharacterSync
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date(DURING))
})

after(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
    await cleanup()
})

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
}

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

type SentParty = { party_id: number, party_name: string, character_ids: (number | null)[], unison_character_ids: (number | null)[], equipment_ids: (number | null)[] }
type SentGroup = { party_group_id: number, party_list: SentParty[] }

async function raidSets(player: TestPlayer): Promise<SentGroup[]> {
    const reply = await post(player, "event/raid/party", {})
    assert.equal(reply.statusCode, 200, reply.body)
    return decodeGameBody(reply.body).data.user_party_group_list
}

/** The units of a set that appear in more than one slot of it (the client's getDuplicatedCharacterIds). */
function duplicates(group: SentGroup): number[] {
    const ids = group.party_list.flatMap(party => [...party.character_ids, ...party.unison_character_ids]).filter((id): id is number => id !== null)
    return ids.filter((id, index) => ids.indexOf(id) !== index)
}

function assertLayout(groups: SentGroup[]) {
    assert.deepEqual(groups.map(group => group.party_group_id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
    for (const group of groups) {
        const first = (group.party_group_id - 1) * 3 + 1
        assert.deepEqual(group.party_list.map(party => party.party_id), [first, first + 1, first + 2])
        assert.deepEqual(group.party_list.map(party => party.party_name), ["Party A", "Party B", "Party C"])
        for (const party of group.party_list) assert.notEqual(party.character_ids[0], null, "every party has a leader")
        assert.deepEqual(duplicates(group), [], `set ${group.party_group_id} holds no unit twice`)
    }
}

function setNormalParty(playerId: number, slot: number, characterIds: (number | null)[], unisonCharacterIds: (number | null)[] = [null, null, null], equipmentIds: (number | null)[] = [null, null, null]) {
    data.updatePlayerPartySync(playerId, slot, {
        name: `Party ${slot}`, characterIds, unisonCharacterIds, equipmentIds, abilitySoulIds: [null, null, null],
        edited: true, options: { allowOtherPlayersToHealMe: true }, category: 1 as never
    })
}

test("a new player's raid sets are 6 sets of 3 parties with no unit twice, from their units", async () => {
    const player = await newPlayer()
    for (const id of [111001, 111002, 111003]) giveCharacter(player.playerId, id)
    const groups = await raidSets(player)
    assertLayout(groups)
    // the normal parties all lead with the starting unit: it leads Main, the Subs get the player's next units
    assert.deepEqual(groups[0].party_list.map(party => party.character_ids[0]), [1, 111001, 111002])
    // stored as sent, and sent the same the next time
    assert.deepEqual(await raidSets(player), groups)
    assert.equal(Object.keys(data.getPlayerPartyGroupListSync(player.playerId, RAID_CATEGORY as never)["1"].list).length, 3)
})

test("raid sets copy the normal parties without repeating a unit, armaments may repeat", async () => {
    const player = await newPlayer()
    for (const id of [111001, 111002, 111003, 111004, 111005, 111006]) giveCharacter(player.playerId, id)
    // normal group 1: party 1 and 2 share 111002, party 3 shares its leader with party 1
    setNormalParty(player.playerId, 1, [111001, 111002, null], [111003, null, null], [5040022, null, null])
    setNormalParty(player.playerId, 2, [111004, 111002, null], [null, null, null], [5040022, null, null])
    setNormalParty(player.playerId, 3, [111001, 111005, null])
    setNormalParty(player.playerId, 4, [111006, null, null])
    const [set] = (await raidSets(player)).filter(group => group.party_group_id === 1)
    assert.deepEqual(set.party_list.map(party => party.character_ids), [[111001, 111002, null], [111004, null, null], [111006, null, null]])
    assert.deepEqual(set.party_list.map(party => party.unison_character_ids[0]), [111003, null, null])
    assert.deepEqual(set.party_list.map(party => party.equipment_ids[0]), [5040022, 5040022, null])
    assert.deepEqual(duplicates(set), [])
})

test("raid sets stored in the old 10-party layout are rebuilt, keeping their first distinct parties", async () => {
    const player = await newPlayer()
    for (const id of [111001, 111002, 111003, 111004, 111005, 111006, 111007]) giveCharacter(player.playerId, id)
    // the old layout: a copy of the normal groups (10 parties each, slots 1-60), the first set rebuilt with Recommended
    const old = data.getDefaultPlayerPartyGroupsSync(RAID_CATEGORY as never)
    const recommended = [[111001, 111002, 111003], [111004, 111005, 111006], [111007, null, null]]
    recommended.forEach((characterIds, index) => { old["1"].list[String(index + 1)].characterIds = characterIds })
    data.insertPlayerPartyGroupListSync(player.playerId, old)
    assert.equal(Object.keys(data.getPlayerPartyGroupListSync(player.playerId, RAID_CATEGORY as never)["1"].list).length, 10)

    const groups = await raidSets(player)
    assertLayout(groups)
    assert.deepEqual(groups.find(group => group.party_group_id === 1)!.party_list.map(party => party.character_ids), recommended)
    const stored = data.getPlayerPartyGroupListSync(player.playerId, RAID_CATEGORY as never)
    assert.deepEqual(Object.keys(stored).sort(), ["1", "2", "3", "4", "5", "6"])
    assert.deepEqual(Object.values(stored).flatMap(group => Object.keys(group.list).map(Number)).sort((a, b) => a - b), Array.from({ length: 18 }, (_, index) => index + 1))
})

test("a player with a single unit keeps the master's default in the Subs", async () => {
    const player = await newPlayer()
    assert.deepEqual(Object.keys(data.getPlayerCharactersSync(player.playerId)), ["1"], "a new player owns only the starting unit")
    const [set] = await raidSets(player)
    assert.deepEqual(set.party_list.map(party => party.character_ids), [[1, null, null], [1, null, null], [1, null, null]])
})

test("a raid battle starts with the set's three parties and finishes with them on the record", async () => {
    const player = await newPlayer()
    for (const id of [111001, 111002]) giveCharacter(player.playerId, id)
    const [set] = await raidSets(player)
    // the client's raid start handler reads only client_checks (optional, an array of strings) and the servertime
    const started = await post(player, "event/raid/battle/start", {
        quest_id: NOVICE, party_group_id: set.party_group_id, play_id: "FT76", use_auto_start_point: false, is_auto_start_mode: false
    })
    assert.equal(started.statusCode, 200, started.body)
    const reply = decodeGameBody(started.body)
    assert.equal(typeof reply.data_headers.servertime, "number")
    assert.ok(Array.isArray(reply.data.client_checks) && reply.data.client_checks.every((check: unknown) => typeof check === "string"))

    const finished = await post(player, "single_battle_quest/finish", {
        quest_id: NOVICE, category: RAID, score: 1000, add_mana: 0, elapsed_time_ms: 60_000,
        is_accomplished: true, is_restored: false, continue_count: 0, api_count: 2, play_id: "FT76",
        statistics: {
            clear_phase: 0,
            party: { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
        }
    })
    assert.equal(finished.statusCode, 200, finished.body)
    const record = data.getPlayerRaidRecordsSync(player.playerId, 4).find(entry => entry.questId === NOVICE)
    assert.ok(record !== undefined)
    assert.deepEqual(record.party.map(party => party.characterIds[0]), set.party_list.map(party => party.character_ids[0]))
})

test("a raid battle start with a set that doesn't exist is refused", async () => {
    const player = await newPlayer()
    await raidSets(player)
    const started = await post(player, "event/raid/battle/start", {
        quest_id: NOVICE, party_group_id: 7, play_id: "FT76", use_auto_start_point: false, is_auto_start_mode: false
    })
    assert.equal(started.statusCode, 400)
})
