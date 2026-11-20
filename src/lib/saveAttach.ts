// Admin-side attaching of saves to portal users (ACC-7, docs/accounts.md "Unlink and migration"). A user has one
// save (a device account with `user_id` set), played on one device at a time. Two saves are never merged: when the
// user already has one, the admin picks which of the two the user keeps, and the other is set aside as a guest save.
//
// - the user has no save: the account becomes theirs. Its device binding stays, so the device that plays it keeps
//   playing without a reload;
// - the user has a save: the attached account replaces it. The old account is detached (a guest save, kept for the
//   admin, with no device bound) and the device the user played on follows the user, as with a link code
//   (src/lib/deviceLink.ts): its secret moves to the attached account, a device that played the attached account
//   before loses it (it starts a new guest, or a shell is signed out), and every session of both accounts ends.
//   If the old account had no device bound, nobody follows and the attached account keeps whatever device it had.
import { getAccountFromPlayerIdSync, getPlayerFromAccountIdSync, getAccountSync, getAccountDeviceSecretHashSync, clearDeviceSecretHashSync, revokeAccountSessionsSync, runInTransactionSync, setAccountDeviceSecretHashSync } from "../data/wdfpData";
import { getAccountUserIdSync, getUserAccountIdsSync, getUserSync, setAccountUserSync } from "../data/users";

export type AttachResult =
    /** the user had no save: the account is now theirs and keeps its device */
    | { outcome: "attached", accountId: number }
    /** the user's save was replaced; `previousAccountId` is a guest save now */
    | { outcome: "replaced", accountId: number, previousAccountId: number }
    /** the account was the user's save already */
    | { outcome: "already", accountId: number }
    /** the account belongs to another user: detach it there first */
    | { outcome: "other-user", ownerId: number }
    | { outcome: "no-user" | "no-account" }

/** How an admin names a save: by its player number (the # in the Players list) or its PID (the game's account number). */
export type SaveNumberKind = "player" | "pid"

/** ADM-3: the save an admin names by `number`, or null if there is none (an account without a player isn't a save). */
export function findSaveSync(number: number, kind: SaveNumberKind): { accountId: number, playerId: number } | null {
    if (kind === "pid") {
        const player = getPlayerFromAccountIdSync(number)
        return player === null ? null : { accountId: number, playerId: player.id }
    }
    const account = getAccountFromPlayerIdSync(number)
    return account === null ? null : { accountId: account.id, playerId: number }
}

export type DetachResult =
    /** the user's save(s) are guest saves now, with their device bindings kept */
    | { outcome: "detached", accountIds: number[] }
    | { outcome: "no-user" | "no-save" }

/** Attaches `accountId` to the user as their save (see the top of this file). One transaction. */
export function attachSaveSync(userId: number, accountId: number): AttachResult {
    return runInTransactionSync((): AttachResult => {
        if (getUserSync(userId) === null) return { outcome: "no-user" }
        if (getAccountSync(accountId) === null) return { outcome: "no-account" }
        const owner = getAccountUserIdSync(accountId)
        if (owner === userId) return { outcome: "already", accountId }
        if (owner !== null) return { outcome: "other-user", ownerId: owner }

        const previous = getUserAccountIdsSync(userId)
        if (previous.length === 0) {
            setAccountUserSync(accountId, userId)
            return { outcome: "attached", accountId }
        }

        // the most recently used account is the user's save and holds the device that follows
        const secretHash = getAccountDeviceSecretHashSync(previous[0])
        if (secretHash !== null) {
            clearDeviceSecretHashSync(secretHash)
            setAccountDeviceSecretHashSync(accountId, secretHash)
        }
        for (const old of previous) {
            setAccountUserSync(old, null)
            revokeAccountSessionsSync(old, { viewer: true })
        }
        setAccountUserSync(accountId, userId)
        revokeAccountSessionsSync(accountId, { viewer: true })
        return { outcome: "replaced", accountId, previousAccountId: previous[0] }
    })
}

/**
 * Takes the user's save away: the account becomes a guest save. Its device binding stays, so the device that
 * plays it keeps playing it as a guest; its sessions end, so the game goes back to the title and reloads.
 */
export function detachSaveSync(userId: number): DetachResult {
    return runInTransactionSync((): DetachResult => {
        if (getUserSync(userId) === null) return { outcome: "no-user" }
        const accountIds = getUserAccountIdsSync(userId)
        if (accountIds.length === 0) return { outcome: "no-save" }
        for (const accountId of accountIds) {
            setAccountUserSync(accountId, null)
            revokeAccountSessionsSync(accountId, { viewer: true })
        }
        return { outcome: "detached", accountIds }
    })
}
