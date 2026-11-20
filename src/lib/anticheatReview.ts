// SEC-18 phase 2: what an admin does with a flag or a flagged player (the review page, the Players page). Restriction is
// quiet: the player sees nothing and keeps playing, but their records stay off shared boards and their co-op rooms off
// the public list (src/lib/coop/restricted.ts). Blocking cuts the device off the account.
import {
    isPlayerRestrictedSync, resolveAnticheatFlagSync, resolveOpenAnticheatFlagsOfPlayerSync, setPlayerRestrictedSync
} from "../data/anticheatData";
import { clearDeviceSecretHashSync, getAccountDeviceSecretHashSync, getAccountFromPlayerIdSync, revokeAccountSessionsSync, runInTransactionSync } from "../data/wdfpData";
import { anticheatMode } from "./anticheat";

/** What each rule's name means, for the review page (names from docs/hardening.md; rules arrive in phases 1 to 4). */
export const RULE_LEGEND: readonly { rule: string, title: string, text: string }[] = [
    { rule: "wall-clock", title: "R1 · Clear time", text: "The battle's reported clear time is longer than the real time between its start and its finish on the server, even at the fastest battle speed." },
    { rule: "instant-finish", title: "R3 · Instant finish", text: "For review: a clear was reported within seconds of the battle's start, loading included, as a script might. A quick repeat of an easy quest can come close, so this is a hint, not proof." },
    { rule: "consistency", title: "R4 · Consistency", text: "The numbers sent with the finish contradict each other, for example a zone time that doesn't match its frames, a biggest hit above the total damage, or a clear time far from the zones' times added up." },
    { rule: "time-limit", title: "R5 · Time limit", text: "The reported battle time is longer than the quest's time limit." },
    { rule: "party-changed", title: "R6 · Party changed", text: "The party in the finish is not the party the battle started with." },
    { rule: "speed", title: "R2 · Speed", text: "The game ran more frames per real second than the top battle speed allows (a speed hack)." },
    { rule: "coop-witness", title: "R7 · Co-op witness", text: "A co-op player's report disagrees with what the other players reported. With two players only a soft flag is raised, since either may be wrong." },
    { rule: "score", title: "R8 · Score", text: "The score can't come from the game: above the game's maximum, too far from the other players' scores in the same co-op report (hard), or far more than the damage and healing reported can earn (soft, for review)." },
    { rule: "imported-save", title: "Imported save", text: "Information only: progress came from a save file, not from play on this server." },
    { rule: "damage-ceiling", title: "R9 · Damage", text: "For review: the party's biggest hit or its damage per second against the boss, for its power, is far above what other players' finishes of the quest show on this server." },
    { rule: "outlier", title: "R10 · Outlier", text: "For review: the clear time or the score is far outside what other players with parties of similar power reach in this quest on this server." },
    { rule: "play-rate", title: "R11 · Play rate", text: "For review: more battles in one hour than a person plays, or twelve hours or more of battles without a break of an hour." },
    { rule: "linked-accounts", title: "R12 · Linked accounts", text: "For review: two accounts that share a device, a portal user or a network met in the same ranking event or co-op room. A shared network alone is weak: families and mobile networks share addresses." }
]

/** Whether a restriction is in force: an admin's restriction counts unless anti-cheat is off. */
export function restrictionActive(playerId: number): boolean {
    return anticheatMode() !== "off" && isPlayerRestrictedSync(playerId)
}

/** Dismisses one open flag. Returns false if there was no such open flag. */
export function dismissFlag(flagId: number, by: number | null): boolean {
    return resolveAnticheatFlagSync(flagId, "dismissed", by)
}

/** Restricts a player and marks their open flags as acted on. */
export function restrictPlayer(playerId: number, by: number | null): void {
    runInTransactionSync(() => {
        setPlayerRestrictedSync(playerId, true, by)
        resolveOpenAnticheatFlagsOfPlayerSync(playerId, by)
    })
}

export function unrestrictPlayer(playerId: number, by: number | null): void {
    setPlayerRestrictedSync(playerId, false, by)
}

/**
 * Blocks a player: restricted, their open flags acted on, their device unbound from the account and every session of it
 * ended (the account tools of ACC-6 and SEC-8, `revokeAccountSessionsSync`), so the device can't sign in to this save
 * again and starts a new guest. A user who owns the save can still sign in on the portal: end their logins on the Users
 * page too. Returns false if the player has no account.
 */
export function blockPlayer(playerId: number, by: number | null): boolean {
    const account = getAccountFromPlayerIdSync(playerId)
    if (account === null) return false
    runInTransactionSync(() => {
        setPlayerRestrictedSync(playerId, true, by)
        resolveOpenAnticheatFlagsOfPlayerSync(playerId, by)
        const secretHash = getAccountDeviceSecretHashSync(account.id)
        if (secretHash !== null) clearDeviceSecretHashSync(secretHash)
        revokeAccountSessionsSync(account.id, { viewer: true })
    })
    return true
}
