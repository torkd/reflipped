// New actual-mode preview coverage; isolated databases and only a fresh synthetic child process.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { createTestServer } from "./helpers"

test("public preview follows active progression changes and uses acceleration only in Accelerated mode", async () => {
    const clock = process.env.SERVER_CLOCK, scheduling = process.env.EVENT_SCHEDULING
    process.env.SERVER_CLOCK = "running"
    process.env.EVENT_SCHEDULING = "on"
    const server = await createTestServer()
    try {
        const { getEventPolicy, setEventPolicy } = await import("../src/lib/eventPolicy")
        const { setSettings } = await import("../src/data/serverSettings")
        const config = async () => {
            const response = await server.fastify.inject({ method: "GET", url: "/shell/config" })
            assert.equal(response.statusCode, 200)
            assert.equal(response.headers["cache-control"], "no-store")
            return response.json()
        }
        const initial = await config()
        assert.deepEqual(initial.progression, { mode: "classic", acceleration: 1 })
        assert.equal(initial.mode, "online")
        const original = getEventPolicy()
        // Owner text is not authoritative even when it sounds like a different mode.
        assert.deepEqual(setSettings({ "server.type": "Sandbox / Accelerated x99" }), [])
        assert.deepEqual((await config()).progression, { mode: "classic", acceleration: 1 })
        for (const mode of ["accelerated", "time-travel", "manual", "classic"] as const) {
            setEventPolicy({ ...original, mode, acceleration: 7 })
            const preview = await config()
            assert.deepEqual(preview.progression, { mode, acceleration: mode === "accelerated" ? 7 : 1 })
            assert.equal(preview.mode, "online", "transport mode stays separate")
        }
        setEventPolicy({ ...original, mode: "accelerated", acceleration: 3 })
        assert.deepEqual((await config()).progression, { mode: "accelerated", acceleration: 3 }, "next request reflects a changed factor")
        process.env.SERVER_CLOCK = "frozen"
        assert.deepEqual((await config()).progression, { mode: "legacy", acceleration: 1 }, "the frozen legacy clock never claims active accelerated scheduling")
    } finally {
        await server.cleanup()
        if (clock === undefined) delete process.env.SERVER_CLOCK; else process.env.SERVER_CLOCK = clock
        if (scheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = scheduling
    }
})

test("a fresh scheduling-off process reports legacy even when a modern policy is stored", () => {
    const script = `
        const { createTestServer } = require('./test/helpers.ts');
        (async () => {
            const server = await createTestServer();
            try {
                const { getEventPolicy, setEventPolicy } = require('./src/lib/eventPolicy.ts');
                setEventPolicy({ ...getEventPolicy(), mode: 'accelerated', acceleration: 9 });
                const reply = await server.fastify.inject({ method: 'GET', url: '/shell/config' });
                if (reply.statusCode !== 200) throw new Error('config failed');
                console.log(JSON.stringify(reply.json()));
            } finally { await server.cleanup(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `
    const output = execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
        env: { ...process.env, EVENT_SCHEDULING: "off", SERVER_CLOCK: "running" }, encoding: "utf8"
    })
    const config = JSON.parse(output.trim().split("\n").at(-1)!)
    assert.deepEqual(config.progression, { mode: "legacy", acceleration: 1 })
    assert.equal(config.mode, "online")
})
