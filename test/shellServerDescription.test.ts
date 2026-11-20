// New community-picker metadata coverage; isolated database only.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestServer } from "./helpers"

test("owner description is optional, bounded, persistent, escaped in Settings and public as plain metadata", async () => {
    const apiToken = "description-test-token-".repeat(3)
    const server = await createTestServer({ adminAuth: true, adminApiToken: apiToken })
    try {
        const { getStoredText, getTextSetting, getSetting, applyPreset, resetSettings } = await import("../src/data/serverSettings")
        const config = async () => {
            const response = await server.fastify.inject({ method: "GET", url: "/shell/config" })
            assert.equal(response.statusCode, 200)
            assert.equal(response.headers["cache-control"], "no-store")
            return response.json()
        }
        const save = (payload: Record<string, unknown>) => server.admin.inject({ method: "POST", url: "/api/server/settings",
            headers: { authorization: `Bearer ${apiToken}` }, payload })
        assert.equal((await config()).description, "")
        const denied = await server.admin.inject({ method: "POST", url: "/api/server/settings", payload: { "server.description": "Unauthenticated change" } })
        assert.equal(denied.statusCode, 401)
        assert.equal(getTextSetting("server.description"), "")
        const description = 'Casual <co-op> & "weekend" events — everyone welcome'
        assert.equal((await save({ "server.description": `  ${description}  ` })).headers.location, "/settings?message=settings_saved")
        assert.equal(getStoredText("server.description"), description)
        assert.equal((await config()).description, description)
        const users = await import("../src/data/users")
        const boss = users.createUserSync({ username: "descriptionadmin", passwordHash: "unused", role: "admin" })!
        const { adminSessions } = await import("../src/data/adminSessions")
        const login = adminSessions.create(boss.id)
        const page = await server.admin.inject({ method: "GET", url: "/settings", headers: { cookie: `reflipped_admin=${login.token}` } })
        assert.equal(page.statusCode, 200)
        const input = page.body.match(/<input\b[^>]*name="server\.description"[^>]*>/)![0]
        assert.match(input, /maxlength="500"/)
        assert.match(input, /Casual &lt;co-op&gt; &amp; &quot;weekend&quot;/)
        assert.doesNotMatch(input, /\brequired\b/)
        assert.ok(applyPreset("responsive"))
        assert.equal(getTextSetting("server.description"), description, "performance presets preserve identity")
        const originalTiming = getSetting("coop.companion_delay_seconds")
        for (const invalid of ["two\nlines", "control\u0000character", "x".repeat(501)]) {
            await save({ "server.description": invalid, "coop.companion_delay_seconds": 77 })
            assert.equal(getTextSetting("server.description"), description)
            assert.equal(getSetting("coop.companion_delay_seconds"), originalTiming, "invalid description rolls back the mixed save")
        }
        assert.equal((await save({ "server.description": "Must roll back", "server.name": "" })).headers.location, "/settings?error=invalid_text_setting")
        assert.equal(getTextSetting("server.description"), description, "name remains required")
        assert.equal((await save({ "server.description": "x".repeat(500) })).headers.location, "/settings?message=settings_saved")
        assert.equal((await config()).description.length, 500)
        const form = await server.admin.inject({ method: "POST", url: "/api/server/settings",
            headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/x-www-form-urlencoded" },
            payload: new URLSearchParams({ "server.description": "  " }).toString() })
        assert.equal(form.headers.location, "/settings?message=settings_saved")
        assert.equal(getStoredText("server.description"), "")
        assert.equal((await config()).description, "", "owners may remove the description")
        await save({ "server.description": description })
        resetSettings()
        assert.equal((await config()).description, "", "reset restores the empty default")
    } finally { await server.cleanup() }
})
