// SEC-5 (device secret at loginDevice) and SEC-8 (openapi session hygiene).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import sqlite3 from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createTestServer, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let types: typeof import("../src/data/types")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    types = await import("../src/data/types")
})

after(async () => {
    await cleanup()
})

interface Device {
    deviceId: string
    whiteKey: string
}

function newDevice(): Device {
    return { deviceId: randomUUID(), whiteKey: randomUUID() }
}

async function loginDevice(device: Device, playerIdHeader?: string, overrides: Record<string, unknown> = {}) {
    const headers: Record<string, string> = { "content-type": "application/json;charset=UTF-8" }
    if (playerIdHeader !== undefined) headers["playerid"] = playerIdHeader
    return fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers,
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId: device.deviceId, idpId: device.deviceId, whiteKey: device.whiteKey, accessToken: "", ...overrides }
    })
}

async function zatLogin(zat: string, playerId: string, whiteKey: string) {
    return fastify.inject({
        method: "POST",
        url: "/openapi/service/v3/zat/login",
        headers: { "content-type": "application/json;charset=UTF-8", "playerid": playerId },
        payload: { ...readCapturedRoute("service_v3_zat_login").requestBody, zat, playerId, whiteKey }
    })
}

/** tool/signup accepts only a live zat, so it shows whether a zat still works. */
async function signup(zat: string) {
    const captured = readCapturedRoute("load").requestBody
    return fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/tool/signup",
        headers: gameHeaders(randomUUID().toUpperCase()),
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
}

test("loginDevice: the device secret finds the account; the secret itself isn't stored or echoed", async () => {
    const device = newDevice()
    const first = await loginDevice(device)
    assert.equal(first.statusCode, 200, first.body)
    const body = first.json()
    // response shape unchanged
    for (const key of ["externalToken", "firstLogin", "player", "zat", "zatExpiryTime", "zrt", "zrtExpiryTime"]) assert.ok(key in body, key)
    assert.notEqual(body.player.idpId, device.whiteKey)

    // same device, no header (first launch after an update) and with its own header: same account
    const again = await loginDevice(device)
    const withHeader = await loginDevice(device, body.player.playerId)
    assert.equal(again.json().player.playerId, body.player.playerId)
    assert.equal(withHeader.json().player.playerId, body.player.playerId)
    assert.equal(withHeader.json().player.idpId, body.player.idpId, "the public idpId is stable")

    const accountId = Number(body.player.playerId)
    assert.ok(data.accountHasDeviceSecretHashSync(accountId, (await import("../src/lib/deviceSecret")).hashDeviceSecret(device.whiteKey)))
})

test("loginDevice: a playerid header can't adopt another device's account", async () => {
    const victim = newDevice()
    const victimId = (await loginDevice(victim)).json().player.playerId

    // an attacker who knows the victim's playerId (it is sent in plain on every request) and deviceId
    const attacker = { deviceId: victim.deviceId, whiteKey: randomUUID() }
    const response = await loginDevice(attacker, victimId)
    assert.equal(response.statusCode, 200, response.body)
    assert.notEqual(response.json().player.playerId, victimId, "an unknown device gets a new account")

    // and the victim still logs in to its own account
    assert.equal((await loginDevice(victim, victimId)).json().player.playerId, victimId)
})

test("loginDevice: whiteKey falls back to deviceId; a missing secret is rejected", async () => {
    // the Kakao SDK sends an empty whiteKey when ad tracking is off
    const device = { deviceId: randomUUID(), whiteKey: "" }
    const first = await loginDevice(device)
    assert.equal(first.statusCode, 200, first.body)
    assert.equal((await loginDevice(device)).json().player.playerId, first.json().player.playerId)

    const none = await loginDevice({ deviceId: "short", whiteKey: "" })
    assert.equal(none.statusCode, 400)
})

test("loginDevice rotates the zat and zrt; viewer sessions stay", async () => {
    const device = newDevice()
    const first = (await loginDevice(device)).json()
    assert.equal((await signup(first.zat)).statusCode, 200)

    const second = (await loginDevice(device, first.player.playerId)).json()
    assert.equal((await signup(first.zat)).statusCode, 400, "the old zat is revoked")
    assert.equal(await data.getSession(first.zrt), null, "the old zrt is revoked")
    assert.equal((await signup(second.zat)).statusCode, 200)

    const accountId = Number(second.player.playerId)
    assert.equal((await data.getAccountSessionsOfType(accountId, types.SessionType.VIEWER)).length, 1, "viewer session kept")
    assert.equal((await data.getAccountSessionsOfType(accountId, types.SessionType.ZAT)).length, 1)
    assert.equal((await data.getAccountSessionsOfType(accountId, types.SessionType.ZRT)).length, 1)
})

test("zat/login: rotates a live zat; a dead zat needs the device secret", async () => {
    const device = newDevice()
    const login = (await loginDevice(device)).json()
    const playerId: string = login.player.playerId

    const rotated = await zatLogin(login.zat, playerId, device.whiteKey)
    assert.equal(rotated.statusCode, 200, rotated.body)
    const newZat: string = rotated.json().zat
    assert.notEqual(newZat, login.zat)
    assert.equal(await data.getSession(login.zat), null, "the presented zat is rotated out")

    // dead zat: the public playerId and deviceId are not enough
    const forged = await zatLogin("dead-zat", playerId, randomUUID())
    assert.equal(forged.statusCode, 400)
    assert.notEqual(await data.getSession(newZat), null, "a failed attempt doesn't revoke the live zat")

    const recovered = await zatLogin("dead-zat", playerId, device.whiteKey)
    assert.equal(recovered.statusCode, 200, recovered.body)
    assert.equal(recovered.json().player.playerId, playerId)
})

test("revokeAccountSessionsSync: zat/zrt only, or everything with viewer", async () => {
    const device = newDevice()
    const login = (await loginDevice(device)).json()
    assert.equal((await signup(login.zat)).statusCode, 200)
    const accountId = Number(login.player.playerId)
    const count = async (type: number) => (await data.getAccountSessionsOfType(accountId, type)).length

    assert.equal(data.revokeAccountSessionsSync(accountId), 2)
    assert.equal(await count(types.SessionType.ZAT), 0)
    assert.equal(await count(types.SessionType.ZRT), 0)
    assert.equal(await count(types.SessionType.VIEWER), 1)

    assert.equal(data.revokeAccountSessionsSync(accountId, { viewer: true }), 1)
    assert.equal(await count(types.SessionType.VIEWER), 0)

    // unlink as ACC-6 will do it: drop the device binding and the sessions; the device then gets a new account
    data.setAccountDeviceSecretHashSync(accountId, null)
    assert.notEqual((await loginDevice(device, login.player.playerId)).json().player.playerId, login.player.playerId)
})

test("deleteExpiredTokenSessionsSync removes expired zat/zrt and keeps viewer sessions", async () => {
    const login = (await loginDevice(newDevice())).json()
    const accountId = Number(login.player.playerId)
    const past = new Date(Date.now() - 1000)
    const expiredZat = await data.insertSession({ accountId, type: types.SessionType.ZAT, expires: past })
    const expiredZrt = await data.insertSession({ accountId, type: types.SessionType.ZRT, expires: past })
    const expiredViewer = await data.insertSessionWithToken({ token: String(100000000 + Math.floor(Math.random() * 899999999)), accountId, type: types.SessionType.VIEWER, expires: past })

    assert.ok(data.deleteExpiredTokenSessionsSync() >= 2)
    const tokens = (await Promise.all([types.SessionType.ZAT, types.SessionType.ZRT, types.SessionType.VIEWER]
        .map(type => data.getAccountSessionsOfType(accountId, type)))).flat().map(session => session.token)
    assert.ok(!tokens.includes(expiredZat.token))
    assert.ok(!tokens.includes(expiredZrt.token))
    assert.ok(tokens.includes(expiredViewer.token), "expired viewer sessions are kept")
    assert.ok(tokens.includes(login.zat) && tokens.includes(login.zrt), "live tokens are kept")
})

test("migration to v4 hashes the old whiteKey idp_id and replaces it with a public id", async () => {
    const { updateBeforeInit } = await import("../src/data/updaters/wdfpData")
    const init = (await import("../src/data/initializers/wdfpData")).default
    const { hashDeviceSecret } = await import("../src/lib/deviceSecret")

    const db = new sqlite3(":memory:")
    db.prepare(`CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, first_login_time DATE NOT NULL, idp_alias TEXT NOT NULL,
        idp_code TEXT NOT NULL, idp_id TEXT NOT NULL, reg_time DATE NOT NULL, last_login_time DATE NOT NULL, status TEXT NOT NULL
    )`).run()
    const whiteKey = randomUUID()
    const deviceId = randomUUID()
    const insert = db.prepare(`INSERT INTO accounts (app_id, first_login_time, idp_alias, idp_code, idp_id, reg_time, last_login_time, status) VALUES ('561429', '', ?, 'zd3', ?, '', '', 'normal')`)
    insert.run(`561429:${randomUUID()}:x`, whiteKey)
    insert.run(`561429:${deviceId}:${deviceId}`, "")
    insert.run("561429:short:short", "")

    updateBeforeInit(db, 3)
    init(db, true)

    const rows = db.prepare(`SELECT idp_id, device_secret_hash FROM accounts ORDER BY id`).all() as { idp_id: string, device_secret_hash: string | null }[]
    assert.equal(rows[0].device_secret_hash, hashDeviceSecret(whiteKey))
    assert.match(rows[0].idp_id, /^\d{10}$/)
    assert.equal(rows[1].device_secret_hash, hashDeviceSecret(deviceId), "an empty whiteKey falls back to the deviceId")
    assert.equal(rows[2].device_secret_hash, null, "with neither, the account matches nothing")
    db.close()
})
