// FT-41: the small client routes. Party codes (party/publish stores a party, party/refer returns it to another
// player), the party name check, and the routes that only acknowledge (encyclopedia/unlock_keyword, the active mission
// incentive routes, bonus/shown_expired_premium, gacha/shown_converted, agreement/agree_*).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let alice: TestPlayer
let bob: TestPlayer
let alicePlayerId: number
before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    alice = await createTestPlayer(fastify)
    bob = await createTestPlayer(fastify)

    // Alice owns the units and armaments of the party she shares
    const { getViewerPlayerIdSync } = await import("../src/data/wdfpData")
    const { givePlayerCharacterSync } = await import("../src/lib/character")
    const { givePlayerEquipmentSync } = await import("../src/lib/equipment")
    alicePlayerId = getViewerPlayerIdSync(alice.viewerId)!
    for (const id of [141063, 141141, 241045]) givePlayerCharacterSync(alicePlayerId, id)
    for (const id of [5040028, 5040029]) givePlayerEquipmentSync(alicePlayerId, id, 1)
})
after(async () => { await cleanup?.() })

function request(player: TestPlayer, route: string, body: object) {
    return fastify.inject({ method: "POST", url: `/latest/api/index.php/${route}`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ viewer_id: player.viewerId, api_count: 1, ...body }) })
}

async function ok(player: TestPlayer, route: string, body: object) {
    const response = await request(player, route, body)
    assert.equal(response.statusCode, 200, `${route}: ${response.body}`)
    return decodeGameBody(response.body)
}

const character = (id: number) => ({
    id, evolution_level: 1, exp: 379988, over_limit_step: 4,
    ex_boost: { status_id: 3, ability_id_list: [7, 35] },
    mana_node_ids: [282126201, 282126202],
    illustration_settings: null
})

const battleParty = {
    characters: [character(141063), null, { ...character(141141), ex_boost: null }],
    unison_characters: [character(241045), null, null],
    equipments: [{ equipment_id: 5040028, level: 5 }, null, { equipment_id: 5040029, level: 5 }],
    ability_soul_ids: [5010058, null, 5040029]
}

test("a published party comes back to another player by its code", async () => {
    const published = await ok(alice, "party/publish", { party_name: "Party G", battle_party: { ...battleParty, extra: 1 } })
    const code = published.data.party_code
    assert.match(code, /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabdefghijmnqrty]{6,}$/, "the client's own check of a typed code")

    const again = await ok(alice, "party/publish", { party_name: "Party G", battle_party: battleParty })
    assert.equal(again.data.party_code, code, "the same party keeps its code")
    const other = await ok(alice, "party/publish", { party_name: "Party H", battle_party: battleParty })
    assert.notEqual(other.data.party_code, code)

    const referred = await ok(bob, "party/refer", { party_code: code })
    assert.equal(referred.data_headers.result_code, 1)
    assert.equal(referred.data.party_name, "Party G")
    assert.deepEqual(referred.data.battle_party, battleParty, "only the fields the client reads are kept")
})

test("a party code carries only units and armaments the sharing player owns", async () => {
    // a unit and an armament Alice doesn't own, and ids the game doesn't have: another player's client would stop on
    // an unknown id, so those slots are emptied
    const party = {
        characters: [character(141063), character(111001), character(999999999)],
        unison_characters: [character(241045), null, null],
        equipments: [{ equipment_id: 5040028, level: 5 }, { equipment_id: 999999999, level: 5 }, null],
        ability_soul_ids: [null, null, null]
    }
    const code = (await ok(alice, "party/publish", { party_name: "Mixed", battle_party: party })).data.party_code
    const referred = await ok(bob, "party/refer", { party_code: code })
    assert.deepEqual(referred.data.battle_party, {
        ...party,
        characters: [character(141063), null, null],
        equipments: [{ equipment_id: 5040028, level: 5 }, null, null]
    })
})

test("showing an old party code again keeps it from being the next one dropped", async () => {
    const { PARTY_CODES_PER_PLAYER } = await import("../src/data/partyCodes")
    const carol = await createTestPlayer(fastify)
    const party = { characters: [null, null, null], unison_characters: [null, null, null], equipments: [null, null, null], ability_soul_ids: [null, null, null] }
    const publish = async (name: string) => (await ok(carol, "party/publish", { party_name: name, battle_party: party })).data.party_code as string

    const first = await publish("Party 0")
    const second = await publish("Party 1")
    for (let i = 2; i < PARTY_CODES_PER_PLAYER; i++) await publish(`Party ${i}`)
    assert.equal(await publish("Party 0"), first, "shown again: the same code")
    await publish("One more")

    assert.equal((await ok(bob, "party/refer", { party_code: first })).data_headers.result_code, 1, "the code just shown again stays")
    assert.equal((await ok(bob, "party/refer", { party_code: second })).data_headers.result_code, 3404, "the oldest one is dropped")
})

test("an unknown party code gets the client's not-found code", async () => {
    const referred = await ok(bob, "party/refer", { party_code: "ZZZZZZZZ" })
    assert.equal(referred.data_headers.result_code, 3404)
})

test("a party the client couldn't read back is refused at publish", async () => {
    const wrongType = await request(alice, "party/publish", { party_name: "Bad", battle_party: { ...battleParty, characters: [{ ...character(1), exp: "lots" }] } })
    assert.equal(wrongType.statusCode, 400)
    const tooMany = await request(alice, "party/publish", { party_name: "Bad", battle_party: { ...battleParty, ability_soul_ids: [1, 2, 3, 4] } })
    assert.equal(tooMany.statusCode, 400)
})

test("party/check_word passes a usable party name and refuses others", async () => {
    assert.equal((await ok(alice, "party/check_word", { word: "Water team" })).data.check_passed, true)
    // the master's name limit is 18, counted in UTF-16 units as the client's String.length does
    assert.equal((await ok(alice, "party/check_word", { word: "x".repeat(18) })).data.check_passed, true)
    assert.equal((await ok(alice, "party/check_word", { word: "x".repeat(19) })).data.check_passed, false)
    assert.equal((await ok(alice, "party/check_word", { word: "\u{1F600}".repeat(9) })).data.check_passed, true)
    assert.equal((await ok(alice, "party/check_word", { word: "\u{1F600}".repeat(10) })).data.check_passed, false)
    assert.equal((await ok(alice, "party/check_word", { word: "bad\u0007name" })).data.check_passed, false)
})

test("party/edit refuses a rename past the limit but keeps longer names already stored", async () => {
    const { viewer_id: _captured, ...body } = readCapturedRoute("party_edit").requestBody as { viewer_id: unknown, party_info_list: Record<string, unknown>[] }
    const party = { ...body.party_info_list[0], character_ids: [null, null, null], unison_character_ids: [null, null, null], equipment_ids: [null, null, null], ability_soul_ids: [null, null, null] }
    const edit = (player: TestPlayer, partyInfo: Record<string, unknown>) =>
        request(player, "party/edit", { ...body, party_info_list: [partyInfo] })

    assert.equal((await edit(bob, { ...party, party_name: "x".repeat(18) })).statusCode, 200)
    assert.equal((await edit(bob, { ...party, party_name: "y".repeat(19) })).statusCode, 400)

    // the profile party's server-made name is 22 characters: saving its units again keeps it
    const profileParty = { ...party, party_category: 99, party_id: 1, party_name: "Setting Favorite Units" }
    assert.equal((await edit(bob, profileParty)).statusCode, 200)
})

test("the acknowledging routes answer with a success", async () => {
    const unlocked = await ok(alice, "encyclopedia/unlock_keyword", { encyclopedia_ids: [133100501] })
    assert.deepEqual(unlocked.data.encyclopedia_list, { "133100501": { read: false } })

    const incentive = await ok(alice, "active_mission/receive_incentive", { mission_id: 30010 })
    assert.equal(incentive.data_headers.result_code, 2479, "the real-prize campaign is over")

    for (const [route, body] of [
        ["active_mission/real_incentive_transitioned_url", { event_id: 3 }],
        ["bonus/shown_expired_premium", { bonus_group_id: 1 }],
        ["gacha/shown_converted", { gacha_id: 1 }],
        ["agreement/agree_terms", { terms_version: 1 }],
        ["agreement/agree_privacy", { privacy_version: 1 }],
        ["agreement/agree_all", { terms_version: 1, privacy_version: 1 }]
    ] as const) {
        assert.equal((await ok(alice, route, body)).data_headers.result_code, 1, route)
    }
})

test("the agreement routes don't need a viewer", async () => {
    const response = await fastify.inject({ method: "POST", url: "/latest/api/index.php/agreement/agree_all", headers: gameHeaders(alice.udid),
        payload: encodeGameBody({ terms_version: 1, privacy_version: 1 }) })
    assert.equal(response.statusCode, 200, response.body)
})
