import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer, readCapturedRoute } from "./helpers";

// FT-18: the Kakao SDK requests only the original APK sends (agreement/set, log/*, promotion/*, heartbeat) answer as
// the original did for a player with no promotions, whatever the body.

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

async function post(route: string, payload: unknown) {
    const response = await fastify.inject({
        method: "POST",
        url: `/openapi/service/${route}`,
        headers: { "content-type": "application/json;charset=UTF-8" },
        payload: JSON.stringify(payload)
    })
    return { status: response.statusCode, body: response.json() }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("Kakao SDK leftovers", () => {
    test("the captured requests get the original's replies", async () => {
        for (const [route, capture] of [
            ["v3/promotion/checkUrlPromotion", "service_v3_promotion_checkUrlPromotion"],
            ["v3/promotion/getStartingPopups", "service_v3_promotion_getStartingPopups"],
            ["v3/promotion/popup/getList", "service_v3_promotion_popup_getList"],
            ["v3/player/heartbeat", "service_v3_player_heartbeat"]
        ]) {
            const captured = readCapturedRoute(capture)
            const { status, body } = await post(route, captured.requestBody)
            assert.equal(status, 200, route)
            assert.deepEqual(body, captured.responseBody, route)
        }
    })

    test("the SDK's logs get a fresh log id", async () => {
        for (const [route, capture] of [
            ["v3/log/writeRoundLog", "service_v3_log_writeRoundLog"],
            ["v3/log/writeSdkBasicLog", "service_v3_log_writeSdkBasicLog"]
        ]) {
            const { status, body } = await post(route, readCapturedRoute(capture).requestBody)
            assert.equal(status, 200, route)
            assert.deepEqual(Object.keys(body), ["logId"], route)
            assert.match(body.logId, uuid, route)
        }
    })

    test("agreement/set refuses the empty agreement as the original did, and takes a filled one", async () => {
        // the capture: the SDK's empty agreement got this 400, and the SDK carried on
        const captured = readCapturedRoute("service_v3_agreement_set")
        const { status, body } = await post("v3/agreement/set", captured.requestBody)
        assert.equal(status, 400)
        assert.deepEqual(body, captured.responseBody)
        assert.equal((await post("v3/agreement/set", { appId: "561429", playerId: "1" })).status, 400)

        const filled = await post("v3/agreement/set", { appId: "561429", playerId: "1", agreement: { E001: "y" } })
        assert.equal(filled.status, 200)
        assert.deepEqual(filled.body, {})
    })

    test("odd bodies don't break the replies", async () => {
        // getStartingPopups echoes the ids as strings, or empty ones when they're missing
        const popups = await post("v3/promotion/getStartingPopups", { playerId: 984521158255 })
        assert.equal(popups.status, 200)
        assert.deepEqual(popups.body, { promotions: [], appId: "", playerId: "984521158255" })
        assert.equal((await post("v3/promotion/getStartingPopups", { appId: { a: 1 } })).status, 400)
        assert.equal((await post("v3/promotion/popup/getList", {})).status, 200)
        assert.equal((await post("v3/log/writeRoundLog", [])).status, 200)
    })
})
