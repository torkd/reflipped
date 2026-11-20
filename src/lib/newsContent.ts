// ADM-4: what the automatic news posts say. Three kinds of thing are announced a week ahead: the calendar's events
// (story, boss, raid, ranking, carnival, gauntlet, co-op boss events), summoning portals, and boosted-drop campaigns.
// Each post says what kind it is, when it runs (real time, UTC, as the server projects it), and everything the
// server knows can be obtained from it: the event shop's units, armaments and items, the raid, ranking and score
// rewards, the collected event item, a portal's featured units. The text is plain: "## " starts a heading and "- "
// a list item (src/lib/newsFormat.ts renders both).

import calendarData from "../../assets/event_calendar.json";
import gachas from "../../assets/gacha.json";
import rewardCampaigns from "../../assets/reward_campaign.json";
import eventItemShop from "../../assets/event_item_shop.json";
import raidOverall from "../../assets/raid_event_overall_reward.json";
import raidRanking from "../../assets/raid_event_ranking_reward.json";
import rankingRewards from "../../assets/ranking_event_ranking_reward.json";
import carnivalRewards from "../../assets/carnival_event_total_score_reward.json";
import rushFolders from "../../assets/rush_event_quest_folder.json";
import collectDrops from "../../assets/collect_item_event_drops.json";
import { getItemCatalog } from "./catalog";
import { eventCatalog } from "./eventSchedule";
import { Announceable, UpcomingEvent } from "./newsSchedule";
import { masterDate } from "../utils";

/** What an announced thing is, for the post's first line. */
export interface NewsSubject extends Announceable {
    kind: "event" | "portal" | "boost"
    /** the post's title: the thing's name */
    name: string
    /** what the thing is called in the first line, e.g. "Raid event" */
    label: string
    /** the sentence saying what that kind of event is */
    about: string
    /** how to look up what it gives */
    detail: () => string[]
}

const MASTER_DATE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/
const jst = (text: string) => masterDate(text).getTime()

// ---- names ----

interface Names { units: Map<number, string>, equipment: Map<number, string>, items: Map<number, string>, titles: Map<number, string> }
let names: Names | undefined

function nameTables(): Names {
    if (names) return names
    const catalog = getItemCatalog()
    return names = {
        units: new Map(catalog.units.map(unit => [unit.id, unit.name ?? `Unit ${unit.id}`])),
        equipment: new Map(catalog.equipment.map(item => [item.id, item.name ?? `Armament ${item.id}`])),
        items: new Map(catalog.items.map(item => [item.id, item.name ?? `Item ${item.id}`])),
        titles: new Map(catalog.degrees.map(degree => [degree.id, degree.name ?? `Title ${degree.id}`]))
    }
}

const unitName = (id: number) => nameTables().units.get(id) ?? `Unit ${id}`
const equipmentName = (id: number) => nameTables().equipment.get(id) ?? `Armament ${id}`
const itemName = (id: number) => nameTables().items.get(id) ?? `Item ${id}`
const titleName = (id: number) => nameTables().titles.get(id) ?? `Title ${id}`

// ---- rewards ----

/** One reward line's meaning, collected so the same thing is listed once. */
type Obtainable = { group: "Units" | "Armaments" | "Items" | "Titles" | "Other", label: string, amount: number }

/** GeneralRewardKind (raid, ranking, carnival and score rewards): 0 item, 1 equipment, 2 beads, 3 mana, 4 pooled exp, 5 unit, 6 title. */
function fromGeneral(reward: { kind: number, id?: number, number: number }): Obtainable | null {
    switch (reward.kind) {
        case 0: return { group: "Items", label: itemName(reward.id ?? 0), amount: reward.number }
        case 1: return { group: "Armaments", label: equipmentName(reward.id ?? 0), amount: reward.number }
        case 2: return { group: "Other", label: "Lodestar Beads", amount: reward.number }
        case 3: return { group: "Other", label: "Mana", amount: reward.number }
        case 4: return { group: "Other", label: "Pooled EXP", amount: reward.number }
        case 5: return { group: "Units", label: unitName(reward.id ?? 0), amount: reward.number }
        case 6: return { group: "Titles", label: titleName(reward.id ?? 0), amount: reward.number }
        default: return null
    }
}

/** ShopItemRewardType (shop products): 0 item, 1 exp, 2 mana, 3 unit, 4 armament. */
function fromShop(reward: { type: number, id?: number, count: number }): Obtainable | null {
    switch (reward.type) {
        case 0: return { group: "Items", label: itemName(reward.id ?? 0), amount: reward.count }
        case 1: return { group: "Other", label: "EXP", amount: reward.count }
        case 2: return { group: "Other", label: "Mana", amount: reward.count }
        case 3: return { group: "Units", label: unitName(reward.id ?? 0), amount: reward.count }
        case 4: return { group: "Armaments", label: equipmentName(reward.id ?? 0), amount: reward.count }
        default: return null
    }
}

const LIST_LIMIT = 80

/** "## Section" and "- name" lines for the obtainable things, units first; a long list is cut with a count. */
function obtainableLines(heading: string, list: Obtainable[]): string[] {
    if (list.length === 0) return []
    const lines: string[] = []
    for (const group of ["Units", "Armaments", "Items", "Titles", "Other"] as const) {
        const merged = new Map<string, number>()
        for (const entry of list) if (entry.group === group) merged.set(entry.label, (merged.get(entry.label) ?? 0) + entry.amount)
        if (merged.size === 0) continue
        const rows = [...merged].map(([label, amount]) => amount > 1 && group !== "Units" && group !== "Armaments" ? `${label} × ${amount}` : label)
        lines.push(`${group}:`, ...rows.slice(0, LIST_LIMIT).map(row => `- ${row}`))
        if (rows.length > LIST_LIMIT) lines.push(`- …and ${rows.length - LIST_LIMIT} more`)
    }
    return lines.length === 0 ? [] : [`## ${heading}`, ...lines]
}

// ---- calendar events ----

const KIND_TEXT: Record<string, { label: string, about: string }> = {
    story_event: { label: "Story event", about: "A limited-time story with its own quests, drops and event rewards." },
    world_story_event: { label: "World story event", about: "A story chapter series with its own quests and boss battles." },
    advent_event: { label: "Boss event", about: "A limited boss to fight alone or in co-op for its drops, with event quests and an item exchange." },
    ranking_event: { label: "Ranking event (time trial)", about: "Play the event quests for the best score: your rank decides the rewards when it ends." },
    carnival_event: { label: "Score event (carnival)", about: "Earn score in the event quests to pass reward borders; the total score of all players unlocks more rewards." },
    raid_event: { label: "Raid event", about: "All players fight one giant boss together: every clear counts towards a shared kill tally that unlocks rewards, and the best scores are ranked." },
    rush_event: { label: "Gauntlet event", about: "A run of battles back to back, with rewards for each round you clear." },
    hard_multi_event: { label: "Co-op boss event", about: "A high-difficulty boss for co-op parties, with daily reward counts and its own drops." }
}

type ShopProduct = { rewards: { type: number, id?: number, count: number }[], availableFrom: string }

/** The shop products that went on sale with the event (the shops are keyed by shop kind, then shop id, then product). */
const shopRewards = (event: { startTime: number }): Obtainable[] => {
    const found: Obtainable[] = []
    const kinds = eventItemShop as unknown as Record<string, Record<string, Record<string, ShopProduct>>>
    for (const shops of Object.values(kinds)) {
        for (const products of Object.values(shops)) {
            for (const product of Object.values(products)) {
                if (!MASTER_DATE.test(product.availableFrom) || jst(product.availableFrom) !== event.startTime) continue
                for (const reward of product.rewards) { const entry = fromShop(reward); if (entry) found.push(entry) }
            }
        }
    }
    return found
}

type GeneralReward = { kind: number, id?: number, number: number }

function eventDetail(event: { id: string, startTime: number }): string[] {
    const [table, rawId] = event.id.split("/")
    const id = Number(rawId)
    const lines: string[] = []
    const general = (rewards: GeneralReward[]) => rewards.flatMap(reward => { const entry = fromGeneral(reward); return entry ? [entry] : [] })

    if (table === "raid_event") {
        const tiers = (raidOverall as unknown as Record<string, { tiers: { kills: number, rewards: GeneralReward[] }[] }>)[String(id)]?.tiers ?? []
        lines.push(...obtainableLines("Kill tally rewards", general(tiers.flatMap(tier => tier.rewards))))
        const byQuest = (raidRanking as unknown as Record<string, Record<string, { rewards: GeneralReward[] }[]>>)[String(id)] ?? {}
        lines.push(...obtainableLines("Ranking rewards", general(Object.values(byQuest).flat().flatMap(tier => tier.rewards))))
    } else if (table === "ranking_event") {
        const tiers = (rankingRewards as unknown as Record<string, { rewards: GeneralReward[] }[]>)[String(id)] ?? []
        lines.push(...obtainableLines("Ranking rewards", general(tiers.flatMap(tier => tier.rewards))))
    } else if (table === "carnival_event") {
        const borders = (carnivalRewards as unknown as Record<string, { rewards: GeneralReward[] }[]>)[String(id)] ?? []
        lines.push(...obtainableLines("Total score rewards", general(borders.flatMap(border => border.rewards))))
    } else if (table === "rush_event") {
        const rounds = (rushFolders as unknown as Record<string, Record<string, { type: number, id?: number, count: number }[]>>)[String(id)] ?? {}
        const list = Object.values(rounds).flat().flatMap(reward => { const entry = fromShop(reward); return entry ? [entry] : [] })
        lines.push(...obtainableLines("Round rewards", list))
    }

    // the collected event item (an event whose drops are gathered and exchanged in its shop)
    const collected = Object.values((collectDrops as unknown as { events: Record<string, { itemId: number, start: string }> }).events)
        .filter(drop => MASTER_DATE.test(drop.start) && jst(drop.start) === event.startTime)
    if (collected.length > 0) lines.push("## Event item", ...[...new Set(collected.map(drop => itemName(drop.itemId)))].map(name => `- ${name}: drops in the event quests and is exchanged in the event shop`))

    lines.push(...obtainableLines("Event shop", shopRewards(event)))
    return lines
}

export function calendarSubjects(): NewsSubject[] {
    return eventCatalog.map(event => {
        const kind = KIND_TEXT[event.kind] ?? { label: "Event", about: "A limited-time event." }
        return {
            id: `event:${event.id}`, kind: "event" as const, name: event.name, label: kind.label, about: kind.about,
            startTime: event.startTime, endTime: event.endTime, detail: () => eventDetail(event)
        }
    })
}

// ---- portals ----

interface GachaRow { startDate: string, endDate: string, type: number, pool: Record<string, { id: number, rank: number, isRateUp: boolean }[]>, guaranteeNumber: number, guaranteeRarity: number }

export function portalSubjects(): NewsSubject[] {
    const portalNames = calendarData.portals as Record<string, string>
    return Object.entries(gachas as unknown as Record<string, GachaRow>)
        .filter(([id, row]) => portalNames[id] !== undefined && MASTER_DATE.test(row.startDate) && MASTER_DATE.test(row.endDate))
        .map(([id, row]) => ({
            id: `portal:${id}`, kind: "portal" as const, name: portalNames[id],
            label: row.type === 1 ? "Armament portal" : "Summoning portal",
            about: "A summoning portal: spend Lodestar Beads or tickets to draw units or armaments, with featured ones drawn more often.",
            startTime: jst(row.startDate), endTime: jst(row.endDate) + 1000,
            detail: () => {
                const pool = Object.values(row.pool).flat()
                const featured = pool.filter(entry => entry.isRateUp)
                const asList = (entries: typeof pool): Obtainable[] => entries.map(entry => ({
                    group: row.type === 1 ? "Armaments" : "Units", label: row.type === 1 ? equipmentName(entry.id) : unitName(entry.id), amount: 1
                }))
                const lines = featured.length > 0 ? obtainableLines("Featured with higher rates", asList(featured)) : []
                lines.push(...obtainableLines("Everything this portal can give", asList(pool)))
                if (row.guaranteeNumber > 0) lines.push("## Guarantee", `- Each 10-pull has ${row.guaranteeNumber} guaranteed draw${row.guaranteeNumber === 1 ? "" : "s"} of ${row.guaranteeRarity}★ or better.`)
                lines.push("## Rates", `- Exact rates for every unit: /game/odds/${id}`)
                return lines
            }
        }))
}

// ---- boosted drops ----

const BOOST_QUESTS: Record<number, string> = {
    0: "main quests", 1: "EX quests", 2: "boss battles", 3: "Kaleidoscope element quests", 4: "EXP and mana quests", 5: "boss event quests",
    6: "story event quests", 7: "the Necropolis and Treasure Zone", 8: "ranking event quests", 9: "world story quests", 10: "world story boss battles",
    11: "practice quests", 12: "Kaleidoscope, EXP and mana quests and the Necropolis", 13: "the Haunt", 14: "Solo Boss Challenges", 15: "carnival quests",
    16: "raid quests", 17: "gauntlet quests", 18: "Chrono Trials", 19: "co-op boss quests", 20: "Score Scramble"
}
const BOOST_REWARD: Record<string, string> = { item: "drops", exp: "EXP", mana: "mana" }

export function boostSubjects(): NewsSubject[] {
    return (rewardCampaigns as { start: string, end: string, reward: string, rate: number, kind: number }[])
        .map((campaign, index) => ({ campaign, index }))
        .filter(({ campaign }) => MASTER_DATE.test(campaign.start) && MASTER_DATE.test(campaign.end))
        .map(({ campaign, index }) => {
            const what = BOOST_REWARD[campaign.reward] ?? "rewards"
            const where = BOOST_QUESTS[campaign.kind] ?? "selected quests"
            return {
                id: `boost:${index}`, kind: "boost" as const, name: `${campaign.rate}× ${what} on ${where}`,
                label: "Boosted drops", about: "A limited time during which some quests give more of one kind of reward.",
                startTime: jst(campaign.start), endTime: jst(campaign.end) + 1000,
                detail: () => ["## What is boosted", `- ${campaign.rate}× ${what} on ${where}.`,
                    "- Campaigns don't stack: of several open at once, each kind of reward takes the highest rate.",
                    ...(campaign.reward === "item" ? ["- Rank points, first-clear rewards and S+ rewards are not boosted."] : [])]
            }
        })
}

let subjects: NewsSubject[] | undefined

/** Everything announced ahead, by id. */
export function newsSubjects(): NewsSubject[] {
    return subjects ??= [...calendarSubjects(), ...portalSubjects(), ...boostSubjects()]
}

// ---- the post ----

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

/** "17 December 2026, 14:00 UTC" */
export function newsDateText(time: number): string {
    const date = new Date(time)
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`
}

/** The title and text of the post for an upcoming thing. */
export function buildNewsPost(upcoming: UpcomingEvent<NewsSubject>): { title: string, body: string } {
    const { event, opens, closes } = upcoming
    const days = Math.max(1, Math.round((closes - opens) / 86_400_000))
    const lines = [
        `${event.label}: ${event.name}`,
        "",
        event.about,
        "",
        `Opens: ${newsDateText(opens)}`,
        `Closes: ${newsDateText(closes)} (about ${days} day${days === 1 ? "" : "s"})`
    ]
    const detail = event.detail()
    if (detail.length > 0) lines.push("", ...detail)
    else lines.push("", "The rewards and quests are listed in the game when it opens.")
    lines.push("", "Dates are the server's schedule in UTC; the game shows them in your time zone.")
    return { title: `Coming up: ${event.name}`, body: lines.join("\n") }
}
