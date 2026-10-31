import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let player: TestPlayer

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    player = await createTestPlayer(fastify)
})

after(async () => {
    await cleanup()
})

function post(route: string, body: Record<string, unknown>) {
    return fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody(body)
    })
}

/** An authenticated route with no side effects worth checking. */
function updateOptions(viewerId: unknown) {
    return post("option/update", { api_count: 1, option_params: {}, viewer_id: viewerId })
}

function load(viewerId: number, zat = player.zat) {
    return post("load", { ...readCapturedRoute("load").requestBody, access_token: zat, viewer_id: viewerId })
}

/** Sets the expiry of the test player's viewer session directly in the database. */
async function setViewerExpiry(expires: Date) {
    const { updateSessionExpirySync } = await import("../src/data/wdfpData")
    updateSessionExpirySync(String(player.viewerId), expires)
}

async function getViewerExpiry(): Promise<Date | undefined> {
    const { getAccountSessionsOfType, getSession } = await import("../src/data/wdfpData")
    const { SessionType } = await import("../src/data/types")
    const zatSession = await getSession(player.zat)
    const sessions = await getAccountSessionsOfType(zatSession!.accountId, SessionType.VIEWER)
    return sessions.find(session => session.token === String(player.viewerId))?.expires
}

test("game routes accept a live viewer session", async () => {
    const response = await updateOptions(player.viewerId)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(decodeGameBody(response.body).data_headers.viewer_id, player.viewerId)
})

test("game routes reject a missing or malformed viewer id", async () => {
    for (const viewerId of [undefined, "abc", 0, -5, 1.5]) {
        const response = await updateOptions(viewerId)
        assert.equal(response.statusCode, 400, `viewer_id ${viewerId}`)
    }
})

test("game routes reject an unknown viewer id", async () => {
    const response = await updateOptions(1)
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().message, "Invalid viewer id.")
})

test("a non-viewer session can't be used as a viewer id", async () => {
    const { insertSessionWithToken, getSession } = await import("../src/data/wdfpData")
    const { SessionType } = await import("../src/data/types")
    const accountId = (await getSession(player.zat))!.accountId
    await insertSessionWithToken({ token: "987654321", accountId, expires: new Date(Date.now() + 60_000), type: SessionType.ZAT })

    const response = await updateOptions(987654321)
    assert.equal(response.statusCode, 400)
})

test("routes that run before a viewer exists don't require one", async () => {
    const response = await post("tool/get_header_response", { viewer_id: 0 })
    assert.equal(response.statusCode, 200, response.body)
})

test("an expired viewer session is rejected, kept, and renewed by /load", async () => {
    await setViewerExpiry(new Date(Date.now() - 1000))

    const rejected = await updateOptions(player.viewerId)
    assert.equal(rejected.statusCode, 400)
    assert.ok(await getViewerExpiry(), "the expired viewer session is kept so the client's viewer id stays valid")

    const loaded = await load(player.viewerId)
    assert.equal(loaded.statusCode, 200, loaded.body)
    assert.ok((await getViewerExpiry())!.getTime() > Date.now(), "load renews the viewer session")

    const accepted = await updateOptions(player.viewerId)
    assert.equal(accepted.statusCode, 200, accepted.body)
})

test("game requests slide the viewer session's expiry forward", async () => {
    const soon = new Date(Date.now() + 60_000)
    await setViewerExpiry(soon)

    const response = await updateOptions(player.viewerId)
    assert.equal(response.statusCode, 200, response.body)
    assert.ok((await getViewerExpiry())!.getTime() > soon.getTime() + 24 * 60 * 60 * 1000)
})

test("/load rejects a viewer id that belongs to another account", async () => {
    const other = await createTestPlayer(fastify)
    const response = await load(other.viewerId)
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().message, "Invalid viewer ID provided.")
})
