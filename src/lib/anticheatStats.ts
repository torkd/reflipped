// SEC-18 phase 4: the soft review rules R9–R12 (docs/hardening.md, "Anti-cheat"). They never act: each raises a soft
// flag for the admin's review page, in every mode but off. Phase 1's rules (src/lib/anticheatRules.ts) judge a finish
// against what an honest client can send; these compare it with what the server has seen from everyone else:
//
// - R9 `damage-ceiling` and R10 `outlier`: per quest, a compact distribution of the server's own honest-looking
//   finishes (log-scale histograms in anticheat_finish_stats), and a finish far outside it. A strict damage ceiling would
//   need the battle formulas (skills, multipliers), which we don't have, so R9 is statistical: damage per party power
//   point, which the client's own power formula (src/lib/partyPower.ts) makes comparable across parties.
// - R11 `play-rate`: battles per real hour, and long runs of play without a break, from the finishes' arrival times.
// - R12 `linked-accounts`: accounts that share a device key, a portal user or a network and meet in a ranking event or a
//   co-op room.
//
// Thresholds stay in code (the owner's decision); they are first guesses to calibrate in log mode. Flag details carry
// our own values only (numbers, ids, rule words), never a request body, token or address (OPS-2).
import { createHmac, createHash, randomBytes } from "crypto";
import { anticheatMode, boardHiddenPlayers, FinishCheck, recordAnticheatFlag } from "./anticheat";
import { repeatOpenAnticheatFlagSync } from "../data/anticheatData";
import {
    FinishStatsRow, getFinishStatsRowsSync, getPlayRateSync, insertLinkedPairSync, noteDeviceKeySync, playersOfSamePortalUserSync,
    playersSharingDeviceKeySync, pruneDeviceKeysSync, setFinishStatsRowSync, setPlayRateSync
} from "../data/anticheatStatsData";
import { getAccountDeviceSecretHashSync, getPlayerRankingRecordSync, getViewerPlayerIdSync } from "../data/wdfpData";
import { partyPowerSync } from "./partyPower";
import { partySlotIds } from "./borderRewards";
import { rankingEventId } from "./ranking";
import { finishingRoundOf } from "./coop/rooms";
import { isLoopbackHost, rateLimitKey } from "./rateLimit";
import { QuestCategory } from "./types";

export type StatsRuleName = "damage-ceiling" | "outlier" | "play-rate" | "linked-accounts"

export interface StatsFlag {
    rule: StatsRuleName
    playerId: number
    details: Record<string, number | string | boolean | null>
}

// ---- R9, R10: the server's own distributions ----

/** A distribution judges nothing before it holds this many finishes. */
export const MIN_SAMPLES = 30
/** Past this many samples a distribution's counts are halved, so it stays small and follows the server's present. */
export const DECAY_AT = 1000
/** Histogram resolution: 4 bins an octave (each bin 19% wide), covering 2^-8 to 2^40. */
export const BINS_PER_OCTAVE = 4
const MIN_LOG2 = -8
const MAX_BIN = (40 - MIN_LOG2) * BINS_PER_OCTAVE - 1

type Metric = "clearTime" | "score" | "maxHitPerPower" | "bossDpsPerPower"

/**
 * How far from the median a finish may be. R10 follows the research's "3× the median per power band" (a clear in a
 * third of the median time). R9's biggest hit gets more room: at the same power one party's top skill can hit far
 * harder than another's, while damage per second averages over the whole battle.
 */
export const METRIC_RULES: Record<Metric, { rule: StatsRuleName, factor: number, low: boolean, banded: boolean }> = {
    clearTime: { rule: "outlier", factor: 3, low: true, banded: true },
    score: { rule: "outlier", factor: 3, low: false, banded: true },
    maxHitPerPower: { rule: "damage-ceiling", factor: 5, low: false, banded: false },
    bossDpsPerPower: { rule: "damage-ceiling", factor: 3, low: false, banded: false }
}

/** Party power bands: half an octave each (×1.41), -1 for every power (or an unknown one). */
export function powerBand(power: number): number {
    return power > 0 ? Math.floor(Math.log2(power) * 2) : -1
}

export function binOf(value: number): number {
    return Math.min(MAX_BIN, Math.max(0, Math.floor((Math.log2(value) - MIN_LOG2) * BINS_PER_OCTAVE)))
}

const binEdge = (bin: number) => 2 ** (bin / BINS_PER_OCTAVE + MIN_LOG2)

/** The median's bin, as [lower edge, upper edge]; null for an empty histogram. */
export function medianRange(row: Pick<FinishStatsRow, "samples" | "bins">): [number, number] | null {
    const bins = Object.entries(row.bins).map(([bin, count]) => [Number(bin), count] as const).sort((a, b) => a[0] - b[0])
    const total = bins.reduce((sum, [, count]) => sum + count, 0)
    if (total <= 0) return null
    let seen = 0
    for (const [bin, count] of bins) {
        seen += count
        if (seen * 2 >= total) return [binEdge(bin), binEdge(bin + 1)]
    }
    return null
}

/** Adds a value to a row, halving its counts past DECAY_AT. */
export function addSample(row: FinishStatsRow, value: number): FinishStatsRow {
    let bins = { ...row.bins }
    const bin = String(binOf(value))
    bins[bin] = (bins[bin] ?? 0) + 1
    let samples = row.samples + 1
    if (samples > DECAY_AT) {
        const halved: Record<string, number> = {}
        samples = 0
        for (const [key, count] of Object.entries(bins)) {
            const half = Math.floor(count / 2)
            if (half > 0) { halved[key] = half; samples += half }
        }
        bins = halved
    }
    return { ...row, samples, bins }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null

/** The metrics of an accomplished, unrestored finish (others give none); `power` is the party's (0: unknown). */
export function finishMetrics(body: unknown, power: number): Partial<Record<Metric, number>> {
    const finish = isRecord(body) ? body : {}
    if (finish.is_accomplished !== true || finish.is_restored === true) return {}
    const statistics = isRecord(finish.statistics) ? finish.statistics : {}
    const zones = Array.isArray(statistics.zones) ? statistics.zones.slice(0, 64).filter(isRecord) : []
    const metrics: Partial<Record<Metric, number>> = {}
    const elapsedMs = finite(finish.elapsed_time_ms)
    if (elapsedMs !== null && elapsedMs > 0) metrics.clearTime = elapsedMs
    const score = finite(finish.score)
    if (score !== null && score > 0) metrics.score = score
    if (power > 0 && zones.length > 0) {
        const maxHit = Math.max(0, ...zones.map(zone => finite(zone.damage_deal_max) ?? 0))
        if (maxHit > 0) metrics.maxHitPerPower = maxHit / power
        const bossDamage = zones.reduce((total, zone) => total + Math.max(0, finite(zone.boss_damage_deal_total) ?? 0), 0)
        if (bossDamage > 0 && elapsedMs !== null && elapsedMs >= 1000) metrics.bossDpsPerPower = bossDamage / (elapsedMs / 1000) / power
    }
    return metrics
}

/** The party's power from the finish's statistics.party (the player's own units, armaments and cores as they are now). */
function finishPartyPower(playerId: number, body: unknown): number {
    const statistics = isRecord(body) && isRecord(body.statistics) ? body.statistics : {}
    const party = isRecord(statistics.party) ? statistics.party : {}
    const characters = partySlotIds(party.characters)
    const unisons = partySlotIds(party.unison_characters)
    const equipments = partySlotIds(party.equipments)
    const souls = partySlotIds(party.ability_soul_ids)
    if (characters.every(id => id === null)) return 0
    return partyPowerSync(playerId, characters.map((character, slot) => ({
        character, unisonCharacter: unisons[slot] ?? null, equipment: equipments[slot] ?? null, abilitySoul: souls[slot] ?? null
    })))
}

const round = (value: number) => Number(value.toPrecision(4))

/**
 * R9 and R10: judges the finish against its quest's distributions, then adds it to them unless it may be a cheat (a
 * hard flag from phase 1, an outlier here, or a player kept off the boards).
 */
function distributionFlags(input: FinishStatsInput, playerId: number, questId: number, mayFeed: boolean): StatsFlag[] {
    const power = finishPartyPower(playerId, input.body)
    const metrics = finishMetrics(input.body, power)
    const entries = Object.entries(metrics) as [Metric, number][]
    if (entries.length === 0) return []
    const band = powerBand(power)
    const rows = getFinishStatsRowsSync(input.category, questId, input.coop, band)
    const rowOf = (metric: Metric): FinishStatsRow => {
        const rowBand = METRIC_RULES[metric].banded ? band : -1
        return rows.find(row => row.metric === metric && row.band === rowBand) ?? { metric, band: rowBand, samples: 0, bins: {} }
    }

    const outlying = new Map<StatsRuleName, StatsFlag>()
    for (const [metric, value] of entries) {
        const settings = METRIC_RULES[metric]
        const row = rowOf(metric)
        if (row.samples < MIN_SAMPLES) continue
        const median = medianRange(row)
        if (median === null) continue
        // the median's far edge, so the histogram's rounding only ever makes the bound looser
        const bound = settings.low ? median[0] / settings.factor : median[1] * settings.factor
        if (settings.low ? value >= bound : value <= bound) continue
        const flag = outlying.get(settings.rule) ?? { rule: settings.rule, playerId, details: { power, band, coop: input.coop } }
        Object.assign(flag.details, {
            [metric]: round(value), [`${metric}Median`]: round(Math.sqrt(median[0] * median[1])), [`${metric}Bound`]: round(bound),
            [`${metric}Samples`]: row.samples
        })
        outlying.set(settings.rule, flag)
    }

    if (mayFeed && outlying.size === 0) {
        for (const [metric, value] of entries) setFinishStatsRowSync(input.category, questId, input.coop, addSample(rowOf(metric), value))
    }
    return [...outlying.values()]
}

// ---- R11: play rate ----

/** Finishes in one real-time clock hour that need a look: one every 30 s for a whole hour, beyond a person's pace. */
export const MAX_FINISHES_PER_HOUR = 120
/** A run of play with no break this long or longer... */
export const LONG_PLAY_MS = 12 * 3600_000
/** ...where a break is this long a gap between finishes. */
export const PLAY_BREAK_MS = 3600_000

/**
 * R11. Honest AFK farming with the client's auto-repeat can reach either threshold too, so each flag notes whether the
 * finish that raised it was an auto-repeat battle (`autoStart`), for the admin to weigh; it stays soft.
 */
function playRateFlags(playerId: number, nowMs: number, autoStart: boolean): StatsFlag[] {
    const hour = Math.floor(nowMs / 3600_000)
    const last = getPlayRateSync(playerId)
    const row = last === null
        ? { hour, hourCount: 1, sessionStart: nowMs, lastFinish: nowMs, flaggedHour: -1, flaggedSession: -1 }
        : {
            ...last,
            hour,
            hourCount: last.hour === hour ? last.hourCount + 1 : 1,
            sessionStart: nowMs - last.lastFinish >= PLAY_BREAK_MS ? nowMs : last.sessionStart,
            lastFinish: nowMs
        }
    const flags: StatsFlag[] = []
    if (row.hourCount >= MAX_FINISHES_PER_HOUR && row.flaggedHour !== hour) {
        flags.push({ rule: "play-rate", playerId, details: { check: "battles-per-hour", battles: row.hourCount,
            hourStart: new Date(hour * 3600_000).toISOString(), threshold: MAX_FINISHES_PER_HOUR, autoStart } })
        row.flaggedHour = hour
    }
    if (nowMs - row.sessionStart >= LONG_PLAY_MS && row.flaggedSession !== row.sessionStart) {
        flags.push({ rule: "play-rate", playerId, details: { check: "long-play", playStart: new Date(row.sessionStart).toISOString(),
            hours: Math.floor((nowMs - row.sessionStart) / 360_000) / 10, breakMinutes: PLAY_BREAK_MS / 60_000, autoStart } })
        row.flaggedSession = row.sessionStart
    }
    setPlayRateSync(playerId, row)
    return flags
}

// ---- R12: linked accounts ----

/** How long a device key links accounts after the last battle finished with it. */
export const DEVICE_KEY_RETENTION_MS = 90 * 24 * 3600_000
/** How long a network (address) key links accounts; kept in memory only. */
export const NETWORK_RETENTION_MS = 48 * 3600_000
/** A network shared by more players than this is a shared or proxy address (a misconfigured TRUST_PROXY): ignored. */
export const NETWORK_MAX_PLAYERS = 8
const NETWORK_MAX_TRACKED_PLAYERS = 100_000
const NETWORK_KEYS_PER_PLAYER = 8

/**
 * A device key: a hash of the account's device secret hash (itself a SHA-256 of a random per-install secret), so the
 * table never holds what loginDevice looks accounts up by. Domain-separated, unkeyed: the input is random already.
 */
export function deviceKey(deviceSecretHash: string): string {
    return createHash("sha256").update(`reflipped-anticheat-device\0${deviceSecretHash}`).digest("hex").slice(0, 32)
}

/**
 * Network keys: an HMAC of the address's rate-limit bucket (IPv4 address, IPv6 /64) with a random key made at each
 * start and never stored, truncated to 64 bits. They live in memory only, for NETWORK_RETENTION_MS: no address, and
 * nothing an address could be recovered from, reaches the database or survives a restart.
 */
const networkSecret = randomBytes(32)
const networkPlayers = new Map<string, Map<number, number>>()
/** player → their network keys → last seen; insertion order is least recently noted first */
const playerNetworks = new Map<number, Map<string, number>>()
let lastNetworkSweep = 0

/** The address's network key; null for loopback (also IPv4-mapped, as a dual-stack listener reports it). */
function networkKey(ip: string): string | null {
    const bucket = rateLimitKey(ip)
    if (isLoopbackHost(ip) || isLoopbackHost(bucket)) return null
    return createHmac("sha256", networkSecret).update(bucket).digest("hex").slice(0, 16)
}

function forgetNetwork(playerId: number, key: string): void {
    playerNetworks.get(playerId)?.delete(key)
    const players = networkPlayers.get(key)
    players?.delete(playerId)
    if (players?.size === 0) networkPlayers.delete(key)
}

function sweepNetworks(nowMs: number): void {
    if (nowMs - lastNetworkSweep < 10 * 60_000) return
    lastNetworkSweep = nowMs
    for (const [playerId, keys] of playerNetworks) {
        for (const [key, seen] of keys) if (nowMs - seen > NETWORK_RETENTION_MS) forgetNetwork(playerId, key)
        if (keys.size === 0) playerNetworks.delete(playerId)
    }
}

/**
 * Notes the network a player's finish came from (R12). The co-op finish calls this with the outer request's address,
 * since the single-player finish it runs arrives from loopback. Loopback is ignored; nothing is kept while off.
 */
export function noteFinishAddress(playerId: number, ip: string | undefined, nowMs = Date.now()): void {
    try {
        if (ip === undefined || ip === "" || anticheatMode() === "off") return
        const key = networkKey(ip)
        if (key === null) return
        sweepNetworks(nowMs)
        let keys = playerNetworks.get(playerId)
        if (keys === undefined) {
            if (playerNetworks.size >= NETWORK_MAX_TRACKED_PLAYERS) {
                const [oldest, oldestKeys] = playerNetworks.entries().next().value!
                for (const old of [...oldestKeys.keys()]) forgetNetwork(oldest, old)
                playerNetworks.delete(oldest)
            }
            keys = new Map()
        }
        playerNetworks.delete(playerId)
        playerNetworks.set(playerId, keys)
        keys.delete(key)
        keys.set(key, nowMs)
        if (keys.size > NETWORK_KEYS_PER_PLAYER) forgetNetwork(playerId, keys.keys().next().value!)
        let players = networkPlayers.get(key)
        if (players === undefined) networkPlayers.set(key, players = new Map())
        players.set(playerId, nowMs)
    } catch (error) {
        console.error("anti-cheat: finish address not noted:", error)
    }
}

function playersSharingNetwork(playerId: number, nowMs: number): number[] {
    const linked = new Set<number>()
    for (const [key, seen] of playerNetworks.get(playerId) ?? []) {
        if (nowMs - seen > NETWORK_RETENTION_MS) continue
        const players = [...(networkPlayers.get(key) ?? [])].filter(([, at]) => nowMs - at <= NETWORK_RETENTION_MS)
        if (players.length > NETWORK_MAX_PLAYERS) continue
        for (const [other] of players) if (other !== playerId) linked.add(other)
    }
    return [...linked]
}

/** Clears the in-memory network keys and write throttles (tests). */
export function resetAnticheatStatsMemory(): void {
    networkPlayers.clear()
    playerNetworks.clear()
    deviceNoted.clear()
    lastNetworkSweep = 0
    lastDevicePrune = 0
}

const deviceNoted = new Map<number, { key: string, atMs: number }>()
let lastDevicePrune = 0

/** Notes the device key the player's account holds now; written at most hourly per player and key. */
function noteDevice(playerId: number, accountId: number, nowMs: number): void {
    if (nowMs - lastDevicePrune >= 24 * 3600_000) {
        lastDevicePrune = nowMs
        pruneDeviceKeysSync(nowMs - DEVICE_KEY_RETENTION_MS)
    }
    const hash = getAccountDeviceSecretHashSync(accountId)
    if (hash === null) return
    const key = deviceKey(hash)
    const noted = deviceNoted.get(playerId)
    if (noted !== undefined && noted.key === key && nowMs - noted.atMs < 3600_000) return
    noteDeviceKeySync(key, playerId, nowMs)
    if (deviceNoted.size >= 100_000) deviceNoted.clear()
    deviceNoted.set(playerId, { key, atMs: nowMs })
}

type LinkKind = "device" | "portal-user" | "network"

/** The players linked to this one, and how. */
function linkedPlayers(playerId: number, accountId: number, nowMs: number): Map<number, Set<LinkKind>> {
    const links = new Map<number, Set<LinkKind>>()
    const add = (kind: LinkKind, ids: number[]) => {
        for (const id of ids) {
            if (id === playerId) continue
            let kinds = links.get(id)
            if (kinds === undefined) links.set(id, kinds = new Set())
            kinds.add(kind)
        }
    }
    add("device", playersSharingDeviceKeySync(playerId, nowMs - DEVICE_KEY_RETENTION_MS))
    add("portal-user", playersOfSamePortalUserSync(accountId, playerId))
    add("network", playersSharingNetwork(playerId, nowMs))
    return links
}

/** The other human players of the co-op round of this quest the viewer is finishing now (the newest: finishingRoundOf()). */
function coopRoundPlayers(viewerId: number, questId: number, category: number): { playerIds: number[], questId: number } | null {
    const room = finishingRoundOf(viewerId, questId, category)
    if (room === undefined) return null
    const playerIds = room.lastRoundViewerIds.filter(id => id !== viewerId).slice(0, 8)
        .map(id => getViewerPlayerIdSync(id)).filter((id): id is number => id !== null)
    return { playerIds, questId: room.questId }
}

/** R12: linked players who meet this one in a ranking event (both have a record) or the co-op round being finished. */
function linkedAccountFlags(input: FinishStatsInput, playerId: number, questId: number, nowMs: number): StatsFlag[] {
    noteDevice(playerId, input.accountId, nowMs)
    if (!input.coop) noteFinishAddress(playerId, input.ip, nowMs)

    // the links are only looked up where players can meet: a ranking event's battle or a co-op round
    let found: Map<number, Set<LinkKind>> | undefined
    const links = () => found ??= linkedPlayers(playerId, input.accountId, nowMs)
    const meetings: { otherId: number, context: Record<string, number | string> }[] = []
    if (input.category === QuestCategory.RANKING_EVENT_SINGLE) {
        const eventId = rankingEventId(questId)
        for (const otherId of links().keys()) {
            if (getPlayerRankingRecordSync(otherId, eventId) !== null) meetings.push({ otherId, context: { where: "ranking-event", eventId } })
        }
    }
    if (input.coop) {
        const round = coopRoundPlayers(input.viewerId, questId, input.category)
        if (round !== null && round.playerIds.length > 0) {
            for (const otherId of round.playerIds) {
                if (links().has(otherId)) meetings.push({ otherId, context: { where: "coop-room", questId: round.questId } })
            }
        }
    }
    if (meetings.length === 0) return []

    const flags: StatsFlag[] = []
    const seen = new Set<number>()
    for (const { otherId, context } of meetings) {
        if (seen.has(otherId)) continue
        seen.add(otherId)
        if (!insertLinkedPairSync(playerId, otherId, new Date(nowMs))) continue
        const how = [...(links().get(otherId) ?? [])].sort().join(", ")
        // one flag on each of the pair, each naming the other, so both show on their own pages
        flags.push({ rule: "linked-accounts", playerId, details: { linkedPlayerId: otherId, links: how, ...context } })
        flags.push({ rule: "linked-accounts", playerId: otherId, details: { linkedPlayerId: playerId, links: how, ...context } })
    }
    return flags
}

// ---- the finish ----

export interface FinishStatsInput {
    accountId: number
    viewerId: number
    category: number
    coop: boolean
    /** the finish's body as the client sent it (read defensively) */
    body: unknown
    /** the request's address (request.ip); loopback, as in the co-op finish's inner request, is ignored */
    ip?: string
    /** the flags phase 1 raised for this finish (checkFinishSync): a hard one keeps it out of the distributions */
    ruleFlags: readonly { severity: string }[]
    /** the battle was started by the client's auto-repeat (the active quest's is_auto_start_mode): noted in R11's details */
    autoStart?: boolean
    /** real time (Date.now()); tests pass their own */
    nowMs?: number
}

/**
 * Runs R9–R12 on a new finish and records their soft flags (every mode but off; off reads and writes nothing).
 * Never throws: a failing rule is logged and the finish goes on. Returns the flags raised.
 */
export function checkFinishStatsSync(input: FinishStatsInput, check: FinishCheck): StatsFlag[] {
    // never throws: a failing review rule must not cost a player their battle (the finish runs in one transaction)
    try {
        return checkFinishStatsUnguarded(input, check)
    } catch (error) {
        if (check.logError) check.logError(error)
        else console.error("anti-cheat: finish statistics failed:", error)
        return []
    }
}

function checkFinishStatsUnguarded(input: FinishStatsInput, check: FinishCheck): StatsFlag[] {
    if (anticheatMode() === "off") return []
    const nowMs = input.nowMs ?? Date.now()
    const flags: StatsFlag[] = []
    const run = (name: string, rule: () => StatsFlag[]) => {
        try {
            flags.push(...rule())
        } catch (error) {
            if (check.logError) check.logError(error)
            else console.error(`anti-cheat: ${name} failed:`, error)
        }
    }
    const mayFeed = !input.ruleFlags.some(flag => flag.severity === "hard") && !boardHiddenPlayers().has(check.playerId)
    run("finish distributions", () => distributionFlags(input, check.playerId, check.questId, mayFeed))
    run("play rate", () => playRateFlags(check.playerId, nowMs, input.autoStart === true))
    run("linked accounts", () => linkedAccountFlags(input, check.playerId, check.questId, nowMs))
    for (const flag of flags) {
        // R9/R10 can fire on every finish of a consistently strong player: one open flag per player, rule and quest,
        // counting the repeats, until the admin resolves it (R11 and R12 have their own once-only rules)
        if (REPEATING_RULES.has(flag.rule) && repeatOpenFlag(flag, check.questId, nowMs)) continue
        recordAnticheatFlag({ playerId: flag.playerId, rule: flag.rule, severity: "soft", route: check.route, questId: check.questId,
            details: flag.details, reqId: check.reqId })
    }
    return flags
}

const REPEATING_RULES = new Set<StatsRuleName>(["damage-ceiling", "outlier"])

/** Counts a repeat on the open flag of the same rule and quest; false (record a new flag) when there is none. */
function repeatOpenFlag(flag: StatsFlag, questId: number, nowMs: number): boolean {
    try {
        return repeatOpenAnticheatFlagSync(flag.playerId, flag.rule, questId, new Date(nowMs))
    } catch (error) {
        console.error("anti-cheat: flag repeat not counted:", error)
        return false
    }
}
