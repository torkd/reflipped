// SH-15: server version, the app/server handshake on /shell/config, the oldest supported app version, and the app
// version each account last signed in with.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import SqliteDatabase from "../src/data/sqlite";
import type { FastifyInstance } from "fastify";
import { createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";
import { version as packageVersion } from "../package.json";

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
const previousCommit = process.env.REFLIPPED_COMMIT

before(async () => {
    // run from the sources there is no out/build-info.json, so the override is the commit
    process.env.REFLIPPED_COMMIT = "0123456789ab"
    ;({ fastify, admin, cleanup } = await createTestServer())
})

after(async () => {
    if (previousCommit === undefined) delete process.env.REFLIPPED_COMMIT
    else process.env.REFLIPPED_COMMIT = previousCommit
    await cleanup()
})

async function config(headers: Record<string, string> = {}) {
    const response = await fastify.inject({ method: "GET", url: "/shell/config", headers })
    assert.equal(response.statusCode, 200)
    return response.json()
}

async function setMinimum(value: string) {
    return admin.inject({
        method: "POST", url: "/api/server/settings", headers: { "content-type": "application/json" },
        payload: { "shell.min_app_version": value }
    })
}

/** A new device signs in (loginDevice, with the app's headers if given) and signs up; returns its player ID. */
async function newPlayer(headers: Record<string, string>): Promise<number> {
    const deviceId = randomUUID()
    const login = await fastify.inject({
        method: "POST", url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json", ...headers },
        payload: { appId: "561429", deviceId, serialNo: deviceId, whiteKey: randomUUID() }
    })
    assert.equal(login.statusCode, 200, login.body)
    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST", url: "/latest/api/index.php/tool/signup", headers: gameHeaders(randomUUID().toUpperCase()),
        payload: encodeGameBody({
            app_secret: captured.app_secret, access_token: login.json().zat, storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin, kakao_pid: captured.kakao_pid, device_id: captured.device_id, idp_code: "zd3"
        })
    })
    assert.equal(signup.statusCode, 200, signup.body)
    const { getViewerPlayerIdSync } = await import("../src/data/wdfpData")
    return getViewerPlayerIdSync(decodeGameBody(signup.body).data_headers.viewer_id)!
}

test("app versions parse as MAJOR.MINOR.PATCH with an optional pre-release and compare numerically", async () => {
    const { compareAppVersions, normalizeAppBuild, normalizeAppVersion, parseAppVersion } = await import("../src/lib/appVersion")
    assert.deepEqual(parseAppVersion("0.10.2"), { text: "0.10.2", code: 100299 })
    assert.deepEqual(parseAppVersion("0.2.0-beta.3"), { text: "0.2.0-beta.3", code: 20033 })
    assert.deepEqual(parseAppVersion("1.0.0-pre"), { text: "1.0.0-pre", code: 1000060 })
    for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "1.2.x", "", "1000.0.0", "1.100.0", "1.0.100",
        "1.2.3-rc.1", "1.2.3-beta.30", "1.2.3-BETA", "1.2.3-beta.", "1.2.3-", "1.2.3-alpha.1.2", "1.2.3-alpha1",
        "1.2.3+build", 1])
        assert.equal(parseAppVersion(bad), null, String(bad))
    assert.ok(compareAppVersions(parseAppVersion("0.10.0")!, parseAppVersion("0.9.9")!) > 0, "not compared as text")
    assert.ok(compareAppVersions(parseAppVersion("1.0.0")!, parseAppVersion("1.0.1")!) < 0)
    assert.equal(compareAppVersions(parseAppVersion("01.0.0")!, parseAppVersion("1.0.0")!), 0)
    assert.equal(normalizeAppVersion(" 01.002.3 "), "1.2.3")
    assert.equal(normalizeAppVersion("00.02.000-beta.03"), "0.2.0-beta.3")
    assert.equal(normalizeAppVersion("0.2.0-alpha"), "0.2.0-alpha")
    assert.equal(normalizeAppBuild("0123456789ab-dirty.20261107.baked"), "0123456789ab-dirty.20261107.baked")
    assert.equal(normalizeAppBuild("<script>"), null)
    assert.equal(normalizeAppBuild("x".repeat(81)), null)
})

test("app versions order as semver and map to the Android version code build.py uses", async () => {
    const { compareAppVersions, parseAppVersion } = await import("../src/lib/appVersion")
    const ordered = ["0.2.0-alpha", "0.2.0-alpha.1", "0.2.0-alpha.2", "0.2.0-alpha.29", "0.2.0-beta", "0.2.0-beta.1",
        "0.2.0-pre", "0.2.0-pre.1", "0.2.0", "0.2.1-alpha", "0.2.1", "0.10.0-beta", "1.0.0-pre.29", "1.0.0"]
    for (let i = 1; i < ordered.length; i++)
        assert.ok(compareAppVersions(parseAppVersion(ordered[i - 1])!, parseAppVersion(ordered[i])!) < 0,
            `${ordered[i - 1]} < ${ordered[i]}`)
    const codes: Record<string, number> = {
        "0.1.0": 10099, "0.2.0-beta.1": 20031, "0.2.0-alpha": 20000, "0.2.0-alpha.29": 20029, "0.2.0-beta": 20030,
        "0.2.0-pre.1": 20061, "0.2.0-pre.29": 20089, "1.2.3": 1020399, "999.99.99": 999999999, "0.0.0": 99
    }
    for (const [text, code] of Object.entries(codes)) assert.equal(parseAppVersion(text)!.code, code, text)
    assert.equal(compareAppVersions(parseAppVersion("0.2.0-alpha")!, parseAppVersion("0.2.0-alpha.0")!), 0,
        "a missing pre-release number counts as 0")
})

test("/shell/config answers with the server version, commit, protocol and the default (any) minimum", async () => {
    const reply = await config()
    assert.equal(reply.version, packageVersion)
    assert.equal(reply.commit, "0123456789ab")
    assert.ok(Number.isInteger(reply.protocol) && reply.protocol >= 1)
    assert.equal(reply.minAppVersion, null)
    assert.equal(reply.appSupported, null, "a request naming no app version gets no verdict")
    assert.equal((await config({ "reflipped-app-version": "0.1.0", "reflipped-app-build": "abc.20261107.picker" })).appSupported, true)
})

test("the oldest supported app version is an admin setting that /shell/config reports", async () => {
    const saved = await setMinimum("0.2.0")
    assert.equal(saved.statusCode, 302)
    assert.equal(saved.headers.location, "/settings?message=settings_saved")
    assert.equal((await config()).minAppVersion, "0.2.0")
    assert.equal((await config({ "reflipped-app-version": "0.1.9" })).appSupported, false)
    assert.equal((await config({ "reflipped-app-version": "0.2.0" })).appSupported, true)
    assert.equal((await config({ "reflipped-app-version": "0.10.0" })).appSupported, true)
    assert.equal((await config({ "reflipped-app-version": "nonsense" })).appSupported, null)

    for (const bad of ["0.2", "latest", "0.2.0-rc.1", "0.2.0-beta.30", "0.2.0-BETA"]) {
        const refused = await setMinimum(bad)
        assert.equal(refused.headers.location, "/settings?error=invalid_app_version", bad)
    }
    assert.equal((await config()).minAppVersion, "0.2.0", "a refused value changes nothing")

    const page = await admin.inject({ method: "GET", url: "/settings" })
    assert.match(page.body, /Oldest supported app version/)
    assert.match(page.body, /name="shell\.min_app_version"[^>]*value="0\.2\.0"/)

    // a pre-release minimum: later pre-releases and the release meet it, earlier ones don't
    assert.equal((await setMinimum("0.2.0-beta.01")).headers.location, "/settings?message=settings_saved")
    assert.equal((await config()).minAppVersion, "0.2.0-beta.1", "the minimum is normalized")
    for (const [app, supported] of [["0.2.0-beta.2", true], ["0.2.0-beta.1", true], ["0.2.0-pre", true], ["0.2.0", true],
        ["0.2.0-beta", false], ["0.2.0-alpha.5", false], ["0.1.9", false]] as const)
        assert.equal((await config({ "reflipped-app-version": app })).appSupported, supported, app)
    assert.equal((await setMinimum("0.2.0")).headers.location, "/settings?message=settings_saved")
    assert.equal((await config({ "reflipped-app-version": "0.2.0-pre.29" })).appSupported, false, "a pre-release is below its release")

    await setMinimum("")
    assert.equal((await config()).minAppVersion, null, "blank accepts every version again")
})

test("GET /api/server/health on the admin listener reports the version and handshake", async () => {
    const response = await admin.inject({ method: "GET", url: "/api/server/health" })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["cache-control"], "no-store")
    const health = response.json()
    assert.equal(health.status, "ok")
    assert.equal(health.version, packageVersion)
    assert.equal(health.commit, "0123456789ab")
    assert.equal(health.protocol, (await config()).protocol)
    assert.equal(health.minAppVersion, null)
    assert.ok(Number.isInteger(health.uptimeSeconds))
    assert.equal((await fastify.inject({ method: "GET", url: "/api/server/health" })).statusCode, 404, "not on the game listener")
})

test("the admin dashboard shows the server version", async () => {
    const page = await admin.inject({ method: "GET", url: "/" })
    assert.equal(page.statusCode, 200)
    assert.ok(page.body.includes(`Reflipped server ${packageVersion} (0123456789ab)`))
})

test("the Players page shows the app version and build each account last signed in with", async () => {
    const current = await newPlayer({ "reflipped-app-version": "0.1.0", "reflipped-app-build": "0123456789ab.20261107.baked" })
    const older = await newPlayer({})
    const invalid = await newPlayer({ "reflipped-app-version": "0.1.0", "reflipped-app-build": "<b>bold</b>" })

    const detail = await admin.inject({ method: "GET", url: `/player/${current}` })
    assert.ok(detail.body.includes("App 0.1.0 · build 0123456789ab.20261107.baked"), "detail page")
    assert.ok((await admin.inject({ method: "GET", url: `/player/${older}` })).body.includes("Older app or original client"))
    const invalidPage = (await admin.inject({ method: "GET", url: `/player/${invalid}` })).body
    assert.ok(invalidPage.includes("App 0.1.0<") || invalidPage.includes("App 0.1.0\n"), "an unusable build is dropped, the version kept")
    assert.ok(!invalidPage.includes("<b>bold</b>"))

    const list = (await admin.inject({ method: "GET", url: "/player" })).body
    assert.ok(list.includes("App 0.1.0 · build 0123456789ab.20261107.baked"))
    assert.ok(list.includes("Older app or original client"))
})

test("a version 14 database gets the accounts' app columns", async () => {
    const { updateBeforeInit, updateAfterInit } = await import("../src/data/updaters/wdfpData")
    const { default: init } = await import("../src/data/initializers/wdfpData")
    const database = new SqliteDatabase(":memory:")
    database.pragma("foreign_keys = ON")
    // the accounts table as version 14 made it
    database.prepare(`CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, first_login_time DATE NOT NULL, idp_alias TEXT NOT NULL,
        idp_code TEXT NOT NULL, idp_id TEXT NOT NULL, reg_time DATE NOT NULL, last_login_time DATE NOT NULL, status TEXT NOT NULL,
        device_secret_hash TEXT, user_id INTEGER
    )`).run()
    database.prepare(`INSERT INTO accounts (app_id, first_login_time, idp_alias, idp_code, idp_id, reg_time, last_login_time, status)
        VALUES ('a', '2025-01-01', 'a:b:c', 'zd3', '1', '2025-01-01', '2025-01-01', 'normal')`).run()

    updateBeforeInit(database, 14)
    init(database, true)
    updateAfterInit(database, 14)

    const columns = (database.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[]).map(column => column.name)
    for (const column of ["app_version", "app_build", "app_seen_at"]) assert.ok(columns.includes(column), column)
    assert.deepEqual(database.prepare(`SELECT app_version, app_build, app_seen_at FROM accounts`).all(),
        [{ app_version: null, app_build: null, app_seen_at: null }])
    database.close()
})
