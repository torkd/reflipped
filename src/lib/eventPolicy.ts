/** Event configuration is independent of the progression clock and reward policy. */
import { getStoredText, setStoredText } from "../data/serverSettings";
import { gameDayOf, gameDayStart } from "./calendar";

export const EVENT_MODES = ["classic", "accelerated", "time-travel", "manual"] as const
export type EventMode = typeof EVENT_MODES[number]
export interface EventPolicy {
    version: 1
    mode: EventMode
    /** Real UTC anchor. Restarting never starts the rotation over. */
    anchor: number
    /** Classic content seconds per real second. Accelerated uses this factor. */
    rotationId?: number
    acceleration: number
    adminTimeTravel: boolean
}
const KEY = "events.policy"

export function validateEventPolicy(value: unknown): EventPolicy {
    if (!value || typeof value !== "object") throw new RangeError("Invalid event settings")
    const p = value as EventPolicy
    if (p.version !== 1 || !EVENT_MODES.includes(p.mode) || !Number.isSafeInteger(p.anchor)
        || p.anchor < Date.UTC(2000, 0, 1) || p.anchor >= Date.UTC(2101, 0, 1)
        || !Number.isInteger(p.acceleration) || p.acceleration < 2 || p.acceleration > 10
        || typeof p.adminTimeTravel !== "boolean"
        || (p.rotationId !== undefined && (!Number.isSafeInteger(p.rotationId) || p.rotationId < 0))) throw new RangeError("Invalid event settings")
    return { version: 1, mode: p.mode, anchor: p.anchor, rotationId: p.rotationId ?? p.anchor, acceleration: p.acceleration, adminTimeTravel: p.adminTimeTravel }
}

export function getEventPolicy(): EventPolicy {
    const stored = getStoredText(KEY)
    if (stored !== null) {
        // Invalid stored configuration must not silently enable permissions or restart rewards.
        return validateEventPolicy(JSON.parse(stored))
    }
    // the rotation starts at the beginning of the game day, so event periods open and close at the daily reset (05:00 Japan
    // time) and not at the minute the server first ran
    const anchor = gameDayStart(gameDayOf(Date.now()))
    const policy: EventPolicy = { version: 1, mode: "classic", anchor, acceleration: 2, adminTimeTravel: false }
    setStoredText(KEY, JSON.stringify(policy))
    return policy
}

export function setEventPolicy(policy: EventPolicy): void {
    setStoredText(KEY, JSON.stringify(validateEventPolicy(policy)))
}

export function playerTimeTravelEnabled(): boolean {
    return getEventPolicy().mode === "time-travel"
}
