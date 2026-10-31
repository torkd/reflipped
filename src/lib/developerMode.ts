/**
 * Developer mode: unlock everything for one player (On), and go back to their own progress (Off).
 *
 * `unlockEverything` first saves the player's own save (the same JSON as the admin page's
 * "Download Save") under `<DATABASE_DIR>/developer-mode-backups/`, then grants every character
 * (max level, over-limit and evolution, all mana nodes), all equipment at max level, large
 * stacks of every item and currency, player rank 100, clears every quest, boss battle and
 * event quest, and marks the tutorial finished (otherwise the client keeps offering to continue it).
 * `revertUnlock` restores that save through the save-import path, so anything earned while
 * unlocked is dropped. Unlocking twice keeps the first (real) save.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { deserializePlayerData, getClientSerializedData, tutorialFinishedTriggerId } from "../data/utils";
import { Player } from "../data/types";
import {
    getPlayerCharacterManaNodesSync, getPlayerCharacterSync, getPlayerEquipmentSync, getPlayerItemSync,
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
import { getItemMaxCountSync, playerLimits } from "./limits";
import { QuestCategory } from "./types";

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
import rankingEventSingleQuests from "../../assets/ranking_event_single_quest.json";
import rushEventQuests from "../../assets/rush_event_quest.json";
import scoreAttackEventQuests from "../../assets/score_attack_event_quest.json";
import soloTimeAttackEventQuests from "../../assets/solo_time_attack_event_quest.json";
import storyEventSingleQuests from "../../assets/story_event_single_quest.json";
import towerDungeonEventQuests from "../../assets/tower_dungeon_event_quest.json";
import worldStoryEventBossBattleQuests from "../../assets/world_story_event_boss_battle_quest.json";
import worldStoryEventQuests from "../../assets/world_story_event_quest.json";


/** Amounts granted. Items and currencies are raised to these, never lowered. */
export const UNLOCK_AMOUNTS = {
    item: 9999,
    beads: 500000,
    mana: 99999999,
    expPool: 99999999,
    starCrumb: 99999,
    bondToken: 9999,
    stamina: 999,
    boostPoint: playerLimits.boostPoint,
    bossBoostPoint: playerLimits.bossBoostPoint,
    /**
     * Rank points for player rank 100, which unlocks every rank-gated system, score attack included
     * (docs/game-system-unlocks.md).
     * The server stores only rank points and the client derives the rank from the master tables
     * `player/player_rank_iosbundled` (ranks 1–100) and `player/player_rank` (101–250), whose second
     * column is the total needed: rank 99 at 632297, rank 100 at 666297.
     */
    rankPoint: 666297
}

/** Best clear rank (S+), as single_battle_quest/finish stores it. */
const BEST_CLEAR_RANK = 5

/** Quest progress section (= quest category) → that category's quests. */
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
    [QuestCategory.TOWER_DUNGEON_EVENT, towerDungeonEventQuests],
    [QuestCategory.EXPERT_SINGLE_EVENT, expertSingleEventQuests],
    [QuestCategory.CARNIVAL_EVENT, carnivalEventQuests],
    [QuestCategory.RAID_EVENT, raidEventQuests],
    [QuestCategory.RUSH_EVENT, rushEventQuests],
    [QuestCategory.SOLO_TIME_ATTACK_EVENT, soloTimeAttackEventQuests],
    [QuestCategory.SCORE_ATTACK_EVENT, scoreAttackEventQuests]
]

// --- snapshot (revert) -----------------------------------------------------------------------------

function backupDir(): string {
    const dataDir = process.env.DATABASE_DIR || ".database"
    return path.join(path.isAbsolute(dataDir) ? dataDir : path.join(process.cwd(), dataDir), "developer-mode-backups")
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
}

/** Restores the player's save from before the unlock and forgets it. False if there is none. */
export function revertUnlock(playerId: number): boolean {
    const file = backupPath(playerId)
    if (!existsSync(file)) return false
    const saved = JSON.parse(readFileSync(file, "utf-8"))
    replacePlayerDataSync(deserializePlayerData(playerId, saved))
    rmSync(file)
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
        const save = getClientSerializedData(playerId, { serializeRushEventData: true })
        if (save === null) return null
        mkdirSync(backupDir(), { recursive: true })
        writeFileSync(backupPath(playerId), JSON.stringify(save))
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
    const { items, equipment } = scanAssetItemAndEquipmentIds()
    const characterIds = getPlayableCharacterIds()
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
    for (const itemId of items) {
        const amount = getPlayerItemSync(playerId, itemId)
        // some items hold far fewer than 9999 (10, 99, 200, ...): never past the item's own limit
        const target = Math.min(UNLOCK_AMOUNTS.item, getItemMaxCountSync(itemId) ?? UNLOCK_AMOUNTS.item)
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
