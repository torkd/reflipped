import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";
import { applyProfileDefaults, LOCAL_PROFILE_DEFAULTS, serverProfile } from "../src/lib/serverProfile";

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    delete process.env.REFLIPPED_PROFILE
    await cleanup()
})

test("REFLIPPED_PROFILE: local, or the server profile for anything else", () => {
    assert.equal(serverProfile(undefined), "server")
    assert.equal(serverProfile(""), "server")
    assert.equal(serverProfile("phone"), "server")
    assert.equal(serverProfile(" Local "), "local")
})

test("the server profile sets nothing", () => {
    const env: NodeJS.ProcessEnv = {}
    assert.deepEqual(applyProfileDefaults(env), [])
    assert.deepEqual(env, {})
})

test("the local profile fills in only the settings that are unset", () => {
    const env: NodeJS.ProcessEnv = { REFLIPPED_PROFILE: "local", LOG_LEVEL: "debug", LOG_FILE: "server.log" }
    const applied = applyProfileDefaults(env)
    assert.ok(!applied.includes("LOG_LEVEL") && !applied.includes("LOG_FILE"))
    assert.equal(env.LOG_LEVEL, "debug", "an explicit setting wins")
    assert.equal(env.LOG_FILE, "server.log")
    assert.equal(env.LISTEN_HOST, "127.0.0.1")
    assert.equal(env.ADMIN_HOST, "127.0.0.1")
    assert.equal(env.ADMIN_PORT, "0", "no admin site on the phone until the app's one-time login")
    assert.equal(env.RATE_LIMIT, "0")
    assert.equal(env.NEW_ACCOUNTS_PER_HOUR, "30")
    assert.equal(env.SCHEDULE_ASSET_CACHE_BYTES, String(100 * 1024 * 1024))
    assert.equal(applied.length, Object.keys(LOCAL_PROFILE_DEFAULTS).length - 2)
})

test("an empty value counts as set", () => {
    const env: NodeJS.ProcessEnv = { REFLIPPED_PROFILE: "local", LISTEN_HOST: "" }
    applyProfileDefaults(env)
    assert.equal(env.LISTEN_HOST, "")
})

test("/shell/config: the local profile is a local server the app signs in to by device", async () => {
    delete process.env.REFLIPPED_PROFILE
    const online = (await fastify.inject({ method: "GET", url: "/shell/config" })).json()
    assert.deepEqual({ mode: online.mode, portal: online.portal, login: online.login },
        { mode: "online", portal: 1, login: { account: true, guest: true, local: false } })

    process.env.REFLIPPED_PROFILE = "local"
    const local = (await fastify.inject({ method: "GET", url: "/shell/config" })).json()
    assert.deepEqual({ mode: local.mode, portal: local.portal, login: local.login },
        { mode: "local", portal: 0, login: { account: false, guest: true, local: true } })
    assert.equal(local.reflipped, 1)
})
