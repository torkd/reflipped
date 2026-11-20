import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestServer } from "./helpers";

// ACC-5: the admin site needs a login with an admin user (docs/accounts.md "Admin login"); the first admin is created
// on the server itself; `/api/*` also opens with the ADMIN_API_TOKEN. The tests run in order on one database.

const API_TOKEN = "t".repeat(40)
const PASSWORD = "correct horse battery"

let fastify: FastifyInstance
let admin: FastifyInstance
let cleanup: () => Promise<void>
let users: typeof import("../src/data/users")
let totp: typeof import("../src/lib/totp")

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer({ adminAuth: true, adminApiToken: API_TOKEN }))
    users = await import("../src/data/users")
    totp = await import("../src/lib/totp")
})
after(async () => {
    await cleanup()
})
beforeEach(async () => {
    (await import("../src/lib/portalAuth")).resetLoginFailures()
})

const REMOTE = "192.168.1.50"

function get(url: string, cookie?: string, remoteAddress = "127.0.0.1") {
    return admin.inject({ method: "GET", url, remoteAddress, headers: cookie ? { cookie } : {} })
}

function post(url: string, form: Record<string, string>, cookie?: string, remoteAddress = "127.0.0.1") {
    return admin.inject({
        method: "POST", url, remoteAddress,
        headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
        payload: new URLSearchParams(form).toString()
    })
}

function cookieOf(response: LightMyRequestResponse): string {
    const header = response.headers["set-cookie"]
    const value = String(Array.isArray(header) ? header[0] : header).split(";")[0]
    assert.match(value, /^reflipped_admin=[A-Za-z0-9_-]+$/)
    return value
}

async function login(username: string, password = PASSWORD, next?: string) {
    return post(next === undefined ? "/login" : `/login?next=${encodeURIComponent(next)}`, { username, password })
}

async function createUser(username: string, role: "player" | "admin") {
    const { hashPassword } = await import("../src/lib/password")
    return users.createUserSync({ username, passwordHash: await hashPassword(PASSWORD), role })!
}

test("with no admin yet, every page leads to the setup, which only opens on the server itself", async () => {
    assert.equal((await get("/")).headers.location, "/setup")
    assert.equal((await get("/login")).headers.location, "/setup")
    const api = await get("/api/server/clock")
    assert.equal(api.statusCode, 401)
    assert.match(api.json().message, /setup/)

    const remote = await get("/setup", undefined, REMOTE)
    assert.equal(remote.statusCode, 200)
    assert.match(remote.body, /ssh -L/)
    assert.doesNotMatch(remote.body, /action="\/setup"/)
    const remotePost = await post("/setup", { username: "intruder", password: PASSWORD, confirm: PASSWORD }, undefined, REMOTE)
    assert.equal(remotePost.headers.location, "/login")
    assert.equal(users.countAdminsSync(), 0)

    assert.equal((await post("/setup", { username: "boss", password: PASSWORD, confirm: "different password" })).headers.location, "/setup?error=password-mismatch")
    assert.equal(users.countAdminsSync(), 0)
})

test("the setup creates the first admin and logs them in; then it is closed", async () => {
    const page = await get("/setup")
    assert.match(page.body, /action="\/setup"/)
    const created = await post("/setup", { username: "boss", password: PASSWORD, confirm: PASSWORD })
    assert.equal(created.headers.location, "/")
    assert.equal(users.getUserByUsernameSync("boss")!.role, "admin")
    const dashboard = await get("/", cookieOf(created))
    assert.equal(dashboard.statusCode, 200)
    assert.match(dashboard.body, /action="\/logout"/)

    assert.equal((await get("/setup")).headers.location, "/login")
    assert.equal((await post("/setup", { username: "second", password: PASSWORD, confirm: PASSWORD })).headers.location, "/login")
    assert.equal(users.getUserByUsernameSync("second"), null)
})

test("only an admin's password logs in, and a page asked for is where the login returns", async () => {
    await createUser("someplayer", "player")
    assert.equal((await login("someplayer")).headers.location, "/login?error=invalid", "a player's right password")
    assert.equal((await login("boss", "wrong password!")).headers.location, "/login?error=invalid")
    assert.equal((await login("nobody")).headers.location, "/login?error=invalid")

    assert.equal((await get("/player")).headers.location, "/login?next=%2Fplayer")
    const loggedIn = await login("boss", PASSWORD, "/player")
    assert.equal(loggedIn.headers.location, "/player")
    assert.equal((await get("/player", cookieOf(loggedIn))).statusCode, 200)

    // never off the site
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "/login"])
        assert.equal((await login("boss", PASSWORD, next)).headers.location, "/", next)
})

test("without a login, POSTs and the API get a 401, and a portal login opens nothing here", async () => {
    assert.equal((await post("/api/server/time", { time: "2025-01-05T08:30" })).statusCode, 401)
    assert.equal((await get("/api/player")).statusCode, 401)

    // the boss's portal session, sent to the admin site under either cookie name
    const portal = await fastify.inject({
        method: "POST", url: "/portal/login", headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ username: "boss", password: PASSWORD }).toString()
    })
    const portalCookie = String(portal.headers["set-cookie"]).split(";")[0]
    const token = portalCookie.split("=")[1]
    assert.equal((await get("/", portalCookie)).statusCode, 302)
    assert.equal((await get("/", `reflipped_admin=${token}`)).statusCode, 302)
})

test("the API token opens /api/* only, and only when it matches", async () => {
    const withToken = (url: string, token: string) => admin.inject({ method: "GET", url, remoteAddress: "127.0.0.1", headers: { authorization: `Bearer ${token}` } })
    assert.equal((await withToken("/api/server/clock", API_TOKEN)).statusCode, 200)
    assert.equal((await withToken("/api/server/clock", "x".repeat(40))).statusCode, 401)
    assert.equal((await withToken("/", API_TOKEN)).statusCode, 302, "pages need a login")

    const { adminApiTokenFromEnv } = await import("../src/lib/adminAuth")
    const saved = process.env.ADMIN_API_TOKEN
    try {
        const warnings: string[] = []
        process.env.ADMIN_API_TOKEN = "short"
        assert.equal(adminApiTokenFromEnv(message => warnings.push(message)), null)
        assert.equal(warnings.length, 1)
        process.env.ADMIN_API_TOKEN = API_TOKEN
        assert.equal(adminApiTokenFromEnv(), API_TOKEN)
    } finally {
        if (saved === undefined) delete process.env.ADMIN_API_TOKEN
        else process.env.ADMIN_API_TOKEN = saved
    }
})

test("an admin with two-step login gives the code before the site opens", async () => {
    const user = await createUser("careful", "admin")
    const secret = totp.generateTotpSecret()
    users.setUserTotpSync(user.id, secret)

    const password = await login("careful", PASSWORD, "/settings")
    assert.equal(password.headers.location, "/login/totp?next=%2Fsettings")
    const pending = cookieOf(password)
    assert.equal((await get("/", pending)).statusCode, 302, "the password alone opens nothing")
    assert.equal((await get("/api/player", pending)).statusCode, 401)

    const valid = new Set([-1, 0, 1].map(offset => totp.totpCode(secret, totp.totpStep() + offset)))
    const wrong = ["000000", "111111", "222222", "333333"].find(code => !valid.has(code))!
    assert.equal((await post("/login/totp?next=%2Fsettings", { code: wrong }, pending)).headers.location, "/login/totp?error=invalid&next=%2Fsettings")
    const done = await post("/login/totp?next=%2Fsettings", { code: totp.totpCode(secret, totp.totpStep()) }, pending)
    assert.equal(done.headers.location, "/settings")
    const full = cookieOf(done)
    assert.notEqual(full, pending, "a new token for the full login")
    assert.equal((await get("/settings", full)).statusCode, 200)
    assert.equal((await get("/", pending)).statusCode, 302, "the pending token is gone")
})

test("logging out ends the session", async () => {
    const cookie = cookieOf(await login("boss"))
    assert.equal((await get("/", cookie)).statusCode, 200)
    assert.equal((await post("/logout", {}, cookie)).headers.location, "/login?message=logged-out")
    assert.equal((await get("/", cookie)).statusCode, 302)
})

test("a demoted admin's login ends at once, and the last admin stays one", async () => {
    const boss = users.getUserByUsernameSync("boss")!
    const careful = users.getUserByUsernameSync("careful")!
    const bossCookie = cookieOf(await login("boss"))

    // careful (TOTP) is demoted by boss: careful's sessions end
    const carefulSession = (await import("../src/data/adminSessions")).adminSessions.create(careful.id).token
    assert.equal((await get("/", `reflipped_admin=${carefulSession}`)).statusCode, 200)
    assert.equal((await post(`/api/user/role?id=${careful.id}`, { role: "player" }, bossCookie)).headers.location, `/user/${careful.id}?message=role-set`)
    assert.equal((await get("/", `reflipped_admin=${carefulSession}`)).statusCode, 302)

    // boss is now the only admin
    assert.equal((await post(`/api/user/role?id=${boss.id}`, { role: "player" }, bossCookie)).headers.location, `/user/${boss.id}?error=last-admin`)
    assert.equal((await post(`/api/user/delete?id=${boss.id}`, {}, bossCookie)).headers.location, `/user/${boss.id}?error=last-admin`)
    assert.equal(users.getUserSync(boss.id)!.role, "admin")
    assert.match((await get(`/user/${boss.id}?error=last-admin`, bossCookie)).body, /only admin/)

    // a role changed straight in the database also takes effect on the next request
    users.setUserRoleSync(boss.id, "player")
    assert.equal((await get("/", bossCookie)).statusCode, 302)
    users.setUserRoleSync(boss.id, "admin")
})

test("a new password ends the user's admin logins too", async () => {
    const boss = users.getUserByUsernameSync("boss")!
    const other = await createUser("deputy", "admin")
    const bossCookie = cookieOf(await login("boss"))
    const deputyCookie = cookieOf(await login("deputy"))
    assert.equal((await post(`/api/user/password?id=${other.id}`, { password: "another long password" }, bossCookie)).headers.location, `/user/${other.id}?message=password-set`)
    assert.equal((await get("/", deputyCookie)).statusCode, 302)
    assert.equal((await get("/", bossCookie)).statusCode, 200)
    assert.equal(users.getUserSync(boss.id)!.role, "admin")
})
