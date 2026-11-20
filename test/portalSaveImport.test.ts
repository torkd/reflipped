import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

// ACC-15: a player imports their own save on the portal, only when the server's owner allows it (off by default) and
// the reward rules are Managed; the same checks as the admin import, a confirmation, once a day.

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let users: typeof import("../src/data/users")
let data: typeof import("../src/data/wdfpData")
let imports: typeof import("../src/lib/playerSaveImport")
let rewards: typeof import("../src/lib/rewardPolicy")

const PASSWORD = "correct horse battery"

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    users = await import("../src/data/users")
    data = await import("../src/data/wdfpData")
    imports = await import("../src/lib/playerSaveImport")
    rewards = await import("../src/lib/rewardPolicy")
})
after(async () => {
    await cleanup()
})
beforeEach(async () => {
    (await import("../src/lib/portalAuth")).resetLoginFailures()
})

function cookieOf(response: LightMyRequestResponse): string {
    const header = response.headers["set-cookie"]
    return String(Array.isArray(header) ? header[0] : header).split(";")[0]
}

function csrfOf(body: string): string {
    return body.match(/name="csrf" value="([^"]+)"/)![1]
}

async function signedInPlayer(username: string) {
    const registered = await fastify.inject({
        method: "POST", url: "/portal/register",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ username, password: PASSWORD, confirm: PASSWORD }).toString()
    })
    assert.equal(registered.statusCode, 302, registered.body)
    const cookie = cookieOf(registered)
    const player = await createTestPlayer(fastify)
    const accountId = (await data.getSession(String(player.viewerId)))!.accountId
    users.setAccountUserSync(accountId, users.getUserByUsernameSync(username)!.id)
    const playerId = data.getPlayerFromAccountIdSync(accountId)!.id
    const page = (await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })).body
    return { cookie, playerId, csrf: csrfOf(page) }
}

/** A multipart form as a browser sends it: text fields, and the save file under "save" when given. */
function upload(cookie: string, fields: Record<string, string>, file?: string) {
    const boundary = "----reflippedtest"
    const parts = Object.entries(fields).map(([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    if (file !== undefined) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="save"; filename="save.json"\r\nContent-Type: application/json\r\n\r\n${file}\r\n`)
    return fastify.inject({
        method: "POST", url: "/portal/save",
        headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: parts.join("") + `--${boundary}--\r\n`
    })
}

async function saveOf(cookie: string): Promise<string> {
    return (await fastify.inject({ method: "GET", url: "/portal/save", headers: { cookie } })).body
}

test("off by default: no import form, and an import is refused", async () => {
    const { cookie, csrf } = await signedInPlayer("offdefault")
    assert.doesNotMatch((await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })).body, /Import a save/)
    const reply = await upload(cookie, { csrf, confirm: "1" }, await saveOf(cookie))
    assert.equal(reply.headers.location, "/portal?error=save-import-off")
})

test("switched on but with Automatic reward rules, imports stay refused", async () => {
    imports.setPlayerSaveImportSetting(true)
    rewards.setRewardPolicy({ management: "automatic" })
    const { cookie, csrf } = await signedInPlayer("automatic")
    assert.doesNotMatch((await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })).body, /Import a save/)
    assert.equal((await upload(cookie, { csrf, confirm: "1" }, await saveOf(cookie))).headers.location, "/portal?error=save-import-off")
})

test("on and Managed: the form shows, checks the file and the confirmation, imports once a day", async () => {
    imports.setPlayerSaveImportSetting(true)
    rewards.setRewardPolicy({ management: "managed" })
    const { cookie, csrf, playerId } = await signedInPlayer("importer")
    assert.match((await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })).body, /Import a save/)

    const save = JSON.parse(await saveOf(cookie))
    assert.equal(typeof save.user_info.free_vmoney, "number")
    save.user_info.free_vmoney = 777

    assert.equal((await upload(cookie, { csrf: "forged", confirm: "1" }, JSON.stringify(save))).statusCode, 403)
    assert.equal((await upload(cookie, { csrf }, JSON.stringify(save))).headers.location, "/portal?error=save-confirm")
    assert.equal((await upload(cookie, { csrf, confirm: "1" })).headers.location, "/portal?error=save-missing")
    assert.equal((await upload(cookie, { csrf, confirm: "1" }, "{not json")).headers.location, "/portal?error=save-invalid")
    assert.notEqual(data.getPlayerSync(playerId)!.freeVmoney, 777, "nothing changed yet")

    assert.equal((await upload(cookie, { csrf, confirm: "1" }, JSON.stringify(save))).headers.location, "/portal?message=save-imported")
    assert.equal(data.getPlayerSync(playerId)!.freeVmoney, 777)

    // once a day
    assert.match((await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })).body, /You can import again after/)
    assert.equal((await upload(cookie, { csrf, confirm: "1" }, JSON.stringify(save))).headers.location, "/portal?error=save-import-wait")
})

test("a player's own import can't put a record on the rush leaderboard", async () => {
    imports.setPlayerSaveImportSetting(true)
    rewards.setRewardPolicy({ management: "managed" })
    const { cookie, csrf, playerId } = await signedInPlayer("rushforger")
    const save = JSON.parse(await saveOf(cookie))
    save.user_rush_event_list = { 9001: {
        active_rush_battle_folder_id: null, endless_battle_max_round: 999, endless_battle_max_round_time: 1,
        endless_battle_max_round_character_id_1: 1, endless_battle_max_round_character_id_2: null, endless_battle_max_round_character_id_3: null,
        endless_battle_max_round_character_evolution_img_lvl_1: 0, endless_battle_max_round_character_evolution_img_lvl_2: null,
        endless_battle_max_round_character_evolution_img_lvl_3: null
    } }
    assert.equal((await upload(cookie, { csrf, confirm: "1" }, JSON.stringify(save))).headers.location, "/portal?message=save-imported")
    const rush = data.getPlayerRushEventSync(playerId, 9001)
    assert.equal(rush?.endlessBattleMaxRound ?? null, null, "the server's record (none) stays, not the file's 999")
})
