import { contentDate, isContentPeriodOpen, scheduledContentEnabled } from "./eventSchedule";
// When an event quest can be started (SEC-16, docs/hardening.md "Security review"): within its event's period, as
// the master tables have it. The game shows an event's quests by the same master dates and the clock the server
// sends, so a game never starts one outside them; a client that asks anyway is refused. The check uses the player's
// own clock (src/lib/playerClock.ts applies it per request).
//
// The periods come from two places:
// - the event calendar (`assets/event_calendar.json`): story, world story (where the calendar has the event), advent,
//   carnival, co-op boss (hard multi), raid, ranking and rush events;
// - the modes' own rows (`assets/quest_mode_periods.json`, FT-51): the Kaleidoscope dailies (element and EXP & Mana),
//   the Necropolis and the Treasure Zone, Solo Boss Challenges and Nostalgia Trials, Chrono Trials and Score
//   Scramble. These modes arrived later than the start of the archive (the element dailies on 2021-09-11, the
//   Necropolis on 2021-12-26, ...; docs/feature-timeline.md), and the final client shows each only inside its row's
//   period, so the server checks the same one.
// Main, EX, boss battle and unit story quests have no period; the Haunt's quests have their own cycle check
// (src/lib/towerDungeon.ts). An event quest's id is `event id * 1000 + quest number`.
//
// `QUEST_PERIOD_CHECK=off` turns the check off (a server whose players start past events some other way; the tests,
// whose battles play events on dates outside them); unset or anything else checks.

import calendarData from "../../assets/event_calendar.json";
import modePeriods from "../../assets/quest_mode_periods.json";
import { masterDate } from "../utils";
import { QuestCategory } from "./types";

/** The calendar's event kind, or the mode's table, for each quest category with periods. */
const EVENT_KINDS: Partial<Record<QuestCategory, string>> = {
    [QuestCategory.STORY_EVENT_SINGLE]: "story_event",
    [QuestCategory.WORLD_STORY_EVENT]: "world_story_event",
    [QuestCategory.WORLD_STORY_EVENT_BOSS_BATTLE]: "world_story_event",
    [QuestCategory.ADVENT_EVENT_SINGLE]: "advent_event",
    [QuestCategory.ADVENT_EVENT_MULTI]: "advent_event",
    [QuestCategory.CARNIVAL_EVENT]: "carnival_event",
    [QuestCategory.HARD_MULTI_EVENT]: "hard_multi_event",
    [QuestCategory.RAID_EVENT]: "raid_event",
    [QuestCategory.RANKING_EVENT_SINGLE]: "ranking_event",
    [QuestCategory.RUSH_EVENT]: "rush_event",
    [QuestCategory.DAILY_WEEK_EVENT]: "daily_week_event",
    [QuestCategory.DAILY_EXP_MANA_EVENT]: "daily_exp_mana_event",
    [QuestCategory.CHALLENGE_DUNGEON_EVENT]: "challenge_dungeon_event",
    [QuestCategory.EXPERT_SINGLE_EVENT]: "expert_single_event",
    [QuestCategory.SOLO_TIME_ATTACK_EVENT]: "solo_time_attack_event",
    [QuestCategory.SCORE_ATTACK_EVENT]: "score_attack_event"
}

export interface EventPeriod {
    /** the calendar id, `<kind>/<event id>` */
    id: string
    start: Date
    /** the last second of the period; null for a mode that stays open */
    end: Date | null
}

const periods = new Map<string, EventPeriod>()
for (const event of (calendarData as { events: { id: string, start: string, end: string }[] }).events) {
    periods.set(event.id, { id: event.id, start: masterDate(event.start), end: masterDate(event.end) })
}
for (const [kind, rows] of Object.entries(modePeriods as Record<string, Record<string, { start: string, end: string | null }>>)) {
    for (const [eventId, row] of Object.entries(rows)) {
        const id = `${kind}/${eventId}`
        periods.set(id, { id, start: masterDate(row.start), end: row.end === null ? null : masterDate(row.end) })
    }
}

/** The period of the event a quest belongs to, or null when there is none for it. */
export function questEventPeriod(category: number, questId: number): EventPeriod | null {
    const kind = EVENT_KINDS[category as QuestCategory]
    if (kind === undefined || !Number.isSafeInteger(questId) || questId < 1000) return null
    return periods.get(`${kind}/${Math.floor(questId / 1000)}`) ?? null
}

/** Whether the period check is on: `QUEST_PERIOD_CHECK` is anything but `off`. */
export function questPeriodCheckFromEnv(value = process.env.QUEST_PERIOD_CHECK): boolean {
    return value?.trim().toLowerCase() !== "off"
}

/**
 * Whether a quest can be started at a date: always, unless it belongs to an event whose period doesn't hold it (and
 * the check is on).
 */
export function isQuestOpen(category: number, questId: number, date: Date, check = questPeriodCheckFromEnv()): boolean {
    if (!check) return true
    const period = questEventPeriod(category, questId)
    if (period === null) return true
    const end = period.end?.getTime()
    if (!scheduledContentEnabled()) {
        const time = contentDate(date).getTime()
        return period.start.getTime() <= time && (end === undefined || time < end + 1000)
    }
    return isContentPeriodOpen(period.start.getTime(), end, date)
}
