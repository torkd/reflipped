/**
 * Deleting a save (FT-59, docs/accounts.md "Deleting a save"): from the game's account menu (`tool/unregister`, which
 * the original APK sends; the Reflipped app's menu opens the portal instead) or from the portal. Owner decision
 * 2026-11-18: the save is deleted, and the account (its login: the portal user, or the guest's device binding) stays,
 * so the next launch signs up again and starts a new save. The account's sessions end, so a device still playing it
 * goes back to the title.
 *
 * The deleted save is kept for {@link DELETED_SAVE_DAYS} days (real time), gzipped, with the records a save file doesn't
 * hold (as developer mode keeps them), so an admin can restore it (the admin site's Players page). A save in developer
 * mode keeps the player's own save from before the unlock. Restoring puts the save back under its old player ID and
 * replaces a save the account started since.
 */
import { gunzipSync, gzipSync } from "zlib";
import { deserializePlayerData, getClientSerializedData } from "../data/utils";
import type { PlayerProgressRecords } from "../data/wdfpData";
import {
    deleteAccountSessionsSync, deletePlayerSync, getAccountFromPlayerIdSync, getAccountSync, getPlayerFromAccountIdSync, getPlayerProgressRecordsSync,
    getPlayerSync, insertMergedPlayerDataSync, replacePlayerDataSync, runInTransactionSync
} from "../data/wdfpData";
import {
    DeletedSave, DeletionSource, deleteDeletedSaveSync, getDeletedSaveSync, insertDeletedSaveSync, listDeletedSavesSync,
    purgeExpiredDeletedSavesSync
} from "../data/deletedSaves";
import { forgetUnlockBackup, unlockBackupSave } from "./developerMode";
import { playerRankSync } from "./assets";
import { runOnPlayerClockSync } from "./playerClock";

/** How long a deleted save is kept for an admin to restore (owner decision 2026-11-18). */
export const DELETED_SAVE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** What a kept save holds: the save as its file has it, and the server-side records. */
interface KeptSave {
    save: Record<string, unknown>
    progressRecords: unknown
}

/**
 * Deletes the player's save, keeping a copy, and ends the account's sessions. Returns the kept copy's ID, or null when
 * there is no such player.
 */
export function deleteSaveSync(playerId: number, source: DeletionSource, now: number = Date.now()): number | null {
    const player = getPlayerSync(playerId)
    if (player === null) return null
    const account = getAccountFromPlayerIdSync(playerId)?.id ?? null
    if (account === null) return null
    purgeExpiredDeletedSavesSync(now)
    const kept: KeptSave = unlockBackupSave(playerId) ?? {
        // on the player's clock, as their own /load and the save download see it: it decides which mail has expired
        save: runOnPlayerClockSync(playerId, () => getClientSerializedData(playerId, { serializeRushEventData: true, serializeSaveData: true })) as unknown as Record<string, unknown>,
        progressRecords: getPlayerProgressRecordsSync(playerId)
    }
    const data = gzipSync(Buffer.from(JSON.stringify(kept)))
    return runInTransactionSync(() => {
        const id = insertDeletedSaveSync({
            accountId: account, playerId, name: player.name, rank: playerRankSync(player.rankPoint), source,
            deletedAt: new Date(now), expiresAt: new Date(now + DELETED_SAVE_DAYS * DAY_MS)
        }, data)
        forgetUnlockBackup(playerId)
        deletePlayerSync(playerId)
        deleteAccountSessionsSync(account)
        return id
    })
}

/** The saves kept for restoring, newest first (expired ones are dropped first). */
export function listKeptSavesSync(now: number = Date.now()): DeletedSave[] {
    purgeExpiredDeletedSavesSync(now)
    return listDeletedSavesSync()
}

export type RestoreResult = "restored" | "missing" | "no-account"

/**
 * Puts a kept save back on its account under its old player ID, replacing the save the account started since (if
 * any), and ends the account's sessions so its device loads it. The kept copy is then gone.
 */
export function restoreDeletedSaveSync(id: number, now: number = Date.now()): RestoreResult {
    purgeExpiredDeletedSavesSync(now)
    const found = getDeletedSaveSync(id)
    if (found === null) return "missing"
    const { save: info, data } = found
    if (getAccountSync(info.accountId) === null) return "no-account"
    const kept = JSON.parse(gunzipSync(data).toString("utf-8")) as KeptSave
    runInTransactionSync(() => {
        const current = getPlayerFromAccountIdSync(info.accountId)
        if (current !== null) {
            forgetUnlockBackup(current.id)
            deletePlayerSync(current.id)
        }
        const restored = deserializePlayerData(info.playerId, kept.save as Parameters<typeof deserializePlayerData>[1])
        // first in under its old ID, then put back as developer mode Off does, with the records the file doesn't hold
        insertMergedPlayerDataSync(info.accountId, restored)
        const records = typeof kept.progressRecords === "object" && kept.progressRecords !== null ? kept.progressRecords : {}
        replacePlayerDataSync(restored, { progressRecords: records as PlayerProgressRecords })
        deleteAccountSessionsSync(info.accountId)
        deleteDeletedSaveSync(id)
    })
    return "restored"
}
