// New PERF-5 request-level coverage. Only temporary databases, no live/game database fixtures.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createTestServer } from "./helpers"

const cacheKey = "database.cache_mib"
const mapKey = "database.mmap_mib"

test("database Settings apply immediately, validate atomically, respect saved overrides and avoid presets", async () => {
    process.env.SQLITE_CACHE_MB = "16"
    process.env.SQLITE_MMAP_MB = "0"
    const server = await createTestServer()
    try {
        const { default: getDatabase, Database } = await import("../src/data")
        const { getSetting, presetKeys } = await import("../src/data/serverSettings")
        const { configureSqlite } = await import("../src/lib/sqliteTuning")
        const db = getDatabase(Database.WDFP_DATA)
        assert.equal(getSetting(cacheKey), 16)
        assert.equal(db.pragma("cache_size", { simple: true }), -16384)
        assert.equal(db.pragma("mmap_size", { simple: true }), 0)
        assert.equal(db.pragma("temp_store", { simple: true }), 1)
        // Probe this SQLite/platform's effective capability, then prove the HTTP path applies it.
        db.pragma("mmap_size = 67108864")
        const supportedMap = db.pragma("mmap_size", { simple: true }) as number
        assert.ok(supportedMap >= 0 && supportedMap <= 67108864)
        db.pragma("mmap_size = 0")
        assert.equal(db.pragma("mmap_size", { simple: true }), 0)
        const post = (payload: Record<string, unknown>) => server.admin.inject({ method: "POST", url: "/api/server/settings", payload })
        assert.equal((await post({ [cacheKey]: 32, [mapKey]: 64 })).headers.location, "/settings?message=settings_saved")
        assert.equal(db.pragma("cache_size", { simple: true }), -32768)
        const mapped = db.pragma("mmap_size", { simple: true }) as number
        assert.equal(mapped, supportedMap) // Catch a missing runtime apply while allowing platform clamping.
        assert.equal(getSetting(mapKey), 64)
        for (const payload of [{ [cacheKey]: 1 }, { [cacheKey]: 257 }, { [mapKey]: -1 }, { [mapKey]: 1025 },
            { [cacheKey]: "2.5" }, { [cacheKey]: 64, [mapKey]: "invalid" }]) {
            const response = await post(payload)
            assert.equal(response.statusCode, 302, JSON.stringify(payload))
            assert.equal(response.headers.location, "/settings?error=invalid_database_setting", JSON.stringify(payload))
            assert.equal(getSetting(cacheKey), 32)
            assert.equal(getSetting(mapKey), 64)
            assert.equal(db.pragma("cache_size", { simple: true }), -32768)
            assert.equal(db.pragma("mmap_size", { simple: true }), mapped)
        }
        const invalidShape = await post({ [cacheKey]: {} })
        assert.equal(invalidShape.statusCode, 400)
        assert.equal(invalidShape.json().code, "FST_ERR_VALIDATION")
        assert.equal(getSetting(cacheKey), 32)
        assert.equal(db.pragma("cache_size", { simple: true }), -32768)
        const secondsInvalid = await post({ "coop.companion_delay_seconds": "bad" })
        assert.equal(secondsInvalid.headers.location, "/settings?error=invalid_setting")
        const secondsPage = await server.admin.inject({ method: "GET", url: "/settings?error=invalid_setting" })
        assert.match(secondsPage.body, /every value must be a whole number of seconds within its range/)
        // The page's form-urlencoded save takes the same immediate-apply path.
        const form = await server.admin.inject({ method: "POST", url: "/api/server/settings",
            headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `${cacheKey}=8&${mapKey}=0` })
        assert.equal(form.headers.location, "/settings?message=settings_saved")
        assert.equal(db.pragma("cache_size", { simple: true }), -8192)
        assert.equal(db.pragma("mmap_size", { simple: true }), 0)
        process.env.SQLITE_CACHE_MB = "invalid-unused-default"
        process.env.SQLITE_MMAP_MB = "invalid-unused-default"
        configureSqlite(db) // Same reader used by startup; saved values win even over invalid unused env values.
        assert.equal(db.pragma("cache_size", { simple: true }), -8192)
        assert.equal(getSetting(cacheKey), 8)
        const page = await server.admin.inject({ method: "GET", url: "/settings?error=invalid_database_setting" })
        assert.equal(page.statusCode, 200)
        assert.match(page.body, /Database memory map/)
        assert.match(page.body, /class="unit">MiB/)
        assert.match(page.body, /class="unit">s/)
        assert.match(page.body, /seconds, MiB|MiB, seconds/)
        assert.ok(!presetKeys().includes(cacheKey) && !presetKeys().includes(mapKey))
        assert.equal((await server.admin.inject({ method: "POST", url: "/api/server/settingsPreset", payload: { preset: "responsive" } })).headers.location,
            "/settings?message=preset_applied")
        assert.equal(getSetting(cacheKey), 8)
        assert.equal(db.pragma("cache_size", { simple: true }), -8192)
        // Invalid env defaults must not destroy saved overrides on Reset.
        const failedReset = await server.admin.inject({ method: "POST", url: "/api/server/resetSettings" })
        assert.equal(failedReset.headers.location, "/settings?error=invalid_database_default")
        assert.equal(getSetting(cacheKey), 8)
        assert.equal(getSetting(mapKey), 0)
        assert.equal(db.pragma("cache_size", { simple: true }), -8192)
        // If an unsaved OTHER budget has an invalid default, a partial save also changes nothing.
        db.prepare("DELETE FROM server_settings WHERE key=?").run(mapKey)
        const failedSave = await post({ [cacheKey]: 32 })
        assert.equal(failedSave.headers.location, "/settings?error=invalid_database_default")
        assert.equal(getSetting(cacheKey), 8)
        assert.equal(db.pragma("cache_size", { simple: true }), -8192)
        assert.equal(db.prepare("SELECT value FROM server_settings WHERE key=?").get(mapKey), undefined)
        process.env.SQLITE_CACHE_MB = "16"
        process.env.SQLITE_MMAP_MB = "0"
        await server.admin.inject({ method: "POST", url: "/api/server/resetSettings" })
        assert.equal(getSetting(cacheKey), 16)
        assert.equal(db.pragma("cache_size", { simple: true }), -16384)
        assert.equal(db.pragma("mmap_size", { simple: true }), 0)
    } finally { await server.cleanup() }
})
