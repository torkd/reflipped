import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute, TestPlayer } from "./helpers";

// FT-24: the Comeback, ActiveUser and ComebackAlways login calendars (src/lib/loginBonus.ts). The test server runs the
// frozen historical clock, so master dates apply as they are.
//   anv3_comeback (Comeback, 5 entries, beginners included): no login from 2024-03-01 05:00 to 2024-04-20 04:59:59 JST
//   anv3_present (ActiveUser, 1 entry): everyone anv3_comeback doesn't take; both run from 2024-04-28 14:00 JST
//   comeback_01 (Comeback, 10 entries, returning players only): with the default "global" rule (src/lib/comebackRule.ts),
//   no login from 2022-12-02 05:00 JST until the first login in the campaign; from 2022-12-17
//   comebackpresent (ComebackAlways, 1 entry): back after 60 days or more away, at any date

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let bonus: typeof import("../src/lib/loginBonus")
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    bonus = await import("../src/lib/loginBonus")
    utils = await import("../src/utils")
})

after(async () => {
    utils.setServerTime(null)
    await cleanup?.()
})

async function newPlayer(): Promise<{ player: TestPlayer, id: number }> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return { player, id: (await data.getAccountPlayers(session!.accountId))[0] }
}

function at(time: string): Date {
    const date = new Date(time)
    utils.setServerTime(date)
    return date
}

/** One /load-like login at `time`, the previous one at `previous`; returns the presented group ids and indexes. */
function login(id: number, time: string, previous: string): Record<string, number> {
    const result = bonus.applyLoginBonuses(id, at(time), new Date(previous))
    bonus.acknowledgeLoginBonuses(id)
    return Object.fromEntries(result.bonusIndexList.map(entry => [entry.bonus_group_id, entry.index]))
}

test("conditional login bonuses: a player active during the window gets the anniversary present, not the comeback calendar", async () => {
    const { id } = await newPlayer()
    login(id, "2024-01-10T12:00:00Z", "2024-01-09T12:00:00Z")
    login(id, "2024-04-10T12:00:00Z", "2024-01-10T12:00:00Z")
    const opened = login(id, "2024-04-28T06:00:00Z", "2024-04-10T12:00:00Z")
    assert.equal(opened.anv3_present, 1)
    assert.equal(opened.anv3_comeback, undefined)
    // one entry: nothing more the next day
    const next = login(id, "2024-04-29T06:00:00Z", "2024-04-28T06:00:00Z")
    assert.equal(next.anv3_present, undefined)
    assert.equal(next.anv3_comeback, undefined)
})

test("conditional login bonuses: a player away during the window climbs the comeback calendar, without the present", async () => {
    const { id } = await newPlayer()
    login(id, "2024-01-15T12:00:00Z", "2024-01-14T12:00:00Z")
    for (let entry = 1; entry <= 5; entry++) {
        const day = login(id, `2024-05-0${entry}T06:00:00Z`, entry === 1 ? "2024-01-15T12:00:00Z" : `2024-05-0${entry - 1}T06:00:00Z`)
        assert.equal(day.anv3_comeback, entry, `entry ${entry}`)
        assert.equal(day.anv3_present, undefined)
    }
    const finished = login(id, "2024-05-06T06:00:00Z", "2024-05-05T06:00:00Z")
    assert.equal(finished.anv3_comeback, undefined, "the calendar stops after its last entry")
    assert.equal(finished.anv3_present, undefined, "a comeback player never gets the present")
})

test("conditional login bonuses: the condition window's last second counts as a login in it", async () => {
    const inside = await newPlayer()
    login(inside.id, "2024-01-15T12:00:00Z", "2024-01-14T12:00:00Z")
    // 2024-04-20 04:59:59 JST
    const lastSecond = login(inside.id, "2024-04-28T06:00:00Z", "2024-04-19T19:59:59Z")
    assert.equal(lastSecond.anv3_present, 1)
    assert.equal(lastSecond.anv3_comeback, undefined)

    const outside = await newPlayer()
    login(outside.id, "2024-01-15T12:00:00Z", "2024-01-14T12:00:00Z")
    const afterWindow = login(outside.id, "2024-04-28T06:00:00Z", "2024-04-19T20:00:00Z")
    assert.equal(afterWindow.anv3_comeback, 1)
    assert.equal(afterWindow.anv3_present, undefined)
})

test("conditional login bonuses: new players count as comebacks only where the calendar includes beginners", async () => {
    const anniversary = await newPlayer()
    const first = login(anniversary.id, "2024-04-28T06:00:00Z", "2024-04-28T05:59:00Z")
    assert.equal(first.anv3_comeback, 1, "Hello 10K: new players included")
    assert.equal(first.anv3_present, undefined)

    const welcomeBack = await newPlayer()
    assert.equal(login(welcomeBack.id, "2022-12-18T06:00:00Z", "2022-12-18T05:59:00Z").comeback_01, undefined,
        "Welcome Back Login Perks: returning players only")
    const returning = await newPlayer()
    login(returning.id, "2022-10-01T12:00:00Z", "2022-09-30T12:00:00Z")
    assert.equal(login(returning.id, "2022-12-18T06:00:00Z", "2022-10-01T12:00:00Z").comeback_01, 1)
    assert.equal(login(returning.id, "2022-12-19T06:00:00Z", "2022-12-18T06:00:00Z").comeback_01, 2)
})

test("conditional login bonuses: a player who started during the window logged in during it, so gets the present", async () => {
    const { id } = await newPlayer()
    // the first login ever, inside anv3_comeback's window: not a new player at the campaign, and not away either
    login(id, "2024-03-10T12:00:00Z", "2024-03-10T11:59:00Z")
    const opened = login(id, "2024-04-28T06:00:00Z", "2024-03-10T12:00:00Z")
    assert.equal(opened.anv3_present, 1)
    assert.equal(opened.anv3_comeback, undefined)
})

test("conditional login bonuses: without the previous login (the tutorial's end) nothing new starts", async () => {
    const { id } = await newPlayer()
    const result = bonus.applyLoginBonuses(id, at("2024-04-28T06:00:00Z"))
    const groups = result.bonusIndexList.map(entry => entry.bonus_group_id)
    assert.equal(groups.includes("anv3_comeback"), false)
    assert.equal(groups.includes("anv3_present"), false)
    assert.equal(groups.includes("comebackpresent"), false)
})

test("conditional login bonuses: the comeback present after 60 days away, once per return", async () => {
    const { id } = await newPlayer()
    login(id, "2025-01-01T12:00:00Z", "2024-12-31T12:00:00Z")
    assert.equal(login(id, "2025-03-01T12:00:00Z", "2025-01-01T12:00:00Z").comebackpresent, undefined, "59 days")

    const back = await newPlayer()
    login(back.id, "2025-01-01T12:00:00Z", "2024-12-31T12:00:00Z")
    const result = bonus.applyLoginBonuses(back.id, at("2025-03-02T12:00:00Z"), new Date("2025-01-01T12:00:00Z"))
    assert.deepEqual(result.bonusIndexList.find(entry => entry.bonus_group_id === "comebackpresent"),
        { bonus_group_id: "comebackpresent", bonus_group_type: "ComebackAlways", index: 1 })
    // a relaunch before the calendar was acknowledged presents it again without earning it twice
    const relaunch = bonus.applyLoginBonuses(back.id, at("2025-03-02T13:00:00Z"), new Date("2025-03-02T12:00:00Z"))
    assert.equal(relaunch.bonusIndexList.find(entry => entry.bonus_group_id === "comebackpresent")?.index, 1)
    bonus.acknowledgeLoginBonuses(back.id)
    assert.equal(login(back.id, "2025-03-03T13:00:00Z", "2025-03-02T13:00:00Z").comebackpresent, undefined)
    // a save import can set an old last login, but the server's own login record still counts
    assert.equal(login(back.id, "2025-03-04T13:00:00Z", "2024-01-01T00:00:00Z").comebackpresent, undefined)
    assert.equal(bonus.latestReturnSync(back.id)?.toISOString(), "2025-03-02T12:00:00.000Z")
    // another long absence earns it again
    assert.equal(bonus.isReturningLoginSync(back.id, new Date("2025-05-10T13:00:00Z"), new Date("2025-03-04T13:00:00Z")), true)
    assert.equal(login(back.id, "2025-05-10T13:00:00Z", "2025-03-04T13:00:00Z").comebackpresent, 1)
    assert.equal(bonus.latestReturnSync(back.id)?.toISOString(), "2025-05-10T13:00:00.000Z")
    assert.equal(bonus.isReturningLoginSync(back.id, new Date("2025-05-11T13:00:00Z"), new Date("2025-05-10T13:00:00Z")), false)
})

test("conditional login bonuses: /load decides from the login before it", async () => {
    const { player, id } = await newPlayer()
    data.updatePlayerSync({ id, lastLoginTime: new Date("2024-10-01T12:00:00Z") })
    at("2025-01-03T12:00:00Z")
    const response = await fastify.inject({
        method: "POST", url: "/latest/api/index.php/load", headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...readCapturedRoute("load").requestBody, access_token: player.zat, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    const list = decodeGameBody(response.body).data.bonus_index_list as { bonus_group_id: string, bonus_group_type: string }[]
    assert.ok(list.some(entry => entry.bonus_group_id === "comebackpresent" && entry.bonus_group_type === "ComebackAlways"))
    assert.equal(data.getPlayerSync(id)!.lastLoginTime.getTime(), new Date("2025-01-03T12:00:00Z").getTime())
})

test("the absence checks look receipts up by player and time, not by scanning the player's receipts", async () => {
    const { default: getDatabase, Database } = await import("../src/data")
    const db = getDatabase(Database.WDFP_DATA)
    const plan = (sql: string, ...params: number[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
        .map(row => row.detail).join(" | ")
    // the two queries loginHistory() runs
    const latest = plan("SELECT MAX(received_at) AS latest FROM players_login_bonus_receipts WHERE player_id = ?", 1)
    const window = plan("SELECT 1 FROM players_login_bonus_receipts WHERE player_id = ? AND received_at >= ? AND received_at < ? LIMIT 1", 1, 0, 1)
    assert.match(latest, /COVERING INDEX players_login_bonus_receipts_player_received/)
    assert.match(window, /players_login_bonus_receipts_player_received \(player_id=\? AND received_at>\? AND received_at<\?\)/)
})
