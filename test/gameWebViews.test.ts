// New SH-5 coverage only: real public routes plus synthetic probability fixtures.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestServer } from "./helpers"
import type { Gacha } from "../src/lib/types"

test("game web views show actual rates, safe contacts and the scheduled server calendar", async (t) => {
    const server = await createTestServer()
    const { portalOdds, oddsPercent } = await import("../src/lib/gachaOdds")
    const { getGachaSync, getOpenGachaIdsSync } = await import("../src/lib/assets")
    const { gachaRankWeights } = await import("../src/lib/gacha")
    const { getServerDate } = await import("../src/utils")
    const { listEvents } = await import("../src/lib/eventCalendar")
    const { isContentPeriodOpen } = await import("../src/lib/eventSchedule")
    const { ownerLink } = await import("../src/routes/web/gamePages")
    try {
        await t.test("weighted units and guaranteed ranks are normalized separately", () => {
            const gacha = { rankWeights: { "1": 5, "2": 25, "3": 70 }, guaranteeRarity: 4, guaranteeNumber: 1,
                pool: { "1": [{ id: 1, odds: 3 }, { id: 2, odds: 1 }], "2": [{ id: 3, odds: 1 }], "3": [{ id: 4, odds: 1 }] } } as unknown as Gacha
            const rows = portalOdds(gacha)
            assert.equal(rows.find(row => row.id === 1)!.standard, 0.05 * 0.75)
            assert.equal(rows.find(row => row.id === 2)!.standard, 0.05 * 0.25)
            assert.equal(rows.find(row => row.id === 3)!.guaranteed, 0.95)
            assert.equal(rows.find(row => row.id === 4)!.guaranteed, 0)
            assert.ok(Math.abs(rows.reduce((sum,row)=>sum+row.standard,0)-1)<1e-12)
            assert.ok(Math.abs(rows.reduce((sum,row)=>sum+row.guaranteed,0)-1)<1e-12)
            gacha.guaranteeRarity = 5
            assert.equal(portalOdds(gacha).find(row=>row.id===1)!.guaranteed, 0.75)
            gacha.pool["1"].forEach(item=>item.odds=0)
            assert.equal(portalOdds(gacha).find(row=>row.id===1)!.guaranteed, 1)
            assert.equal(oddsPercent(0.075), "7.5%")
            assert.equal(oddsPercent(1), "100%")
            assert.equal(oddsPercent(0), "0%")
            assert.equal(oddsPercent(1e-12), "<0.000001%")
            gacha.pool["1"][0].odds = NaN
            assert.throws(() => portalOdds(gacha), /invalid item weights/)
        })
        await t.test("public odds pages match the live draw helper for regular and special portals", async () => {
            const index = await server.fastify.inject("/game/odds")
            assert.equal(index.statusCode, 200)
            for (const id of getOpenGachaIdsSync(getServerDate())) assert.ok(index.body.includes(`/game/odds/${id}`))
            for (const id of ["184", "5038", "2", "800000"]) {
                const page = await server.fastify.inject(`/game/odds/${id}`)
                assert.equal(page.statusCode, 200)
                const gacha = getGachaSync(id)!
                const rows = portalOdds(gacha)
                for (const row of rows.slice(0,5)) {
                    assert.ok(page.body.includes(`data-id="${row.id}" data-standard="${row.standard}"`))
                    assert.ok(page.body.includes(`data-guaranteed="${row.guaranteed}"`))
                }
                const normal = gachaRankWeights(gacha,false)
                assert.ok(Math.abs(rows.filter(row=>row.stars===5).reduce((sum,row)=>sum+row.standard,0) - normal[0]/normal.reduce((a,b)=>a+b,0))<1e-12)
                assert.match(page.body, /last 1 draw uses the guaranteed rates/)
                assert.match(page.headers["content-security-policy"] as string, /default-src 'none'/)
                assert.equal(page.headers["referrer-policy"], "no-referrer")
                assert.equal(page.headers["cache-control"], "no-store")
                assert.doesNotMatch(page.body, /<script|javascript:/)
            }
            assert.equal((await server.fastify.inject("/game/odds?id=184")).headers.location, "/game/odds/184")
            assert.equal((await server.fastify.inject("/game/odds/999999999")).statusCode, 404)
            assert.equal((await server.fastify.inject("/game/odds/__proto__")).statusCode, 400)
            assert.equal((await server.fastify.inject("/game/odds?id=https://evil.test")).statusCode, 400)
        })
        await t.test("events filter with the same content-period helper, without claiming personal progress", async () => {
            const page = await server.fastify.inject("/game/events")
            assert.equal(page.statusCode, 200)
            const now = getServerDate()
            for (const event of listEvents().filter(event=>isContentPeriodOpen(event.start.getTime(),event.end.getTime(),now)))
                assert.ok(page.body.includes(event.name.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")))
            assert.match(page.body, /personal calendar may differ/)
            // Exercise projected periods too; no viewer ID means the shared server view, never an account's offset.
            const clock = process.env.SERVER_CLOCK
            const schedule = process.env.EVENT_SCHEDULING
            process.env.SERVER_CLOCK = "real"
            process.env.EVENT_SCHEDULING = "on"
            try {
                const projected = await server.fastify.inject("/game/events")
                assert.equal(projected.statusCode, 200)
                const expected = listEvents().filter(event=>isContentPeriodOpen(event.start.getTime(),event.end.getTime(),getServerDate()))
                for (const event of expected) assert.ok(projected.body.includes(event.name.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")))
            } finally {
                if (clock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = clock
                if (schedule === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = schedule
            }
        })
        await t.test("only configured HTTPS contacts appear; owner text is escaped", async () => {
            delete process.env.SERVER_SUPPORT_URL
            delete process.env.SERVER_COMMUNITY_URL
            assert.match((await server.fastify.inject("/game/support")).body, /has not listed a contact page/)
            assert.match((await server.fastify.inject("/game/community")).body, /has not listed a community page/)
            for (const unsafe of ["javascript:alert(1)", "http://unsafe.test", "https://user:secret@example.com", "file:///x", "not a url"])
                assert.equal(ownerLink(unsafe), null)
            process.env.SERVER_SUPPORT_URL = "https://support.example/help?a=1&b=2"
            process.env.SERVER_COMMUNITY_URL = "https://community.example/invite"
            process.env.SERVER_NAME = '<script>alert("owner")</script>'
            const help = await server.fastify.inject("/game/support")
            assert.ok(help.body.includes('href="https://support.example/help?a=1&amp;b=2"'))
            assert.ok(help.body.includes("&lt;script&gt;"))
            assert.doesNotMatch(help.body, /<script>/)
            assert.match(help.body, /Do not send your password/)
            assert.match((await server.fastify.inject("/game/community")).body, /https:\/\/community.example\/invite/)
        })
    } finally { await server.cleanup() }
})
