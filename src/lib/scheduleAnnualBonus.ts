/** Resolve annual bonus windows before installing them as ordinary full client periods. */
import bonuses from "../../assets/login_bonus.json";
import { ScheduleAssetUnavailableError } from "./scheduleArchiveCache";

const JST_OFFSET = 9 * 60 * 60 * 1000
const yearOf = (time: number) => new Date(time + JST_OFFSET).getUTCFullYear()
const rawTime = (value: string) => Date.parse(`${value.replace(" ", "T")}+09:00`)
const partial = /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
function validPartial(value: string): boolean {
    const parsed = rawTime(`2000-${value}`)
    return partial.test(value) && Number.isFinite(parsed)
        && new Date(parsed + JST_OFFSET).toISOString().slice(5, 19).replace("T", " ") === value
}

export interface AnnualBonusOccurrence { start: number, end: number, startYear: number }

/**
 * Choose the current year's season (previous year's for the January part of a cross-year season),
 * intersecting the release window. If that season predates launch or follows closure, the nearest
 * eligible season is a valid closed client range. An empty range must never reach the stock
 * TimeRange constructor: it throws C2044 when end<start.
 */
export function annualBonusOccurrence(
    annualStart: string,
    annualEnd: string,
    releaseStart: number | undefined,
    releaseEnd: number | undefined,
    contentTime: number
): AnnualBonusOccurrence {
    if (!validPartial(annualStart) || !validPartial(annualEnd) || !Number.isFinite(contentTime))
        throw new ScheduleAssetUnavailableError("Invalid annual login bonus period")
    const year = yearOf(contentTime)
    const monthDay = new Date(contentTime + JST_OFFSET).toISOString().slice(5, 19).replace("T", " ")
    const desired = annualEnd < annualStart && monthDay <= annualEnd ? year - 1 : year
    // A yearly season can begin in its release boundary's year or the adjacent year. Together
    // with the desired year these candidates find the nearest eligible interval without an
    // unbounded year scan, even for a long-lived or finite campaign.
    const candidates = new Set([desired])
    for (const boundary of [releaseStart, releaseEnd]) if (boundary !== undefined) {
        const boundaryYear = yearOf(boundary)
        for (const delta of [-1, 0, 1]) candidates.add(boundaryYear + delta)
    }
    for (const startYear of [...candidates].filter(value => value >= 1 && value <= 9998)
        .sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired) || a - b)) {
        const start = rawTime(`${String(startYear).padStart(4, "0")}-${annualStart}`)
        let end = rawTime(`${String(startYear).padStart(4, "0")}-${annualEnd}`)
        if (end < start) end = rawTime(`${String(startYear + 1).padStart(4, "0")}-${annualEnd}`)
        const clippedStart = Math.max(start, releaseStart ?? -Infinity)
        const clippedEnd = Math.min(end, releaseEnd ?? Infinity)
        if (Number.isFinite(clippedStart) && Number.isFinite(clippedEnd) && clippedStart <= clippedEnd)
            return { start: clippedStart, end: clippedEnd, startYear }
    }
    throw new ScheduleAssetUnavailableError("Annual login bonus has no occurrence within its release period")
}

/** Year/season changes invalidate client assets; seconds within the season do not. */
export function annualBonusViewIdentity(contentTime: number): string {
    return JSON.stringify([yearOf(contentTime), ...bonuses.filter(group =>
        (group.groupType === "Normal" || group.groupType === "Limited") && group.annualStart && group.annualEnd)
        .map(group => [group.id, annualBonusOccurrence(group.annualStart!, group.annualEnd!,
            group.startDate === null ? undefined : rawTime(group.startDate),
            group.endDate === null ? undefined : rawTime(group.endDate), contentTime)])])
}
