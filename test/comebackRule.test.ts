// FT-65: who the one-off comeback login calendars take (src/lib/comebackRule.ts), and the Welcome Back Gift at any
// date. The test server runs the frozen historical clock, so master dates apply as they are.
//   comeback_01 runs from 2022-12-17 05:00 JST (2022-12-16 20:00 UTC); global rule: no login since 2022-12-01 20:00 UTC
//   anv3_comeback / anv3_present run from 2024-04-28 14:00 JST; anv3_comeback's window 2024-03-01 to 2024-04-20 JST
//   comebackpresent's master period starts 2023-07-25, which no longer matters
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let data: typeof import("../src/data/wdfpData")
let bonus: typeof import("../src/lib/loginBonus")
let rule: typeof import("../src/lib/comebackRule")
let utils: typeof import("../src/utils")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    data = await import("../src/data/wdfpData")
    bonus = await import("../src/lib/loginBonus")
    rule = await import("../src/lib/comebackRule")
    utils = await import("../src/utils")
})

afterEach(() => rule.setComebackRule("global"))

after(async () => {
    utils.setServerTime(null)
    await cleanup?.()
})

async function newPlayer(): Promise<number> {
    const player = await createTestPlayer(fastify)
    const session = await data.getSession(String(player.viewerId))
    return (await data.getAccountPlayers(session!.accountId))[0]
}

/** One /load-like login at `time`, the previous one at `previous`; the presented group ids and indexes. */
function login(id: number, time: string, previous: string): Record<string, number> {
    const date = new Date(time)
    utils.setServerTime(date)
    const result = bonus.applyLoginBonuses(id, date, new Date(previous))
    bonus.acknowledgeLoginBonuses(id)
    return Object.fromEntries(result.bonusIndexList.map(entry => [entry.bonus_group_id, entry.index]))
}

test("global rule: Welcome Back Login Perks for existing players with no login since 2022-12-01 20:00 UTC", async () => {
    // Ana: last played 2022-11-20, back in the campaign
    const ana = await newPlayer()
    login(ana, "2022-11-20T12:00:00Z", "2022-11-19T12:00:00Z")
    assert.equal(login(ana, "2022-12-18T06:00:00Z", "2022-11-20T12:00:00Z").comeback_01, 1)

    // Ben: played on 2022-12-05, after the cutoff
    const ben = await newPlayer()
    login(ben, "2022-11-20T12:00:00Z", "2022-11-19T12:00:00Z")
    login(ben, "2022-12-05T12:00:00Z", "2022-11-20T12:00:00Z")
    assert.equal(login(ben, "2022-12-18T06:00:00Z", "2022-12-05T12:00:00Z").comeback_01, undefined)

    // a login during the master's old one-hour window (2022-11-14 05:30 JST) no longer rules a player out
    const early = await newPlayer()
    login(early, "2022-11-13T20:30:00Z", "2022-11-12T12:00:00Z")
    assert.equal(login(early, "2022-12-18T06:00:00Z", "2022-11-13T20:30:00Z").comeback_01, 1)

    // Cleo: new during the campaign
    const cleo = await newPlayer()
    assert.equal(login(cleo, "2022-12-20T06:00:00Z", "2022-12-20T05:59:00Z").comeback_01, undefined)
})

test("everyone rule: both one-off calendars for every player, and the anniversary present still for those who stayed", async () => {
    rule.setComebackRule("everyone")
    const ben = await newPlayer()
    login(ben, "2022-12-05T12:00:00Z", "2022-12-04T12:00:00Z")
    assert.equal(login(ben, "2022-12-18T06:00:00Z", "2022-12-05T12:00:00Z").comeback_01, 1)
    const cleo = await newPlayer()
    assert.equal(login(cleo, "2022-12-20T06:00:00Z", "2022-12-20T05:59:00Z").comeback_01, 1)

    // active during anv3_comeback's window: the calendar and the present
    const stayed = await newPlayer()
    login(stayed, "2024-04-10T12:00:00Z", "2024-04-09T12:00:00Z")
    const opened = login(stayed, "2024-04-28T06:00:00Z", "2024-04-10T12:00:00Z")
    assert.equal(opened.anv3_comeback, 1)
    assert.equal(opened.anv3_present, 1)
})

test("the Welcome Back Gift goes to a player back after 60 days at any date, also before its master period", async () => {
    const id = await newPlayer()
    login(id, "2022-01-01T12:00:00Z", "2021-12-31T12:00:00Z")
    assert.equal(login(id, "2022-06-01T12:00:00Z", "2022-01-01T12:00:00Z").comebackpresent, 1)
    assert.equal(bonus.latestReturnSync(id)?.toISOString(), "2022-06-01T12:00:00.000Z")
})

test("the admin site saves the comeback rule", async () => {
    const saved = await admin.inject({ method: "POST", url: "/api/server/comebackRule", payload: { comebackRule: "everyone" } })
    assert.equal(saved.statusCode, 302)
    assert.equal(saved.headers.location, "/settings?message=comeback_saved")
    assert.equal(rule.getComebackRule(), "everyone")
    const refused = await admin.inject({ method: "POST", url: "/api/server/comebackRule", payload: { comebackRule: "nobody" } })
    assert.equal(refused.statusCode, 400)
    assert.equal(rule.getComebackRule(), "everyone")
    const page = await admin.inject({ method: "GET", url: "/settings" })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Comeback login calendars/)
    assert.match(page.body, /name="comebackRule" value="everyone" checked/)
})
