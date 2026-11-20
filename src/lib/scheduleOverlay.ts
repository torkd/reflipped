/**
 * The client reads availability from its local master files, independently of API responses.
 * Rebase those dates into the real clock without changing non-date cells (including translations).
 * The path inventory covers all date-valued masters registered by the supported SWF/CDN revision;
 * it contains paths only, never raw game data. See docs/event-scheduling.md.
 */
import { createHash } from "crypto";
import { digestPath, masterAssetPath } from "./cdnIndex";
import { buildPatchedScript, scriptAssetPath } from "./skillScripts";
import { decodeOrderedMap, OrderedMapNode, walkLeaves } from "./orderedmap";
import { BALANCE_CHANGE_TABLES, BalanceChange } from "./balanceChanges";
import { writeZip, ZipFile } from "./zipWriter";
import { BASELINE_CHARACTER_GACHA_ID } from "./scheduleGacha";
import { bossQuestOpening } from "./scheduleBossQuests";
import { annualBonusOccurrence } from "./scheduleAnnualBonus";
import { towerQuestPeriod } from "./scheduleTowerCycles";
import { PROMO_BUNDLE_NAMES, PROMO_BUNDLE_PRICES } from "./specialExchangePromo";

/** Known date-bearing master files, including ancillary show/exchange/aggregation windows. */
export const SCHEDULE_MASTER_TABLES: readonly string[] = [
    "active_mission/active_mission",
    "active_mission/active_mission_event",
    "bonus/login_bonus",
    "box_gacha/box",
    "box_gacha/box_gacha",
    "campaign/daily_challenge_point_campaign",
    "campaign/multi_special_exchange/multi_special_exchange_campaign",
    "campaign/reward_campaign",
    "campaign/special_exchange/special_exchange_campaign",
    "campaign/stamina_campaign",
    "campaign/start_dash_exchange/start_dash_exchange_campaign",
    "campaign/start_dash_exchange/start_dash_exchange_campaign_term",
    "character_election/character_election",
    "encyclopedia/encyclopedia",
    "equipment_enhancement/equipment_enhancement",
    "equipment_enhancement/equipment_enhancement_config",
    "equipment_enhancement/equipment_enhancement_shop",
    "equipment_enhancement/equipment_enhancement_shop_category",
    "ex_boost/ex_boost_config",
    "feature_banner/feature_announcement",
    "feature_banner/feature_banner",
    "feature_banner/feature_guide_dialog",
    "gacha/gacha",
    "gacha/gacha_campaign",
    "gacha/tutorial_gacha",
    "help/help",
    "item/item",
    "mission/collect_item_event_mission",
    "mission/daily_mission",
    "mission/degree_mission",
    "mission/event_mission",
    "mission/regular_mission",
    "payment/android_payment",
    "payment/ios_payment",
    "quest/boss_battle/boss_battle_multi_pickup_event",
    "quest/boss_battle/boss_battle_multi_pickup_event_schedule",
    "quest/boss_battle_quest",
    "quest/character_quest",
    "quest/event/advent_event",
    "quest/event/advent_event_quest",
    "quest/event/carnival_event",
    "quest/event/carnival_event_quest",
    "quest/event/challenge_dungeon_event",
    "quest/event/challenge_dungeon_event_quest",
    "quest/event/daily_challenge_point",
    "quest/event/daily_exp_mana_event",
    "quest/event/daily_exp_mana_event_quest",
    "quest/event/daily_week_event",
    "quest/event/daily_week_event_quest",
    "quest/event/event_shop_select_item_campaign",
    "quest/event/expert_single_event",
    "quest/event/expert_single_event_campaign",
    "quest/event/expert_single_event_quest",
    "quest/event/hard_multi_event",
    "quest/event/hard_multi_event_quest",
    "quest/event/raid_event",
    "quest/event/raid_event_quest",
    "quest/event/ranking_event",
    "quest/event/ranking_event_single_quest",
    "quest/event/rush_event",
    "quest/event/rush_event_quest",
    "quest/event/score_attack_event",
    "quest/event/score_attack_event_quest",
    "quest/event/solo_time_attack_event",
    "quest/event/solo_time_attack_event_quest",
    "quest/event/story_event",
    "quest/event/story_event_single_quest",
    "quest/event/tower_dungeon_event",
    "quest/event/tower_dungeon_event_quest",
    "quest/event/world_story_event",
    "quest/event/world_story_event_boss_battle_quest",
    "quest/event/world_story_event_quest",
    "quest/ex_quest",
    "quest/main_quest",
    "quest/practice/practice_quest",
    "reward/event/collect_item_event",
    "reward/periodic_reward_point",
    "shop/bond_token_exchange",
    "shop/boss_coin_shop",
    "shop/boss_coin_shop_category",
    "shop/boss_coin_shop_select_item_campaign",
    "shop/event_item_shop",
    "shop/general_shop",
    "shop/mana_shop",
    "shop/shop_cost_item_schedule",
    "shop/shop_pickup_schedule",
    "shop/special_pack_shop",
    "shop/star_crumb_exchange",
    "shop/star_grain_shop",
    "shop/treasure_shop",
    "skill_preview/skill_preview_quest",
    "town/town_content",
    "tutorial/triggered_tutorial"
]

/**
 * Balance masters (FT-47): shipped with every view, so a device that saw another balance epoch gets this one's: the
 * mana boards and the tables balance changes touch (src/lib/balanceChanges.ts). Optional: a CDN without them (test
 * fixtures) builds the date overlay alone.
 */
export const BALANCE_MASTER_TABLES: readonly string[] = ["mana_board/mana_node", ...BALANCE_CHANGE_TABLES]

export interface ScheduleBalance {
    /** units whose second mana board isn't out: their board-2 rows are left out of `mana_board/mana_node` */
    hiddenBoard2: ReadonlySet<string>
    /** balance changes not landed yet, latest first: their earlier values are written back */
    pending?: readonly BalanceChange[]
    /** the masters' language (`en`, `ko`, `th`): a text cell written for one language skips the others */
    language?: string
}

/** Writes back the values before the pending changes (latest first, so the earliest change's values win). */
function applyPendingChanges(table: string, node: OrderedMapNode, pending: readonly BalanceChange[], language: string): void {
    for (const change of pending) {
        for (const entry of change.entries) {
            if (entry.table !== table) continue
            const leaf = node.kind === "map" ? node.at(entry.key) : undefined
            if (leaf?.kind !== "leaf") throw new Error(`Balance change ${change.id}: no ${table} entry ${entry.key.join("/")}`)
            leaf.setRecords(entry.records)
        }
        for (const cell of change.cells) {
            if (cell.table !== table || (cell.language !== undefined && cell.language !== language)) continue
            const leaf = node.kind === "map" ? node.at(cell.key) : undefined
            if (leaf?.kind !== "leaf") throw new Error(`Balance change ${change.id}: no ${table} entry ${cell.key.join("/")}`)
            leaf.setCell(cell.record, cell.column, cell.before)
        }
    }
}

export interface ScheduleProjection {
    sourceStart: number
    targetStart: number
    rate: number
    /** Annual bonus materialization uses the selected historical year, never the real year. */
    contentTime?: number
}

export interface ScheduleOverlaySource {
    readMaster(table: string): Buffer | undefined
    /** Any other asset of the CDN or data pack by its path (the battle scripts balance changes patch). */
    readAsset?(assetPath: string): Buffer | undefined
    /** Effective existing restore/mod/translation member; undefined falls back to the CDN. */
    readLayerMember?(member: string): Buffer | undefined
}

export interface ScheduleOverlayResult {
    archive: Buffer
    sha256: string
    files: number
    dateCells: number
    dates: number
}

const DATE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
const JST_OFFSET = 9 * 60 * 60 * 1000

/** Strict master-date parsing, independent of server clocks, DB initialization, and the host timezone. */
export function parseScheduleMasterDate(value: string): number | null {
    if (!DATE.test(value)) return null
    const time = Date.parse(`${value.replace(" ", "T")}+09:00`)
    if (!Number.isFinite(time) || new Date(time + JST_OFFSET).getUTCFullYear() < 1
        || formatScheduleMasterDate(time) !== value) return null
    return time
}

export function formatScheduleMasterDate(time: number): string {
    const date = new Date(Math.floor(time / 1000) * 1000 + JST_OFFSET)
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
        throw new RangeError("Schedule date is outside the client's master date format")
    return date.toISOString().slice(0, 19).replace("T", " ")
}

/** All-or-nothing validation avoids rewriting ordinary text which merely mentions a date. */
export function rebaseScheduleDateCell(value: string, projection: ScheduleProjection): { value: string, dates: number } | null {
    if (!Number.isFinite(projection.sourceStart) || !Number.isFinite(projection.targetStart)
        || !Number.isFinite(projection.rate) || projection.rate <= 0) throw new RangeError("Invalid schedule projection")
    const tokens = value.split(",")
    let count = 0
    const dates: (number | null)[] = []
    for (const token of tokens) {
        if (token === "(None)") { dates.push(null); continue }
        const time = parseScheduleMasterDate(token)
        if (time === null) return null
        dates.push(time)
        count++
    }
    if (count === 0) return null
    return {
        value: dates.map(time => time === null ? "(None)" : formatScheduleMasterDate(
            projection.targetStart + (time - projection.sourceStart) / projection.rate)).join(","),
        dates: count
    }
}

/**
 * Build a complete overlay over the effective installed layers, not over untranslated CDN rows.
 * `projection=null` restores all schedule-bearing files when scheduling is disabled again.
 * Full date-bearing files are included even when a particular projection changes no cells: a device
 * may arrive from any other view. This also resets earlier schedule edits in those same members.
 */
export function buildScheduleOverlay(
    source: ScheduleOverlaySource,
    projection: ScheduleProjection | null,
    tables: readonly string[] = SCHEDULE_MASTER_TABLES,
    balance: ScheduleBalance | null = null,
    /** special exchange campaigns (by id) whose mode differs from the master's (src/lib/campaignModes.ts) */
    specialExchangeModes: Readonly<Record<string, "free" | "paid">> | null = null
): ScheduleOverlayResult {
    const files: ZipFile[] = []
    let dateCells = 0, dates = 0
    for (const table of BALANCE_MASTER_TABLES) {
        if (!balance) break
        const member = digestPath(masterAssetPath(table))
        const raw = source.readLayerMember?.(member) ?? source.readMaster(table)
        if (!raw) continue
        const node = decodeOrderedMap(raw)
        // mana_node: unit -> board -> nodes; a unit has a second board only while its board-2 entry exists
        if (table === "mana_board/mana_node" && node.kind === "map") for (const unit of balance.hiddenBoard2) {
            const boards = node.get(unit)
            if (boards?.kind === "map") boards.delete("2")
        }
        applyPendingChanges(table, node, balance.pending ?? [], balance.language ?? "en")
        files.push({ name: member, data: node.encode() })
    }
    // skills' battle scripts before the pending changes: latest first, so the earliest change's script wins. Needed
    // whenever skill/action_skill ships (its cells point the skills at them); a CDN without that table (test fixtures)
    // has no use for them either
    const skillsShipped = files.some(file => file.name === digestPath(masterAssetPath("skill/action_skill")))
    const scripts = new Map<string, Buffer>()
    for (const patch of (balance?.pending ?? []).flatMap(change => change.scripts ?? [])) {
        const path = scriptAssetPath(patch.source)
        const raw = source.readLayerMember?.(digestPath(path)) ?? source.readAsset?.(path)
        if (!raw && !skillsShipped) continue
        if (!raw) throw new Error(`Balance change: no battle script ${path} in the local CDN or data pack`)
        scripts.set(patch.target, buildPatchedScript(raw, patch))
    }
    for (const [target, data] of scripts) files.push({ name: digestPath(scriptAssetPath(target)), data })
    for (const table of [...new Set(tables)].sort()) {
        const member = digestPath(masterAssetPath(table))
        const raw = source.readLayerMember?.(member) ?? source.readMaster(table)
        if (!raw) throw new Error(`Schedule overlay requires master/${table}.orderedmap in the local CDN`)
        const node = decodeOrderedMap(raw)
        for (const { leaf, keys } of walkLeaves(node)) {
            const annual = table === "bonus/login_bonus" && projection ? leaf.records.map(record => {
                if ((record[0] !== "0" && record[0] !== "1") || !record[42] || record[42] === "(None)"
                    || !record[43] || record[43] === "(None)") return null
                if (projection.contentTime === undefined) throw new Error("Annual login bonus projection requires its historical content time")
                return annualBonusOccurrence(record[42], record[43],
                    parseScheduleMasterDate(record[40]) ?? undefined,
                    parseScheduleMasterDate(record[41]) ?? undefined, projection.contentTime)
            }) : []
            const bossOpenings = table === "quest/boss_battle_quest" && keys.length === 3 ? leaf.records.map(record => {
                const start = parseScheduleMasterDate(record[5] ?? ""), end = record[6] === "(None)" ? null : parseScheduleMasterDate(record[6] ?? "")
                return start === null || !Number.isInteger(Number(keys[1])) ? null : bossQuestOpening(Number(keys[1]), start, end)
            }) : []
            leaf.records.forEach((record, row) => record.forEach((cell, column) => {
                // Inventory/restore still recognizes dates but leaves original bytes untouched.
                const rebased = rebaseScheduleDateCell(cell, projection ?? { sourceStart: 0, targetStart: 0, rate: 1 })
                if (!rebased) return
                dateCells++
                dates += rebased.dates
                if (projection) leaf.setCell(row, column, rebased.value)
            }))
            annual.forEach((period, row) => {
                if (!period || !projection) return
                const project = (time: number) => formatScheduleMasterDate(projection.targetStart + (time - projection.sourceStart) / projection.rate)
                leaf.setCell(row, 40, project(period.start))
                leaf.setCell(row, 41, project(period.end))
                // The stock wrapper falls back to full start/end when annual fields are absent.
                leaf.setCell(row, 42, "(None)")
                leaf.setCell(row, 43, "(None)")
            })
            // Deliberate preservation policy shared with server gacha availability. This ordinary
            // bead-funded baseline keeps its original opening and extends past the final archived banner. These are
            // the generated gacha master's zero-based start/end columns, not guessed date cells.
            // A special exchange campaign whose mode the owner changed (src/lib/campaignModes.ts): a ticket gift promo
            // made paid gets the gift flag (column 9) off and the paid seasons' price (10) and bundle name (12), so the
            // season's screen offers the bundle; a sold season made free gets the flag on, as the promos had it.
            const mode = projection && table === "campaign/special_exchange/special_exchange_campaign" && keys.length === 1
                ? specialExchangeModes?.[keys[0]] : undefined
            if (mode === "paid" && leaf.records[0]?.[9] === "1") {
                const kind = leaf.records[0][2] === "0" ? "character" : "equipment"
                leaf.setCell(0, 9, "0")
                leaf.setCell(0, 10, String(PROMO_BUNDLE_PRICES[kind]))
                leaf.setCell(0, 12, PROMO_BUNDLE_NAMES[kind])
            } else if (mode === "free" && leaf.records[0]?.[9] === "0") {
                leaf.setCell(0, 9, "1")
            }
            if (projection && table === "gacha/gacha" && keys.length === 1
                && keys[0] === String(BASELINE_CHARACTER_GACHA_ID)) {
                leaf.setCell(0, 30, "2199-12-31 23:59:59")
            }
            // Boss quests of rerun bosses (the Queens) open at the boss's first spotlight and stay open, like the other
            // bosses (columns 5 and 6 are the quest's start and end; the key path is chapter/stage node/stage).
            bossOpenings.forEach((opening, row) => {
                if (opening === null || !projection) return
                leaf.setCell(row, 5, formatScheduleMasterDate(projection.targetStart + (opening - projection.sourceStart) / projection.rate))
                leaf.setCell(row, 6, "(None)")
            })
            // The Haunt's cycles get back-to-back periods, the ones the server opens (src/lib/scheduleTowerCycles.ts):
            // the client's Haunt screen fails with C3092 unless exactly one cycle's ten quests are open. Columns 5 and 6
            // are the quest's start and end, 7 and 8 its yearly window, which the periods replace. Restoring writes
            // them too, so a device with scheduling turned off again keeps agreeing with the server.
            if (table === "quest/event/tower_dungeon_event_quest") leaf.records.forEach((record, row) => {
                const period = towerQuestPeriod(Number(record[0]))
                if (period === null || record.length < 9) return
                const project = (time: number) => formatScheduleMasterDate(projection
                    ? projection.targetStart + (time - projection.sourceStart) / projection.rate : time)
                leaf.setCell(row, 5, project(period.start))
                leaf.setCell(row, 6, period.end === null ? "(None)" : project(period.end - 1000))
                leaf.setCell(row, 7, "(None)")
                leaf.setCell(row, 8, "(None)")
            })
        }
        files.push({ name: member, data: node.encode() })
    }
    const archive = writeZip(files)
    return { archive, sha256: createHash("sha256").update(archive).digest("hex"), files: files.length, dateCells, dates }
}
