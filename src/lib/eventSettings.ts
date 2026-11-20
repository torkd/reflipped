import { getStoredText, setStoredText } from "../data/serverSettings";
import { getEventPolicy, setEventPolicy, validateEventPolicy, EventMode } from "./eventPolicy";
import { getRewardPolicy, PROFILE_MULTIPLIER, rewardPercent, setRewardPolicy } from "./rewardPolicy";
import { runInTransactionSync } from "../data/wdfpData";

export interface EventSettingsUpdate {
    mode: EventMode
    /** Left out (a locked field is not sent): the current pace stays. */
    acceleration?: string | number
    adminTimeTravel?: "1" | "0"
    management: "managed" | "automatic"
    multiplierOverride?: string | number | null
    /** Empty or null: bosses use the general multiplier. */
    bossMultiplierOverride?: string | number | null
    /**
     * What the settings page sends: the percentage it showed (100 is 1×). A value the page showed unchanged leaves the
     * stored override alone; one equal to what the choice follows (the profile's default, or for bosses the general
     * multiplier) clears the override, so it keeps following that. Wins over the multipliers above.
     */
    multiplierPercent?: string | number
    bossMultiplierPercent?: string | number
}

/** All settings commit together; changing pace preserves the current timeline position. */
export function saveEventSettings(update: EventSettingsUpdate, now = Date.now()): void {
    runInTransactionSync(() => {
        const current = getEventPolicy()
        const beforeRate = current.mode === "accelerated" ? current.acceleration : 1
        const acceleration = update.acceleration === undefined ? current.acceleration : Number(update.acceleration)
        const afterRate = update.mode === "accelerated" ? acceleration : 1
        const anchor = Math.round(now - (now - current.anchor) * beforeRate / afterRate)
        const policy = validateEventPolicy({ ...current, mode: update.mode, acceleration,
            anchor, rotationId: current.rotationId ?? current.anchor, adminTimeTravel: update.adminTimeTravel === "1" })
        const prior = getRewardPolicy()
        const rewardUpdate: Parameters<typeof setRewardPolicy>[0] = { management: update.management }
        if (update.management === "automatic" && prior.management !== "automatic") {
            rewardUpdate.multiplierOverride = null
            rewardUpdate.bossMultiplierOverride = null
        } else {
            if (update.multiplierOverride !== undefined) rewardUpdate.multiplierOverride = update.multiplierOverride
            if (update.bossMultiplierOverride !== undefined) rewardUpdate.bossMultiplierOverride = update.bossMultiplierOverride
            const profileDefault = PROFILE_MULTIPLIER
            const asMultiplier = (percent: string | number) => Number.isFinite(Number(percent)) && String(percent).trim() !== "" ? Number(percent) / 100 : String(percent)
            if (update.multiplierPercent !== undefined && Number(update.multiplierPercent) !== rewardPercent(prior.multiplier)) {
                rewardUpdate.multiplierOverride = Number(update.multiplierPercent) === rewardPercent(profileDefault) ? null : asMultiplier(update.multiplierPercent)
            }
            if (update.bossMultiplierPercent !== undefined && Number(update.bossMultiplierPercent) !== rewardPercent(prior.bossMultiplier)) {
                const general = rewardUpdate.multiplierOverride !== undefined ? rewardUpdate.multiplierOverride : prior.multiplierOverride
                const followed = typeof general === "number" ? general : profileDefault
                rewardUpdate.bossMultiplierOverride = Number(update.bossMultiplierPercent) === rewardPercent(followed) ? null : asMultiplier(update.bossMultiplierPercent)
            }
        }
        const invalid = setRewardPolicy(rewardUpdate)
        if (invalid.length) throw new RangeError(`Invalid reward setting: ${invalid.join(", ")}`)
        setEventPolicy(policy)
        let history: unknown
        try { history = JSON.parse(getStoredText("events.history") ?? "[]") } catch { history = [] }
        const entries = Array.isArray(history) ? history.slice(-49) : []
        entries.push({ at: now, mode: policy.mode, acceleration: policy.acceleration,
            management: getRewardPolicy().management, multiplier: getRewardPolicy().multiplier,
            bossMultiplier: getRewardPolicy().bossMultiplier })
        setStoredText("events.history", JSON.stringify(entries))
    })
}
