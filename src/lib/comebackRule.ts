// Who gets the one-off comeback login calendars (FT-65): `comeback_01` ("Welcome Back Login Perks", 10 days of 150
// beads) and `anv3_comeback` (the 3rd anniversary's 5 days). The server's owner chooses (Settings, Rewards):
//
// - "global" (default): as the global server ran them. `comeback_01`'s master window (2022-11-14 05:00-06:00 JST, one
//   hour a month before the campaign) isn't what the global server used: Kakao's notice (2023-01-03, "Welcome Back
//   Login Perks", https://worldflipper.playkakaogames.com/news/1730) gave the beads to "returning players who have not
//   logged in since Dec 01, 20:00 UTC", not to new players. So a player qualifies with no login from 2022-12-02 05:00
//   JST (a master date, moved by the event schedule like the others) until their first login in the campaign.
//   `anv3_comeback` keeps its master window (no login 2024-03-01 to 04-20; new players included).
// - "everyone": both calendars go to every player who logs in during them, new players included. Their campaign's
//   thank-you present (ActiveUser, `anv3_present`) keeps following the global rule, so a player who stayed gets it too.
//
// The standing Welcome Back Gift (ComebackAlways) isn't affected: it goes to any player back after 60+ days away.

import { getStoredText, setStoredText } from "../data/serverSettings";

export type ComebackRule = "global" | "everyone"
export const COMEBACK_RULES: readonly ComebackRule[] = ["global", "everyone"]
const KEY = "loginbonus.comeback_rule"

/** The calendars the setting covers. */
export const OPEN_COMEBACK_GROUPS: readonly string[] = ["comeback_01", "anv3_comeback"]

/**
 * The global server's own absence rule where it differs from the master: no login from `since` (a master date, Japan
 * time) until the player's first login in the campaign.
 */
export const GLOBAL_COMEBACK_ABSENCE: Readonly<Record<string, { since: string }>> = {
    comeback_01: { since: "2022-12-02 05:00:00" }
}

export function getComebackRule(): ComebackRule {
    const stored = getStoredText(KEY)
    return stored === "everyone" ? "everyone" : "global"
}

export function setComebackRule(rule: ComebackRule): void {
    if (!COMEBACK_RULES.includes(rule)) throw new RangeError(`Unknown comeback rule ${rule}`)
    setStoredText(KEY, rule === "global" ? null : rule)
}
