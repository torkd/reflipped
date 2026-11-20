// Binds a portal user's save to the device that signed in from the shell (ACC-3, docs/accounts.md "Shell login").
// A user has one save, bound to one device at a time: signing in on a device gives that device a new device token
// (the account's device secret from then on) and ends every session of the account, so the device that played
// before is refused until it signs in again.
import { getAccountsFromDeviceSecretHashSync, insertAccountSync, moveAccountViewerSessionsSync, revokeAccountSessionsSync, runInTransactionSync, setAccountDeviceSecretHashSync } from "../data/wdfpData";
import { getAccountUserIdSync, getUserAccountIdsSync, setAccountUserSync } from "../data/users";
import { deviceSecretFromBody, generateDeviceToken, generatePublicIdpId, hashDeviceSecret, isDeviceToken } from "./deviceSecret";

export interface DeviceSignIn {
    /** the new device secret; the shell sends it as `whiteKey` */
    token: string
    accountId: number
    /** how the account came to the user: it had one, the device's guest account, or a new one */
    source: "existing" | "claimed" | "new"
}

/**
 * Gives the user's save to this device. The user's account (most recently used, should there be several) is the
 * save; a user without one takes over the device's guest account, found by `guestKey` (the shell's own per-install
 * key), if it belongs to no user yet; otherwise a new account starts. `appId` is used only for a new account.
 */
export function signInDeviceSync(userId: number, guestKey: string | null, appId: string): DeviceSignIn {
    return runInTransactionSync(() => {
        // the device's guest account, found by its own install key (a device token is never a guest key: it already
        // belongs to a signed-in account); only one that belongs to no user
        const guestSecret = guestKey === null ? null : deviceSecretFromBody({ whiteKey: guestKey })
        const guest = guestSecret === null || isDeviceToken(guestSecret) ? undefined
            : getAccountsFromDeviceSecretHashSync(hashDeviceSecret(guestSecret)).find(account => getAccountUserIdSync(account.id) === null)

        let source: DeviceSignIn["source"] = "existing"
        let accountId: number | undefined = getUserAccountIdsSync(userId)[0]
        if (accountId === undefined) {
            if (guest !== undefined) {
                accountId = guest.id
                source = "claimed"
            } else {
                accountId = insertAccountSync({ appId, idpAlias: `${appId}:portal:${userId}`, idpCode: "zd3", idpId: generatePublicIdpId(), status: "normal" }).id
                source = "new"
            }
            setAccountUserSync(accountId, userId)
        }
        const token = generateDeviceToken()
        setAccountDeviceSecretHashSync(accountId, hashDeviceSecret(token))
        // the device that played before stops here: its tokens and its viewer session go
        revokeAccountSessionsSync(accountId, { viewer: true })
        // the device's game keeps the viewer ID it signed up with as a guest, and /load can't give the user's account an
        // ID another account holds: it comes along (the guest save stays behind, out of this device's reach)
        if (guest !== undefined && guest.id !== accountId) moveAccountViewerSessionsSync(guest.id, accountId)
        return { token, accountId, source }
    })
}

/**
 * Log out in the shell (ACC-12): the device gives up the account it plays with `token`. The account's sessions end,
 * its viewer session too, so the viewer ID the device's game keeps is free for whichever account it plays next (a login
 * revokes that account's own viewer sessions, and /load adopts a free ID). The account's device secret stays: nothing
 * else holds the token, and the next sign-in anywhere replaces it. An unknown token changes nothing.
 *
 * @returns Whether the token belonged to an account.
 */
export function signOutDeviceSync(token: string): boolean {
    if (!isDeviceToken(token)) return false
    return runInTransactionSync(() => {
        const accounts = getAccountsFromDeviceSecretHashSync(hashDeviceSecret(token))
        for (const account of accounts) revokeAccountSessionsSync(account.id, { viewer: true })
        return accounts.length > 0
    })
}

/** Release every account proven by an install key, including legacy duplicate/code-linked bindings. */
export function signOutInstallDeviceSync(whiteKey: string): boolean {
    const secret = deviceSecretFromBody({ whiteKey })
    if (secret === null || isDeviceToken(secret)) return false
    return runInTransactionSync(() => {
        const accounts = getAccountsFromDeviceSecretHashSync(hashDeviceSecret(secret))
        // loginDevice can select any legacy duplicate through its playerid tie-breaker. Logout carries no such
        // selector, so releasing only the first match could leave the device's actual viewer session bound.
        for (const account of accounts) revokeAccountSessionsSync(account.id, { viewer: true })
        return accounts.length > 0
    })
}
