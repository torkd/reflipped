// SH-15: the update notice on /shell/config (newest app version, update page, notes) and its admin settings.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>

before(async () => { ({ fastify, admin, cleanup } = await createTestServer()) })
after(async () => { await cleanup() })

const GUIDE = "https://github.com/torkd/reflipped/blob/main/docs/connecting-air-shell.md"

async function config(version?: string) {
    const response = await fastify.inject({
        method: "GET", url: "/shell/config", headers: version ? { "reflipped-app-version": version } : {}
    })
    assert.equal(response.statusCode, 200)
    return response.json()
}

async function save(values: Record<string, string>) {
    return admin.inject({
        method: "POST", url: "/api/server/settings", headers: { "content-type": "application/json" }, payload: values
    })
}

test("no announcement by default: every field is null", async () => {
    const reply = await config("0.1.0")
    assert.equal(reply.latestAppVersion, null)
    assert.equal(reply.updateAvailable, false)
    assert.equal(reply.updateUrl, null)
    assert.equal(reply.updateNotes, null)
    assert.equal((await config()).updateAvailable, null, "a request naming no app version gets no verdict")
})

test("the newest app version announces an update to older apps, with the default guide link", async () => {
    assert.equal((await save({ "shell.latest_app_version": "0.3.0" })).headers.location, "/settings?message=settings_saved")
    const old = await config("0.2.0")
    assert.equal(old.latestAppVersion, "0.3.0")
    assert.equal(old.updateAvailable, true)
    assert.equal(old.updateUrl, GUIDE)
    assert.equal(old.updateNotes, null)
    assert.equal((await config("0.3.0")).updateAvailable, false)
    assert.equal((await config("0.10.0")).updateAvailable, false, "compared as numbers")
    assert.equal((await config("0.3.0-beta.2")).updateAvailable, true, "a pre-release is older than its release")
    assert.equal((await config()).updateAvailable, null)
    assert.equal((await config()).latestAppVersion, "0.3.0", "the version is public even to a request naming none")
})

test("the update page and notes are optional settings", async () => {
    const saved = await save({ "shell.update_url": "https://example.org/get-the-app", "shell.update_notes": "Fixes the lobby." })
    assert.equal(saved.headers.location, "/settings?message=settings_saved")
    const reply = await config("0.2.0")
    assert.equal(reply.updateUrl, "https://example.org/get-the-app")
    assert.equal(reply.updateNotes, "Fixes the lobby.")
    await save({ "shell.update_url": "", "shell.update_notes": "" })
    const cleared = await config("0.2.0")
    assert.equal(cleared.updateUrl, GUIDE)
    assert.equal(cleared.updateNotes, null)
})

test("a newest version below the oldest supported one is raised to it", async () => {
    await save({ "shell.min_app_version": "0.4.0" })
    const reply = await config("0.3.0")
    assert.equal(reply.minAppVersion, "0.4.0")
    assert.equal(reply.latestAppVersion, "0.4.0")
    assert.equal(reply.appSupported, false)
    assert.equal(reply.updateAvailable, true)
    assert.equal((await config("0.4.0")).updateAvailable, false)
    await save({ "shell.min_app_version": "" })
    assert.equal((await config()).latestAppVersion, "0.3.0")
})

test("bad values are refused and nothing is saved", async () => {
    const badVersion = await save({ "shell.latest_app_version": "latest", "shell.update_notes": "kept?" })
    assert.equal(badVersion.headers.location, "/settings?error=invalid_app_version")
    for (const url of ["javascript:alert(1)", "ftp://example.org/x", "https://user:pw@example.org/", "example.org", "https://example.org/#x", "https://exa mple.org"])
        assert.equal((await save({ "shell.update_url": url })).headers.location, "/settings?error=invalid_text_setting", url)
    assert.equal((await save({ "shell.update_notes": "x".repeat(281) })).statusCode, 400, "over the limit")
    assert.equal((await save({ "shell.update_notes": "two\nlines" })).headers.location, "/settings?error=invalid_text_setting")
    const reply = await config("0.2.0")
    assert.equal(reply.latestAppVersion, "0.3.0")
    assert.equal(reply.updateNotes, null)
})

test("the latest version is normalized, can be cleared, and shows on the Settings page", async () => {
    await save({ "shell.latest_app_version": "00.03.1-beta.01" })
    assert.equal((await config()).latestAppVersion, "0.3.1-beta.1")
    await save({ "shell.latest_app_version": "0.3.1-beta.1" })
    const page = await admin.inject({ method: "GET", url: "/settings" })
    assert.match(page.body, /Newest app version/)
    assert.match(page.body, /name="shell\.latest_app_version"[^>]*value="0\.3\.1-beta\.1"/)
    assert.match(page.body, /name="shell\.update_url"/)
    assert.match(page.body, /name="shell\.update_notes"/)
    await save({ "shell.latest_app_version": "" })
    const cleared = await config("0.1.0")
    assert.equal(cleared.latestAppVersion, null)
    assert.equal(cleared.updateAvailable, false)
})
