import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

test("guest login → signup → load", async (t) => {
    const deviceId = randomUUID()
    const whiteKey = randomUUID()
    const udid = randomUUID().toUpperCase()

    let zat = ""
    let viewerId = 0

    await t.test("infodesk /v2/app answers", async () => {
        const response = await fastify.inject({ method: "GET", url: "/infodesk/v2/app" })
        assert.equal(response.statusCode, 200)
        // the SDK verifies this body against the `sig` header and kills the app on mismatch
        assert.match(String(response.headers["sig"]), /^0;/)
        assert.equal(typeof response.json().content.appOption.gameServerAddr, "string")
    })

    await t.test("openapi loginDevice issues tokens", async () => {
        const captured = readCapturedRoute("service_v4_auth_loginDevice")
        const response = await fastify.inject({
            method: "POST",
            url: "/openapi/service/v4/auth/loginDevice",
            headers: { "content-type": "application/json;charset=UTF-8" },
            payload: { ...captured.requestBody, deviceId, idpId: deviceId, whiteKey, accessToken: "" }
        })
        assert.equal(response.statusCode, 200, response.body)

        const body = response.json()
        assert.equal(typeof body.zat, "string")
        assert.equal(typeof body.zrt, "string")
        assert.ok(body.zatExpiryTime > Date.now())
        // the idpId is public; the whiteKey is the device secret and is never echoed (SEC-5)
        assert.match(body.player.idpId, /^\d{10}$/)
        assert.notEqual(body.player.idpId, whiteKey)
        zat = body.zat
    })

    await t.test("loginDevice is idempotent for the same device", async () => {
        const captured = readCapturedRoute("service_v4_auth_loginDevice")
        const payload = { ...captured.requestBody, deviceId, idpId: deviceId, whiteKey, accessToken: "" }
        const first = await fastify.inject({ method: "POST", url: "/openapi/service/v4/auth/loginDevice", payload })
        const second = await fastify.inject({ method: "POST", url: "/openapi/service/v4/auth/loginDevice", payload })
        assert.equal(first.json().player.playerId, second.json().player.playerId)
        zat = second.json().zat
    })

    await t.test("tool/signup maps the zat to a viewer id", async () => {
        const captured = readCapturedRoute("load").requestBody
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/tool/signup`,
            headers: gameHeaders(udid),
            payload: encodeGameBody({
                app_secret: captured.app_secret,
                access_token: zat,
                storage_directory_path: captured.storage_directory_path,
                app_admin: captured.app_admin,
                kakao_pid: captured.kakao_pid,
                device_id: captured.device_id,
                idp_code: "zd3"
            })
        })
        assert.equal(response.statusCode, 200, response.body)

        const body = decodeGameBody(response.body)
        assert.equal(body.data_headers.result_code, 1)
        assert.equal(body.data_headers.udid, udid)
        viewerId = body.data_headers.viewer_id
        assert.ok(Number.isInteger(viewerId) && viewerId > 0, `bad viewer_id ${viewerId}`)
    })

    await t.test("load returns the new player's data", async () => {
        const captured = readCapturedRoute("load").requestBody
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/load`,
            headers: gameHeaders(udid),
            payload: encodeGameBody({ ...captured, access_token: zat, viewer_id: viewerId })
        })
        assert.equal(response.statusCode, 200, response.body)

        const body = decodeGameBody(response.body)
        assert.equal(body.data_headers.result_code, 1)
        assert.equal(body.data_headers.viewer_id, viewerId)

        // the fresh save should carry the same top-level sections as the captured response,
        // apart from known gaps
        const knownMissing = ["premium_bonus_index_list", "premium_bonus_mailed_item_list"]
        const expectedKeys = Object.keys(readCapturedRoute("load").responseBody.data)
        const missing = expectedKeys.filter(key => !(key in body.data) && !knownMissing.includes(key))
        assert.deepEqual(missing, [], `load response is missing sections: ${missing.join(", ")}`)
        assert.equal(typeof body.data.user_info.stamina, "number")
    })

    await t.test("load rejects an unknown viewer id", async () => {
        const captured = readCapturedRoute("load").requestBody
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/load`,
            headers: gameHeaders(udid),
            payload: encodeGameBody({ ...captured, access_token: zat, viewer_id: 1 })
        })
        assert.equal(response.statusCode, 400)
    })

    await t.test("load rejects a zat the server never issued", async () => {
        const captured = readCapturedRoute("load").requestBody
        const response = await fastify.inject({
            method: "POST",
            url: `${apiPrefix}/load`,
            headers: gameHeaders(udid),
            payload: encodeGameBody({ ...captured, access_token: "not-a-zat", viewer_id: viewerId })
        })
        assert.equal(response.statusCode, 400)
    })
})
