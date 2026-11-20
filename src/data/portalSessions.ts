// Portal login sessions (ACC-2, docs/accounts.md "Web portal"). The browser's cookie holds a random token; the
// database holds its SHA-256, so a copy of the database logs no one in. Each session has its own CSRF token for the
// portal's forms. A session that passed the password of a user with TOTP on is `mfaPending` until the code is given,
// and then replaced by a new one (new token), so the token seen before the second factor never becomes a full login.
// Times are real time, not the server clock.
import type { Statement } from "./sqlite";
import { createHash, randomBytes } from "crypto";
import getDatabase, { Database } from ".";

/** How long a session lasts without use; each use slides it forward. */
export const PORTAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** How long the step between the password and the TOTP code may take. */
export const MFA_PENDING_TTL_MS = 5 * 60 * 1000
/** A session is slid forward at most this often, so page views don't each write. */
const SLIDE_INTERVAL_MS = 60 * 60 * 1000

export interface PortalSession {
    userId: number
    csrfToken: string
    expires: Date
    mfaPending: boolean
    mfaFailures: number
    /** a TOTP secret shown on the setup page and not yet confirmed with a code */
    pendingTotpSecret: string | null
}

type SessionRow = {
    user_id: number
    csrf_token: string
    expires: string
    mfa_pending: number
    mfa_failures: number
    pending_totp_secret: string | null
}

type Statements = {
    insert: Statement<[string, number, string, string, string, number]>
    byToken: Statement<[string]>
    slide: Statement<[string, string]>
    delete: Statement<[string]>
    deleteForUser: Statement<[number]>
    deleteOthersForUser: Statement<[number, string]>
    countForUser: Statement<[number, string]>
    addMfaFailure: Statement<[string]>
    setPendingTotp: Statement<[string | null, string]>
    deleteExpired: Statement<[string]>
}

/**
 * The sessions of one login: the portal's (`portal_sessions`) or the admin site's (`admin_sessions`, ACC-5,
 * src/data/adminSessions.ts). Both tables have the same columns; keeping them apart means a portal cookie can never
 * open the admin site, whatever the user's role. Statements are prepared on first use, so importing this module
 * doesn't open the database.
 */
export class LoginSessionStore {
    private statements: Statements | null = null

    constructor(private readonly table: "portal_sessions" | "admin_sessions", readonly ttlMs: number) {
    }

    private db(): Statements {
        if (this.statements) return this.statements
        const database = getDatabase(Database.WDFP_DATA)
        const table = this.table
        this.statements = {
            insert: database.prepare(`INSERT INTO ${table} (token_hash, user_id, csrf_token, created_time, expires, mfa_pending) VALUES (?, ?, ?, ?, ?, ?)`),
            byToken: database.prepare(`SELECT user_id, csrf_token, expires, mfa_pending, mfa_failures, pending_totp_secret FROM ${table} WHERE token_hash = ?`),
            slide: database.prepare(`UPDATE ${table} SET expires = ? WHERE token_hash = ? AND mfa_pending = 0`),
            delete: database.prepare(`DELETE FROM ${table} WHERE token_hash = ?`),
            deleteForUser: database.prepare(`DELETE FROM ${table} WHERE user_id = ?`),
            deleteOthersForUser: database.prepare(`DELETE FROM ${table} WHERE user_id = ? AND token_hash != ?`),
            countForUser: database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ? AND mfa_pending = 0 AND expires > ?`),
            addMfaFailure: database.prepare(`UPDATE ${table} SET mfa_failures = mfa_failures + 1 WHERE token_hash = ? RETURNING mfa_failures`),
            setPendingTotp: database.prepare(`UPDATE ${table} SET pending_totp_secret = ? WHERE token_hash = ?`),
            deleteExpired: database.prepare(`DELETE FROM ${table} WHERE expires <= ?`)
        }
        return this.statements
    }

    /** Starts a session for the user and returns its cookie token, which is not stored anywhere. */
    create(userId: number, options: { mfaPending?: boolean } = {}, now: Date = new Date()): { token: string, session: PortalSession } {
        const token = randomToken()
        const mfaPending = options.mfaPending === true
        const expires = new Date(now.getTime() + (mfaPending ? MFA_PENDING_TTL_MS : this.ttlMs))
        const csrfToken = randomToken()
        this.db().insert.run(hashToken(token), userId, csrfToken, now.toISOString(), expires.toISOString(), mfaPending ? 1 : 0)
        return { token, session: { userId, csrfToken, expires, mfaPending, mfaFailures: 0, pendingTotpSecret: null } }
    }

    /** The session of a cookie token; null when unknown or expired (an expired one is deleted). Slides a full session forward. */
    get(token: string, now: Date = new Date()): PortalSession | null {
        const tokenHash = hashToken(token)
        const row = this.db().byToken.get(tokenHash) as SessionRow | undefined
        if (row === undefined) return null
        const expires = new Date(row.expires)
        if (!(expires.getTime() > now.getTime())) {
            this.db().delete.run(tokenHash)
            return null
        }
        const session: PortalSession = {
            userId: row.user_id,
            csrfToken: row.csrf_token,
            expires,
            mfaPending: row.mfa_pending !== 0,
            mfaFailures: row.mfa_failures,
            pendingTotpSecret: row.pending_totp_secret
        }
        const slideInterval = Math.min(SLIDE_INTERVAL_MS, this.ttlMs / 4)
        if (!session.mfaPending && expires.getTime() - now.getTime() < this.ttlMs - slideInterval) {
            session.expires = new Date(now.getTime() + this.ttlMs)
            this.db().slide.run(session.expires.toISOString(), tokenHash)
        }
        return session
    }

    /** Ends one session (logout). */
    delete(token: string) {
        this.db().delete.run(hashToken(token))
    }

    /** Ends every session of the user, or every one but `exceptToken` (the one that changed the password). */
    deleteForUser(userId: number, exceptToken?: string): number {
        return exceptToken === undefined
            ? this.db().deleteForUser.run(userId).changes
            : this.db().deleteOthersForUser.run(userId, hashToken(exceptToken)).changes
    }

    /** How many full (not pending, not expired) sessions the user has. */
    countForUser(userId: number, now: Date = new Date()): number {
        return (this.db().countForUser.get(userId, now.toISOString()) as { count: number }).count
    }

    /** Counts a wrong TOTP code on a pending session; returns the failures so far. */
    addMfaFailure(token: string): number {
        const row = this.db().addMfaFailure.get(hashToken(token)) as { mfa_failures: number } | undefined
        return row?.mfa_failures ?? 0
    }

    /** Keeps the TOTP secret the setup page shows until it is confirmed (or, null, drops it). */
    setPendingTotp(token: string, secret: string | null) {
        this.db().setPendingTotp.run(secret, hashToken(token))
    }

    /** Removes expired sessions; returns how many. */
    deleteExpired(now: Date = new Date()): number {
        return this.db().deleteExpired.run(now.toISOString()).changes
    }
}

function hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex")
}

function randomToken(): string {
    return randomBytes(32).toString("base64url")
}

const portalStore = new LoginSessionStore("portal_sessions", PORTAL_SESSION_TTL_MS)

/** Starts a session for the user and returns its cookie token, which is not stored anywhere. */
export function createPortalSessionSync(userId: number, options: { mfaPending?: boolean } = {}, now: Date = new Date()): { token: string, session: PortalSession } {
    return portalStore.create(userId, options, now)
}

/** The session of a cookie token; null when unknown or expired (an expired one is deleted). Slides a full session forward. */
export function getPortalSessionSync(token: string, now: Date = new Date()): PortalSession | null {
    return portalStore.get(token, now)
}

/** Ends one session (logout). */
export function deletePortalSessionSync(token: string) {
    portalStore.delete(token)
}

/** Ends every session of the user, or every one but `exceptToken` (the one that changed the password). */
export function deleteUserPortalSessionsSync(userId: number, exceptToken?: string): number {
    return portalStore.deleteForUser(userId, exceptToken)
}

/** How many full (not pending, not expired) sessions the user has. */
export function countUserPortalSessionsSync(userId: number, now: Date = new Date()): number {
    return portalStore.countForUser(userId, now)
}

/** Counts a wrong TOTP code on a pending session; returns the failures so far. */
export function addPortalSessionMfaFailureSync(token: string): number {
    return portalStore.addMfaFailure(token)
}

/** Keeps the TOTP secret the setup page shows until it is confirmed (or, null, drops it). */
export function setPortalSessionPendingTotpSync(token: string, secret: string | null) {
    portalStore.setPendingTotp(token, secret)
}

/** Removes expired sessions; returns how many. */
export function deleteExpiredPortalSessionsSync(now: Date = new Date()): number {
    return portalStore.deleteExpired(now)
}
