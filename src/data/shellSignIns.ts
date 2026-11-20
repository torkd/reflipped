// One-time codes for the shell's portal sign-in (ACC-3, docs/accounts.md "Shell login"). The portal makes one when a
// logged-in user presses Play in the shell's WebView and hands it to the shell in a URL the shell intercepts; the
// shell trades it for a device token (POST /portal/shell/token). Codes are random 256-bit strings, live two minutes
// and work once; only their SHA-256 is stored, as for every other token. Real time, not the server clock.
import type { Statement } from "./sqlite";
import { createHash, randomBytes } from "crypto";
import getDatabase, { Database } from ".";

export const SHELL_SIGN_IN_LIFETIME_MS = 2 * 60 * 1000

let statements: {
    insert: Statement<[string, number, string]>
    redeem: Statement<[string, string]>
    deleteExpired: Statement<[string]>
} | null = null

/** Prepared on first use, so importing this module doesn't open the database. */
function db() {
    if (statements) return statements
    const database = getDatabase(Database.WDFP_DATA)
    statements = {
        insert: database.prepare(`INSERT INTO shell_sign_ins (code_hash, user_id, expires) VALUES (?, ?, ?)`),
        redeem: database.prepare(`DELETE FROM shell_sign_ins WHERE code_hash = ? AND expires > ? RETURNING user_id`),
        deleteExpired: database.prepare(`DELETE FROM shell_sign_ins WHERE expires <= ?`)
    }
    return statements
}

function hashCode(code: string): string {
    return createHash("sha256").update(code, "utf8").digest("hex")
}

/** A new code for the user; not stored anywhere but as its hash. */
export function createShellSignInSync(userId: number, now: Date = new Date()): string {
    const code = randomBytes(32).toString("base64url")
    db().insert.run(hashCode(code), userId, new Date(now.getTime() + SHELL_SIGN_IN_LIFETIME_MS).toISOString())
    return code
}

/** Uses up a code and returns its user; null when unknown, used or expired. */
export function redeemShellSignInSync(code: string, now: Date = new Date()): number | null {
    const row = db().redeem.get(hashCode(code), now.toISOString()) as { user_id: number } | undefined
    return row?.user_id ?? null
}

/** Removes expired codes; returns how many. */
export function deleteExpiredShellSignInsSync(now: Date = new Date()): number {
    return db().deleteExpired.run(now.toISOString()).changes
}
