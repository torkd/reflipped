// FT-36: the player's own profile. profile/get_my_profile sends the profile's counts against the game's totals, the
// show/hide settings and the favourite units (party category 99, made the first time and saved through party/edit);
// profile/update_profile_settings keeps the settings; profile/rename changes the name, refusing an empty or too long
// one with the client's "word can't be used" code (207).
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, TestPlayer } from "./helpers";
import degrees from "../assets/degree.json";

const apiPrefix = "/latest/api/index.php"
const PROFILE_PARTY = 99

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...body, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body)
}

async function newPlayer(): Promise<TestPlayer & { playerId: number }> {
    const { setServerTime } = await import("../src/utils")
    setServerTime(new Date("2025-01-03T12:00:00Z"))
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    return { ...player, playerId }
}

test("get_my_profile counts the player's units, second boards and titles against the game's totals", async () => {
    const player = await newPlayer()
    const owned = Object.keys(data.getPlayerCharactersSync(player.playerId)).filter(id => !id.startsWith("7")).length
    const { data: profile } = await post(player, "profile/get_my_profile", {})

    assert.equal(profile.profile_info.owned_character_count, owned)
    assert.equal(profile.profile_info.max_owned_character_count, 454)
    assert.equal(profile.profile_info.opened_mana_board_second_count, 0)
    assert.equal(profile.profile_info.max_opened_mana_board_second_count, 397)
    assert.equal(profile.profile_info.owned_degree_count, 1, "the default title")
    assert.equal(profile.profile_info.max_owned_degree_count, (degrees as unknown[]).length)
    assert.deepEqual({ ...profile.profile_settings }, {
        show_owned_character_count: true, show_opened_mana_board_second_count: true, show_owned_degree_count: true
    })
})

test("the favourite units are their own party set, made once and saved through party/edit", async () => {
    const player = await newPlayer()
    const first = (await post(player, "profile/get_my_profile", {})).data.user_party_group_list
    assert.equal(first.length, 1)
    assert.equal(first[0].party_group_id, 1)
    assert.equal(first[0].party_list.length, 1)
    const party = first[0].party_list[0]
    assert.equal(party.party_id, 1)
    assert.equal(party.party_group_id, 1)
    assert.equal(party.party_edited, false)

    // pick a unit the player owns other than the one the set starts with
    const unit = Number(Object.keys(data.getPlayerCharactersSync(player.playerId)).find(id => Number(id) !== party.character_ids[0])
        ?? party.character_ids[0])
    await post(player, "party/edit", {
        main_party_id: 1, api_count: 1,
        party_info_list: [{
            party_category: PROFILE_PARTY, party_name: "Favourites", party_id: 1, party_edited: true,
            unison_character_ids: [null, null, null], equipment_ids: [null, null, null], character_ids: [unit, null, null],
            ability_soul_ids: [null, null, null], options: { allow_other_players_to_heal_me: true }
        }]
    })
    const after = (await post(player, "profile/get_my_profile", {})).data.user_party_group_list
    assert.equal(after.length, 1, "still one set")
    assert.equal(after[0].party_list[0].character_ids[0], unit)
    assert.equal(after[0].party_list[0].party_name, "Favourites")

    // the normal parties are untouched, and /load's party groups don't include the profile's
    const normal = data.getPlayerPartyGroupListSync(player.playerId)
    assert.ok(Object.values(normal).every(group => Number(group.category) !== PROFILE_PARTY))
    assert.equal(Object.keys(data.getPlayerPartyGroupListSync(player.playerId, PROFILE_PARTY as never)).length, 1)
})

test("update_profile_settings keeps the show/hide settings", async () => {
    const player = await newPlayer()
    const settings = { show_owned_character_count: false, show_opened_mana_board_second_count: true, show_owned_degree_count: false }
    const updated = await post(player, "profile/update_profile_settings", { profile_settings: settings })
    assert.deepEqual({ ...updated.data.profile_settings }, settings)
    const { data: profile } = await post(player, "profile/get_my_profile", {})
    assert.deepEqual({ ...profile.profile_settings }, settings)
})

test("rename changes the name and refuses an empty or too long one with 207", async () => {
    const player = await newPlayer()
    const renamed = await post(player, "profile/rename", { name: "  Flipper  " })
    assert.equal(renamed.data_headers.result_code, 1)
    assert.equal(data.getPlayerSync(player.playerId)!.name, "Flipper")

    for (const name of ["", "   ", "ABCDEFGHIJKLMNOPQRSTU", "Bad\nName"]) {
        const refused = await post(player, "profile/rename", { name })
        assert.equal(refused.data_headers.result_code, 207, JSON.stringify(name))
    }
    assert.equal(data.getPlayerSync(player.playerId)!.name, "Flipper")

    // twenty characters (the config's limit), counted as characters
    await post(player, "profile/rename", { name: "フリッパーフリッパーフリッパーフリッパー" })
    assert.equal(data.getPlayerSync(player.playerId)!.name, "フリッパーフリッパーフリッパーフリッパー")
})
