import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import SqliteDatabase from "../src/data/sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestServer } from "./helpers";

// ACC-2: the player portal on the game listener, and the admin site's Users pages (docs/accounts.md "Web portal").

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let portalAuth: typeof import("../src/lib/portalAuth")
let totp: typeof import("../src/lib/totp")
let users: typeof import("../src/data/users")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
    portalAuth = await import("../src/lib/portalAuth")
    totp = await import("../src/lib/totp")
    users = await import("../src/data/users")
})

after(async () => {
    await cleanup()
})

beforeEach(() => {
    portalAuth.resetLoginFailures()
})

const PASSWORD = "correct horse battery"

/** The `reflipped_portal` cookie a reply sets, as a Cookie header ("" when it clears it). */
function cookieOf(response: LightMyRequestResponse): string | undefined {
    const header = response.headers["set-cookie"]
    const value = Array.isArray(header) ? header[0] : header
    if (value === undefined) return undefined
    const pair = value.split(";")[0]
    return pair.endsWith("=") ? "" : pair
}

function post(instance: FastifyInstance, url: string, form: Record<string, string>, cookie?: string, headers: Record<string, string> = {}) {
    return instance.inject({
        method: "POST", url,
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...headers },
        payload: new URLSearchParams(form).toString()
    })
}

function get(url: string, cookie?: string) {
    return fastify.inject({ method: "GET", url, headers: cookie ? { cookie } : {} })
}

/** The CSRF token of the page's forms. */
function csrfOf(html: string): string {
    const match = html.match(/name="csrf" value="([^"]+)"/)
    assert.ok(match, "the page has a CSRF field")
    return match[1]
}

async function register(username: string, password = PASSWORD): Promise<string> {
    const response = await post(fastify, "/portal/register", { username, password, confirm: password })
    assert.equal(response.statusCode, 302)
    assert.equal(response.headers.location, "/portal?message=welcome")
    const cookie = cookieOf(response)
    assert.ok(cookie)
    return cookie
}

async function login(username: string, password = PASSWORD): Promise<LightMyRequestResponse> {
    return post(fastify, "/portal/login", { username, password })
}

async function accountCsrf(cookie: string): Promise<string> {
    const page = await get("/portal", cookie)
    assert.equal(page.statusCode, 200)
    return csrfOf(page.body)
}

test("registering logs the player in with an HttpOnly, SameSite cookie", async () => {
    const response = await post(fastify, "/portal/register", { username: "alice", password: PASSWORD, confirm: PASSWORD })
    const setCookie = String(response.headers["set-cookie"])
    assert.match(setCookie, /^reflipped_portal=[A-Za-z0-9_-]+;/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Lax/)
    assert.doesNotMatch(setCookie, /Secure/, "plain HTTP: browsers would drop a Secure cookie")

    const page = await get("/portal", cookieOf(response))
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /<h1 class="page-title">alice<\/h1>/)
    assert.equal(page.headers["cache-control"], "no-store")
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/)
})

test("the portal without a login goes to the login page", async () => {
    const response = await get("/portal")
    assert.equal(response.statusCode, 302)
    assert.equal(response.headers.location, "/portal/login")
    assert.equal((await get("/portal/login")).statusCode, 200)
    assert.equal((await get("/portal", "reflipped_portal=not-a-session")).headers.location, "/portal/login")
})

test("registration checks the username and password", async () => {
    const cases: [Record<string, string>, string][] = [
        [{ username: "ab", password: PASSWORD, confirm: PASSWORD }, "username-length"],
        [{ username: "bad name", password: PASSWORD, confirm: PASSWORD }, "username-characters"],
        [{ username: "bobby", password: "short", confirm: "short" }, "password-short"],
        [{ username: "bobby", password: PASSWORD, confirm: PASSWORD + "x" }, "password-mismatch"],
        [{ username: "bobbybobby", password: "bobbybobby", confirm: "bobbybobby" }, "password-is-username"]
    ]
    for (const [form, error] of cases) {
        const response = await post(fastify, "/portal/register", form)
        assert.equal(response.headers.location, `/portal/register?error=${error}`)
    }
    await register("bobby")
    assert.equal((await post(fastify, "/portal/register", { username: "BOBBY", password: PASSWORD, confirm: PASSWORD })).headers.location, "/portal/register?error=taken")
})

test("login with the right password starts a session; a wrong one doesn't say which part was wrong", async () => {
    await register("carol")
    const wrong = await login("carol", "wrong password!")
    assert.equal(wrong.headers.location, "/portal/login?error=invalid")
    assert.equal(cookieOf(wrong), undefined)
    assert.equal((await login("nobody-here")).headers.location, "/portal/login?error=invalid")

    const right = await login("Carol")
    assert.equal(right.headers.location, "/portal")
    assert.equal((await get("/portal", cookieOf(right))).statusCode, 200)
    assert.ok(users.getUserByUsernameSync("carol")?.lastLoginTime)
})

test("logout needs the session's CSRF token and ends the session", async () => {
    const cookie = await register("dave")
    const csrf = await accountCsrf(cookie)

    await post(fastify, "/portal/logout", { csrf: "forged" }, cookie)
    assert.equal((await get("/portal", cookie)).statusCode, 200, "a forged token logs no one out")

    const response = await post(fastify, "/portal/logout", { csrf }, cookie)
    assert.equal(response.headers.location, "/portal/login?message=logged-out")
    assert.equal(cookieOf(response), "")
    assert.equal((await get("/portal", cookie)).headers.location, "/portal/login")
})

test("POSTs from another site are refused, and logged-in forms need the CSRF token", async () => {
    const cross = await post(fastify, "/portal/login", { username: "x", password: "y" }, undefined, { "sec-fetch-site": "cross-site" })
    assert.equal(cross.statusCode, 403)
    const foreignOrigin = await post(fastify, "/portal/login", { username: "x", password: "y" }, undefined, { origin: "https://evil.example", host: "localhost" })
    assert.equal(foreignOrigin.statusCode, 403)

    const cookie = await register("erin")
    const noToken = await post(fastify, "/portal/password", { csrf: "", current: PASSWORD, password: "a new password 1", confirm: "a new password 1" }, cookie)
    assert.equal(noToken.statusCode, 403)
})

test("changing the password needs the current one and ends the other sessions", async () => {
    const cookie = await register("frank")
    const other = cookieOf(await login("frank"))!
    const csrf = await accountCsrf(cookie)
    const next = "another long password"

    const wrong = await post(fastify, "/portal/password", { csrf, current: "not it at all", password: next, confirm: next }, cookie)
    assert.equal(wrong.headers.location, "/portal?error=current-wrong")

    const changed = await post(fastify, "/portal/password", { csrf, current: PASSWORD, password: next, confirm: next }, cookie)
    assert.equal(changed.headers.location, "/portal?message=password-changed")
    assert.equal((await get("/portal", cookie)).statusCode, 200, "this session stays")
    assert.equal((await get("/portal", other)).headers.location, "/portal/login", "the other one ended")
    assert.equal((await login("frank")).headers.location, "/portal/login?error=invalid")
    assert.equal((await login("frank", next)).headers.location, "/portal")
})

/** Turns TOTP on for the logged-in user and returns the secret and the step of the code used. */
async function enableTotp(cookie: string): Promise<{ secret: string, step: number }> {
    const page = await get("/portal/totp", cookie)
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /src="data:image\/png;base64,/)
    const secret = page.body.match(/<code[^>]*>([A-Z2-7 ]+)<\/code>/)![1].replace(/ /g, "")
    // the same secret on a reload
    assert.ok((await get("/portal/totp", cookie)).body.includes(secret.slice(0, 4)))
    const csrf = csrfOf(page.body)

    const valid = new Set([-1, 0, 1].map(offset => totp.totpCode(secret, totp.totpStep() + offset)))
    const wrong = ["000000", "111111", "222222", "333333"].find(code => !valid.has(code))!
    assert.equal((await post(fastify, "/portal/totp", { csrf, code: wrong }, cookie)).headers.location, "/portal/totp?error=invalid")
    const step = totp.totpStep()
    const on = await post(fastify, "/portal/totp", { csrf, code: totp.totpCode(secret, step) }, cookie)
    assert.equal(on.headers.location, "/portal?message=totp-on")
    return { secret, step }
}

test("with TOTP on, a login needs a code, which works once", async () => {
    const cookie = await register("grace")
    const { secret, step } = await enableTotp(cookie)

    const first = await login("grace")
    assert.equal(first.headers.location, "/portal/login/totp")
    const pending = cookieOf(first)!
    assert.equal((await get("/portal", pending)).headers.location, "/portal/login", "a pending login opens nothing")
    const csrf = csrfOf((await get("/portal/login/totp", pending)).body)

    // the code used to turn TOTP on can't be used again
    assert.equal((await post(fastify, "/portal/login/totp", { csrf, code: totp.totpCode(secret, step) }, pending)).headers.location, "/portal/login/totp?error=invalid")

    const next = totp.totpCode(secret, step + 1)
    const done = await post(fastify, "/portal/login/totp", { csrf, code: next }, pending)
    assert.equal(done.headers.location, "/portal")
    const full = cookieOf(done)!
    assert.notEqual(full, pending, "the full login gets a new token")
    assert.equal((await get("/portal", full)).statusCode, 200)
    assert.equal((await get("/portal", pending)).headers.location, "/portal/login")

    // replaying the same code on a new login fails
    const again = cookieOf(await login("grace"))!
    const againCsrf = csrfOf((await get("/portal/login/totp", again)).body)
    assert.equal((await post(fastify, "/portal/login/totp", { csrf: againCsrf, code: next }, again)).headers.location, "/portal/login/totp?error=invalid")
})

test("five wrong codes end the pending login", async () => {
    const cookie = await register("heidi")
    const { secret } = await enableTotp(cookie)
    const pending = cookieOf(await login("heidi"))!
    const csrf = csrfOf((await get("/portal/login/totp", pending)).body)
    const valid = new Set([-1, 0, 1].map(offset => totp.totpCode(secret, totp.totpStep() + offset)))
    const wrong = ["123456", "234567", "345678", "456789", "567890", "678901"].filter(code => !valid.has(code))
    let last: LightMyRequestResponse | undefined
    for (const code of wrong.slice(0, 5)) last = await post(fastify, "/portal/login/totp", { csrf, code }, pending)
    assert.equal(last!.headers.location, "/portal/login?error=totp-locked")
    assert.equal((await get("/portal/login/totp", pending)).headers.location, "/portal/login?error=totp-expired")
})

test("TOTP is turned off with the password", async () => {
    const cookie = await register("ivan")
    await enableTotp(cookie)
    const csrf = await accountCsrf(cookie)
    assert.equal((await post(fastify, "/portal/totp/disable", { csrf, password: "not the password" }, cookie)).headers.location, "/portal?error=totp-password-wrong")
    assert.equal((await post(fastify, "/portal/totp/disable", { csrf, password: PASSWORD }, cookie)).headers.location, "/portal?message=totp-off")
    assert.equal((await login("ivan")).headers.location, "/portal")
})

test("ten failed logins lock the username for a while, even with the right password", async () => {
    await register("judy")
    for (let i = 0; i < portalAuth.LOGIN_FAILURE_LIMIT; i++) await login("judy", `wrong password ${i}`)
    assert.equal((await login("judy")).headers.location, "/portal/login?error=locked")
    assert.equal((await login("JUDY")).headers.location, "/portal/login?error=locked")
    portalAuth.resetLoginFailures()
    assert.equal((await login("judy")).headers.location, "/portal")
})

test("with PORTAL_REGISTRATION=closed, only the admin creates users", async () => {
    process.env.PORTAL_REGISTRATION = "closed"
    try {
        assert.equal((await get("/portal/register")).headers.location, "/portal/login")
        const response = await post(fastify, "/portal/register", { username: "mallory", password: PASSWORD, confirm: PASSWORD })
        assert.equal(response.headers.location, "/portal/login")
        assert.equal(users.getUserByUsernameSync("mallory"), null)
        assert.doesNotMatch((await get("/portal/login")).body, /Create an account/)
    } finally {
        delete process.env.PORTAL_REGISTRATION
    }
})

test("over HTTPS behind a trusted proxy the cookie is Secure with the __Host- prefix", async () => {
    const { buildServer } = await import("../src/app")
    const proxied = buildServer({ trustProxy: true })
    try {
        const response = await post(proxied, "/portal/register", { username: "secure-sam", password: PASSWORD, confirm: PASSWORD }, undefined, { "x-forwarded-proto": "https" })
        const setCookie = String(response.headers["set-cookie"])
        assert.match(setCookie, /^__Host-reflipped_portal=/)
        assert.match(setCookie, /; Secure/)
        const page = await proxied.inject({ method: "GET", url: "/portal", headers: { cookie: cookieOf(response)!, "x-forwarded-proto": "https" } })
        assert.equal(page.statusCode, 200)
        assert.doesNotMatch(page.body, /isn't encrypted/)
    } finally {
        await proxied.close()
    }
})

test("the portal's POSTs have their own per-IP rate limit", async () => {
    const { buildServer } = await import("../src/app")
    const limited = buildServer({ rateLimit: { global: 0, portal: 2 } })
    try {
        const codes: number[] = []
        for (let i = 0; i < 3; i++) codes.push((await post(limited, "/portal/login", { username: "nobody", password: "whatever" })).statusCode)
        assert.deepEqual(codes, [302, 302, 429])
        assert.equal((await limited.inject({ method: "GET", url: "/portal/login" })).statusCode, 200, "pages aren't limited")
    } finally {
        await limited.close()
    }
})

test("admin: create a user, set a new password, turn TOTP off, end logins, delete", async () => {
    const created = await post(admin, "/api/user/create", { username: "kim", password: "admin given password", role: "player" })
    assert.match(String(created.headers.location), /^\/user\/\d+\?message=created$/)
    const id = Number(String(created.headers.location).match(/\/user\/(\d+)/)![1])
    assert.equal((await post(admin, "/api/user/create", { username: "KIM", password: "admin given password" })).headers.location, "/user?error=taken")
    assert.equal((await post(admin, "/api/user/create", { username: "lee", password: "short" })).headers.location, "/user?error=password-short")

    const list = await admin.inject({ method: "GET", url: "/user" })
    assert.equal(list.statusCode, 200)
    assert.match(list.body, /kim/)
    assert.equal((await admin.inject({ method: "GET", url: `/user/${id}` })).statusCode, 200)

    const cookie = cookieOf(await login("kim", "admin given password"))!
    await enableTotp(cookie)

    assert.equal((await post(admin, `/api/user/password?id=${id}`, { password: "a fresh password" })).headers.location, `/user/${id}?message=password-set`)
    assert.equal((await get("/portal", cookie)).headers.location, "/portal/login", "a new password ends the logins")

    assert.equal((await post(admin, `/api/user/totp/reset?id=${id}`, {})).headers.location, `/user/${id}?message=totp-off`)
    const fresh = await login("kim", "a fresh password")
    assert.equal(fresh.headers.location, "/portal", "no code asked after the reset")

    assert.equal((await post(admin, `/api/user/role?id=${id}`, { role: "admin" })).headers.location, `/user/${id}?message=role-set`)
    assert.equal(users.getUserSync(id)?.role, "admin")
    assert.equal((await post(admin, `/api/user/role?id=${id}`, { role: "root" })).statusCode, 400)

    assert.equal((await post(admin, `/api/user/logout?id=${id}`, {})).headers.location, `/user/${id}?message=logged-out`)
    assert.equal((await get("/portal", cookieOf(fresh))).headers.location, "/portal/login")

    // the only admin stays (ACC-5); with another admin, the user can go
    assert.equal((await post(admin, `/api/user/delete?id=${id}`, {})).headers.location, `/user/${id}?error=last-admin`)
    const other = users.createUserSync({ username: "kims-deputy", passwordHash: "x", role: "admin" })!
    assert.equal((await post(admin, `/api/user/delete?id=${id}`, {})).headers.location, "/user?message=deleted")
    assert.equal(users.getUserSync(id), null)
    users.deleteUserSync(other.id)
})

test("TOTP codes match RFC 6238's SHA-1 test vectors", () => {
    // RFC 6238 appendix B: the ASCII secret "12345678901234567890", 8 digits there; the last 6 here
    const secret = totp.base32Encode(Buffer.from("12345678901234567890"))
    const vectors: [number, string][] = [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [20000000000, "65353130"]]
    for (const [seconds, code] of vectors) {
        assert.equal(totp.totpCode(secret, Math.floor(seconds / 30)), code.slice(-6))
        assert.equal(totp.matchTotp(secret, code.slice(-6), new Date(seconds * 1000)), Math.floor(seconds / 30))
    }
    assert.equal(totp.base32Decode(totp.base32Encode(Buffer.from("hello world")))?.toString(), "hello world")
})

test("a version 7 database gets the TOTP columns", async () => {
    const { updateBeforeInit, updateAfterInit } = await import("../src/data/updaters/wdfpData")
    const { default: init } = await import("../src/data/initializers/wdfpData")
    const database = new SqliteDatabase(":memory:")
    database.pragma("foreign_keys = ON")
    // the users table as version 7 made it
    database.prepare(`CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
        email TEXT UNIQUE COLLATE NOCASE, role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
        created_time DATE NOT NULL, last_login_time DATE
    )`).run()
    database.prepare(`INSERT INTO users (username, password_hash, created_time) VALUES ('old', 'hash', '2026-10-31')`).run()

    updateBeforeInit(database, 7)
    init(database, true)
    updateAfterInit(database, 7)

    const columns = (database.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map(column => column.name)
    assert.ok(columns.includes("totp_secret") && columns.includes("totp_last_step"))
    assert.deepEqual(database.prepare(`SELECT totp_secret FROM users`).all(), [{ totp_secret: null }])
    const tables = (database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(row => row.name)
    assert.ok(tables.includes("portal_sessions"))
    database.close()
})
