// SH-15: the update APK on /shell/config: the app downloads and installs it itself when the owner set its address and
// SHA-256 and a newer app is announced.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => { ({ fastify, admin, cleanup } = await createTestServer()) })
after(async () => { await cleanup() })

const SHA = "AB".repeat(32)

async function config() {
    const response = await fastify.inject({ method: "GET", url: "/shell/config", headers: { "reflipped-app-version": "0.1.0" } })
    assert.equal(response.statusCode, 200)
    return response.json()
}

function save(values: Record<string, string>) {
    return admin.inject({ method: "POST", url: "/api/server/settings", headers: { "content-type": "application/json" }, payload: { tab: "identity", ...values } })
}

test("no update APK by default", async () => {
    assert.equal((await config()).updateApk, null)
})

test("an APK address with its SHA-256 is offered only while a newer app is announced", async () => {
    await save({ "shell.update_apk_url": "https://example.org/reflipped-0.3.0.apk", "shell.update_apk_sha256": SHA })
    assert.equal((await config()).updateApk, null, "no newer version announced yet")
    await save({ "shell.latest_app_version": "0.3.0" })
    assert.deepEqual((await config()).updateApk, { url: "https://example.org/reflipped-0.3.0.apk", sha256: SHA.toLowerCase() })
})

test("an address without a SHA-256 offers no APK, and a malformed SHA-256 is refused", async () => {
    await save({ "shell.update_apk_sha256": "" })
    assert.equal((await config()).updateApk, null)
    const refused = await save({ "shell.update_apk_sha256": "not-a-hash" })
    assert.match(String(refused.headers.location), /error=invalid_text_setting/)
    assert.equal((await config()).updateApk, null)
})
