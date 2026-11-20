// New community-card metadata coverage; no image downloads or live services.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestServer } from "./helpers"

test("community type and thumbnail are owner-editable, bounded, escaped and exposed with an online mode", async () => {
    const apiToken = "card-metadata-test-token-".repeat(3)
    const server = await createTestServer({ adminAuth: true, adminApiToken: apiToken })
    try {
        const settings = await import("../src/data/serverSettings")
        const config = async () => {
            const response = await server.fastify.inject({ method: "GET", url: "/shell/config" })
            assert.equal(response.statusCode, 200)
            assert.equal(response.headers["cache-control"], "no-store")
            return response.json()
        }
        const save = (payload: Record<string, unknown>) => server.admin.inject({ method: "POST", url: "/api/server/settings",
            headers: { authorization: `Bearer ${apiToken}` }, payload })
        const initial = await config()
        assert.equal(initial.type, "")
        assert.equal(initial.thumbnail, null)
        assert.equal(initial.mode, "online")
        const label = '<Sandbox> & "Custom"'
        const thumbnail = "https://images.example.org/community/thumbnail.png?width=320&v=2"
        const denied = await server.admin.inject({ method: "POST", url: "/api/server/settings", payload: { "server.type": "Other" } })
        assert.equal(denied.statusCode, 401)
        assert.equal((await save({ "server.type": `  ${label}  `, "server.thumbnail": thumbnail, "server.description": "Custom community" })).headers.location,
            "/settings?message=settings_saved")
        assert.equal(settings.getStoredText("server.type"), label)
        assert.equal(settings.getStoredText("server.thumbnail"), thumbnail)
        const edited = await config()
        assert.equal(edited.type, label)
        assert.equal(edited.thumbnail, thumbnail)
        assert.equal(edited.description, "Custom community")
        assert.equal(edited.mode, "online")
        const users = await import("../src/data/users")
        const boss = users.createUserSync({ username: "cardmetadataadmin", passwordHash: "unused", role: "admin" })!
        const { adminSessions } = await import("../src/data/adminSessions")
        const login = adminSessions.create(boss.id)
        const page = await server.admin.inject({ method: "GET", url: "/settings", headers: { cookie: `reflipped_admin=${login.token}` } })
        const typeInput = page.body.match(/<input\b[^>]*name="server\.type"[^>]*>/)![0]
        const thumbnailInput = page.body.match(/<input\b[^>]*name="server\.thumbnail"[^>]*>/)![0]
        assert.match(typeInput, /&lt;Sandbox&gt; &amp; &quot;Custom&quot;/)
        assert.match(typeInput, /maxlength="40"/)
        assert.match(thumbnailInput, /width=320&amp;v=2/)
        assert.match(thumbnailInput, /maxlength="2048"/)
        assert.doesNotMatch(typeInput, /\brequired\b/)
        assert.doesNotMatch(thumbnailInput, /\brequired\b/)
        const timing = settings.getSetting("coop.companion_delay_seconds")
        for (const invalid of ["/relative.png", "//images.example.org/image.png", "https:////images.example.org/image.png", "ftp://images.example.org/image.png",
            "javascript:alert(1)", "data:image/png;base64,AA", "file:///tmp/image.png", "https://user:pass@images.example.org/a.png",
            "https://@images.example.org/a.png", "https://images.example.org/a.png#fragment", "https://images.example.org/a b.png",
            "https://images.example.org/a\nb.png", "https://images.example.org\\a.png", "https://images.example.org:65536/a.png", "https://"]) {
            await save({ "server.thumbnail": invalid, "server.type": "Must roll back", "coop.companion_delay_seconds": 77 })
            assert.equal(settings.getTextSetting("server.thumbnail"), thumbnail, invalid)
            assert.equal(settings.getTextSetting("server.type"), label, invalid)
            assert.equal(settings.getSetting("coop.companion_delay_seconds"), timing, invalid)
        }
        for (const invalid of ["x".repeat(41), "two\nlines"]) {
            await save({ "server.type": invalid, "server.description": "Must roll back" })
            assert.equal(settings.getTextSetting("server.description"), "Custom community")
            assert.equal(settings.getTextSetting("server.type"), label)
        }
        const publicQuery = "https://images.example.org?owner=public@example.org&width=320"
        assert.equal((await save({ "server.thumbnail": publicQuery })).headers.location, "/settings?message=settings_saved")
        assert.equal((await config()).thumbnail, publicQuery, "public query strings are allowed without credential heuristics")
        const prefix = "https://images.example.org/"
        const maxUrl = prefix + "a".repeat(2048 - prefix.length)
        assert.equal((await save({ "server.type": "x".repeat(40), "server.thumbnail": maxUrl })).headers.location, "/settings?message=settings_saved")
        assert.equal((await config()).thumbnail.length, 2048)
        assert.equal((await save({ "server.thumbnail": maxUrl + "a", "server.type": "Must roll back" })).statusCode, 400)
        assert.equal(settings.getTextSetting("server.type"), "x".repeat(40))
        assert.equal((await save({ "server.thumbnail": "http://10.0.2.2:8302/thumbnail.png" })).headers.location, "/settings?message=settings_saved")
        assert.ok(settings.applyPreset("responsive"))
        assert.equal((await config()).type, "x".repeat(40), "performance presets preserve card identity")
        await save({ "server.type": " ", "server.thumbnail": " ", "server.mode": "local" })
        const cleared = await config()
        assert.equal(cleared.type, "")
        assert.equal(cleared.thumbnail, null)
        assert.equal(cleared.mode, "online", "owner labels and extra settings never change the online mode")
        await save({ "server.type": "Classic progression", "server.thumbnail": thumbnail })
        settings.resetSettings()
        assert.equal((await config()).thumbnail, null)
        assert.equal((await config()).type, "")
    } finally { await server.cleanup() }
})
