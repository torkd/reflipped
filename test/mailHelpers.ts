// Shared setup for the mail tests (gift box, mail to every player, save mail, history, reward points): one test server
// per test file, a few players and the admin and game requests they make. `setupMailTests()` registers the hooks.
import { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

const apiPrefix = "/latest/api/index.php"
export const itemId = 14018
export const degreeId = 2010

export let fastify: FastifyInstance
export let admin: FastifyInstance
export let data: typeof import("../src/data/wdfpData")
let cleanup: () => Promise<void>

/** Starts the test server before the file's tests and stops it after; the server clock is reset after each test. */
export function setupMailTests() {
    before(async () => {
        ({ fastify, admin, cleanup } = await createTestServer())
        // the data layer opens the test database, so import it only after createTestServer()
        data = await import("../src/data/wdfpData")
    })
    afterEach(async () => {
        const { setServerTime } = await import("../src/utils")
        setServerTime(null)
    })
    after(async () => {
        await cleanup()
    })
}

export type Player = TestPlayer & { playerId: number }

export async function newPlayer(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    const playerId = (await data.getAccountPlayers(session!.accountId))[0]
    const result = { ...player, playerId }
    await post(result, "load", { ...readCapturedRoute("load").requestBody, access_token: player.zat })
    // These mail-only fixtures start after login delivery; calendar gifts are covered by loginBonus tests.
    // Remove that fixture gift without changing balances or adding history to the mailbox under test.
    const database = (await import("../src/data")).default(0)
    database.prepare("DELETE FROM players_mail WHERE player_id = ? AND reason_id = 55").run(playerId)
    await post(result, "bonus/shown", {})
    return result
}

export async function request(player: TestPlayer, route: string, body: Record<string, unknown>) {
    return fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: gameHeaders(player.udid),
        payload: encodeGameBody({ api_count: 1, ...body, viewer_id: player.viewerId })
    })
}

export async function post(player: TestPlayer, route: string, body: Record<string, unknown>) {
    const response = await request(player, route, body)
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

export const gift = { subject: "Gift", description: "For everyone" }

export function sendMail(player: Player, mail: Record<string, unknown>) {
    return admin.inject({ method: "POST", url: `/api/player/mail?id=${player.playerId}`, payload: { ...gift, ...mail } })
}

export function sendToAll(mail: Record<string, unknown>) {
    return admin.inject({ method: "POST", url: "/api/player/mail/all", payload: { ...gift, ...mail } })
}

export async function pendingMail(player: Player) {
    return (await post(player, "mail/index", { current_page: 1, app_secret: "", app_admin: "" })).mail as any[]
}

/** Fills a player's gift box to the limit straight in the database (1000 admin sends would be slow). */
export async function fillGiftBox(player: Player) {
    const { mailLimits } = await import("../src/lib/limits")
    const { getServerDate } = await import("../src/utils")
    const missing = mailLimits.pendingMails - data.getPlayerReceivableMailCountSync(player.playerId, getServerDate())
    data.runInTransactionSync(() => {
        for (let i = 0; i < missing; i++) data.insertPlayerMailSync(player.playerId, {
            type: 8, typeId: null, number: 1, reasonId: 0, subject: "Filler", description: "", createTime: getServerDate(), receiveTime: null, rewardLimitTime: null
        })
    })
}

export function uploadSave(playerId: number, content: string) {
    const boundary = "----save"
    return admin.inject({
        method: "POST",
        url: `/api/player/save?id=${playerId}`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="save-data"; filename="save.json"\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--\r\n`
    })
}

export async function exportSave(player: Player): Promise<any> {
    const response = await admin.inject({ method: "GET", url: `/api/player/save?id=${player.playerId}` })
    assert.equal(response.statusCode, 200)
    return response.json()
}

export function developerMode(player: Player, state: "on" | "off") {
    return admin.inject({ method: "POST", url: `/api/player/developer-mode?id=${player.playerId}&state=${state}`, headers: { "content-type": "multipart/form-data; boundary=----form" }, payload: "------form--\r\n" })
}
