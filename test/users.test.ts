import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import SqliteDatabase from "../src/data/sqlite";
import { createTestServer } from "./helpers";

// ACC-1: portal users, accounts.user_id and link codes (docs/accounts.md "Data model").

type Users = typeof import("../src/data/users")
type WdfpData = typeof import("../src/data/wdfpData")

let users: Users
let wdfpData: WdfpData
let cleanup: () => Promise<void>

before(async () => {
    const server = await createTestServer()
    cleanup = server.cleanup
    users = await import("../src/data/users")
    wdfpData = await import("../src/data/wdfpData")
})

after(async () => {
    await cleanup()
})

let accountCount = 0
async function newAccount(): Promise<number> {
    accountCount++
    const account = await wdfpData.insertAccount({
        appId: "test", idpAlias: `test:device-${accountCount}:0`, idpCode: "zd3", idpId: String(1_000_000_000 + accountCount), status: "normal"
    })
    return account.id
}

test("a user is created with the player role and found by username or email without case", () => {
    const user = users.createUserSync({ username: "Alice", passwordHash: "hash", email: "Alice@Example.com" })
    assert.ok(user)
    assert.equal(user.role, "player")
    assert.equal(user.lastLoginTime, null)
    assert.ok(user.createdTime instanceof Date)
    assert.equal(users.getUserByUsernameSync("alice")?.id, user.id)
    assert.equal(users.getUserByEmailSync("alice@example.COM")?.id, user.id)
    assert.equal(users.getUserSync(user.id)?.username, "Alice")
    assert.equal(users.getUserByUsernameSync("nobody"), null)
})

test("a taken username or email gives null", () => {
    users.createUserSync({ username: "bob", passwordHash: "hash", email: "bob@example.com" })
    assert.equal(users.createUserSync({ username: "BOB", passwordHash: "hash" }), null)
    assert.equal(users.createUserSync({ username: "bob2", passwordHash: "hash", email: "BOB@example.com" }), null)
    const carol = users.createUserSync({ username: "carol", passwordHash: "hash" })!
    assert.equal(users.setUserEmailSync(carol.id, "bob@example.com"), false)
    assert.equal(users.setUserEmailSync(carol.id, "carol@example.com"), true)
    // users without an email don't clash
    assert.ok(users.createUserSync({ username: "dave", passwordHash: "hash" }))
})

test("an unknown role is refused by the schema", () => {
    assert.throws(() => users.createUserSync({ username: "mallory", passwordHash: "hash", role: "root" as never }))
})

test("password hash, role and last login are updated", () => {
    const user = users.createUserSync({ username: "erin", passwordHash: "old" })!
    users.setUserPasswordHashSync(user.id, "new")
    users.setUserRoleSync(user.id, "admin")
    const login = new Date("2026-10-31T12:00:00.000Z")
    users.setUserLastLoginSync(user.id, login)
    const updated = users.getUserSync(user.id)!
    assert.equal(updated.passwordHash, "new")
    assert.equal(updated.role, "admin")
    assert.equal(updated.lastLoginTime?.toISOString(), login.toISOString())
})

test("accounts belong to a user and go back to guests when the user is deleted", async () => {
    const user = users.createUserSync({ username: "frank", passwordHash: "hash" })!
    const first = await newAccount()
    const second = await newAccount()
    const guest = await newAccount()
    users.setAccountUserSync(first, user.id)
    users.setAccountUserSync(second, user.id)
    assert.equal(users.getAccountUserIdSync(first), user.id)
    assert.equal(users.getAccountUserIdSync(guest), null)
    assert.deepEqual(new Set(users.getUserAccountIdsSync(user.id)), new Set([first, second]))

    users.setAccountUserSync(second, null)
    assert.deepEqual(users.getUserAccountIdsSync(user.id), [first])

    users.deleteUserSync(user.id)
    assert.equal(users.getUserSync(user.id), null)
    assert.equal(users.getAccountUserIdSync(first), null)
    assert.ok(await wdfpData.getAccount(first), "the account and its save stay")
})

test("a link code is redeemed once, accepts typing variations, and the newest code replaces older ones", () => {
    const user = users.createUserSync({ username: "grace", passwordHash: "hash" })!
    const now = new Date("2026-10-31T12:00:00.000Z")
    const old = users.createLinkCodeSync(user.id, now)
    const { code, expires } = users.createLinkCodeSync(user.id, now)
    assert.match(code, /^[2-9A-HJKMNP-Z]{8}$/)
    assert.equal(expires.getTime() - now.getTime(), 10 * 60 * 1000)

    assert.equal(users.redeemLinkCodeSync(old.code, now), null, "the earlier code stopped working")
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `
    assert.equal(users.redeemLinkCodeSync(typed, now), user.id)
    assert.equal(users.redeemLinkCodeSync(code, now), null, "a code works once")
    assert.equal(users.redeemLinkCodeSync("not a code", now), null)
})

test("a link code expires and the cleanup removes expired codes", () => {
    const user = users.createUserSync({ username: "heidi", passwordHash: "hash" })!
    const now = new Date("2026-10-31T12:00:00.000Z")
    const { code, expires } = users.createLinkCodeSync(user.id, now)
    assert.equal(users.redeemLinkCodeSync(code, expires), null)
    assert.ok(users.deleteExpiredLinkCodesSync(expires) >= 1)
    assert.equal(users.deleteExpiredLinkCodesSync(expires), 0)
})

test("deleting a user deletes its link codes", () => {
    const user = users.createUserSync({ username: "ivan", passwordHash: "hash" })!
    const now = new Date()
    const { code } = users.createLinkCodeSync(user.id, now)
    users.deleteUserSync(user.id)
    assert.equal(users.redeemLinkCodeSync(code, now), null)
})

test("passwords are hashed with argon2id and verified", async () => {
    const { hashPassword, verifyPassword, passwordNeedsRehash, MAX_PASSWORD_LENGTH } = await import("../src/lib/password")
    const hash = await hashPassword("correct horse")
    assert.match(hash, /^\$argon2id\$/)
    assert.equal(await verifyPassword(hash, "correct horse"), true)
    assert.equal(await verifyPassword(hash, "wrong horse"), false)
    assert.equal(await verifyPassword(null, "correct horse"), false)
    assert.equal(await verifyPassword("not a hash", "correct horse"), false)
    assert.equal(await verifyPassword(hash, "x".repeat(MAX_PASSWORD_LENGTH + 1)), false)
    assert.equal(passwordNeedsRehash(hash), false)
    assert.equal(passwordNeedsRehash("$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"), true)
})

test("a version 6 database gets accounts.user_id and the new tables", async () => {
    const { updateBeforeInit, updateAfterInit } = await import("../src/data/updaters/wdfpData")
    const { default: init } = await import("../src/data/initializers/wdfpData")
    const database = new SqliteDatabase(":memory:")
    database.pragma("foreign_keys = ON")
    // the accounts table as version 6 made it
    database.prepare(`CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, first_login_time DATE NOT NULL, idp_alias TEXT NOT NULL,
        idp_code TEXT NOT NULL, idp_id TEXT NOT NULL, reg_time DATE NOT NULL, last_login_time DATE NOT NULL, status TEXT NOT NULL,
        device_secret_hash TEXT
    )`).run()
    database.prepare(`INSERT INTO accounts (app_id, first_login_time, idp_alias, idp_code, idp_id, reg_time, last_login_time, status)
        VALUES ('a', '2025-01-01', 'a:b:c', 'zd3', '1', '2025-01-01', '2025-01-01', 'normal')`).run()

    updateBeforeInit(database, 6)
    init(database, true)
    updateAfterInit(database, 6)

    const columns = (database.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[]).map(column => column.name)
    assert.ok(columns.includes("user_id"))
    assert.deepEqual(database.prepare(`SELECT user_id FROM accounts`).all(), [{ user_id: null }])
    const tables = (database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(row => row.name)
    assert.ok(tables.includes("users") && tables.includes("link_codes"))
    database.close()
})
