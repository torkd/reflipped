/**
 * Admin actions on a player's data: start over, or delete the player entirely.
 */
import { deleteAccountSync, deletePlayerSync, getAccountFromPlayerIdSync, insertDefaultPlayerSync, runInTransactionSync } from "../data/wdfpData";
import { forgetUnlockBackup } from "./developerMode";

/**
 * Replaces the player with a fresh default one on the same account, so the device stays signed in
 * and starts a new game. Returns the new player's id, or null if the player doesn't exist.
 */
export function resetPlayer(playerId: number): number | null {
    const account = getAccountFromPlayerIdSync(playerId)
    if (account === null) return null
    forgetUnlockBackup(playerId)
    // one transaction, so a failed insert keeps the old player
    return runInTransactionSync(() => {
        deletePlayerSync(playerId)
        return insertDefaultPlayerSync(account.id).id
    })
}

/**
 * Deletes the player's account and everything on it. The device signs in as a new guest next time
 * (the app may need its data cleared to forget the old login). False if the player doesn't exist.
 */
export function deletePlayer(playerId: number): boolean {
    const account = getAccountFromPlayerIdSync(playerId)
    if (account === null) return false
    forgetUnlockBackup(playerId)
    deleteAccountSync(account.id)
    return true
}
