import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, encodeGameBody, gameHeaders, readCapturedRoute, signedGameHeaders, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let logOnly: FastifyInstance
let cleanup: () => Promise<void>
let player: TestPlayer

before(async () => {
    ({ fastify, cleanup } = await createTestServer({ paramCheck: "enforce" }))
    player = await createTestPlayer(fastify)

    // a second game server on the same database, in log-only mode
    const { buildServer } = await import("../src/app")
    logOnly = buildServer({ paramCheck: "log" })
    await logOnly.ready()
})

after(async () => {
    await logOnly.close()
    await cleanup()
})

/** An authenticated route with no side effects worth checking. */
const route = "option/update"
const path = `${apiPrefix}/${route}`

function optionsBody(viewerId = player.viewerId) {
    return encodeGameBody({ api_count: 1, option_params: {}, viewer_id: viewerId })
}

function send(headers: Record<string, string>, payload = optionsBody(), server = fastify) {
    return server.inject({ method: "POST", url: path, headers, payload })
}

test("PARAM matches the captured client request", async () => {
    // docs/routes/asset_version_info.md, body re-encoded byte for byte as the client sent it (Content-Length 52)
    const { computeRequestParam } = await import("../src/lib/gameAuth")
    const captured = readCapturedRoute("asset_version_info").requestHeaders
    const body = "gq1hc3NldF92ZXJzaW9upzIuMS4xMjGpdmlld2VyX2lkziXekZI="
    assert.equal(computeRequestParam(captured["udid"], captured["game-app-id"], `${apiPrefix}/asset/version_info`, body), captured["param"])
})

test("a request signed with the signup UDID is accepted", async () => {
    const payload = optionsBody()
    const response = await send(signedGameHeaders(player.udid, player.viewerId, path, payload), payload)
    assert.equal(response.statusCode, 200, response.body)
})

test("an unsigned request is rejected", async () => {
    const response = await send(gameHeaders(player.udid))
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().message, "Invalid request signature.")
})

test("a wrong UDID, GAME-APP-ID, path or body is rejected", async () => {
    const payload = optionsBody()
    const cases: Record<string, Record<string, string>> = {
        "other UDID": signedGameHeaders("00000000-0000-0000-0000-000000000000", player.viewerId, path, payload),
        "other GAME-APP-ID": { ...signedGameHeaders(player.udid, player.viewerId, path, payload), "game-app-id": "123456789" },
        "other path": signedGameHeaders(player.udid, player.viewerId, `${apiPrefix}/load`, payload),
        "other body": signedGameHeaders(player.udid, player.viewerId, path, encodeGameBody({ viewer_id: player.viewerId }))
    }
    for (const [name, headers] of Object.entries(cases)) {
        const response = await send(headers, payload)
        assert.equal(response.statusCode, 403, name)
    }
})

test("log-only mode lets unsigned requests through", async () => {
    const response = await send(gameHeaders(player.udid), optionsBody(), logOnly)
    assert.equal(response.statusCode, 200, response.body)
})

test("/load binds the UDID of a viewer session that has none", async () => {
    const { updateSessionUdidSync } = await import("../src/data/wdfpData")
    updateSessionUdidSync(String(player.viewerId), "")

    const payload = optionsBody()
    const signed = signedGameHeaders(player.udid, player.viewerId, path, payload)
    assert.equal((await send(signed, payload)).statusCode, 403)

    const load = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/load`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: player.viewerId })
    })
    assert.equal(load.statusCode, 200, load.body)

    assert.equal((await send(signed, payload)).statusCode, 200)
})

test("PARAM_CHECK defaults to enforce, and an unknown value doesn't weaken it", async () => {
    // imported late: gameAuth pulls in the data layer, which opens the test database (see createTestServer)
    const { paramCheckModeFromEnv } = await import("../src/lib/gameAuth")
    assert.equal(paramCheckModeFromEnv(undefined), "enforce")
    assert.equal(paramCheckModeFromEnv(""), "enforce")
    assert.equal(paramCheckModeFromEnv("lgo"), "enforce")
    assert.equal(paramCheckModeFromEnv("log"), "log")
    assert.equal(paramCheckModeFromEnv("off"), "off")
})

test("co-op start and finish pass their signed requests on to the single-player routes", async () => {
    // multi_battle_quest/{start,finish,abort} call single_battle_quest/* internally, which must be signed too
    const request = async (route: string, body: Record<string, unknown>) => {
        const payload = encodeGameBody({ ...body, viewer_id: player.viewerId })
        const url = `${apiPrefix}/${route}`
        return fastify.inject({ method: "POST", url, headers: signedGameHeaders(player.udid, player.viewerId, url, payload), payload })
    }
    const start = await request("multi_battle_quest/start", { quest_id: 1001001, category: 2, party_id: 11, room_number: "000000", play_id: "SIGNED", use_boost_point: false, use_boss_boost_point: false, is_auto_start_mode: true, mate_player_ids: [] })
    assert.equal(start.statusCode, 200, start.body)
    const finish = await request("multi_battle_quest/finish", { ...readCapturedRoute("multi_battle_quest_finish").requestBody, quest_id: 1001001, category: 2 })
    assert.equal(finish.statusCode, 200, finish.body)
})
