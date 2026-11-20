import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

// ACC-8: the portal's player features: profile and save download, the mods list, and time travel (the player's own
// clock), which a user only gets once an admin turns it on for them or PORTAL_TIME_TRAVEL=all.

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let users: typeof import("../src/data/users")
let data: typeof import("../src/data/wdfpData")
let clock: typeof import("../src/lib/playerClock")

const PASSWORD = "correct horse battery"

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    users = await import("../src/data/users")
    data = await import("../src/data/wdfpData")
    clock = await import("../src/lib/playerClock")
})
after(async () => {
    delete process.env.PORTAL_TIME_TRAVEL
    await cleanup()
})
beforeEach(async () => {
    (await import("../src/lib/portalAuth")).resetLoginFailures()
    delete process.env.PORTAL_TIME_TRAVEL
})

function cookieOf(response: LightMyRequestResponse): string {
    const header = response.headers["set-cookie"]
    return String(Array.isArray(header) ? header[0] : header).split(";")[0]
}

function form(instance: FastifyInstance, url: string, body: Record<string, string>, cookie?: string) {
    return instance.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
        payload: new URLSearchParams(body).toString()
    })
}

function page(cookie: string) {
    return fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })
}

function csrfOf(body: string): string {
    return body.match(/name="csrf" value="([^"]+)"/)![1]
}

/** A portal user; with `save`, a guest player of the game becomes their save. */
async function user(username: string, save: boolean) {
    const registered = await form(fastify, "/portal/register", { username, password: PASSWORD, confirm: PASSWORD })
    assert.equal(registered.statusCode, 302, registered.body)
    const cookie = cookieOf(registered)
    const id = users.getUserByUsernameSync(username)!.id
    let playerId: number | null = null
    let accountId: number | null = null
    if (save) {
        const player = await createTestPlayer(fastify)
        accountId = (await data.getSession(String(player.viewerId)))!.accountId
        users.setAccountUserSync(accountId, id)
        playerId = data.getPlayerFromAccountIdSync(accountId)!.id
    }
    return { cookie, id, playerId, accountId }
}

test("without a save, the page has no player cards, and the save download says so", async () => {
    const { cookie } = await user("nosave", false)
    const body = (await page(cookie)).body
    assert.doesNotMatch(body, /Your player/)
    assert.doesNotMatch(body, /<h2 class="card-title">Time travel<\/h2>/)
    assert.match(body, /Mods on this server/)
    assert.equal((await fastify.inject({ method: "GET", url: "/portal/save", headers: { cookie } })).headers.location, "/portal?error=no-player")
})

test("the profile shows the player, and the save downloads as the admin site exports it", async () => {
    const { cookie, playerId, accountId } = await user("saver", true)
    const body = (await page(cookie)).body
    assert.match(body, /Your player/)
    assert.match(body, new RegExp(`<span class="stat-value text-base">${accountId}</span>`))
    assert.match(body, /href="\/portal\/save"/)

    const download = await fastify.inject({ method: "GET", url: "/portal/save", headers: { cookie } })
    assert.equal(download.statusCode, 200)
    assert.equal(download.headers["content-disposition"], `attachment; filename="reflipped-save-${playerId}.json"`)
    assert.equal(download.headers["cache-control"], "no-store")
    const exported = await admin.inject({ method: "GET", url: `/api/player/save?id=${playerId}` })
    assert.deepEqual(download.json(), exported.json())

    assert.equal((await fastify.inject({ method: "GET", url: "/portal/save" })).headers.location, "/portal/login")
})

test("time travel is off until an admin turns it on, and off again when they turn it off", async () => {
    const { cookie, id, playerId } = await user("traveller", true)
    let body = (await page(cookie)).body
    assert.doesNotMatch(body, /<h2 class="card-title">Time travel<\/h2>/)
    const csrf = csrfOf(body)
    assert.equal((await form(fastify, "/portal/clock", { csrf, date: "2025-01-10" }, cookie)).headers.location, "/portal?error=time-travel-off")
    assert.equal((await form(fastify, "/portal/clock/reset", { csrf }, cookie)).headers.location, "/portal?error=time-travel-off")
    assert.equal(clock.getPlayerClockSync(playerId!)!.offsetDays, 0)

    assert.match((await admin.inject({ method: "GET", url: `/user/${id}` })).body, /Turn on time travel/)
    assert.equal((await form(admin, `/api/user/time-travel?id=${id}`, { enabled: "1" })).headers.location, `/user/${id}?message=time-travel-on`)
    assert.equal(users.getUserSync(id)!.timeTravel, true)

    body = (await page(cookie)).body
    assert.match(body, /<h2 class="card-title">Time travel<\/h2>/)
    assert.match(body, /value="2025-01-03"/, "the date picker starts on the game day")
    assert.equal((await form(fastify, "/portal/clock", { csrf, date: "2025-01-10" }, cookie)).headers.location, "/portal?message=clock-set")
    assert.equal(clock.getPlayerClockSync(playerId!)!.offsetDays, 7)
    assert.match((await page(cookie)).body, /7 days ahead/)

    // refusals leave the clock where it is
    assert.equal((await form(fastify, "/portal/clock", { csrf, date: "not-a-day" }, cookie)).headers.location, "/portal?error=clock-invalid")
    assert.equal((await form(fastify, "/portal/clock", { csrf, date: "2031-06-01" }, cookie)).headers.location, "/portal?error=clock-no-portal")
    assert.equal((await form(fastify, "/portal/clock", { csrf: "forged", date: "2025-01-12" }, cookie)).statusCode, 403)
    assert.equal(clock.getPlayerClockSync(playerId!)!.offsetDays, 7)

    assert.equal((await form(fastify, "/portal/clock/reset", { csrf }, cookie)).headers.location, "/portal?message=clock-reset")
    assert.equal(clock.getPlayerClockSync(playerId!)!.offsetDays, 0)

    // turned off: refused again, and a clock the player moved stays (the admin resets it on the player page)
    await form(fastify, "/portal/clock", { csrf, date: "2025-01-05" }, cookie)
    assert.equal((await form(admin, `/api/user/time-travel?id=${id}`, { enabled: "0" })).headers.location, `/user/${id}?message=time-travel-off`)
    assert.equal((await form(fastify, "/portal/clock", { csrf, date: "2025-01-10" }, cookie)).headers.location, "/portal?error=time-travel-off")
    assert.equal(clock.getPlayerClockSync(playerId!)!.offsetDays, 2)
    assert.equal((await form(admin, `/api/user/time-travel?id=${id}`, { enabled: "yes" })).statusCode, 400)
})

test("PORTAL_TIME_TRAVEL=all opens time travel to every user, and the admin switch shows it", async () => {
    const { cookie, id, playerId } = await user("everyone", true)
    process.env.PORTAL_TIME_TRAVEL = "all"
    const body = (await page(cookie)).body
    assert.match(body, /<h2 class="card-title">Time travel<\/h2>/)
    assert.equal((await form(fastify, "/portal/clock", { csrf: csrfOf(body), date: "2025-01-04" }, cookie)).headers.location, "/portal?message=clock-set")
    assert.equal(clock.getPlayerClockSync(playerId!)!.offsetDays, 1)
    const adminPage = (await admin.inject({ method: "GET", url: `/user/${id}` })).body
    assert.match(adminPage, /PORTAL_TIME_TRAVEL=all/)
    assert.match(adminPage, /class="btn-outline" disabled>Turn on time travel/)
})

test("the mods card lists the server's mods by file name", async () => {
    const { cookie } = await user("modder", false)
    assert.match((await page(cookie)).body, /This server has no mods/)
    const dir = path.join(process.env.CDN_DIR!, "mods")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "b-<sounds>.zip"), "b")
    writeFileSync(path.join(dir, "a-pictures.zip"), "a")
    const layers = await import("../src/lib/assetLayers")
    layers.resetAssetLayers()
    try {
        const body = (await page(cookie)).body
        assert.match(body, /<li>a-pictures\.zip<\/li>\s*<li>b-&lt;sounds&gt;\.zip<\/li>/)
    } finally {
        layers.resetAssetLayers()
    }
})
