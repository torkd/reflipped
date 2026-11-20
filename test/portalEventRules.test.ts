import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { User } from "../src/data/users";
import { createTestServer } from "./helpers";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
before(async () => { ({ fastify, cleanup } = await createTestServer()) })
after(async () => { await cleanup() })

test("portal rules show mode, effective rewards and account travel access without controls", async () => {
    const oldClock = process.env.SERVER_CLOCK
    const oldScheduling = process.env.EVENT_SCHEDULING
    process.env.SERVER_CLOCK = "real"
    process.env.EVENT_SCHEDULING = "on"
    try {
        const { setEventPolicy, getEventPolicy } = await import("../src/lib/eventPolicy")
        const { setRewardPolicy } = await import("../src/lib/rewardPolicy")
        const { eventRulesCard } = await import("../src/routes/portal/playerCards")
        const user = { id: 1, username: "<script>alert(1)</script>", role: "player", timeTravel: false } as User
        const base = getEventPolicy()
        setRewardPolicy({ management: "automatic" })
        for (const [mode, label, multiplier] of [
            ["classic", "Classic", "100"], ["accelerated", "Accelerated", "100"],
            ["time-travel", "Time Travel", "100"], ["manual", "Manual", "100"]
        ] as const) {
            setEventPolicy({ ...base, mode, adminTimeTravel: false })
            const html = eventRulesCard(user)
            assert.match(html, new RegExp(`>${label}</span>`))
            assert.ok(html.includes(`${multiplier}%`))
            assert.match(html, /Automatic — the server&#39;s reward rules|Automatic — the server's reward rules/)
            assert.match(html, mode === "time-travel" ? /Available to your account/ : /Not available to your account/)
            assert.doesNotMatch(html, /<script|<form|alert\(1\)/)
        }
        setEventPolicy({ ...base, mode: "classic", adminTimeTravel: true })
        const admin = eventRulesCard({ ...user, role: "admin" })
        assert.match(admin, /Admin time travel: enabled/)
        assert.match(admin, /Available to your account/)
        setRewardPolicy({ management: "managed", multiplierOverride: 3.2 })
        assert.match(eventRulesCard(user), /Managed — the server administrator controls the reward rules/)
        assert.ok(eventRulesCard(user).includes("320%"))
    } finally {
        if (oldClock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = oldClock
        if (oldScheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = oldScheduling
    }
})

test("account page includes the rules card", async () => {
    const response = await fastify.inject({ method: "POST", url: "/portal/register",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ username: "rulesplayer", password: "correct horse battery", confirm: "correct horse battery" }).toString() })
    assert.equal(response.statusCode, 302)
    const cookie = String(response.headers["set-cookie"]).split(";")[0]
    const account = await fastify.inject({ method: "GET", url: "/portal", headers: { cookie } })
    assert.equal(account.statusCode, 200)
    assert.match(account.body, /Event and reward rules/)
    assert.doesNotMatch(account.body, /\{\{eventRulesCard\}\}/)
})
