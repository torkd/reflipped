import { after, afterEach, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

// FT-5: per-player clocks. A player's clock is the server clock moved by whole game days (src/lib/playerClock.ts);
// every game request of that player runs on it. The server clock is frozen here (test helper), at the default
// 2025-01-03T12:00:00 UTC, so replies' `servertime` can be compared exactly.

const apiPrefix = "/latest/api/index.php"
const SERVER_NOW = Date.parse("2025-01-03T12:00:00Z")

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    // These fixtures explicitly cover the retained legacy clock, not projected event schedules.
    process.env.EVENT_SCHEDULING = "off";
    ({ fastify, admin, cleanup } = await createTestServer())
})

afterEach(async () => {
    const { setServerTime } = await import("../src/utils")
    setServerTime(null)
})

after(async () => {
    await cleanup()
})

type Player = TestPlayer & { playerId: number, accountId: number }

async function signUp(): Promise<Player> {
    const player = await createTestPlayer(fastify)
    const data = await import("../src/data/wdfpData")
    const players = data.getAllPlayersSync()
    const playerId = players[players.length - 1].id
    return { ...player, playerId, accountId: data.getAccountFromPlayerIdSync(playerId)!.id }
}

async function setClock(player: Player, iso: string | null) {
    const { setPlayerClockSync } = await import("../src/lib/playerClock")
    return setPlayerClockSync(player.playerId, iso === null ? null : new Date(iso))
}

/** A game request's reply (unsigned: the test server only logs PARAM failures). */
async function gameRequest(route: string, body: Record<string, unknown>, udid?: string): Promise<any> {
    const response = await fastify.inject({
        method: "POST",
        url: `${apiPrefix}/${route}`,
        headers: udid ? gameHeaders(udid) : { "content-type": "application/x-www-form-urlencoded" },
        payload: encodeGameBody(body)
    })
    assert.equal(response.statusCode, 200, `${route}: ${response.body}`)
    return decodeGameBody(response.body)
}

/** The `servertime` of a reply, as an ISO date. */
const replyTime = (reply: any) => new Date(reply.data_headers.servertime * 1000).toISOString()

const missionProgress = (player: Player) => gameRequest("mission/get_mission_progress", { ...readCapturedRoute("mission_get_mission_progress").requestBody, viewer_id: player.viewerId })
const attentionCheck = (player: Player) => gameRequest("attention/check", { ...readCapturedRoute("attention_check").requestBody, viewer_id: player.viewerId })
const load = (player: Player) => gameRequest("load", { ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: player.viewerId }, player.udid)

/** An admin form post; returns where it redirects. */
async function post(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number, location: string }> {
    const response = await admin.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        payload: new URLSearchParams(form).toString()
    })
    return { status: response.statusCode, location: String(response.headers.location) }
}

test("a player's clock is the server clock moved by whole game days", async () => {
    const player = await signUp()
    const { getPlayerClockSync } = await import("../src/lib/playerClock")
    assert.deepEqual(getPlayerClockSync(player.playerId), { offsetDays: 0, date: new Date(SERVER_NOW) })

    // game day 2024-06-10, at the server clock's time of day
    const clock = await setClock(player, "2024-06-10T03:00:00Z")
    assert.deepEqual(clock, { offsetDays: -207, date: new Date("2024-06-10T12:00:00Z") })
    assert.deepEqual(getPlayerClockSync(player.playerId), clock)
    // 21:00 UTC is already the next game day (05:00 in Japan is 20:00 UTC)
    assert.equal((await setClock(player, "2024-06-10T21:00:00Z"))?.date.toISOString(), "2024-06-11T12:00:00.000Z")
    // ahead of the server clock works the same way
    assert.equal((await setClock(player, "2025-01-20T00:00:00Z"))?.offsetDays, 17)
    assert.equal((await setClock(player, null))?.offsetDays, 0)

    const { setPlayerClockSync } = await import("../src/lib/playerClock")
    assert.equal(setPlayerClockSync(999999, new Date()), null, "no such player")
    assert.throws(() => setPlayerClockSync(player.playerId, new Date("1900-01-01T00:00:00Z")), RangeError)
    assert.equal(getPlayerClockSync(player.playerId)?.offsetDays, 0, "nothing stored after the refusal")
})

test("game requests of a player run on the player's clock, others' on the server clock", async () => {
    const traveller = await signUp()
    const stayer = await signUp()
    await setClock(traveller, "2024-06-10T00:00:00Z")
    assert.equal(replyTime(await missionProgress(traveller)), "2024-06-10T12:00:00.000Z")
    assert.equal(replyTime(await attentionCheck(traveller)), "2024-06-10T12:00:00.000Z")
    assert.equal(replyTime(await missionProgress(stayer)), "2025-01-03T12:00:00.000Z")

    // outside any request: the server clock
    const { getServerDate } = await import("../src/utils")
    assert.equal(getServerDate().toISOString(), "2025-01-03T12:00:00.000Z")
    const { runOnPlayerClockSync } = await import("../src/lib/playerClock")
    assert.equal(runOnPlayerClockSync(traveller.playerId, () => getServerDate().toISOString()), "2024-06-10T12:00:00.000Z")
    assert.equal(getServerDate().toISOString(), "2025-01-03T12:00:00.000Z", "only inside the call")
})

test("concurrent requests of two players keep their own clocks", async () => {
    const past = await signUp()
    const future = await signUp()
    await setClock(past, "2023-03-01T00:00:00Z")
    await setClock(future, "2025-01-20T00:00:00Z")
    const requests: Promise<[string, string]>[] = []
    for (let i = 0; i < 20; i++) {
        const [player, expected] = i % 2 === 0 ? [past, "2023-03-01T12:00:00.000Z"] : [future, "2025-01-20T12:00:00.000Z"]
        const request = i % 4 < 2 ? attentionCheck(player) : missionProgress(player)
        requests.push(request.then(reply => [replyTime(reply), expected]))
    }
    for (const [actual, expected] of await Promise.all(requests)) assert.equal(actual, expected)
})

test("/load runs on the player's clock and applies the player's game day's resets", async () => {
    const player = await signUp()
    await setClock(player, "2024-06-10T00:00:00Z")
    const reply = await load(player)
    assert.equal(replyTime(reply), "2024-06-10T12:00:00.000Z")
    const { getPlayerResetsSync, getPlayerSync } = await import("../src/data/wdfpData")
    assert.deepEqual(getPlayerResetsSync(player.playerId), { day: "2024-06-10", month: "2024-06" })
    assert.equal(getPlayerSync(player.playerId)?.lastLoginTime.toISOString(), "2024-06-10T12:00:00.000Z")

    // back on the server clock: a different game day, so the resets run again
    await setClock(player, null)
    assert.equal(replyTime(await load(player)), "2025-01-03T12:00:00.000Z")
    assert.deepEqual(getPlayerResetsSync(player.playerId), { day: "2025-01-03", month: "2025-01" })
})

test("shop stock counts the player's own game day", async () => {
    const player = await signUp()
    await setClock(player, "2024-06-10T00:00:00Z")
    const { runOnPlayerClockSync } = await import("../src/lib/playerClock")
    const { currentPurchases } = await import("../src/lib/shopLimits")
    const { getServerDate } = await import("../src/utils")
    const purchases = runOnPlayerClockSync(player.playerId, () => currentPurchases(player.playerId, 1, 1, getServerDate()))
    assert.deepEqual([purchases.day, purchases.month], ["2024-06-10", "2024-06"])
})

test("title requests that name a viewer show that player's clock; requests without one the server clock", async () => {
    const player = await signUp()
    await setClock(player, "2024-06-10T00:00:00Z")
    // the client returns to the title whenever the game day of a reply changes, so the title must not differ from /load
    assert.equal(replyTime(await gameRequest("tool/get_header_response", { viewer_id: player.viewerId })), "2024-06-10T12:00:00.000Z")
    assert.equal(replyTime(await gameRequest("asset/version_info", { ...readCapturedRoute("asset_version_info").requestBody, viewer_id: player.viewerId }, player.udid)), "2024-06-10T12:00:00.000Z")
    assert.equal(replyTime(await gameRequest("tool/get_header_response", { viewer_id: null })), "2025-01-03T12:00:00.000Z")
    assert.equal(replyTime(await gameRequest("tool/get_header_response", { viewer_id: 123456789 })), "2025-01-03T12:00:00.000Z", "unknown viewer")
})

test("the clock stays with the account through a progress reset and goes with the account", async () => {
    const player = await signUp()
    await setClock(player, "2024-06-10T00:00:00Z")
    const { resetPlayer, deletePlayer } = await import("../src/lib/playerAdmin")
    const { getPlayerClockSync } = await import("../src/lib/playerClock")
    const newPlayerId = resetPlayer(player.playerId)!
    assert.equal(getPlayerClockSync(newPlayerId)?.offsetDays, -207)

    assert.equal(deletePlayer(newPlayerId), true)
    const { default: getDatabase, Database } = await import("../src/data")
    const rows = getDatabase(Database.WDFP_DATA).prepare(`SELECT * FROM account_clocks WHERE account_id = ?`).all(player.accountId)
    assert.deepEqual(rows, [])
})

test("a calendar switch moves the player's clock too, the same days away", async () => {
    const clock = await import("../src/lib/serverClock")
    const player = await signUp()
    process.env.SERVER_CLOCK = "running"
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-30T10:00:00Z") })
    try {
        clock.reloadServerClock()
        clock.setServerTime(new Date("2025-01-30T19:00:00Z"))
        clock.startCalendar()
        await setClock(player, "2025-01-29T00:00:00Z")
        assert.equal(replyTime(await missionProgress(player)), "2025-01-29T19:00:00.000Z")
        mock.timers.tick(2 * 60 * 60 * 1000)
        // the server clock wrapped from 30 January 20:00 to 2 January 20:00 (game day 3 January) and on an hour
        assert.equal(replyTime(await missionProgress(player)), "2025-01-01T21:00:00.000Z")
    } finally {
        mock.timers.reset()
        process.env.SERVER_CLOCK = "frozen"
        clock.reloadServerClock()
    }
})

test("moving a player's clock back starts an era of their own: days and months they played are new again", async () => {
    const clock = await import("../src/lib/serverClock")
    const player = await signUp()
    const { getPlayerResetsSync } = await import("../src/data/wdfpData")
    const buyMonthly = async () => (await fastify.inject({
        method: "POST", url: `${apiPrefix}/shop/buy`, headers: gameHeaders(player.udid),
        // general shop (8) item 220032 costs nothing and is sold once a month
        payload: encodeGameBody({ viewer_id: player.viewerId, shop_type: 8, shop_item_id: 220032, number: 1, api_count: 1 })
    })).statusCode
    process.env.SERVER_CLOCK = "running"
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-30T10:00:00Z") })
    try {
        clock.reloadServerClock()
        clock.setServerTime(new Date("2025-01-10T12:00:00Z"))
        const era = clock.getClockEra()
        await setClock(player, "2025-01-20T00:00:00Z")
        await load(player)
        assert.equal(getPlayerResetsSync(player.playerId)?.day, era > 0 ? `2025-01-20~${era}` : "2025-01-20")
        assert.equal(await buyMonthly(), 200)
        assert.equal(await buyMonthly(), 400, "once a month")

        // forward again: the same era, the month stays bought
        await setClock(player, "2025-01-25T00:00:00Z")
        assert.equal(await buyMonthly(), 400)
        // back to days already played (in the same month): a new era for this player only
        await setClock(player, "2025-01-15T00:00:00Z")
        await load(player)
        assert.equal(getPlayerResetsSync(player.playerId)?.day, `2025-01-15~${era + 1}`)
        assert.equal(await buyMonthly(), 200, "a new month for the shop")
        assert.equal(clock.getClockEra(), era, "the server clock's era is unchanged")
        // following the server clock (2025-01-10) is back too; the era stays with the account
        await setClock(player, null)
        const { default: getDatabase, Database } = await import("../src/data")
        assert.deepEqual(getDatabase(Database.WDFP_DATA).prepare(`SELECT offset_days, era FROM account_clocks WHERE account_id = ?`).get(player.accountId), { offset_days: 0, era: 2 })
        await load(player)
        assert.equal(getPlayerResetsSync(player.playerId)?.day, `2025-01-10~${era + 2}`)
    } finally {
        mock.timers.reset()
        process.env.SERVER_CLOCK = "frozen"
        clock.reloadServerClock()
    }
})

test("the admin player page shows and sets the player's clock", async () => {
    const player = await signUp()
    let page = await admin.inject({ method: "GET", url: `/player/${player.playerId}` })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Now 2025-01-03 12:00 UTC, the server clock\./)
    assert.match(page.body, /value="2025-01-03"/)

    assert.deepEqual(await post(`/api/player/clock?id=${player.playerId}`, { date: "2024-06-10" }), { status: 302, location: `/player/${player.playerId}?message=clock-set` })
    page = await admin.inject({ method: "GET", url: `/player/${player.playerId}?message=clock-set` })
    assert.match(page.body, /207 days behind the server clock\./)
    assert.match(page.body, /Clock set\./)
    assert.match(page.body, /value="2024-06-10"/)

    assert.deepEqual(await post(`/api/player/clock/reset?id=${player.playerId}`, {}), { status: 302, location: `/player/${player.playerId}?message=clock-reset` })
    const { getPlayerClockSync } = await import("../src/lib/playerClock")
    assert.equal(getPlayerClockSync(player.playerId)?.offsetDays, 0)
})

test("the admin site refuses days without a portal unless forced, invalid days and other sites", async () => {
    const player = await signUp()
    const { getPlayerClockSync } = await import("../src/lib/playerClock")
    const url = `/api/player/clock?id=${player.playerId}`
    const page = `/player/${player.playerId}`
    for (const [date, code] of [["2026-01-01", "clock-no-portal"], ["2018-01-01", "clock-no-portal"], ["2024-02-30", "clock-invalid"], ["10-06-2024", "clock-invalid"], ["1900-01-01", "clock-out-of-range"]])
        assert.deepEqual(await post(url, { date }), { status: 302, location: `${page}?error=${code}` }, date)
    assert.equal(getPlayerClockSync(player.playerId)?.offsetDays, 0)

    assert.equal((await post(url, { date: "2026-01-01" }, { "sec-fetch-site": "cross-site", "origin": "https://evil.example" })).status, 403)
    assert.equal(getPlayerClockSync(player.playerId)?.offsetDays, 0)
    assert.deepEqual(await post("/api/player/clock?id=999999", { date: "2024-06-10" }), { status: 302, location: "/player" })
    assert.equal((await post(`/api/player/clock?id=abc`, { date: "2024-06-10" })).status, 400)

    // forced past the content: the page warns
    assert.deepEqual(await post(url, { date: "2025-03-01", force: "1" }), { status: 302, location: `${page}?message=clock-set` })
    const html = (await admin.inject({ method: "GET", url: page })).body
    assert.match(html, /This player&#39;s clock is on a date with no summoning portal open \(2025-03-01 12:00 UTC\)/)
})

test("admin mail is dated and expires on the player's clock, also when sent to every player", async () => {
    const traveller = await signUp()
    const stayer = await signUp()
    await setClock(traveller, "2024-12-20T00:00:00Z")
    const mail = { type: 8, number: 100, subject: "Clock", description: "On the player's clock" }
    const json = { "content-type": "application/json" }
    // expires between the traveller's now (2024-12-20) and the server's (2025-01-03)
    const single = await admin.inject({ method: "POST", url: `/api/player/mail?id=${traveller.playerId}`, headers: json, payload: { ...mail, rewardLimitTime: "2024-12-25T00:00:00Z" } })
    assert.equal(single.statusCode, 200, single.body)
    const all = await admin.inject({ method: "POST", url: "/api/player/mail/all", headers: json, payload: mail })
    assert.equal(all.statusCode, 200, all.body)

    const { getPlayerReceivableMailListSync } = await import("../src/data/wdfpData")
    // every mail, expired or not
    const created = (player: Player) => getPlayerReceivableMailListSync(player.playerId, new Date(0), 0, 100).map(entry => entry.createTime.toISOString())
    assert.deepEqual(created(traveller), ["2024-12-20T12:00:00.000Z", "2024-12-20T12:00:00.000Z"])
    assert.deepEqual(created(stayer), ["2025-01-03T12:00:00.000Z"])

    // the admin list and the gift box both still hold the expiring mail for the traveller
    const listed = await admin.inject({ method: "GET", url: `/api/player/mail?id=${traveller.playerId}` })
    assert.equal(listed.json().length, 2)
    const box = await gameRequest("mail/index", { ...readCapturedRoute("mail_index").requestBody, viewer_id: traveller.viewerId })
    assert.equal(box.data.total_count, 2)
})

test("sending to every player counts each gift box on its player's clock", async () => {
    const traveller = await signUp()
    const stayer = await signUp()
    await setClock(traveller, "2024-12-20T00:00:00Z")
    const data = await import("../src/data/wdfpData")
    const { mailLimits } = await import("../src/lib/limits")
    // a full box for both that expired on 2025-01-01: still full on the traveller's clock, empty on the server's
    data.runInTransactionSync(() => {
        for (const player of [traveller, stayer]) for (let i = 0; i < mailLimits.pendingMails; i++) data.insertPlayerMailSync(player.playerId, {
            type: 8, typeId: null, number: 1, reasonId: 0, subject: "Filler", description: "", createTime: new Date("2024-12-01T00:00:00Z"), receiveTime: null, rewardLimitTime: new Date("2025-01-01T00:00:00Z")
        })
    })
    const all = await admin.inject({ method: "POST", url: "/api/player/mail/all", headers: { "content-type": "application/json" }, payload: { type: 8, number: 1, subject: "All", description: "" } })
    assert.equal(all.statusCode, 200, all.body)
    const latest = (player: Player) => data.getPlayerReceivableMailListSync(player.playerId, new Date(0), 0, 1)[0].subject
    assert.equal(latest(traveller), "Filler", "full on the traveller's clock: skipped")
    assert.equal(latest(stayer), "All")
})

test("a database whose account_clocks has no era gets it on start, whatever its version says", async () => {
    // an early build of FT-5 made the table without it, in a database already at version 6
    const { default: Sqlite } = await import("../src/data/sqlite")
    const { default: init } = await import("../src/data/initializers/wdfpData")
    const db = new Sqlite(":memory:")
    try {
        db.prepare(`CREATE TABLE account_clocks (account_id INTEGER NOT NULL UNIQUE, offset_days INTEGER NOT NULL)`).run()
        db.prepare(`INSERT INTO account_clocks (account_id, offset_days) VALUES (1, -5)`).run()
        init(db, true)
        assert.deepEqual(db.prepare(`SELECT account_id, offset_days, era FROM account_clocks`).all(), [{ account_id: 1, offset_days: -5, era: 0 }])
        // a second start changes nothing
        init(db, true)
        assert.deepEqual((db.prepare(`PRAGMA table_info(account_clocks)`).all() as { name: string }[]).map(column => column.name), ["account_id", "offset_days", "era", "source"])
    } finally {
        db.close()
    }
})

test("a player named like a placeholder keeps the name on the admin pages", async () => {
    const player = await signUp()
    const { updatePlayerSync } = await import("../src/data/wdfpData")
    const name = "{{clockState}} {{nav}} $& $'"
    updatePlayerSync({ id: player.playerId, name })
    for (const url of [`/player/${player.playerId}`, "/player"]) {
        const page = await admin.inject({ method: "GET", url })
        assert.equal(page.statusCode, 200)
        assert.ok(page.body.includes("{{clockState}} {{nav}} $&amp; $&#39;"), `${url}: the name as it is`)
        // eight pages (Cheat review: SEC-18), the theme switch and the Log out button (ACC-5)
        assert.equal(page.body.split('class="nav-link').length - 1, 10, `${url}: the navigation once`)
    }
    assert.match((await admin.inject({ method: "GET", url: `/player/${player.playerId}` })).body, /<title>\{\{clockState\}\} \{\{nav\}\}/)
})

test("every notice code the player clock routes send renders a notice on the player page", async () => {
    const player = await signUp()
    const { readFileSync } = await import("fs")
    const codes = [...readFileSync("src/routes/web_api/playerClock.ts", "utf-8").matchAll(/\?(error|message)=([\w-]+)/g)].map(match => [match[1], match[2]] as const)
    assert.equal(codes.length, 6)
    for (const [kind, code] of codes) {
        const page = await admin.inject({ method: "GET", url: `/player/${player.playerId}?${kind}=${code}` })
        const notice = page.body.match(/<div class="notice-(error|info)">([^<]+)<\/div>/)
        assert.equal(notice?.[1], kind === "error" ? "error" : "info", code)
        assert.ok(notice![2].length > 10, code)
    }
})

test("a player on the server clock is warned about the server clock, a player off it about their own", async () => {
    const { setServerTime } = await import("../src/utils")
    const player = await signUp()
    // past the last portal (2025-01-31 05:00 UTC)
    setServerTime(new Date("2025-01-31T06:00:00Z"))
    const onServer = (await admin.inject({ method: "GET", url: `/player/${player.playerId}` })).body
    assert.match(onServer, /The server clock is on a date with no summoning portal open/)
    assert.doesNotMatch(onServer, /This player&#39;s clock is on/)
    await setClock(player, "2025-02-05T00:00:00Z")
    try {
        const off = (await admin.inject({ method: "GET", url: `/player/${player.playerId}` })).body
        assert.match(off, /This player&#39;s clock is on a date with no summoning portal open/)
    } finally {
        await setClock(player, null)
    }
})
