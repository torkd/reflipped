// SEC-18: optional server anti-cheat (docs/hardening.md, "Anti-cheat"). No check inside the open, self-built app can
// be trusted, so everything here judges what the server receives. Phase 0 is the groundwork: the mode, the flag store
// and the facts later rules need (an active quest's real start time and party). Phase 1 adds the finish rules
// (src/lib/anticheatRules.ts), run by checkFinishSync() from single_battle_quest/finish, which the co-op finish runs too.
//
// Modes: `off` (nothing recorded), `log` (rules record flags, players see nothing; the default online), `enforce`
// (a hard flag keeps the finish's record off shared boards; its rewards are paid as usual). Always `off` on the server
// on the phone (SH-13): its player owns the server and the database. Shared boards leave out developer-mode players in
// every mode (src/lib/developerModePlayers.ts) and restricted players unless the mode is off (boardHiddenPlayers()).
import { getSetting, getStoredText, setStoredText } from "../data/serverSettings";
import { FlagSeverity, insertAnticheatFlagSync, restrictedPlayerSetSync } from "../data/anticheatData";
import { isLocalProfile } from "./serverProfile";
import { developerModePlayers } from "./developerModePlayers";
import { FinishJudgement, judgeFinish, RuleFlag } from "./anticheatRules";

export type AnticheatMode = "off" | "log" | "enforce"
export const ANTICHEAT_MODES: readonly AnticheatMode[] = ["off", "log", "enforce"]
const MODE_KEY = "anticheat.mode"

function parseMode(value: string | null | undefined): AnticheatMode | null {
    const mode = value?.trim().toLowerCase()
    return (ANTICHEAT_MODES as readonly string[]).includes(mode ?? "") ? mode as AnticheatMode : null
}

/** How long the admin's stored choice is kept in memory: a finish asks for the mode several times. */
const MODE_CACHE_MS = 5_000
let storedModeCache: { mode: AnticheatMode | null, readAt: number } | null = null

/** The admin's stored choice, read at most every MODE_CACHE_MS (setAnticheatMode() drops the cache). */
function storedMode(): AnticheatMode | null {
    const now = Date.now()
    if (storedModeCache === null || now - storedModeCache.readAt > MODE_CACHE_MS || now < storedModeCache.readAt) {
        storedModeCache = { mode: parseMode(getStoredText(MODE_KEY)), readAt: now }
    }
    return storedModeCache.mode
}

/** The mode in force: off on the phone's own server, else the admin's choice, else ANTICHEAT, else log. */
export function anticheatMode(): AnticheatMode {
    if (isLocalProfile()) return "off"
    let stored: AnticheatMode | null = null
    try {
        stored = storedMode()
    } catch (error) {
        // never let anti-cheat break a game request: an unreadable setting falls back to ANTICHEAT, else log
        console.error("anti-cheat: mode not read:", error)
    }
    return stored ?? parseMode(process.env.ANTICHEAT) ?? "log"
}

/** The admin's choice (null: follow ANTICHEAT, else log). Throws a RangeError for anything else. Seen at once. */
export function setAnticheatMode(mode: AnticheatMode | null): void {
    if (mode !== null && parseMode(mode) === null) throw new RangeError(`unknown anti-cheat mode: ${mode}`)
    storedModeCache = null
    setStoredText(MODE_KEY, mode)
}

export interface FlagInput {
    playerId: number
    /** A short stable name, e.g. "wall-clock" or "imported-save". */
    rule: string
    severity: FlagSeverity
    route?: string
    questId?: number
    /** Our own values only (times, counts, ids): never a request body, header or token (OPS-2). */
    details?: Record<string, unknown>
    reqId?: string
}

/**
 * Records a flag unless the mode is off; returns its id, or null when nothing was recorded. Never throws: a failing
 * flag write must not cost a player their battle.
 */
export function recordAnticheatFlag(flag: FlagInput): number | null {
    if (anticheatMode() === "off") return null
    try {
        return insertAnticheatFlagSync({
            playerId: flag.playerId, rule: flag.rule, severity: flag.severity, route: flag.route ?? null,
            questId: flag.questId ?? null, details: flag.details ?? {}, reqId: flag.reqId ?? null, created: new Date()
        })
    } catch (error) {
        console.error("anti-cheat flag not recorded:", error)
        return null
    }
}

/**
 * The players every shared board leaves out (ranking percentiles, the rush leaderboard, the raid ranking and kill
 * tally, suggested parties): developer-mode players always, restricted players unless the mode is off. Turning
 * anti-cheat off suspends restrictions without forgetting them; restricting is an admin action (phase 2's review
 * page, whose restrictionActive() follows the same rule).
 */
export function boardHiddenPlayers(): ReadonlySet<number> {
    const developers = developerModePlayers()
    if (anticheatMode() === "off") return developers
    let restricted: ReadonlySet<number>
    try {
        restricted = restrictedPlayerSetSync()
    } catch (error) {
        console.error("anti-cheat: restricted players not read:", error)
        return developers
    }
    if (restricted.size === 0) return developers
    if (developers.size === 0) return restricted
    return new Set([...developers, ...restricted])
}

export interface FinishCheck {
    playerId: number
    route: string
    questId: number
    reqId?: string
    /** where a failing check is logged (the request's logger); console.error without one */
    logError?: (error: unknown) => void
}

/**
 * Judges a battle finish and records its flags (every mode but off). Returns whether the finish's records stay off the
 * shared boards: only in enforce mode after a hard flag, whose details then carry `excluded: true` for the review
 * page. Never throws: a failing check is logged and the finish goes on as if nothing was flagged.
 */
export function checkFinishSync(judgement: Omit<FinishJudgement, "wallClockSlackMs" | "nowMs">, check: FinishCheck): { excluded: boolean, flags: RuleFlag[] } {
    try {
        const mode = anticheatMode()
        if (mode === "off") return { excluded: false, flags: [] }
        const flags = judgeFinish({ ...judgement, nowMs: Date.now(), wallClockSlackMs: getSetting("anticheat.wall_clock_slack_seconds") * 1000 })
        const excluded = mode === "enforce" && flags.some(flag => flag.severity === "hard")
        for (const flag of flags) {
            recordAnticheatFlag({
                playerId: check.playerId, rule: flag.rule, severity: flag.severity, route: check.route, questId: check.questId,
                details: excluded && flag.severity === "hard" ? { ...flag.details, excluded: true } : flag.details, reqId: check.reqId
            })
        }
        return { excluded, flags }
    } catch (error) {
        if (check.logError) check.logError(error)
        else console.error("anti-cheat: finish check failed:", error)
        return { excluded: false, flags: [] }
    }
}
