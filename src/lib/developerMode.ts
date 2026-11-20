/**
 * Developer mode: unlock everything for one player (On), and go back to their own progress (Off).
 *
 * `unlockEverything` first saves the player's own save (the same JSON as the admin page's
 * "Download Save") under `<DATABASE_DIR>/developer-mode-backups/`, then grants every character
 * (max level, over-limit and evolution, all mana nodes), all equipment at max level, a stack of
 * every item of the game's item table and of every currency well under its limit (so rewards and
 * shops can still be tested), player rank 100, clears every quest, boss battle and event quest except the
 * Haunt's (so its floors can be played and tested from the start), and marks the tutorial finished (otherwise the client
 * keeps offering to continue it).
 * `revertUnlock` restores that save through the save-import path, with the server-side records the save doesn't
 * hold (mission progress, login bonus receipts, earned mail sources), so anything earned while unlocked is dropped. Mail sent from the admin site meanwhile (one player's or everyone's) isn't earned: what of it
 * still waits is kept. Unlocking twice keeps the first (real) save.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { developerModeBackupDir, setDeveloperMode } from "./developerModePlayers";
import { deserializePlayerData, getClientSerializedData, tutorialFinishedTriggerId } from "../data/utils";
import { Player } from "../data/types";
import {
    getLastMailIdSync, getPlayerAllMailSync, getPlayerProgressRecordsSync, getPlayerCharacterManaNodesSync, getPlayerCharacterSync, getPlayerEquipmentSync, getPlayerItemSync,
    getPlayerSingleQuestProgressSync, getPlayerSync, getPlayerTriggeredTutorialsSync, givePlayerItemSync,
    insertPlayerCharacterManaNodesSync, insertPlayerQuestProgressSync, insertPlayerTriggeredTutorialSync,
    replacePlayerDataSync, runInTransactionSync, updatePlayerCharacterBondTokenSync,
    updatePlayerCharacterSync, updatePlayerEquipmentSync, updatePlayerItemSync, updatePlayerQuestProgressSync,
    updatePlayerSync
} from "../data/wdfpData";
import { characterExpCaps, givePlayerCharacterSync } from "./character";
import { getPlayableCharacterIds, scanAssetItemAndEquipmentIds } from "./catalog";
import { givePlayerEquipmentSync } from "./equipment";
import { getEquipmentMaxLevelSync } from "./assets";
import { mailLimits, playerLimits } from "./limits";
import itemMaxCounts from "../../assets/item_max_count.json";
import { QuestCategory } from "./types";
import { runOnPlayerClockSync } from "./playerClock";
import { customMailReasonId } from "./mail";
import { getServerDate } from "../utils";

import characters from "../../assets/character.json";
import manaNodes from "../../assets/mana_node.json";
import adventEventQuests from "../../assets/advent_event_quest.json";
import bossBattleQuests from "../../assets/boss_battle_quest.json";
import carnivalEventQuests from "../../assets/carnival_event_quest.json";
import challengeDungeonEventQuests from "../../assets/challenge_dungeon_event_quest.json";
import characterQuests from "../../assets/character_quest.json";
import dailyExpManaEventQuests from "../../assets/daily_exp_mana_event_quest.json";
import dailyWeekEventQuests from "../../assets/daily_week_event_quest.json";
import exQuests from "../../assets/ex_quest.json";
import expertSingleEventQuests from "../../assets/expert_single_event_quest.json";
import mainQuests from "../../assets/main_quest.json";
import raidEventQuests from "../../assets/raid_event_quest.json";
import hardMultiEventQuests from "../../assets/hard_multi_event_quest.json";
import rankingEventSingleQuests from "../../assets/ranking_event_single_quest.json";
import rushEventQuests from "../../assets/rush_event_quest.json";
import scoreAttackEventQuests from "../../assets/score_attack_event_quest.json";
import practiceQuests from "../../assets/practice_quest.json";
import soloTimeAttackEventQuests from "../../assets/solo_time_attack_event_quest.json";
import storyEventSingleQuests from "../../assets/story_event_single_quest.json";
import worldStoryEventBossBattleQuests from "../../assets/world_story_event_boss_battle_quest.json";
import worldStoryEventQuests from "../../assets/world_story_event_quest.json";


/**
 * Items get this share of their own limit (`item_max_count`: 9999 → 2999, 99999 → 29999, 10 → 3), so rewards, shop
 * purchases and exchanges still fit on top.
 */
export const UNLOCK_ITEM_SHARE = 0.3

/** An item's developer mode stack: its share of the item's limit, at least 1. */
export function unlockItemAmount(maxCount: number): number {
    return Math.max(1, Math.floor(maxCount * UNLOCK_ITEM_SHARE))
}

/**
 * Amounts granted, well under each limit (`playerLimits`) for the same reason. Items and currencies are raised to
 * these, never lowered.
 */
export const UNLOCK_AMOUNTS = {
    beads: 300000,
    mana: 300000000,
    expPool: 300000000,
    starCrumb: 300000,
    bondToken: 30000,
    /** under the 999 overflow cap, so stamina items and refills still work */
    stamina: 500,
    /** half of each gauge, so boost refills can be tested */
    boostPoint: Math.floor(playerLimits.boostPoint / 2),
    bossBoostPoint: Math.floor(playerLimits.bossBoostPoint / 2),
    /**
     * Rank points for player rank 120, which unlocks every rank-gated system: score attack (rank 100) and the co-op
     * boss events (rank 120, `hard_multi_*`; DEV-1) included (docs/game-system-unlocks.md).
     * The server stores only rank points and the client derives the rank from the master tables
     * `player/player_rank_iosbundled` (ranks 1–100) and `player/player_rank` (101–250), whose second
     * column is the total needed: rank 100 at 666297, rank 120 at 1774864.
     */
    rankPoint: 1774864
}

/** Best clear rank (S+), as single_battle_quest/finish stores it. */
const BEST_CLEAR_RANK = 5

/**
 * Quest progress section (= quest category) → that category's quests, all cleared. The Haunt (tower dungeon event) is
 * left out: its floors open one after another, so clearing them would leave nothing to test.
 */
const QUESTS_BY_CATEGORY: [QuestCategory, Record<string, any>][] = [
    [QuestCategory.MAIN, mainQuests],
    [QuestCategory.BOSS_BATTLE, bossBattleQuests],
    [QuestCategory.CHARACTER, characterQuests],
    [QuestCategory.EX, exQuests],
    [QuestCategory.DAILY_WEEK_EVENT, dailyWeekEventQuests],
    [QuestCategory.ADVENT_EVENT_SINGLE, adventEventQuests],
    [QuestCategory.ADVENT_EVENT_MULTI, adventEventQuests],
    [QuestCategory.STORY_EVENT_SINGLE, storyEventSingleQuests],
    [QuestCategory.RANKING_EVENT_SINGLE, rankingEventSingleQuests],
    [QuestCategory.CHALLENGE_DUNGEON_EVENT, challengeDungeonEventQuests],
    [QuestCategory.DAILY_EXP_MANA_EVENT, dailyExpManaEventQuests],
    [QuestCategory.WORLD_STORY_EVENT, worldStoryEventQuests],
    [QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE, worldStoryEventBossBattleQuests],
    [QuestCategory.EXPERT_SINGLE_EVENT, expertSingleEventQuests],
    [QuestCategory.CARNIVAL_EVENT, carnivalEventQuests],
    [QuestCategory.RAID_EVENT, raidEventQuests],
    [QuestCategory.HARD_MULTI_EVENT, hardMultiEventQuests],
    [QuestCategory.RUSH_EVENT, rushEventQuests],
    [QuestCategory.SOLO_TIME_ATTACK_EVENT, soloTimeAttackEventQuests],
    [QuestCategory.SCORE_ATTACK_EVENT, scoreAttackEventQuests],
    [QuestCategory.PRACTICE, practiceQuests]
]

// --- snapshot (revert) -----------------------------------------------------------------------------

function backupDir(): string {
    return developerModeBackupDir()
}

function backupPath(playerId: number): string {
    return path.join(backupDir(), `${playerId}.json`)
}

/** Whether developer mode is on (a save from before the unlock is waiting to be restored). */
export function isUnlocked(playerId: number): boolean {
    return existsSync(backupPath(playerId))
}

/** Drops a saved pre-unlock save without restoring it (the player is being reset or deleted). */
export function forgetUnlockBackup(playerId: number): void {
    rmSync(backupPath(playerId), { force: true })
    setDeveloperMode(playerId, false)
}

/**
 * The backup's own field (not part of a save): the highest mail ID when it was made, so the mail sent while unlocked can
 * be told apart. A backup from before it has none.
 */
const LAST_MAIL_ID_FIELD = "developer_mode_last_mail_id"
/** The backup's records a save doesn't carry (`getPlayerProgressRecordsSync()`); a backup from before them has none. */
const PROGRESS_RECORDS_FIELD = "developer_mode_progress_records"

/**
 * The player's own save from before the unlock, with the records a save doesn't carry, or null when developer mode is
 * off (FT-59: a deleted save keeps this one, not the unlocked progress).
 */
export function unlockBackupSave(playerId: number): { save: Record<string, unknown>, progressRecords: unknown } | null {
    const file = backupPath(playerId)
    if (!existsSync(file)) return null
    const { [LAST_MAIL_ID_FIELD]: _lastMailId, [PROGRESS_RECORDS_FIELD]: progressRecords, ...save } = JSON.parse(readFileSync(file, "utf-8"))
    return { save, progressRecords }
}

/**
 * Restores the player's save from before the unlock and forgets it. False if there is none. Admin mail (reason 0, one
 * player's or sent to everyone) that arrived while unlocked and still waits is kept, as far as the gift box has room:
 * it wasn't earned with the unlocked progress, unlike mission rewards and exchange bonuses, which are dropped with it.
 */
export function revertUnlock(playerId: number): boolean {
    const file = backupPath(playerId)
    if (!existsSync(file)) return false
    const { [LAST_MAIL_ID_FIELD]: lastMailId, [PROGRESS_RECORDS_FIELD]: progressRecords, ...saved } = JSON.parse(readFileSync(file, "utf-8"))
    runOnPlayerClockSync(playerId, () => {
        const restored = deserializePlayerData(playerId, saved)
        // a backup from before the gift box was saved keeps the player's current mail anyway (replacePlayerDataSync)
        if (restored.mailList !== undefined && Number.isSafeInteger(lastMailId)) {
            const now = getServerDate()
            const room = mailLimits.pendingMails - restored.mailList.filter(mail => mail.receiveTime === null && (mail.rewardLimitTime === null || mail.rewardLimitTime > now)).length
            const sentMeanwhile = getPlayerAllMailSync(playerId).filter(mail => mail.id > lastMailId && mail.reasonId === customMailReasonId
                && mail.receiveTime === null && (mail.rewardLimitTime === null || mail.rewardLimitTime > now))
            // the newest, when there are more than fit; as new mails after the restored ones, which get new IDs too
            const kept = (room > 0 ? sentMeanwhile.slice(-room) : []).map(({ id, ...mail }) => mail)
            restored.mailList = [...restored.mailList, ...kept]
        }
        // not the import's retention of earned rewards and claims: those earned while unlocked go with the rest
        replacePlayerDataSync(restored, { progressRecords: typeof progressRecords === "object" && progressRecords !== null ? progressRecords : {} })
    })
    rmSync(file)
    setDeveloperMode(playerId, false)
    return true
}

// --- unlock ----------------------------------------------------------------------------------------

export interface UnlockSummary {
    characters: number
    equipment: number
    items: number
    quests: number
}

/** Saves the player's own save (unless already unlocked), then grants everything. */
export function unlockEverything(playerId: number): UnlockSummary | null {
    const player = getPlayerSync(playerId)
    if (player === null) return null

    if (!isUnlocked(playerId)) {
        // on the player's clock, like the save download (which mail has expired depends on it)
        const save = runOnPlayerClockSync(playerId, () => getClientSerializedData(playerId, { serializeRushEventData: true, serializeSaveData: true }))
        if (save === null) return null
        mkdirSync(backupDir(), { recursive: true })
        writeFileSync(backupPath(playerId), JSON.stringify({ ...save, [LAST_MAIL_ID_FIELD]: getLastMailIdSync(), [PROGRESS_RECORDS_FIELD]: getPlayerProgressRecordsSync(playerId) }))
        setDeveloperMode(playerId, true)
    }

    // one transaction, so a failure part way leaves the player as they were
    return runInTransactionSync(() => grantEverythingSync(player))
}

function grantEverythingSync(player: Player): UnlockSummary {
    const playerId = player.id

    // currencies
    updatePlayerSync({
        id: playerId,
        freeVmoney: Math.max(player.freeVmoney, UNLOCK_AMOUNTS.beads),
        freeMana: Math.max(player.freeMana, UNLOCK_AMOUNTS.mana),
        expPool: Math.max(player.expPool, UNLOCK_AMOUNTS.expPool),
        starCrumb: Math.max(player.starCrumb, UNLOCK_AMOUNTS.starCrumb),
        bondToken: Math.max(player.bondToken, UNLOCK_AMOUNTS.bondToken),
        stamina: Math.max(player.stamina, UNLOCK_AMOUNTS.stamina),
        boostPoint: Math.max(player.boostPoint, UNLOCK_AMOUNTS.boostPoint),
        bossBoostPoint: Math.max(player.bossBoostPoint, UNLOCK_AMOUNTS.bossBoostPoint),
        rankPoint: Math.max(player.rankPoint, UNLOCK_AMOUNTS.rankPoint)
    })

    // characters: owned, max level and over-limit, evolved, every mana node, bond tokens received
    const { equipment } = scanAssetItemAndEquipmentIds()
    // every item of the game's item table (the rewards and shops alone left out event items, tickets and coins)
    const items = Object.entries(itemMaxCounts as Record<string, number>).map(([id, max]) => [Number(id), unlockItemAmount(max)] as const)
    // Event and guest units with skills have action skills, abilities, leader abilities and status rows in the
    // original master; skill-less 7xxxxx placeholders can make the client fail with C8601.
    const eventCharacterIds = Object.entries(characters as Record<string, { skill_count: number }>)
        .filter(([id, unit]) => /^7\d{5}$/.test(id) && unit.skill_count > 0)
        .map(([id]) => Number(id))
    const characterIds = [...getPlayableCharacterIds(), ...eventCharacterIds]
    for (const characterId of characterIds) {
        if (getPlayerCharacterSync(playerId, characterId) === null && givePlayerCharacterSync(playerId, characterId) === null) continue
        const rarity = (characters as Record<string, { rarity: number }>)[String(characterId)].rarity
        const caps = characterExpCaps[rarity] ?? []
        updatePlayerCharacterSync(playerId, characterId, {
            exp: caps.length > 0 ? caps[caps.length - 1] : 0,
            overLimitStep: Math.max(0, caps.length - 1),
            evolutionLevel: 1
        })
        const boards = (manaNodes as Record<string, Record<string, Record<string, unknown>>>)[String(characterId)] ?? {}
        const owned = new Set(getPlayerCharacterManaNodesSync(playerId, characterId))
        const missing = Object.values(boards).flatMap(nodes => Object.keys(nodes)).map(Number).filter(id => !owned.has(id))
        if (missing.length > 0) insertPlayerCharacterManaNodesSync(playerId, characterId, missing)
        // every board complete: its Amity Scroll can be received
        for (const board of Object.keys(boards)) updatePlayerCharacterBondTokenSync(playerId, characterId, { manaBoardIndex: Number(board), status: 1 })
    }

    // equipment at max level; items
    for (const equipmentId of equipment) {
        if (getPlayerEquipmentSync(playerId, equipmentId) === null) givePlayerEquipmentSync(playerId, equipmentId, 1)
        // each armament's own maximum: orbs and some others stop at level 1, and the client throws C2284 above it
        updatePlayerEquipmentSync(playerId, equipmentId, { level: getEquipmentMaxLevelSync(equipmentId) ?? 1 })
    }
    for (const [itemId, target] of items) {
        const amount = getPlayerItemSync(playerId, itemId)
        if (amount === null) givePlayerItemSync(playerId, itemId, target)
        else if (amount < target) updatePlayerItemSync(playerId, itemId, target)
    }

    // every quest, boss battle and event quest cleared with the best rank
    let quests = 0
    for (const [category, questList] of QUESTS_BY_CATEGORY) {
        for (const [questId, quest] of Object.entries(questList)) {
            const progress = {
                finished: true,
                clearRank: BEST_CLEAR_RANK,
                ...(typeof quest?.sPlusRankTime === "number" ? { bestElapsedTimeMs: quest.sPlusRankTime } : {})
            }
            if (getPlayerSingleQuestProgressSync(playerId, category, questId) === null) {
                insertPlayerQuestProgressSync(playerId, category, { questId: Number(questId), ...progress })
            } else {
                updatePlayerQuestProgressSync(playerId, category, { questId: Number(questId), ...progress })
            }
            quests++
        }
    }

    // the tutorial counts as done, or the client keeps asking to continue it and co-op, the portal and the rest stay shut
    if (!getPlayerTriggeredTutorialsSync(playerId).includes(tutorialFinishedTriggerId)) {
        insertPlayerTriggeredTutorialSync(playerId, tutorialFinishedTriggerId)
    }

    return { characters: characterIds.length, equipment: equipment.length, items: items.length, quests }
}
