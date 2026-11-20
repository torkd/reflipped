// Save import (ACC-15): a player replaces their own save on the portal, when the server's owner allows it. Off by
// default: a save file can be edited, so the owner opts in (Settings, Rewards). Like the admin's import it needs
// Managed reward rules (Automatic locks every save upload), runs the same checks (src/data/saveSchema.ts and the
// size limit), and is logged with the account and player. One import per player a day.

import { FastifyBaseLogger } from "fastify";
import { getStoredText, setStoredText } from "../data/serverSettings";
import { InvalidSaveError, validateSaveData } from "../data/saveSchema";
import { deserializePlayerData } from "../data/utils";
import { getPlayerRushEventSync, replacePlayerDataSync, runInTransactionSync } from "../data/wdfpData";
import { getRewardPolicy } from "./rewardPolicy";
import { runOnPlayerClockSync } from "./playerClock";
import { recordAnticheatFlag } from "./anticheat";

const ENABLED_KEY = "save.player_import"
const LAST_IMPORT_PREFIX = "save.player_import.last."
export const PLAYER_IMPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** Whether the owner switched player imports on (whatever the reward rules). */
export function playerSaveImportSetting(): boolean {
    return getStoredText(ENABLED_KEY) === "1"
}

export function setPlayerSaveImportSetting(on: boolean): void {
    setStoredText(ENABLED_KEY, on ? "1" : null)
}

/** Whether a player may import now: switched on, and Managed reward rules. */
export function playerSaveImportEnabled(): boolean {
    return playerSaveImportSetting() && getRewardPolicy().management === "managed"
}

/** When the player may import again (ms since the epoch), or null when they may now. */
export function nextPlayerImportAt(playerId: number, now = Date.now()): number | null {
    const last = Number(getStoredText(LAST_IMPORT_PREFIX + playerId))
    if (!Number.isFinite(last) || last <= 0) return null
    const next = last + PLAYER_IMPORT_COOLDOWN_MS
    return next > now ? next : null
}

export type SaveImportResult = "imported" | "invalid" | "automatic" | "failed"

/**
 * Checks a save file and replaces the player's progress with it, all or nothing: a bad file changes nothing. Shared by
 * the admin's upload and the player's own. The reward rules are checked again in the replacing transaction, since the
 * upload's parsing let other requests run. JSON.parse quotes the file in its message, so only our own texts are
 * logged (OPS-2).
 */
export function importPlayerSave(playerId: number, file: Buffer, log: FastifyBaseLogger,
                                 options: { byPlayer?: boolean } = {}): SaveImportResult {
    let parsed
    try {
        const saveData = validateSaveData(JSON.parse(file.toString("utf-8")),
            (where, reason) => log.warn({ playerId, where, reason }, "save import: received mail left out"))
        // on the player's clock: mail dated after the player's "now" is brought back to it
        parsed = runOnPlayerClockSync(playerId, () => deserializePlayerData(playerId, saveData))
        // A player's own file can be edited: it must not put a record on the shared rush leaderboard. Its endless
        // best (round, time, units) stays what this server recorded from real battles; the rest of the rush progress
        // comes from the file (security review 2026-11-13). The admin's import is trusted as before.
        if (options.byPlayer && parsed.rushEventList !== undefined) {
            parsed = { ...parsed, rushEventList: parsed.rushEventList.map(event => {
                const current = getPlayerRushEventSync(playerId, event.eventId)
                return { ...event,
                    endlessBattleMaxRound: current?.endlessBattleMaxRound ?? null,
                    endlessBattleMaxRoundTime: current?.endlessBattleMaxRoundTime ?? null,
                    endlessBattleMaxRoundCharacterIds: current?.endlessBattleMaxRoundCharacterIds ?? [null, null, null],
                    endlessBattleMaxRoundCharacterEvolutionImgLvls: current?.endlessBattleMaxRoundCharacterEvolutionImgLvls ?? [null, null, null] }
            }) }
        }
    } catch (error) {
        const reason = error instanceof InvalidSaveError ? error.message
            : error instanceof SyntaxError ? "not valid JSON" : "unreadable save"
        log.warn({ playerId, reason }, "save import rejected")
        return "invalid"
    }
    try {
        return runInTransactionSync(() => {
            if (getRewardPolicy().management === "automatic") return "automatic" as const
            if (options.byPlayer && !playerSaveImportSetting()) return "automatic" as const
            replacePlayerDataSync(parsed)
            if (options.byPlayer) setStoredText(LAST_IMPORT_PREFIX + playerId, String(Date.now()))
            // SEC-18: informational only (owner's decision): the admin can see that the progress came from outside
            recordAnticheatFlag({ playerId, rule: "imported-save", severity: "info", route: options.byPlayer ? "portal" : "admin",
                details: { byPlayer: options.byPlayer === true } })
            return "imported" as const
        })
    } catch (error) {
        log.error({ playerId, err: error }, "save import failed")
        return "failed"
    }
}
