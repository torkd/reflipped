// Reward management controls manual economy edits separately from event scheduling. Under Automatic the rules of
// docs/event-reward-cadence.md (FT-32) decide every amount: rewards keep their original amounts in every profile, and
// an accelerated run's progress (its event currencies and event missions, `runProgress`) counts its speed times.
import { AsyncLocalStorage } from "async_hooks";
import type { FastifyReply, FastifyRequest } from "fastify";
import bossCoinShop from "../../assets/boss_coin_shop.json";
import eventItemShop from "../../assets/event_item_shop.json";
import rewardElementMap from "../../assets/reward_element_map.json";
import { getStoredText, setStoredTexts } from "../data/serverSettings";
import { getEventPolicy, type EventMode } from "./eventPolicy";
import { currentRunSpeed } from "./eventSchedule";
import { getItemMaxCountSync, playerLimits } from "./limits";
import { QuestCategory, RewardType, type Reward, type EquipmentItemReward, type CurrencyReward } from "./types";
import { MailType } from "../data/types";

export type RewardManagement = "managed" | "automatic"
export interface RewardPolicy {
    management: RewardManagement
    profile: EventMode
    profileMultiplier: number
    multiplierOverride: number | null
    multiplier: number
    /** Managed only; empty means bosses use the general multiplier. */
    bossMultiplierOverride: number | null
    bossMultiplier: number
}
const MANAGEMENT_KEY = "rewards.management"
const MULTIPLIER_KEY = "rewards.multiplier_override"
const BOSS_MULTIPLIER_KEY = "rewards.boss_multiplier_override"
export const MIN_REWARD_MULTIPLIER = 0.1
export const MAX_REWARD_MULTIPLIER = 10

function parseMultiplier(value: unknown): number | null {
    if (typeof value !== "number" && typeof value !== "string") return null
    if (String(value).trim() === "") return null
    const number = Number(value)
    return Number.isFinite(number) && number >= MIN_REWARD_MULTIPLIER && number <= MAX_REWARD_MULTIPLIER ? number : null
}
/**
 * The multiplier every content profile starts with: the original amounts. An accelerated run is k times shorter, but
 * instead of paying k times more of everything (which inflated beads, mana and EXP per real day and still left event
 * shops and mission ladders out of reach), its progress counts k times (`runProgress`): each run can be finished with
 * the original effort, and income paced by real days stays as it was. Managed can still override it.
 */
export const PROFILE_MULTIPLIER = 1

/**
 * Event currencies: their drops are a run's progress. They are what the event exchange shops cost (event items and
 * event Denarius), except the Elements and Ethers some shops also take, which are ordinary growth materials (the
 * items `reward_element_map` resolves element drops to), and the Matter shop (event type 4), which outlasts any run.
 */
type ShopRow = { costs: { id: number }[] }
const elementItems = new Set<number>()
const collectIds = (value: unknown): void => {
    if (typeof value === "number") elementItems.add(value)
    else if (value !== null && typeof value === "object") Object.values(value).forEach(collectIds)
}
collectIds(rewardElementMap)
const runCurrencies = new Set<number>()
for (const [type, shops] of Object.entries(eventItemShop as Record<string, Record<string, Record<string, ShopRow>>>)) {
    if (type === "4") continue
    for (const shop of Object.values(shops)) for (const row of Object.values(shop)) for (const cost of row.costs) {
        if (!elementItems.has(cost.id)) runCurrencies.add(cost.id)
    }
}
export function isRunCurrency(itemId: number): boolean { return runCurrencies.has(itemId) }

/**
 * The mission patterns that count effort spent during a run (clears, battle statistics, stamina used, login days),
 * whose progress counts the run's speed times in event and collect item event missions. Not item gains (pattern 35:
 * the drops are scaled already) nor anything measured as a maximum.
 */
export const RUN_PROGRESS_PATTERNS: ReadonlySet<number> = new Set([0, 12, 13, 14, 15, 16, 17, 18, 21, 26, 36, 46, 47, 48, 49])

/** A run's progress counted at the playing run's speed (1 outside Accelerated). */
export function runProgress(amount: number, speed = currentRunSpeed()): number {
    return amount > 0 && speed > 1 ? Math.min(2 ** 31 - 1, amount * speed) : amount
}

/** A multiplier the way the pages show it: 1 is 100 %, 1.5 is 150 %. */
export function rewardPercent(multiplier: number): number { return Math.round(multiplier * 100) }

/** The quests the boss multiplier applies to: boss battles and the co-op boss events. */
export const BOSS_QUEST_CATEGORIES: ReadonlySet<number> = new Set([
    QuestCategory.BOSS_BATTLE, QuestCategory.ADVENT_EVENT_MULTI, QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
    QuestCategory.RAID_EVENT, QuestCategory.HARD_MULTI_EVENT
])

/** The multiplier a quest of this category earns at: the boss one for bosses, else the general one. */
export function multiplierForCategory(category: number, policy: RewardPolicy = getRewardPolicy()): number {
    return BOSS_QUEST_CATEGORIES.has(category) ? policy.bossMultiplier : policy.multiplier
}

/** What a server that never saved the choice uses: Automatic, unless `REWARD_MANAGEMENT=managed` says otherwise. */
function defaultManagement(): RewardManagement {
    return process.env.REWARD_MANAGEMENT?.trim().toLowerCase() === "managed" ? "managed" : "automatic"
}

export function getRewardPolicy(): RewardPolicy {
    const stored = getStoredText(MANAGEMENT_KEY)
    const management: RewardManagement = stored === "managed" || stored === "automatic" ? stored : defaultManagement()
    const profile = getEventPolicy().mode
    const profileMultiplier = PROFILE_MULTIPLIER
    const multiplierOverride = management === "managed" ? parseMultiplier(getStoredText(MULTIPLIER_KEY)) : null
    const bossMultiplierOverride = management === "managed" ? parseMultiplier(getStoredText(BOSS_MULTIPLIER_KEY)) : null
    const multiplier = multiplierOverride ?? profileMultiplier
    return { management, profile, profileMultiplier, multiplierOverride, multiplier, bossMultiplierOverride, bossMultiplier: bossMultiplierOverride ?? multiplier }
}

/** Validates and persists the update all-or-none. Automatic has no retained custom multiplier to restore later. */
export function setRewardPolicy(update: { management?: unknown, multiplierOverride?: unknown, bossMultiplierOverride?: unknown }): string[] {
    const invalid: string[] = []
    const current = getRewardPolicy()
    const management = update.management ?? current.management
    if (management !== "managed" && management !== "automatic") invalid.push("management")
    const entries: [string, string | null][] = [[MANAGEMENT_KEY, String(management)]]
    for (const [field, key] of [["multiplierOverride", MULTIPLIER_KEY], ["bossMultiplierOverride", BOSS_MULTIPLIER_KEY]] as const) {
        const hasOverride = Object.prototype.hasOwnProperty.call(update, field)
        const value = update[field]
        const clearOverride = value === null || value === ""
        const multiplier = hasOverride && !clearOverride ? parseMultiplier(value) : null
        if (hasOverride && !clearOverride && (multiplier === null || management !== "managed")) invalid.push(field)
        if (management === "automatic" || hasOverride) entries.push([key, multiplier === null ? null : String(multiplier)])
    }
    if (invalid.length > 0) return invalid
    setStoredTexts(entries)
    return []
}

/** Backend guard: hiding an admin form alone must not permit a direct POST to bypass Automatic's fixed rules. */
export async function requireManagedRewards(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
    if (getRewardPolicy().management === "automatic") return rejectAutomaticRewardMutation(reply)
}

/** Also used after asynchronous upload parsing, where policy must be checked again at commit. */
export function rejectAutomaticRewardMutation(reply: FastifyReply): FastifyReply {
    return reply.code(403).send({
        error: "Forbidden", code: "automatic-rewards",
        message: "Automatic reward management is enabled. Switch to Managed to change rewards manually."
    })
}

// A deliberately narrow, authoritative item classification: the currencies actually accepted by the Boss Coin
// shop, plus Wrightpieces (the armament crafting currency). Unknown items, tickets, ability cores and unique
// counters stay unchanged. More farmable currencies can be added when their master classification is available.
const scalableItems = new Set<number>([100000])
for (const category of Object.values(bossCoinShop)) for (const row of Object.values(category)) {
    for (const cost of row.costs) scalableItems.add(cost.id)
}
export function isScalableRewardItem(itemId: number): boolean { return scalableItems.has(itemId) }

const earningMultiplier = new AsyncLocalStorage<number>()
/** A host room's immutable reward policy applies only to its event earnings, not the guest's reward day. */
export function runOnEarnedRewardMultiplier<T>(multiplier: number, fn: () => T): T {
    return earningMultiplier.run(multiplier, fn)
}
/** The multiplier earned rewards get now (the running context's, else the policy's). */
export function currentEarningMultiplier(): number { return earningMultiplier.getStore() ?? getRewardPolicy().multiplier }

/** Called once where a reward is earned, never when receiving mail or restoring/importing inventory totals. */
export function scaleEarnedAmount(amount: number, kind: "beads" | "mana" | "exp" | "item", itemId?: number, multiplier = currentEarningMultiplier()): number {
    if (kind === "item" && (itemId === undefined || !isScalableRewardItem(itemId))) return amount
    const limit = kind === "beads" ? playerLimits.virtualMoney : kind === "mana" ? playerLimits.mana
        : kind === "exp" ? playerLimits.expPool : getItemMaxCountSync(itemId!) ?? amount
    // rounded down, but a reward that pays something never scales to nothing: a 1-unit drop at 50 % still pays 1
    const scaled = amount > 0 && multiplier > 0 ? Math.max(1, Math.floor(amount * multiplier)) : Math.floor(amount * multiplier)
    return Math.max(0, Math.min(limit, scaled))
}

/** Copies a master reward; source tables are never mutated or scaled again by generic inventory grants. */
export function scaleEarnedReward(reward: Reward, multiplier = currentEarningMultiplier()): Reward {
    const copy = { ...reward }
    if (reward.type === RewardType.ITEM) {
        const item = reward as EquipmentItemReward
        return { ...copy, count: scaleEarnedAmount(item.count, "item", item.id, multiplier) } as EquipmentItemReward
    }
    const kind = reward.type === RewardType.BEADS ? "beads" : reward.type === RewardType.MANA ? "mana" : reward.type === RewardType.EXP ? "exp" : null
    return kind === null ? copy : { ...copy, count: scaleEarnedAmount((reward as CurrencyReward).count, kind, undefined, multiplier) } as CurrencyReward
}

/** Converts a game's mail reward at entitlement creation; the gift box's receive path never scales it again. */
export function scaleEarnedMailAmount(type: MailType, amount: number, typeId?: number | null): number {
    if (type === MailType.FREE_VMONEY) return scaleEarnedAmount(amount, "beads")
    if (type === MailType.FREE_MANA) return scaleEarnedAmount(amount, "mana")
    if (type === MailType.EXP_POOL) return scaleEarnedAmount(amount, "exp")
    if (type === MailType.ITEM) return scaleEarnedAmount(amount, "item", typeId ?? undefined)
    return amount
}
