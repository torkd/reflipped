// Portal users and device link codes (ACC-1, docs/accounts.md "Data model"). The game never sees these: it keeps
// logging in as a device guest (`accounts`), and `accounts.user_id` says which user, if any, owns that account.
// Times are real time, not the server clock: they are about logins and code expiry, not game content.
import type { Statement } from "./sqlite";
import getDatabase, { Database } from ".";
import { generateLinkCode, hashLinkCode, LINK_CODE_LIFETIME_MS, normalizeLinkCode } from "../lib/linkCode";

export type UserRole = "player" | "admin"

export interface User {
    id: number
    /** unique, compared without case */
    username: string
    /** argon2id encoded hash (src/lib/password.ts) */
    passwordHash: string
    /** unique without case when set */
    email: string | null
    role: UserRole
    createdTime: Date
    lastLoginTime: Date | null
    /** base32 TOTP secret when the second factor is on (src/lib/totp.ts) */
    totpSecret: string | null
    /** an admin lets the user move their player's clock on the portal (ACC-8; `PORTAL_TIME_TRAVEL=all` lets everyone) */
    timeTravel: boolean
}

type UserRow = {
    id: number
    username: string
    password_hash: string
    email: string | null
    role: UserRole
    created_time: string
    last_login_time: string | null
    totp_secret: string | null
    time_travel: number
}

const USER_COLUMNS = `id, username, password_hash, email, role, created_time, last_login_time, totp_secret, time_travel`

let statements: {
    insert: Statement<[string, string, string | null, UserRole, string]>
    byId: Statement<[number]>
    byUsername: Statement<[string]>
    byEmail: Statement<[string]>
    setPasswordHash: Statement<[string, number]>
    setEmail: Statement<[string | null, number]>
    setRole: Statement<[UserRole, number]>
    setLastLogin: Statement<[string, number]>
    setTotp: Statement<[string | null, number]>
    useTotpStep: Statement<[number, number, number]>
    all: Statement<[]>
    delete: Statement<[number]>
    setAccountUser: Statement<[number | null, number]>
    accountUser: Statement<[number]>
    userAccounts: Statement<[number]>
    clearUnusedCodes: Statement<[number]>
    insertCode: Statement<[string, number, string]>
    redeemCode: Statement<[string, string, string]>
    deleteExpiredCodes: Statement<[string]>
    countAdmins: Statement<[]>
    setTimeTravel: Statement<[number, number]>
} | null = null

/** Prepared on first use, so importing this module doesn't open the database. */
function db() {
    if (statements) return statements
    const database = getDatabase(Database.WDFP_DATA)
    statements = {
        insert: database.prepare(`INSERT INTO users (username, password_hash, email, role, created_time) VALUES (?, ?, ?, ?, ?) RETURNING ${USER_COLUMNS}`),
        byId: database.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`),
        byUsername: database.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`),
        byEmail: database.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`),
        setPasswordHash: database.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`),
        setEmail: database.prepare(`UPDATE users SET email = ? WHERE id = ?`),
        setRole: database.prepare(`UPDATE users SET role = ? WHERE id = ?`),
        setTimeTravel: database.prepare(`UPDATE users SET time_travel = ? WHERE id = ?`),
        countAdmins: database.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`),
        setLastLogin: database.prepare(`UPDATE users SET last_login_time = ? WHERE id = ?`),
        setTotp: database.prepare(`UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?`),
        useTotpStep: database.prepare(`UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_secret IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < ?)`),
        all: database.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY username`),
        delete: database.prepare(`DELETE FROM users WHERE id = ?`),
        setAccountUser: database.prepare(`UPDATE accounts SET user_id = ? WHERE id = ?`),
        accountUser: database.prepare(`SELECT user_id FROM accounts WHERE id = ?`),
        userAccounts: database.prepare(`SELECT id FROM accounts WHERE user_id = ? ORDER BY last_login_time DESC, id DESC`),
        clearUnusedCodes: database.prepare(`DELETE FROM link_codes WHERE user_id = ? AND used_time IS NULL`),
        insertCode: database.prepare(`INSERT INTO link_codes (code_hash, user_id, expires) VALUES (?, ?, ?)`),
        redeemCode: database.prepare(`UPDATE link_codes SET used_time = ? WHERE code_hash = ? AND used_time IS NULL AND expires > ? RETURNING user_id`),
        deleteExpiredCodes: database.prepare(`DELETE FROM link_codes WHERE expires <= ?`)
    }
    return statements
}

function userOf(row: UserRow | undefined): User | null {
    if (row === undefined) return null
    return {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        email: row.email,
        role: row.role,
        createdTime: new Date(row.created_time),
        lastLoginTime: row.last_login_time === null ? null : new Date(row.last_login_time),
        totpSecret: row.totp_secret,
        timeTravel: row.time_travel !== 0
    }
}

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string })?.code === "SQLITE_CONSTRAINT_UNIQUE"
}

/** Adds a user; null when the username or email is taken (case doesn't matter). Hash the password first (hashPassword). */
export function createUserSync(user: { username: string, passwordHash: string, email?: string | null, role?: UserRole }): User | null {
    try {
        return userOf(db().insert.get(user.username, user.passwordHash, user.email ?? null, user.role ?? "player", new Date().toISOString()) as UserRow)
    } catch (error) {
        if (isUniqueViolation(error)) return null
        throw error
    }
}

export function getUserSync(userId: number): User | null {
    return userOf(db().byId.get(userId) as UserRow | undefined)
}

/** The user with this username, compared without case. */
export function getUserByUsernameSync(username: string): User | null {
    return userOf(db().byUsername.get(username) as UserRow | undefined)
}

/** The user with this email, compared without case. */
export function getUserByEmailSync(email: string): User | null {
    return userOf(db().byEmail.get(email) as UserRow | undefined)
}

export function setUserPasswordHashSync(userId: number, passwordHash: string) {
    db().setPasswordHash.run(passwordHash, userId)
}

/** Sets or clears the user's email; false when another user has it. */
export function setUserEmailSync(userId: number, email: string | null): boolean {
    try {
        db().setEmail.run(email, userId)
        return true
    } catch (error) {
        if (isUniqueViolation(error)) return false
        throw error
    }
}

export function setUserRoleSync(userId: number, role: UserRole) {
    db().setRole.run(role, userId)
}

/** Lets the user move their player's clock on the portal, or stops it (ACC-8). */
export function setUserTimeTravelSync(userId: number, enabled: boolean) {
    db().setTimeTravel.run(enabled ? 1 : 0, userId)
}

/** How many users have the admin role (ACC-5: with none, the admin site offers to create the first). */
export function countAdminsSync(): number {
    return (db().countAdmins.get() as { count: number }).count
}

/** Records a portal login now. */
export function setUserLastLoginSync(userId: number, time: Date = new Date()) {
    db().setLastLogin.run(time.toISOString(), userId)
}

/** Turns the TOTP second factor on with this secret, or (null) off. */
export function setUserTotpSync(userId: number, secret: string | null) {
    db().setTotp.run(secret, userId)
}

/**
 * Records that a TOTP code of this time step was accepted; false when that step or a later one was used already, so
 * a code can't be replayed (RFC 6238 section 5.2).
 */
export function useUserTotpStepSync(userId: number, step: number): boolean {
    return db().useTotpStep.run(step, userId, step).changes > 0
}

/** Every user, by username. */
export function getAllUsersSync(): User[] {
    return (db().all.all() as UserRow[]).map(row => userOf(row)!)
}

/** Deletes the user, its link codes and portal sessions; its device accounts and saves stay, as guests. */
export function deleteUserSync(userId: number) {
    db().delete.run(userId)
}

/** Gives a device account to a user, or (null) makes it a guest again. */
export function setAccountUserSync(accountId: number, userId: number | null) {
    db().setAccountUser.run(userId, accountId)
}

/** The user owning a device account; null for a guest or an unknown account. */
export function getAccountUserIdSync(accountId: number): number | null {
    const row = db().accountUser.get(accountId) as { user_id: number | null } | undefined
    return row?.user_id ?? null
}

/** The user's device accounts, most recently used first. */
export function getUserAccountIdsSync(userId: number): number[] {
    return (db().userAccounts.all(userId) as { id: number }[]).map(row => row.id)
}

/**
 * Issues a new link code for the user and returns it; the user's earlier unused codes stop working, so only the
 * latest one shown in the portal is live. It expires after LINK_CODE_LIFETIME_MS.
 */
export function createLinkCodeSync(userId: number, now: Date = new Date()): { code: string, expires: Date } {
    const expires = new Date(now.getTime() + LINK_CODE_LIFETIME_MS)
    const statements = db()
    for (;;) {
        const code = generateLinkCode()
        try {
            getDatabase(Database.WDFP_DATA).transaction(() => {
                statements.clearUnusedCodes.run(userId)
                statements.insertCode.run(hashLinkCode(code), userId, expires.toISOString())
            })()
            return { code, expires }
        } catch (error) {
            // another live or used code has the same hash: draw again
            if ((error as { code?: string })?.code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw error
        }
    }
}

/** Uses up a link code and returns its user; null when it is unknown, used or expired. Typing variations are accepted. */
export function redeemLinkCodeSync(input: string, now: Date = new Date()): number | null {
    const code = normalizeLinkCode(input)
    if (code === null) return null
    const nowISO = now.toISOString()
    const row = db().redeemCode.get(nowISO, hashLinkCode(code), nowISO) as { user_id: number } | undefined
    return row?.user_id ?? null
}

/** Removes expired codes, used or not; returns how many. */
export function deleteExpiredLinkCodesSync(now: Date = new Date()): number {
    return db().deleteExpiredCodes.run(now.toISOString()).changes
}
