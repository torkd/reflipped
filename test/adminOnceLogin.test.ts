import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestServer } from "./helpers";

// SH-13 step 5b: the server on the phone opens its admin site only through one-time logins the Reflipped app makes
// (a code in a file only the app can write); /setup and the password login stay closed.

let admin: FastifyInstance
let cleanup: () => Promise<void>
const dir = mkdtempSync(path.join(tmpdir(), "reflipped-once-"))
const file = path.join(dir, "admin-login")
const CODE = "ab".repeat(32)

before(async () => {
    process.env.ADMIN_LOGIN_CODE_FILE = file
    ;({ admin, cleanup } = await createTestServer({ adminAuth: true }))
})
after(async () => {
    delete process.env.ADMIN_LOGIN_CODE_FILE
    rmSync(dir, { recursive: true, force: true })
    await cleanup()
})

function get(url: string, cookie?: string, remoteAddress = "127.0.0.1") {
    return admin.inject({ method: "GET", url, remoteAddress, headers: cookie ? { cookie } : {} })
}

function sessionCookie(setCookie: string | string[] | undefined): string {
    const first = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""]).find(c => c.startsWith("reflipped_admin="))
    assert.ok(first, "an admin session cookie")
    return first.split(";")[0]
}

test("without a code the one-time login refuses, and /setup and /login point at the app", async () => {
    assert.equal((await get(`/login/once/${CODE}`)).statusCode, 403)
    const setup = await get("/setup")
    assert.equal(setup.statusCode, 302)
    assert.equal(setup.headers.location, "/login")
    const login = await get("/login")
    assert.equal(login.statusCode, 200)
    assert.match(login.body, /Reflipped app/)
})

test("a wrong code is refused without spending the real one, so other apps can't cancel the owner's login", async () => {
    writeFileSync(file, CODE)
    assert.equal((await get(`/login/once/${"cd".repeat(32)}`)).statusCode, 403)
    assert.equal((await get(`/login/once/x`)).statusCode, 403)
    assert.equal(existsSync(file), true)
    const reply = await get(`/login/once/${CODE}`)
    assert.equal(reply.statusCode, 302)
    assert.equal(existsSync(file), false)
})

test("a code from another address or older than two minutes is refused", async () => {
    writeFileSync(file, CODE)
    assert.equal((await get(`/login/once/${CODE}`, undefined, "192.168.1.50")).statusCode, 403)
    writeFileSync(file, CODE)
    const old = (Date.now() - 3 * 60 * 1000) / 1000
    utimesSync(file, old, old)
    assert.equal((await get(`/login/once/${CODE}`)).statusCode, 403)
})

test("the right code logs in once as the phone's admin", async () => {
    writeFileSync(file, CODE)
    const reply = await get(`/login/once/${CODE}`)
    assert.equal(reply.statusCode, 302)
    assert.equal(reply.headers.location, "/")
    const cookie = sessionCookie(reply.headers["set-cookie"])
    assert.equal((await get("/", cookie)).statusCode, 200)
    assert.equal(existsSync(file), false)
    // the same link again: used up
    assert.equal((await get(`/login/once/${CODE}`)).statusCode, 403)
})
