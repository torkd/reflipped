// Earned reward mail belongs to the player's server history, even when a save replaces the ordinary mailbox.
// A source key stays after its received mail is trimmed, so an older exported copy cannot reopen that gift.
import { randomUUID } from "crypto";
import getDatabase, { Database } from ".";
import type { PlayerMail } from "./types";
import { rewardMailFingerprint, storedRewardMailFingerprint, StoredRewardIdentity } from "./rewardMailIdentity";

const db = getDatabase(Database.WDFP_DATA)

interface RewardMailSource { sourceKey: string, mailId: number | null, fingerprint: string }
type ImportMail = Omit<PlayerMail, "id"> & { id?: number }

/** Called in the same transaction that inserts the actual reward mail. */
export function recordRewardMailSourceSync(playerId: number, mailId: number): string {
    const key = randomUUID()
    const mail = db.prepare(`SELECT * FROM players_mail WHERE player_id = ? AND id = ?`).get(playerId, mailId) as StoredRewardIdentity | undefined
    if (mail === undefined) throw new Error("A reward source must name this player's existing mail.")
    db.prepare(`INSERT INTO players_reward_mail_sources (player_id, source_key, mail_id, content_fingerprint) VALUES (?, ?, ?, ?)`)
        .run(playerId, key, mailId, storedRewardMailFingerprint(mail))
    return key
}

export interface RewardMailImport {
    mailList: ImportMail[]
    sources: RewardMailSource[]
}

/**
 * Uploaded ordinary mail still replaces ordinary mail. Locally earned gifts keep their current pending/received
 * state and IDs instead. Known source keys whose history was already trimmed suppress stale uploaded copies too.
 * A key from another server/player is ordinary imported mail; it never creates an authoritative local source.
 * Only unmarked legacy exports fall back to a multiset of immutable fingerprints. Identical unmarked gifts from
 * another server are indistinguishable from local ones; supplied foreign source keys deliberately bypass that rule.
 */
export function retainRewardMailForImportSync(playerId: number, imported: ImportMail[] | undefined, current: PlayerMail[]): RewardMailImport {
    const sources = db.prepare(`SELECT source_key AS sourceKey, mail_id AS mailId, content_fingerprint AS fingerprint
        FROM players_reward_mail_sources WHERE player_id = ? ORDER BY rowid`).all(playerId) as RewardMailSource[]
    // Older saves omit the mailbox altogether: preserve its IDs and relative receipt order exactly.
    if (imported === undefined) return { mailList: current, sources }
    const byKey = new Map(sources.map(source => [source.sourceKey, source]))
    const byId = new Map(sources.filter((source): source is RewardMailSource & { mailId: number } => source.mailId !== null)
        .map(source => [source.mailId, source]))
    const byFingerprint = new Map<string, RewardMailSource[]>()
    for (const source of sources) if (source.fingerprint) {
        const matches = byFingerprint.get(source.fingerprint) ?? []
        matches.push(source)
        byFingerprint.set(source.fingerprint, matches)
    }
    const live = new Map(current.filter(mail => byId.has(mail.id)).map(mail => [byId.get(mail.id)!.sourceKey, mail]))
    const seen = new Set<string>()
    const receivedAfterSnapshot = new Set<string>()
    const mailList: ImportMail[] = []
    for (const mail of imported) {
        const source = (mail.id === undefined ? undefined : byId.get(mail.id))
            ?? (mail.rewardSourceKey !== undefined ? byKey.get(mail.rewardSourceKey)
                : byFingerprint.get(mail.rewardImportFingerprint ?? rewardMailFingerprint(mail))?.find(match => !seen.has(match.sourceKey)))
        if (source === undefined) { mailList.push(mail); continue }
        if (seen.has(source.sourceKey)) continue
        seen.add(source.sourceKey)
        const authoritative = live.get(source.sourceKey)
        // Substitute in place: an unchanged explicit save must preserve history order across clock rewinds.
        if (authoritative !== undefined) {
            // A pending gift received after this snapshot belongs after its old received history, rather than in
            // the snapshot's pending prefix. Append these gifts below in their actual local receipt order.
            if (mail.receiveTime === null && authoritative.receiveTime !== null) receivedAfterSnapshot.add(source.sourceKey)
            else mailList.push(authoritative)
        }
    }
    for (const mail of current) {
        const source = byId.get(mail.id)
        if (source !== undefined && (!seen.has(source.sourceKey) || receivedAfterSnapshot.has(source.sourceKey))) {
            mailList.push(mail)
            seen.add(source.sourceKey)
        }
    }
    return { mailList, sources }
}

/** The player replacement deleted the old rows; restore sources only after their retained mails exist again. */
export function restoreRewardMailSourcesSync(playerId: number, sources: RewardMailSource[]): void {
    const insert = db.prepare(`INSERT INTO players_reward_mail_sources (player_id, source_key, mail_id, content_fingerprint) VALUES (?, ?, ?, ?)`)
    for (const source of sources) insert.run(playerId, source.sourceKey, source.mailId, source.fingerprint)
}
