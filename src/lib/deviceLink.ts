// Device linking (ACC-4, docs/accounts.md "Device linking"): a device that plays as a guest, such as the original
// APK, which can't open the portal, or a shell whose player chose to play without an account, moves to a portal
// user's save with a one-time code from the portal (src/lib/linkCode.ts), typed in the game as the profile comment.
//
// A user has one save, played on one device at a time (as with the shell's sign-in, src/lib/shellSignIn.ts):
// - a user without a save takes over the device's guest account, which keeps playing as it is;
// - otherwise the device's secret moves to the user's account, and every session of both accounts ends, so the
//   device's next launch (or its next request, which fails and sends the game back to the title) loads the user's
//   save. The guest save stays behind, unbound, for an admin to find (ACC-7). The device that played the user's save
//   before no longer matches: a signed-in shell is told it was signed out, any other device starts a new guest.
//
// Unlink (ACC-6): `unlinkDeviceSync` lets the user give up the device their save is bound to (a lost or sold phone).
import { clearDeviceSecretHashSync, getAccountDeviceSecretHashSync, revokeAccountSessionsSync, runInTransactionSync, setAccountDeviceSecretHashSync } from "../data/wdfpData";
import { getAccountUserIdSync, getUserAccountIdsSync, redeemLinkCodeSync, setAccountUserSync } from "../data/users";
import { normalizeLinkCode } from "./linkCode";

export type DeviceLinkResult =
    /** the device now plays the user's save, from its next `/load` */
    | { outcome: "linked", accountId: number }
    /** the user had no save: the device's own account is now theirs */
    | { outcome: "claimed", accountId: number }
    /** the device already plays this user's save */
    | { outcome: "already", accountId: number }
    /** the code is unknown, used or expired; or the account tried too often */
    | { outcome: "invalid" | "locked" }
    /** the device plays another user's save; it can't be moved with a code (that user has to sign in elsewhere first) */
    | { outcome: "other-user" }

/** Wrong codes one account may try in FAILURE_WINDOW_MS. Codes have about 40 bits, so this only keeps the log quiet. */
export const LINK_FAILURE_LIMIT = 10
const FAILURE_WINDOW_MS = 15 * 60 * 1000

const failures = new Map<number, { count: number, since: number }>()

function recentFailures(accountId: number, now: number): number {
    const entry = failures.get(accountId)
    if (entry === undefined || now - entry.since >= FAILURE_WINDOW_MS) {
        failures.delete(accountId)
        return 0
    }
    return entry.count
}

function recordFailure(accountId: number, now: number) {
    const count = recentFailures(accountId, now)
    failures.set(accountId, { count: count + 1, since: count === 0 ? now : failures.get(accountId)!.since })
}

/** Forgets every account's wrong codes (tests). */
export function resetLinkFailures() {
    failures.clear()
}

/** Whether a profile comment is meant as a link code: 8 code symbols, ignoring case, spaces and dashes. */
export function looksLikeLinkCode(comment: string): boolean {
    return normalizeLinkCode(comment) !== null
}

/** Redeems `code` for the device playing `accountId` and moves the device to the code's user (see the top of this file). */
export function linkDeviceSync(accountId: number, code: string, now: Date = new Date()): DeviceLinkResult {
    const time = now.getTime()
    if (recentFailures(accountId, time) >= LINK_FAILURE_LIMIT) return { outcome: "locked" }
    return runInTransactionSync((): DeviceLinkResult => {
        const userId = redeemLinkCodeSync(code, now)
        if (userId === null) {
            recordFailure(accountId, time)
            return { outcome: "invalid" }
        }
        const owner = getAccountUserIdSync(accountId)
        if (owner === userId) return { outcome: "already", accountId }
        if (owner !== null) return { outcome: "other-user" }

        const target = getUserAccountIdsSync(userId)[0]
        if (target === undefined) {
            setAccountUserSync(accountId, userId)
            return { outcome: "claimed", accountId }
        }

        const secretHash = getAccountDeviceSecretHashSync(accountId)
        if (secretHash !== null) clearDeviceSecretHashSync(secretHash)
        setAccountDeviceSecretHashSync(target, secretHash)
        // both games reload: this device into the user's save (its viewer ID is free again, so /load adopts it for the
        // user's account), the device that played the save before into a sign-in or a new guest
        revokeAccountSessionsSync(accountId, { viewer: true })
        revokeAccountSessionsSync(target, { viewer: true })
        return { outcome: "linked", accountId: target }
    })
}

/**
 * Unlinks the device that plays the user's save (ACC-6, the portal's "Unlink device"): the save lets go of its device
 * secret and every session of it ends, the viewer session too, so the game on that device fails at its next request
 * and its next launch no longer finds the save (a signed-in shell is told it was signed out, a guest key starts a new
 * guest). The save itself is untouched; a shell sign-in or a link code binds it again.
 *
 * Only the user's own accounts let go of the secret, unlike the move in `linkDeviceSync`: a guest key shared with an
 * older guest account (duplicates from before SEC-5) is not that account's to lose, and with the user's account
 * unbound the device reaches that guest, never the save.
 *
 * @returns The user's accounts that were bound to a device.
 */
export function unlinkDeviceSync(userId: number): number[] {
    return runInTransactionSync(() => {
        const unbound: number[] = []
        for (const accountId of getUserAccountIdsSync(userId)) {
            if (getAccountDeviceSecretHashSync(accountId) !== null) {
                setAccountDeviceSecretHashSync(accountId, null)
                unbound.push(accountId)
            }
            revokeAccountSessionsSync(accountId, { viewer: true })
        }
        return unbound
    })
}
