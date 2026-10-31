import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { createTestServer, encodeGameBody, readCapturedRoute } from "./helpers";

// Mail can't carry more than the game lets a player own: past a limit (or past 2^31) the client crashes on its
// main screen. Limits: src/lib/limits.ts.

const apiPrefix = "/latest/api/index.php"

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

async function signUpPlayer(): Promise<number> {
    const deviceId = randomUUID()
    const login = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey: randomUUID(), accessToken: "" }
    })
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/tool/signup`,
        headers: { "content-type": "application/x-www-form-urlencoded", "udid": randomUUID().toUpperCase() },
        payload: encodeGameBody({
            app_secret: captured.app_secret, access_token: login.json().zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
        })
    })
    assert.equal(signup.statusCode, 200, signup.body)
    const { getAllPlayersSync } = await import("../src/data/wdfpData")
    const players = getAllPlayersSync()
    return players[players.length - 1].id
}

const send = (playerId: number, mail: Record<string, unknown>) => admin.inject({
    method: "POST",
    url: `/api/player/mail?id=${playerId}`,
    payload: { subject: "Test", description: "Test", ...mail }
})

test("mail can't carry more than the game allows, or things the game doesn't have", async (t) => {
    const playerId = await signUpPlayer()
    const refused = async (mail: Record<string, unknown>, why: string) =>
        assert.equal((await send(playerId, mail)).statusCode, 400, why)

    await t.test("amounts", async () => {
        await refused({ type: "CHARACTER", typeId: 100001, number: 100 }, "99 copies of a unit is the most")
        await refused({ type: "PAID_VMONEY", number: 1_000_000 }, "beads cap at 999,999")
        await refused({ type: "FREE_MANA", number: 1_000_000_000 }, "mana caps at 999,999,999")
        await refused({ type: "BOOST_POINT", number: 21 }, "boost points cap at 20")
        await refused({ type: "BOSS_BOOST_POINT", number: 31 }, "boss boost points cap at 30")
        await refused({ type: "STAR_CRUMB", number: 2 ** 31 }, "past 32-bit ints")
        await refused({ type: "STAR_CRUMB", number: 1.5 }, "whole numbers only")
        await refused({ type: "STAR_CRUMB", number: -1 }, "positive only")
        await refused({ type: "ITEM", typeId: 49200, number: 1000 }, "the Log Key holds 999")
        assert.equal((await send(playerId, { type: "ITEM", typeId: 49200, number: 999 })).statusCode, 200, "up to the item's own limit is fine")
        assert.equal((await send(playerId, { type: "PAID_VMONEY", number: 999_999 })).statusCode, 200)
    })

    await t.test("ids the game doesn't have", async () => {
        await refused({ type: "ITEM", typeId: 123456789, number: 1 }, "no such item")
        await refused({ type: "EQUIPMENT", typeId: 123456789, number: 1 }, "no such armament")
        await refused({ type: "CHARACTER", typeId: 999999, number: 1 }, "not a playable unit")
    })

    await t.test("text", async () => {
        await refused({ type: "STAR_CRUMB", number: 1, subject: "x".repeat(101) }, "subject too long")
        await refused({ type: "STAR_CRUMB", number: 1, subject: "   " }, "subject empty")
        await refused({ type: "STAR_CRUMB", number: 1, description: "x".repeat(501) }, "description too long")
        await refused({ type: "STAR_CRUMB", number: 1, subject: "bad\u0000text" }, "control characters")
        assert.equal((await send(playerId, { type: "STAR_CRUMB", number: 1, description: "two\nlines" })).statusCode, 200, "a line break is fine")
    })
})

test("mail that would take a player past a limit stays in the box", async () => {
    const data = await import("../src/data/wdfpData")
    const { sendPlayerMailSync, receivePlayerMailsSync } = await import("../src/lib/mail")
    const { MailType } = await import("../src/data/types")
    const playerId = await signUpPlayer()

    data.givePlayerItemSync(playerId, 49200, 990)                                  // the Log Key holds 999
    const tooMuch = sendPlayerMailSync(playerId, { type: MailType.ITEM, typeId: 49200, number: 20, subject: "a", description: "b" })
    const fits = sendPlayerMailSync(playerId, { type: MailType.ITEM, typeId: 49200, number: 9, subject: "a", description: "b" })

    const result = receivePlayerMailsSync(playerId, [tooMuch, fits])!
    assert.deepEqual(result.receivedMailIds, [fits])
    assert.equal(result.maxOveredMailCount, 1)
    assert.equal(data.getPlayerItemSync(playerId, 49200), 999)
    assert.equal(data.getPlayerMailSync(playerId, tooMuch)!.receiveTime, null, "still in the box")
})

test("what a save holds past the limits is clamped on the way to the client", async () => {
    const data = await import("../src/data/wdfpData")
    const { getClientSerializedData } = await import("../src/data/utils")
    const playerId = await signUpPlayer()

    data.updatePlayerSync({ id: playerId, vmoney: 600_000, freeVmoney: 900_000, starCrumb: 5_000_000, freeMana: 3_000_000_000, boostPoint: 99, bossBoostPoint: 99 })
    data.givePlayerItemSync(playerId, 49200, 4_000_000_000)
    const sent = getClientSerializedData(playerId, {})!

    const info = sent.user_info as unknown as Record<string, number>
    assert.ok(info.vmoney + info.free_vmoney <= 999_999, "paid and free vmoney share one limit")
    assert.equal(info.star_crumb, 999_999)
    assert.equal(info.free_mana, 999_999_999)
    assert.equal(info.boost_point, 20)
    assert.equal(info.boss_boost_point, 30)
    assert.equal((sent.item_list as Record<string, number>)["49200"], 999)
})
