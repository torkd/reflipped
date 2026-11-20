// SEC-18 phase 1: the rules that judge a battle finish (docs/hardening.md, "Anti-cheat"). One pure function,
// judgeFinish(), compares what the client reports with what the server saw (the battle's real start, its party) and
// with the quest's master data. It returns flags; recording them and acting on them is src/lib/anticheat.ts's job.
//
// Hard rules flag what an honest client can't send; soft ones are for review. The thresholds stay in code (the owner's
// decision); only the wall-clock slack is a setting (anticheat.wall_clock_slack_seconds). Flag details carry our own
// values only (times, counts, ids), never a request body or token (OPS-2).
//
// What the captures show (docs/routes/single_battle_quest_finish.md, multi_battle_quest_finish.md; one zone each):
// - a zone's playthrough_ms is its playthrough_frame × 17 in both: the battle timer adds Math.round(16.667) = 17 ms
//   per counted frame, plus real stalls (at most 1000 ms per UpdateTime sync, only while the timer runs);
// - solo: elapsed_time_ms equals the zone's playthrough_ms (20995); co-op: 510 ms below it (42007 vs 42517), since a
//   co-op clear time is the smallest over the player's own and the teammates' battles;
// - damage_deal_max ≤ damage_deal_total, and boss_damage_deal_total ≤ damage_deal_total (equal in the boss fight);
// - damage_to_boss_own is above damage_deal_total in the co-op capture (15049011 vs 14667345), so it is not compared;
// - the solo capture is a cleared Treasure Zone quest with no boss and 0 boss damage.
//
// Several zones (0.0.81 bytecode, no capture yet; review of 2026-11-14): a zone's figures are its own, never a running
// total. ZoneImpl.preparation builds each zone a fresh damage stats object and a fresh stats manager, and ZoneImpl.run
// (the zone's start) snapshots the battle-wide ElapsedTimeCalculator (setupStartTime: startFrame = rawFrame, startTime =
// maxRawTime). A phase's playthrough_frame and playthrough_ms are rawFrame − startFrame and maxRawTime − startTime;
// fixPhasePlayStatistics stores them and resets the start and the damage stats (initializeStats) before the next phase.
// The zone's figures (getZoneStatistics) sum its phases, and its damage_deal_max is the largest phase max, each phase
// keeping damage_deal_total (add, stat 3) and damage_deal_max (setMax, stat 4) over the same hits. So the zones'
// frames and times add up to the battle's (R2, R4 elapsed-*-zones) and each zone's max stays within its total.

import { QuestCategory } from "./types";

export type RuleName = "wall-clock" | "speed" | "instant-finish" | "consistency" | "time-limit" | "party-changed" | "score"

export interface RuleFlag {
    rule: RuleName
    severity: "hard" | "soft"
    details: Record<string, number | string | boolean | null | (number | null)[]>
}

// The battle's clock, from the client's bytecode (0.0.81, static analysis):
// - the frame loop (pinball/context/Top.hx `frame`) is a fixed-step accumulator: each logic step is 1/60 s, at most 3
//   steps run per enter-frame and the backlog is clamped to 7, with a speed rate never above 1 (lower in co-op while
//   lagging, 0.01 while inactive);
// - the auto speed levels 1, 2 and 3 run 1, 2 and 3 steps a frame (BattleScenePlayingStateImpl.proceedBattles,
//   BattleScene.getBattleSpeed); release builds have no debug speed;
// - playthrough_frame counts only the frames the battle timer runs (ElapsedTimeCalculator.update, while
//   canProgressElapsedTimer: not before launch, zone changes, cut-ins or the result fade), 17 ms each in playthrough_ms.
// So over T real seconds an honest battle simulates at most 3 × (7 + 60 T) = 180 T + 21 frames, in co-op too.

/** The top battle speed, as a factor of the normal 60 frames a second (auto speed level 3). */
export const MAX_BATTLE_SPEED = 3
/** The milliseconds a counted frame adds to playthrough_ms (Math.round(16.667)). */
export const MS_PER_FRAME = 17
/** Frames per real second at the top speed. */
export const MAX_FRAMES_PER_SECOND = 60 * MAX_BATTLE_SPEED
/** R1 and R2: headroom on the speed ceilings (rounding, timer granularity). */
export const SPEED_MARGIN = 1.05
/** R3: a clear claimed this soon after the start (real time, loading included) is worth a look (soft). */
export const INSTANT_FINISH_MS = 5_000
/** R4: how far the clear time may be from the zones' summed playthrough_ms, per zone. */
export const ZONE_TIME_TOLERANCE_MS = 1_000
/** R5: rounding on top of the quest's time limit (the battle clock may add up to 1 s of real time per command). */
export const TIME_LIMIT_TOLERANCE_MS = 5_000

/** Quest kinds that are a boss fight: a solo clear with no boss damage at all is suspicious (R4, soft). */
const BOSS_CATEGORIES = new Set<number>([
    QuestCategory.BOSS_BATTLE,
    QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE,
    QuestCategory.RAID_EVENT,
    QuestCategory.HARD_MULTI_EVENT,
    QuestCategory.EXPERT_SINGLE_EVENT,
    QuestCategory.SOLO_TIME_ATTACK_EVENT
])

// R8, the score. The final score, from the 0.0.81 bytecode (static analysis; Battle.hx `getClearParameter`, the multi
// result's `getMyFinalScore` / `getOtherFinalScore` and the final score class they build):
//   score = floor((battle score + score bonuses) × time multiplier), clamped to 0 … 99,999,999,999.
// - The battle score, for every quest kind but the ranking events, Carnival, Chrono Trials and Score Scramble (each has
//   its own calculator): the damage dealt to hostile targets (breakable blocks left out) plus the healing done to the
//   party, outside healing from a continue. In co-op it is the largest over the room's battles, and every phone simulates
//   everyone's hits on the shared boss, so it is close to the whole room's damage.
// - The score bonuses (master score/score_bonus): the best skill chain bonus reached (300, 700 or 1500), the follow bonus
//   (the start's total_follow_bonus, at least 10; Reflipped caps it at 9990, FOLLOW_BONUS_CAP in follows.ts), a greeting
//   (10) and, for the player's own score in co-op only, the contribution rank (5000, 3000 or 1000).
// - The time multiplier (the score source's `getTimeMultiplier`): from x = 1 − clear time / time limit, 0.01 when x is
//   under 0.1077, then (2x)³ up to x = 0.5, 1 up to 0.6, 1 + 1.5 × (5(x − 0.6))² up to 0.8, 4 − 1.5 × (5(x − 1))² up
//   to 1 and 4 beyond, each rounded down to a hundredth; doubled for a solo play of an advent, boss battle or world story
//   boss quest when the quest can be played in co-op too (always for world story bosses, per quest for the others). In
//   co-op it is the largest over the room's battles and never doubled.
// Checked against the captures: the co-op finish's 8083396649 is floor(2067364872 × 3.91) and its two mates' scores differ from
// it by exactly 1800 and 400 × 3.91; in the emulator rounds of 2026-11-14 own and seen scores differ by 1000 or 5000 ×
// 3.99, 3.63 and 3.71, the multipliers of 1972, 59330 and 52054 ms on a 600 s limit. The solo capture fits 3.99 (20995 ms
// of 1800 s) with a battle score of 60428, which is its damage_deal_total (45428) plus 15000 the statistics don't show.
//
// What the finish carries: the clear time (so the multiplier, given the quest's limit), the player's own damage and heals,
// damage_to_boss_all in co-op. What it doesn't: the battle score itself (the solo capture's extra 15000; in the emulator
// rounds the battle score was 1.3 to 1.44 × damage_to_boss_all), the skill chain and greeting bonuses. So the score
// can't be recomputed, and R8 is:
// - hard `above-max`: the client never sends more than 99,999,999,999;
// - hard `mates` (co-op): the player's own score and each mate's in the same finish share the battle score and the
//   multiplier on one phone, so they differ only by their bonuses × the multiplier (at most 4 in co-op): at most 70,001
//   apart. This is drift-proof (one phone's own numbers; R7 compares phones);
// - soft `damage`: a score beyond what twice the damage and healing the finish reports, plus 50,000 points, can earn at the
//   top multiplier. Honest finishes so far reach 43 to 65% of it, so it catches a score raised 1.5 to 2.5 times or more.

/** R8: the largest final score the client sends (the final score's clamp). */
export const MAX_SCORE = 99_999_999_999
/** R8: the top time multiplier, ×2 for a solo play of a boss quest co-op can also play. */
export const MAX_TIME_MULTIPLIER = 4
/** R8: the most score bonus points one player can have: contribution 5000, skill chains (all three, to be safe) 2500,
 * greeting 10, the follow bonus cap 9990, and the achievement bonuses the result screen showed in the emulator QA of
 * 2026-11-14 (a Lv3 power flip 2000, 4+ skills 2000, 10+ soft-spot hits 5000, no unit through the flippers 500, ending
 * with 70%+ HP 3000, no deaths 2000, a coffined unit revived 1500): an own score and a mate's view of it differ by the
 * achievements each phone counted plus the own contribution rank (27,462 = 6,900 × 3.98 seen). */
export const MAX_SCORE_BONUS = 5_000 + 2_500 + 10 + 9_990 + 2_000 + 2_000 + 5_000 + 500 + 3_000 + 2_000 + 1_500
/** R8 `mates`: how far apart the own score and a mate's may be in one co-op finish: the bonuses × the multiplier, twice
 * over for bonus kinds not seen yet (a doubled or invented score is far beyond it). */
export const COOP_SCORE_GAP = 2 * MAX_TIME_MULTIPLIER * MAX_SCORE_BONUS + 1
/** R8 `damage`: the battle score's headroom over the reported damage and healing (honest finishes: up to 1.44×). */
export const SCORE_DAMAGE_FACTOR = 2
/** R8 `damage`: points on top (bonuses and the battle score the statistics don't show, 15,000 in the solo capture). */
export const SCORE_DAMAGE_SLACK = 50_000

/** Quest kinds whose score comes from another calculator than damage and healing (left out of R8 `damage`). */
const OWN_SCORE_CATEGORIES = new Set<number>([
    QuestCategory.RANKING_EVENT_SINGLE,
    QuestCategory.CARNIVAL_EVENT,
    QuestCategory.SOLO_TIME_ATTACK_EVENT,
    QuestCategory.SCORE_ATTACK_EVENT
])
/** Boss quests co-op can also play: their solo plays may double the time multiplier. */
const DOUBLED_MULTIPLIER_CATEGORIES = new Set<number>([
    QuestCategory.BOSS_BATTLE,
    QuestCategory.ADVENT_EVENT_SINGLE,
    QuestCategory.ADVENT_EVENT_MULTI,
    QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE
])

/** The client's time multiplier for a clear time / time limit ratio (see above); `doubled` for a solo boss play. */
export function timeMultiplier(clearTimeRate: number, doubled = false): number {
    const x = 1 - clearTimeRate
    // the client rounds down to hundredths after adding 1e-10 twice
    const hundredths = (value: number) => Math.floor(value * 100 + 1e-10 + 1e-10) * 0.01
    let multiplier: number
    if (x < 0.1077) multiplier = 0.01
    else if (x < 0.5) { const y = x * 2; multiplier = hundredths(y * y * y) }
    else if (x < 0.6) multiplier = 1
    else if (x < 0.8) { const y = (x - 0.6) * 5; multiplier = hundredths(y * y * 1.5 + 1) }
    else if (x < 1) { const y = (x - 1) * 5; multiplier = hundredths(-y * y * 1.5 + 4) }
    else multiplier = 4
    return doubled ? multiplier * 2 : multiplier
}

export interface FinishJudgement {
    /** what the start recorded (ActiveQuest) */
    start: {
        /** real time of the start's reply (Date.now()); none: R1 and R3 are skipped */
        startedAtMs?: number
        /** the party the battle started with; null or none (a fixed party): R6 is skipped */
        startParty?: { characterIds: (number | null)[] } | null
        /** play_continue calls the server answered for this battle */
        continues?: number
        coop: boolean
    }
    /** the finish's body as the client sent it (read defensively) */
    body: unknown
    quest: { category: number, timeLimitMs?: number }
    /** real time the finish arrived (Date.now()) */
    nowMs: number
    /** anticheat.wall_clock_slack_seconds, in milliseconds */
    wallClockSlackMs: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null

/** The flags a finish raises; [] for an honest one. Pure: no clock, no database. */
export function judgeFinish(input: FinishJudgement): RuleFlag[] {
    const body = isRecord(input.body) ? input.body : {}
    const statistics = isRecord(body.statistics) ? body.statistics : {}
    const elapsedMs = finite(body.elapsed_time_ms)
    const accomplished = body.is_accomplished === true
    // A restored (resumed) battle can't reach this server: the client keeps its restore log only for the play ids the
    // load reply lists as unfinished (unfinished_quest_list), which Reflipped never sends, so it deletes every log at
    // start-up (emulator QA 2026-11-14, onCompleteLoading → deleteBattleRestoreExcept). A finish claiming is_restored is
    // judged like any other, and noted: exempting it skipped R1 to R4 for anyone who set the flag. If resume is ever
    // offered, restore the exemption for the listed play ids only.
    const claimsRestored = body.is_restored === true
    const wallMs = input.start.startedAtMs === undefined ? null : Math.max(0, input.nowMs - input.start.startedAtMs)
    const zones = Array.isArray(statistics.zones) ? statistics.zones.filter(isRecord) : null
    const flags: RuleFlag[] = []

    if (claimsRestored) flags.push({ rule: "consistency", severity: "soft", details: { check: "restored-claim" } })

    // R1, wall-clock ceiling: the clear time is counted frames × 17 ms plus real stalls, so at the top speed it stays
    // within about 3 × 17/16.667 of the real time from the start's reply to the finish's arrival; the margin covers the
    // 17/16.667, one second of frames (17 × 60 ms) the backlog and rounding, and the slack setting the rest.
    if (wallMs !== null && elapsedMs !== null) {
        const ceilingMs = Math.round(wallMs * MAX_BATTLE_SPEED * SPEED_MARGIN + MS_PER_FRAME * 60 + input.wallClockSlackMs)
        if (elapsedMs > ceilingMs) flags.push({ rule: "wall-clock", severity: "hard", details: { elapsedMs, wallMs, ceilingMs } })
    }

    // R2, frame-rate ceiling (speed tools): the zones' counted frames within 180 a real second plus the backlog
    if (wallMs !== null && zones !== null && zones.length > 0) flags.push(...frameRateFlags(sum(zones, "playthrough_frame"), wallMs))

    // R3, instant finish: a clear claimed within seconds of the start, loading included, looks like a script. Soft (review
    // of 2026-11-14): the 5 s are uncalibrated, a ×3 farm of a trivial quest may come close, and a script can simply
    // wait; R1 and R2 catch a claimed time the wall time can't hold.
    if (wallMs !== null && accomplished && wallMs < INSTANT_FINISH_MS) {
        flags.push({ rule: "instant-finish", severity: "soft", details: { wallMs, thresholdMs: INSTANT_FINISH_MS } })
    }

    // R4, internal consistency of the statistics (catches a hand-forged body, not a modified game)
    flags.push(...consistencyFlags(input, zones, elapsedMs, accomplished))

    // R5, time limit: the battle ends when its time runs out. A continue may give the time again, so each continue
    // the server answered allows one more limit.
    if (input.quest.timeLimitMs !== undefined && input.quest.timeLimitMs > 0 && elapsedMs !== null) {
        const continues = Math.max(0, input.start.continues ?? 0)
        const ceilingMs = input.quest.timeLimitMs * (1 + continues) + TIME_LIMIT_TOLERANCE_MS
        if (elapsedMs > ceilingMs) {
            flags.push({ rule: "time-limit", severity: "hard", details: { elapsedMs, timeLimitMs: input.quest.timeLimitMs, continues, ceilingMs } })
        }
    }

    // R6, the party at the finish is the party the battle started with: the slot as saved at the start (solo), or the
    // co-op start's client_battle_party. Order isn't compared (only which units), nor fixed parties (no snapshot).
    const startParty = input.start.startParty
    if (startParty !== null && startParty !== undefined) {
        const party = isRecord(statistics.party) ? statistics.party : {}
        const finishIds = unitIds(party.characters, slot => isRecord(slot) ? slot.id : null)
        const startIds = unitIds(startParty.characterIds, id => id)
        if (finishIds.join(",") !== startIds.join(",")) {
            flags.push({ rule: "party-changed", severity: "hard", details: { startCharacterIds: startIds, finishCharacterIds: finishIds } })
        }
    }

    // R8, the score: within what the client can send, and within reach of the finish's own numbers (see above)
    flags.push(...scoreFlags(input, body, zones))

    return flags
}

/** R8: at most one flag, the first check that fails (above-max, then mates, then damage). */
function scoreFlags(input: FinishJudgement, body: Record<string, unknown>, zones: Record<string, unknown>[] | null): RuleFlag[] {
    const score = finite(body.score)
    if (score === null) return []
    if (score > MAX_SCORE) return [{ rule: "score", severity: "hard", details: { check: "above-max", score, maxScore: MAX_SCORE } }]

    // co-op: the own score against each mate's in this finish, the largest gap (AI companions too: same battle score).
    // Skipped for an isolated finish (the player lost the connection and played on alone, so the mates' scores it holds
    // are stale), and only soft for a lost one (HARD_MULTI_EVENT pays a wipe: the own score froze at it, the mates'
    // battles may have gone on).
    const mateScores = Array.isArray(body.mate_player_result) && body.isolated !== true
        ? body.mate_player_result.filter(isRecord).map(mate => finite(mate.score)).filter((value): value is number => value !== null)
        : []
    if (mateScores.length > 0) {
        const mateScore = mateScores.reduce((far, value) => Math.abs(score - value) > Math.abs(score - far) ? value : far)
        const gap = Math.abs(score - mateScore)
        if (gap > COOP_SCORE_GAP) {
            const lost = body.is_accomplished === false
            return [{ rule: "score", severity: lost ? "soft" : "hard",
                details: { check: "mates", score, mateScore, gap, maxGap: COOP_SCORE_GAP, mates: mateScores.length, accomplished: !lost } }]
        }
    }

    // the score against the damage and healing the finish reports (soft: the battle score isn't in the finish)
    if (zones === null || zones.length === 0 || OWN_SCORE_CATEGORIES.has(input.quest.category)) return []
    const damage = Math.max(sum(zones, "damage_deal_total"), sum(zones, "damage_to_boss_all"))
    const healing = zones.reduce((total, zone) => total + (Array.isArray(zone.members)
        ? zone.members.filter(isRecord).reduce((part, member) =>
            // the healing given and the healing received count the same heal twice: the larger of the two
            part + Math.max(finite(member.heal_with_overheal) ?? 0, finite(member.heal_receive_value_with_overheal) ?? 0), 0)
        : 0), 0)
    const multiplier = MAX_TIME_MULTIPLIER * (!input.start.coop && DOUBLED_MULTIPLIER_CATEGORIES.has(input.quest.category) ? 2 : 1)
    const ceiling = Math.round(multiplier * (SCORE_DAMAGE_FACTOR * (damage + healing) + SCORE_DAMAGE_SLACK))
    return score > ceiling
        ? [{ rule: "score", severity: "soft", details: { check: "damage", score, damage, healing, multiplier, ceiling } }]
        : []
}

/** R2: more counted frames than 180 a real second (× 1.05, plus 60 for the backlog) need a speed tool. */
export function frameRateFlags(totalFrames: number, wallMs: number): RuleFlag[] {
    const ceilingFrames = Math.floor(MAX_FRAMES_PER_SECOND * (wallMs / 1000) * SPEED_MARGIN + 60)
    return totalFrames > ceilingFrames
        ? [{ rule: "speed", severity: "hard", details: { frames: totalFrames, wallMs, ceilingFrames } }]
        : []
}

function consistencyFlags(input: FinishJudgement, zones: Record<string, unknown>[] | null, elapsedMs: number | null,
    accomplished: boolean): RuleFlag[] {
    const flags: RuleFlag[] = []
    const fail = (severity: RuleFlag["severity"], check: string, details: RuleFlag["details"]) =>
        flags.push({ rule: "consistency", severity, details: { check, ...details } })

    if (zones === null || zones.length === 0) {
        // every captured finish has its zones; a clear without them is worth a look, not proof
        if (accomplished) fail("soft", "no-zones", {})
        return flags
    }

    // per zone: 17 ms a counted frame at least (stalls only add); the largest hit within the total; boss damage within all damage
    const firstZone = (test: (zone: Record<string, unknown>) => boolean) => zones.findIndex(test)
    const frames = firstZone(zone => {
        const ms = finite(zone.playthrough_ms), count = finite(zone.playthrough_frame)
        return ms !== null && count !== null && ms < count * MS_PER_FRAME
    })
    if (frames >= 0) fail("hard", "zone-frames", { zone: frames, playthroughMs: finite(zones[frames].playthrough_ms), playthroughFrame: finite(zones[frames].playthrough_frame) })
    const damageMax = firstZone(zone => greater(zone.damage_deal_max, zone.damage_deal_total))
    if (damageMax >= 0) fail("hard", "damage-max", { zone: damageMax, damageDealMax: finite(zones[damageMax].damage_deal_max), damageDealTotal: finite(zones[damageMax].damage_deal_total) })
    const bossDamage = firstZone(zone => greater(zone.boss_damage_deal_total, zone.damage_deal_total))
    if (bossDamage >= 0) fail("hard", "boss-damage", { zone: bossDamage, bossDamageDealTotal: finite(zones[bossDamage].boss_damage_deal_total), damageDealTotal: finite(zones[bossDamage].damage_deal_total) })

    // the clear time against the zones' summed time. Solo: equal in the capture, so either way is hard. Co-op: the clear
    // time is the smallest over the teammates' battles too, so below the sum is only soft. 
    // Only one-zone captures exist, but the bytecode shows per-zone figures (above); the per-zone tolerance (the zone
    // changes, where the timer stops) is a guess to calibrate in log mode.
    if (elapsedMs !== null && zones.every(zone => finite(zone.playthrough_ms) !== null)) {
        const zonesMs = sum(zones, "playthrough_ms")
        const toleranceMs = ZONE_TIME_TOLERANCE_MS * zones.length
        if (elapsedMs > zonesMs + toleranceMs) fail("hard", "elapsed-above-zones", { elapsedMs, zonesMs, toleranceMs })
        // an isolated co-op finish (the player lost the room and played on alone) undershoots the zones by the stall,
        // 8 s in the emulator QA of 2026-11-14: not flagged
        else if (elapsedMs < zonesMs - toleranceMs && !(input.start.coop && isRecord(input.body) && input.body.isolated === true)) {
            fail(input.start.coop ? "soft" : "hard", "elapsed-below-zones", { elapsedMs, zonesMs, toleranceMs })
        }
    }

    // a solo boss fight cleared without any boss damage (soft: no capture of a solo boss clear confirms it, and the win
    // condition of every boss quest isn't known). Co-op is skipped: teammates may have done all the damage.
    if (accomplished && !input.start.coop && BOSS_CATEGORIES.has(input.quest.category)
        && zones.every(zone => finite(zone.boss_damage_deal_total) !== null) && sum(zones, "boss_damage_deal_total") === 0) {
        fail("soft", "no-boss-damage", { zones: zones.length })
    }

    // Dropped: the zone count against the quest's zones. The converted master data has no zone count per quest.
    return flags
}

function greater(a: unknown, b: unknown): boolean {
    const x = finite(a), y = finite(b)
    return x !== null && y !== null && x > y
}

function sum(zones: Record<string, unknown>[], key: string): number {
    return zones.reduce((total, zone) => total + (finite(zone[key]) ?? 0), 0)
}

/** The party's unit ids, empty slots left out, sorted: R6 compares which units, not their order. */
function unitIds<T>(slots: unknown, idOf: (slot: T) => unknown): number[] {
    if (!Array.isArray(slots)) return []
    return slots.slice(0, 3).map(slot => idOf(slot as T)).filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id))
        .sort((a, b) => a - b)
}
