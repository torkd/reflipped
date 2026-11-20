// SEC-18 phase 3, rule R7 `coop-witness` (docs/hardening.md, "Anti-cheat"): co-op battles run in lockstep, so every
// phone simulates every player's battle, and each `multi_battle_quest/finish` reports both the player's own result and,
// in `mate_player_result`, what its game computed for the others. A member whose report disagrees with what the others
// report is the odd one out.
//
// What the client sends (0.0.81 bytecode, the finish request builder and the result parameter's constructor):
// - `score` is getMyFinalScore().total; a mate's `score` is getOtherFinalScore(viewerId).total, the same formula (the
//   round's battle score and time multiplier, that battle's score bonuses and follow bonus) over that mate's simulated
//   battle, passed on unchanged.
// - `contribution_score` (own) and a mate's `contribution_score` are both the battle's contributionScore, read from
//   the same per-battle list (setupOrederedContributionInformations).
// - `elapsed_time_ms` is the round's clear time (MultiBattleRecord.clearTime: the smallest over the player's own and
//   the teammates' battles) × 1000. A battle's time also takes real time from UpdateTime syncs (up to 1 s per command,
//   docs/coop-research.md), which can land differently at the very end.
// - `is_accomplished` is the player's own battle's; the boss is the room's, so members agree.
// - A mate entry's `com_id` is set for an AI companion (the host's game simulates it): not a witness, not checked.
//
// The figures are not exact across phones, and one phone can drift from the others (emulator test, 2026-11-14, three
// honest players, rounds of 2 s, 59 s and 52 s; numbers in docs/hardening.md):
// - the own score adds score bonuses the other phones don't count for that player (1000 to 5000 points × the time
//   multiplier), and each phone stops simulating at its own clear, so honest views of one score differ by about 1%;
// - one emulator, the slowest, drifted from the other two in both long rounds while the battle went on: its scores
//   were 1.7% higher, then 4.5% lower; its share of the damage (contribution) was off by up to 38% for itself and 22%
//   for another player; its clear time was 85 ms, then 4.7 s, apart. The other two phones agreed with each other
//   (contributions exactly, scores within the bonus gap, clear times exactly).
// - the summed damage_to_boss_all differed by up to 1.8%, so it is kept in the details but not judged.
// So only the score can raise a hard flag, with a wide score tolerance: R7 catches gross lies (a doubled score), not a
// few percent. Contribution and clear time only raise soft flags, for review.
//
// Finishes that see a different battle (review fixes, 2026-11-14):
// - `isolated: true`: the player lost the connection and played on alone (docs/coop-research.md, "startIsolatedMode"),
//   so their views of the others and the others' views of them stop matching. Such a finish is kept (it ends the round
//   for them, and the details count it) but casts no vote and is judged by none.
// - `is_accomplished: false`: HARD_MULTI_EVENT pays a lost finish, so a wiped player finishes while the others clear.
//   Their score froze at the wipe, and so did their views of the others. Any item with a vote from or about a lost
//   finish is soft only, and so is a split on the accomplishment itself (a wipe isn't a lie).
//
// Collection: the finishes of a room's round are kept in memory (at most MAX_PENDING_ROUNDS rounds, each at most the
// room's players, numbers only) and judged once every player of the round has ended it over HTTP (finish or abort), or
// WITNESS_TIMEOUT_MS after its first finish (a player who quit or lost the connection never sends one). Nothing is
// collected while the mode is off.
//
// Judging: per item (a member's score as they claim it and as each other finisher saw it; the same for contribution;
// the round-wide clear time and accomplishment from each finisher), the values are grouped within the item's tolerance.
// With 3+ values and a strict majority, everyone outside it is the odd one out: a hard flag (soft for the items that
// are never hard). Without a majority (two finishers who disagree, or three different values), everyone involved gets
// a soft flag, since who lied is unknown.
import { anticheatMode, recordAnticheatFlag } from "./anticheat";
import { CoopRoom, finishingRoundOf, listRooms } from "./coop/rooms";
import getDatabase, { Database } from "../data";
import { FlagSeverity } from "../data/anticheatData";

export const WITNESS_RULE = "coop-witness"
/** How long a round waits for its players' finishes after the first one. */
export const WITNESS_TIMEOUT_MS = 2 * 60_000
/** Rounds waiting at most; past it the oldest is judged early with the finishes it has. */
export const MAX_PENDING_ROUNDS = 4096
/** Two values agree within the larger of `abs` and `rel` × the larger value. */
export interface Tolerance { abs: number, rel: number }
/** How one item is judged: its tolerance, and whether an odd one out is a hard flag or only a soft one. */
export interface WitnessCheck { tolerance: Tolerance, hard: boolean }
/** Scores: honest views seen 4.5% apart on a drifting phone (above); hard only far beyond that. */
export const SCORE_CHECK: WitnessCheck = { tolerance: { abs: 100_000, rel: 0.25 }, hard: true }
/** Contributions: a drifting phone's damage shares were 38% off (above), so never hard. */
export const CONTRIBUTION_CHECK: WitnessCheck = { tolerance: { abs: 10_000, rel: 0.5 }, hard: false }
/** Clear times: a drifting phone's was 4.7 s (9%) off (above), so never hard. */
export const ELAPSED_CHECK: WitnessCheck = { tolerance: { abs: 10_000, rel: 0.2 }, hard: false }
/** The boss is the room's, but one member can be wiped out while the others clear (a lost finish): never hard. */
export const ACCOMPLISHED_CHECK: WitnessCheck = { tolerance: { abs: 0, rel: 0 }, hard: false }
const SWEEP_INTERVAL_MS = 30_000

/** What one finish wrote to a shared board, so enforce mode can take it back (excludeCoopFinish). */
export interface CoopFinishBoards {
    category: number
    questId: number
    /** the suggested party (FT-50) this finish stored: its clear_time, or null if it stored none */
    recentPartyClearTime: number | null
}

interface MateReport { score: number | null, contribution: number | null }

interface CoopFinishReport {
    viewerId: number
    playerId: number
    reqId?: string
    score: number | null
    contribution: number | null
    accomplished: boolean | null
    /** the player played on alone after losing the connection: no vote, not judged */
    isolated: boolean
    elapsedMs: number | null
    /** damage_to_boss_all over the zones: collected for the review, not judged (not yet calibrated) */
    damageToBossAll: number | null
    /** what this player's game computed for the round's other human players, by viewer id */
    mates: Map<number, MateReport>
    boards: CoopFinishBoards
}

interface PendingRound {
    key: string
    roomNumber: string
    round: number
    questId: number
    /** the round's human players (CoopRoom.lastRoundViewerIds when its first finish came) */
    members: number[]
    reports: Map<number, CoopFinishReport>
    firstFinishAt: number
}

const pending = new Map<string, PendingRound>()
let sweepTimer: NodeJS.Timeout | null = null

const finite = (value: unknown): number | null => {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value
    return typeof number === "number" && Number.isFinite(number) ? number : null
}


/** A finish's sum of `damage_to_boss_all` over its zones, or null. */
function damageToBossAll(statistics: unknown): number | null {
    const zones = (statistics as { zones?: unknown } | null)?.zones
    if (!Array.isArray(zones)) return null
    let total = 0, seen = false
    for (const zone of zones.slice(0, 64)) {
        const value = finite((zone as Record<string, unknown> | null)?.damage_to_boss_all)
        if (value !== null) { total += value; seen = true }
    }
    return seen ? total : null
}

function recentPartyClearTime(playerId: number, category: number, questId: number): number | null {
    const row = getDatabase(Database.WDFP_DATA).prepare(`SELECT clear_time FROM players_recent_quest_parties
        WHERE player_id = ? AND category = ? AND quest_id = ?`).get(playerId, category, questId) as { clear_time: number } | undefined
    return row?.clear_time ?? null
}

/** A co-op finish about to run: what the shared boards hold before it, or null when nothing is collected. */
export interface CoopWitnessFinish {
    room: CoopRoom
    round: number
    playerId: number
    viewerId: number
    recentPartyBefore: number | null
}

/**
 * Before a co-op finish runs the single-player finish: notes the round and what the boards hold, so the finish's own
 * writes can be told apart later. Null (and free) when the mode is off or the player is in no round of the finish's
 * quest (the newest, if a crash left them in an older one: finishingRoundOf()).
 */
export function beginCoopWitnessFinish(viewerId: number, playerId: number, questId: number, category: number): CoopWitnessFinish | null {
    try {
        if (anticheatMode() === "off") return null
        const room = finishingRoundOf(viewerId, questId, category)
        if (room === undefined) return null
        return { room, round: room.round, playerId, viewerId, recentPartyBefore: recentPartyClearTime(playerId, room.category, room.questId) }
    } catch (error) {
        console.error("co-op witness: finish not collected:", error)
        return null
    }
}

/** The fields of a co-op finish the witness rule reads (multi_battle_quest/finish's body). */
export interface CoopFinishBody {
    score?: unknown
    contribution_score?: unknown
    is_accomplished?: unknown
    elapsed_time_ms?: unknown
    mate_player_result?: unknown
    statistics?: unknown
    isolated?: unknown
}

/** After the single-player finish succeeded: keeps the player's report for the round. Never throws. */
export function collectCoopFinish(started: CoopWitnessFinish | null, body: CoopFinishBody, reqId?: string, now = Date.now()): void {
    if (started === null) return
    try {
        const { room, round, playerId, viewerId } = started
        const after = recentPartyClearTime(playerId, room.category, room.questId)
        const key = `${room.roomNumber}:${room.roomSequence}:${round}`
        let entry = pending.get(key)
        if (entry === undefined) {
            sweep(now)
            while (pending.size >= MAX_PENDING_ROUNDS) evaluateRound(pending.values().next().value!)
            entry = {
                key, roomNumber: room.roomNumber, round, questId: room.questId, members: [...room.lastRoundViewerIds],
                reports: new Map(), firstFinishAt: now
            }
            pending.set(key, entry)
            ensureSweepTimer()
        }
        if (!entry.members.includes(viewerId) || entry.reports.has(viewerId)) return

        const mates = new Map<number, MateReport>()
        const results = Array.isArray(body.mate_player_result) ? body.mate_player_result : []
        for (const result of results.slice(0, 16)) {
            if (result === null || typeof result !== "object") continue
            const mate = result as Record<string, unknown>
            const mateViewerId = finite(mate.viewer_id)
            const comId = finite(mate.com_id)
            // AI companions (com_id) are simulated by the host's game: no witness to anything
            if (mateViewerId === null || (comId !== null && comId !== 0)) continue
            if (mateViewerId === viewerId || !entry.members.includes(mateViewerId) || mates.has(mateViewerId)) continue
            mates.set(mateViewerId, { score: finite(mate.score), contribution: finite(mate.contribution_score) })
        }
        entry.reports.set(viewerId, {
            viewerId, playerId, reqId,
            score: finite(body.score),
            contribution: finite(body.contribution_score),
            accomplished: typeof body.is_accomplished === "boolean" ? body.is_accomplished : null,
            isolated: body.isolated === true,
            elapsedMs: finite(body.elapsed_time_ms),
            damageToBossAll: damageToBossAll(body.statistics),
            mates,
            boards: {
                category: room.category, questId: room.questId,
                recentPartyClearTime: after !== null && after !== started.recentPartyBefore ? after : null
            }
        })
    } catch (error) {
        console.error("co-op witness: finish not collected:", error)
    }
}

/**
 * After a player's finish or abort was noted (noteRoundEnded): judges every waiting round of theirs whose players have
 * all ended it. Never throws.
 */
export function coopWitnessRoundEnded(viewerId: number): void {
    if (pending.size === 0) return
    try {
        const rooms = new Map(listRooms().map(room => [room.roomNumber, room]))
        for (const entry of [...pending.values()]) {
            if (!entry.members.includes(viewerId)) continue
            const room = rooms.get(entry.roomNumber)
            // the room is gone or moved on to another round: nobody else can finish this one
            const sameRound = room !== undefined && room.round === entry.round && room.inBattle
            const ended = (id: number) => entry.reports.has(id) || (sameRound && room!.roundEndedViewerIds.includes(id))
            if (!sameRound || entry.members.every(ended)) evaluateRound(entry)
        }
    } catch (error) {
        console.error("co-op witness: round not judged:", error)
    }
}

/** Judges the rounds whose wait is over (a player never finished). Runs on a timer; tests call it with a clock. */
export function sweep(now = Date.now()): void {
    for (const entry of [...pending.values()]) {
        if (now - entry.firstFinishAt >= WITNESS_TIMEOUT_MS) evaluateRound(entry)
    }
}

function ensureSweepTimer() {
    if (sweepTimer !== null) return
    sweepTimer = setInterval(() => {
        try { sweep() } catch (error) { console.error("co-op witness: sweep failed:", error) }
        if (pending.size === 0 && sweepTimer !== null) { clearInterval(sweepTimer); sweepTimer = null }
    }, SWEEP_INTERVAL_MS)
    sweepTimer.unref()
}

/** How many rounds wait for finishes (tests). */
export function pendingCoopWitnessRounds(): number {
    return pending.size
}

/** Forgets every waiting round (tests). */
export function resetCoopWitness(): void {
    pending.clear()
    if (sweepTimer !== null) { clearInterval(sweepTimer); sweepTimer = null }
}

// ---- judging ----

interface Vote<T> { by: CoopFinishReport, value: T }

interface Verdict<T> {
    /** the voters outside the majority (hard), or every voter of a split without one (soft) */
    flagged: CoopFinishReport[]
    severity: FlagSeverity
    majority: T | null
}

/** Groups the votes within `tolerance`; null when they all agree or there are fewer than two. */
export function judgeVotes<T extends number | boolean>(votes: Vote<T>[], tolerance: Tolerance): Verdict<T> | null {
    if (votes.length < 2) return null
    const agree = (a: T, b: T) => typeof a === "number" && typeof b === "number"
        ? Math.abs(a - b) <= Math.max(tolerance.abs, tolerance.rel * Math.max(Math.abs(a), Math.abs(b)))
        : a === b
    let best = votes[0], bestCount = 0
    for (const candidate of votes) {
        const count = votes.filter(vote => agree(vote.value, candidate.value)).length
        if (count > bestCount) { best = candidate; bestCount = count }
    }
    if (bestCount === votes.length) return null
    if (votes.length >= 3 && bestCount * 2 > votes.length) {
        return { flagged: votes.filter(vote => !agree(vote.value, best.value)).map(vote => vote.by), severity: "hard", majority: best.value }
    }
    return { flagged: votes.map(vote => vote.by), severity: "soft", majority: null }
}

interface Disagreement {
    field: "score" | "contribution_score" | "is_accomplished" | "elapsed_time_ms"
    /** whose result the item is (a player id), or null for the round's clear time and accomplishment */
    about: number | null
    severity: FlagSeverity
    majority: number | boolean | null
    /** every report on the item: by whom (player id) and the value */
    values: { by: number, value: number | boolean }[]
}

function present<T>(votes: Vote<T | null>[]): Vote<T>[] {
    return votes.filter((vote): vote is Vote<T> => vote.value !== null)
}

function evaluateRound(entry: PendingRound): void {
    pending.delete(entry.key)
    const mode = anticheatMode()
    if (mode === "off") return
    const reports = [...entry.reports.values()]
    if (process.env.COOP_DEBUG === "1") {
        // the reported numbers only (no body), for calibrating the tolerances on real clients
        console.log(`[coop] witness round ${entry.roomNumber}#${entry.round}: ${JSON.stringify(reports.map(report => ({
            viewer: report.viewerId, score: report.score, contribution: report.contribution, accomplished: report.accomplished,
            isolated: report.isolated, elapsedMs: report.elapsedMs, damageToBossAll: report.damageToBossAll,
            mates: Object.fromEntries([...report.mates].map(([id, mate]) => [id, mate]))
        })))} members ${entry.members.length}`)
    }
    // an isolated finish played a battle of its own: it casts no vote and nobody's view of it is judged
    const voters = reports.filter(report => !report.isolated)
    if (voters.length < 2) return

    const lost = (report: CoopFinishReport | null) => report !== null && report.accomplished === false
    const byPlayer = new Map<number, { report: CoopFinishReport, disagreements: Disagreement[] }>()
    const note = <T extends number | boolean>(field: Disagreement["field"], about: CoopFinishReport | null, votes: Vote<T>[], check: WitnessCheck) => {
        const verdict = judgeVotes(votes, check.tolerance)
        if (verdict === null) return
        // a lost finish's numbers froze at the wipe: judged from or against one, a split is only worth a look
        const hard = check.hard && !lost(about) && !votes.some(vote => lost(vote.by))
        const disagreement: Disagreement = {
            field, about: about?.playerId ?? null, severity: hard ? verdict.severity : "soft", majority: verdict.majority,
            values: votes.map(vote => ({ by: vote.by.playerId, value: vote.value }))
        }
        for (const report of verdict.flagged) {
            const flagged = byPlayer.get(report.viewerId) ?? { report, disagreements: [] }
            flagged.disagreements.push(disagreement)
            byPlayer.set(report.viewerId, flagged)
        }
    }

    for (const subject of voters) {
        const witnesses = voters.filter(report => report !== subject)
        note("score", subject, present([{ by: subject, value: subject.score },
            ...witnesses.map(witness => ({ by: witness, value: witness.mates.get(subject.viewerId)?.score ?? null }))]), SCORE_CHECK)
        note("contribution_score", subject, present([{ by: subject, value: subject.contribution },
            ...witnesses.map(witness => ({ by: witness, value: witness.mates.get(subject.viewerId)?.contribution ?? null }))]), CONTRIBUTION_CHECK)
    }
    note("is_accomplished", null, present(voters.map(report => ({ by: report, value: report.accomplished }))), ACCOMPLISHED_CHECK)
    note("elapsed_time_ms", null, present(voters.map(report => ({ by: report, value: report.elapsedMs }))), ELAPSED_CHECK)

    for (const { report, disagreements } of byPlayer.values()) {
        const severity: FlagSeverity = disagreements.some(item => item.severity === "hard") ? "hard" : "soft"
        const details: Record<string, unknown> = {
            round: entry.round,
            members: entry.members.length,
            finishers: reports.length,
            isolated: reports.length - voters.length,
            lost: voters.filter(voter => lost(voter)).length,
            claimed: {
                score: report.score, contribution_score: report.contribution, is_accomplished: report.accomplished,
                isolated: report.isolated, elapsed_time_ms: report.elapsedMs, damage_to_boss_all: report.damageToBossAll
            },
            disagreements
        }
        if (severity === "hard" && mode === "enforce") {
            details.excluded = true
            details.undone = excludeCoopFinish(report.playerId, report.boards)
        }
        recordAnticheatFlag({
            playerId: report.playerId, rule: WITNESS_RULE, severity, route: "multi_battle_quest/finish",
            questId: entry.questId, details, reqId: report.reqId
        })
    }
}

/**
 * Enforce mode: takes a hard-flagged co-op finish's record back off the shared boards, after the fact (the round is
 * judged once its last finish is in, when the others' finishes are long written). Rewards are never taken back.
 *
 * What a co-op finish can write to a shared board, and what is undone:
 * - its party as the player's suggested party for the quest (FT-50): deleted, if the row is still the one this finish
 *   wrote (same clear time). The player's earlier party for the quest was replaced by it and doesn't come back.
 * - nothing else: ranking, rush and raid records come from solo quests only (their categories never run in a co-op
 *   room), and the follow bonus count (FT-43) is no board.
 *
 * Phase 1 (SEC-18) keeps a hard-flagged finish off the boards as it is written; this is R7's separate path, kept small
 * so the two can share one exclusion later. Returns what was undone.
 */
export function excludeCoopFinish(playerId: number, boards: CoopFinishBoards): string[] {
    const undone: string[] = []
    try {
        if (boards.recentPartyClearTime !== null) {
            const result = getDatabase(Database.WDFP_DATA).prepare(`DELETE FROM players_recent_quest_parties
                WHERE player_id = ? AND category = ? AND quest_id = ? AND clear_time = ?`)
                .run(playerId, boards.category, boards.questId, boards.recentPartyClearTime)
            if (Number(result.changes) > 0) undone.push("suggested-party")
        }
    } catch (error) {
        console.error("co-op witness: finish not excluded:", error)
    }
    return undone
}
