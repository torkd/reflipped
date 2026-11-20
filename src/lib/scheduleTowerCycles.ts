import towerDungeonEventQuests from "../../assets/tower_dungeon_event_quest.json";

/**
 * The Haunt's monthly cycles as one run of back-to-back periods (FT-77), shared by the server (src/lib/towerDungeon.ts,
 * `towerCycleAt`) and the client masters the schedule overlay sends (src/lib/scheduleOverlay.ts).
 *
 * The master's own periods can't be sent as they are. Where the global and Japanese schedules meet (August to October
 * 2024) they overlap: 1271, 1301, 1281, 1311 and 1291 start in that order, while 1301 still runs when 1281 starts, and
 * so on. And the cycles from February 2025 on have no end but a yearly month-day window (`annual_start_time` and
 * `annual_end_time`, columns 7 and 8), which doesn't follow their start dates and isn't projected. The client's Haunt
 * screen (`TowerDungeonQuestSelectScene.prepareScene`) takes the battle quests within their period at the scene's time
 * (`getWithinPeriodSingleBattleQuests`: the quest period and, when set, the annual window) and throws client error 3092
 * ("C3092", shown before any request) unless there are exactly ten, so two open cycles (20 quests) or none break it.
 *
 * So every cycle runs from its own start until the next cycle starts, the last one without an end: where two periods
 * overlap the later-starting cycle counts, as the server always picked, and the four days between 1291's end
 * (2024-10-17) and 1321's start stay with 1291 instead of going back to 1311. The overlay writes these periods into
 * the master (with the annual window cleared), so the client sees exactly the ten quests of the cycle the server has
 * open, at every date.
 */
export interface TowerCyclePeriod {
    /** the cycle's quests by floor, lowest first */
    questIds: number[]
    /** master time (ms) */
    start: number
    /** master time (ms) the next cycle starts at (exclusive); null for the last cycle */
    end: number | null
}

/** Master dates are JST (this file stays free of imports from the clock modules, which import the overlay in turn). */
const jstTime = (text: string) => new Date(`${text.replace(" ", "T")}+09:00`).getTime()

let periods: TowerCyclePeriod[] | undefined
let periodOfQuest: Map<number, TowerCyclePeriod> | undefined

/** Every cycle, by start. */
export function towerCyclePeriods(): readonly TowerCyclePeriod[] {
    if (periods !== undefined) return periods
    const quests = towerDungeonEventQuests as Record<string, { start?: string, end?: string | null }>
    const groups = new Map<number, number[]>()
    for (const id of Object.keys(quests).map(Number).sort((a, b) => a - b)) {
        const start = quests[String(id)].start
        if (start === undefined) continue
        const time = jstTime(start)
        groups.set(time, [...groups.get(time) ?? [], id])
    }
    const starts = [...groups.keys()].sort((a, b) => a - b)
    periods = starts.map((start, index) => {
        const questIds = groups.get(start)!
        const next = starts[index + 1]
        const ownEnd = quests[String(questIds[0])].end
        return { questIds, start, end: next ?? (ownEnd ? jstTime(ownEnd) + 1000 : null) }
    })
    periodOfQuest = new Map(periods.flatMap(period => period.questIds.map(id => [id, period] as const)))
    return periods
}

/** The period of the cycle a Haunt quest belongs to, or null for an unknown quest. */
export function towerQuestPeriod(questId: number): TowerCyclePeriod | null {
    towerCyclePeriods()
    return periodOfQuest!.get(questId) ?? null
}
