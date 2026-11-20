import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

let server: FastifyInstance
let cleanup: () => Promise<void>
before(async () => { ({ fastify: server, cleanup } = await createTestServer()) })
after(async () => { await cleanup() })

async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await server.inject({ method: "POST", url: `/latest/api/index.php/${route}`,
        headers: gameHeaders(player.udid), payload: encodeGameBody({ ...body, viewer_id: player.viewerId }) })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}
async function load(player: TestPlayer) {
    return post(player, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
}

test("option changes merge across both update routes and remain isolated on load", async () => {
    const a = await createTestPlayer(server)
    const b = await createTestPlayer(server)
    const beforeB = (await load(b)).user_option
    await post(a, "option/update", { api_count: 1, option_params: { regression_music: true, regression_sound: true } })
    await post(a, "option/update_in_battle", { api_count: 2, option_params: { regression_music: false } })
    const result = (await load(a)).user_option
    assert.equal(result.regression_music, false)
    assert.equal(result.regression_sound, true)
    assert.deepEqual((await load(b)).user_option, beforeB)
})

test("normal party edits persist on load and discard another player's unowned unit and armament", async () => {
    const a = await createTestPlayer(server)
    const b = await createTestPlayer(server)
    const data = await import("../src/data/wdfpData")
    const aId = data.getViewerPlayerIdSync(a.viewerId)!
    const bId = data.getViewerPlayerIdSync(b.viewerId)!
    const unit = 141003
    const equipment = 2010002
    ;(await import("../src/lib/character")).givePlayerCharacterSync(bId, unit)
    ;(await import("../src/lib/equipment")).givePlayerEquipmentSync(bId, equipment, 1)
    assert.equal(data.playerOwnsCharacterSync(aId, unit), false)
    assert.equal(data.playerOwnsEquipmentSync(aId, equipment), false)
    const beforeB = (await load(b)).user_party_group_list
    const ownedUnit = Number(Object.keys(data.getPlayerCharactersSync(aId))[0])
    const captured = readCapturedRoute("party_edit").requestBody
    const party = { ...captured.party_info_list[0], party_id: 1, party_category: 1, party_name: "Regression", party_edited: true,
        character_ids: [ownedUnit, unit, null], unison_character_ids: [unit, null, null], equipment_ids: [equipment, null, null],
        ability_soul_ids: [null, null, null], options: { allow_other_players_to_heal_me: true } }
    await post(a, "party/edit", { ...captured, main_party_id: 1, party_info_list: [party] })
    await post(a, "party_group/edit", { api_count: 2, party_group_edit_params_list: [{ party_group_id: 1, party_category: 1, party_group_color_id: 3 }] })
    const groups = (await load(a)).user_party_group_list
    const edited = groups["1"].list["1"]
    assert.equal(edited.name, "Regression")
    assert.deepEqual(edited.character_ids, [ownedUnit, null, null])
    assert.deepEqual(edited.unison_character_ids, [null, null, null])
    assert.deepEqual(edited.equipment_ids, [null, null, null])
    assert.equal(groups["1"].color_id, 3)
    assert.deepEqual((await load(b)).user_party_group_list, beforeB)
})

test("character progression persists, charges resources and refuses repeated claims", async () => {
    const p = await createTestPlayer(server)
    const data = await import("../src/data/wdfpData")
    const assets = await import("../src/lib/assets")
    const id = data.getViewerPlayerIdSync(p.viewerId)!
    const character = 1
    const start = data.getPlayerCharacterSync(id, character)!
    data.updatePlayerSync({ id, expPool: 10000, freeMana: 9999999 })
    data.updatePlayerCharacterSync(id, character, { stack: 2 })
    await post(p, "expod/inject_exp", { character_id: character, exp: 1000 })
    assert.equal(data.getPlayerSync(id)!.expPool, 9000)
    assert.equal(data.getPlayerCharacterSync(id, character)!.exp, start.exp + 1000)
    await post(p, "character/over_limit", { character_id: character, over_limit_count: 1, use_stack: true, item_id: 0 })
    assert.equal(data.getPlayerCharacterSync(id, character)!.overLimitStep, start.overLimitStep + 1)
    assert.equal(data.getPlayerCharacterSync(id, character)!.stack, 1)
    await post(p, "character/set_illustration_settings", { character_id: character, illustration_settings: [1, 2, 3, 4, 5, 6, 7] })
    assert.deepEqual(data.getPlayerCharacterSync(id, character)!.illustrationSettings, [1, 2, 3, 4, 5, 6])

    const nodes = assets.getCharacterManaNodesSync(character, 1)!
    const node = Number(Object.keys(nodes)[0])
    for (const item of Object.keys(nodes[node]!.items)) {
        if (data.getPlayerItemSync(id, item) === null) data.givePlayerItemSync(id, item, 9999)
        else data.updatePlayerItemSync(id, item, 9999)
    }
    await post(p, "character/learn_mana_node", { character_id: character, mana_node_multiplied_id_list: [node] })
    assert.ok(data.getPlayerCharacterManaNodesSync(id, character).includes(node))
    const manaAfter = data.getPlayerSync(id)!.freeMana
    const repeated = await server.inject({ method: "POST", url: "/latest/api/index.php/character/learn_mana_node", headers: gameHeaders(p.udid),
        payload: encodeGameBody({ viewer_id: p.viewerId, character_id: character, mana_node_multiplied_id_list: [node] }) })
    assert.equal(repeated.statusCode, 400)
    assert.equal(data.getPlayerSync(id)!.freeMana, manaAfter)

    data.updatePlayerCharacterBondTokenSync(id, character, { manaBoardIndex: 1, status: 1 })
    const before = data.getPlayerSync(id)!.bondToken
    await post(p, "character/receive_bond_token", { character_id: character, mana_board_index: 1 })
    assert.equal(data.getPlayerSync(id)!.bondToken, before + 1)
    const retry = await server.inject({ method: "POST", url: "/latest/api/index.php/character/receive_bond_token", headers: gameHeaders(p.udid),
        payload: encodeGameBody({ viewer_id: p.viewerId, character_id: character, mana_board_index: 1 }) })
    assert.equal(retry.statusCode, 400)
    assert.equal(data.getPlayerSync(id)!.bondToken, before + 1)
})

test("EX boost draw and confirmation persist, and equipment protection blocks sale", async () => {
    const p = await createTestPlayer(server)
    const data = await import("../src/data/wdfpData")
    const id = data.getViewerPlayerIdSync(p.viewerId)!
    data.updatePlayerCharacterSync(id, 1, { exp: 99999999 })
    if (data.getPlayerItemSync(id, 10003) === null) data.givePlayerItemSync(id, 10003, 2)
    else data.updatePlayerItemSync(id, 10003, 2)
    const draw = await post(p, "ex_boost/draw", { character_id: 1, cost_item_id: 10003 })
    assert.equal(data.getPlayerItemSync(id, 10003), 1)
    await post(p, "ex_boost/select", { is_confirm: true })
    const saved = data.getPlayerCharacterSync(id, 1)!.exBoost!
    assert.equal(saved.statusId, draw.draw_result.status_id)
    assert.deepEqual(saved.abilityIdList, draw.draw_result.ability_id_list)
    const equipment = 2010002
    ;(await import("../src/lib/equipment")).givePlayerEquipmentSync(id, equipment, 1)
    await post(p, "equipment/set_protection", { protection: true, equipment_ids: [equipment] })
    assert.equal(data.getPlayerEquipmentSync(id, equipment)!.protection, true)
    const sell = await server.inject({ method: "POST", url: "/latest/api/index.php/equipment/sell_equipment", headers: gameHeaders(p.udid),
        payload: encodeGameBody({ viewer_id: p.viewerId, equipment_list: [{ equipment_id: equipment }] }) })
    assert.equal(sell.statusCode, 400)
    assert.equal(data.getPlayerEquipmentSync(id, equipment)!.protection, true)
    await post(p, "equipment/set_protection", { protection: false, equipment_ids: [equipment] })
    assert.equal(data.getPlayerEquipmentSync(id, equipment)!.protection, false)
})

test("character stories and representative EX, boss and mana quests record successful clears", async () => {
    const p = await createTestPlayer(server)
    const data = await import("../src/data/wdfpData")
    const id = data.getViewerPlayerIdSync(p.viewerId)!
    await post(p, "story_quest/finish", { quest_id: 101, category: 3, party_id: 1, api_count: 1 })
    assert.ok(data.getPlayerSingleQuestProgressSync(id, 3, 101)?.finished)
    data.insertPlayerQuestProgressSync(id, 1, { questId: 4011005, finished: true, clearRank: 1 })
    for (const [category, quest] of [[4, 1001001], [2, 1001001], [14, 1001], [13, 1001]] as const) {
        await post(p, "single_battle_quest/start", { quest_id: quest, category, party_id: 1, use_boost_point: false,
            use_boss_boost_point: false, is_auto_start_mode: false, api_count: 2, play_id: `quest-${category}` })
        const finish = await post(p, "single_battle_quest/finish", { ...readCapturedRoute("single_battle_quest_finish").requestBody,
            quest_id: quest, category, is_accomplished: true, api_count: 3, play_id: `quest-${category}` })
        assert.ok(finish, `category ${category} returned a result`)
        const progress = data.getPlayerSingleQuestProgressSync(id, category, quest)
        assert.ok(progress?.finished, `category ${category} clear persisted`)
    }
})

test("encyclopedia index and read_keyword retain the captured response shapes", async () => {
    const p = await createTestPlayer(server)
    const index = await post(p, "encyclopedia/index", { api_count: 1 })
    const capturedIndex = readCapturedRoute("encyclopedia_index").responseBody.data
    assert.equal(index.mail_arrived, capturedIndex.mail_arrived)
    assert.equal(typeof index.encyclopedia_list["500000201"].read, typeof capturedIndex.encyclopedia_list["500000201"].read)
    const capture = readCapturedRoute("encyclopedia_read_keyword")
    const read = await post(p, "encyclopedia/read_keyword", capture.requestBody)
    assert.deepEqual(read.encyclopedia_list, capture.responseBody.data.encyclopedia_list)
})
