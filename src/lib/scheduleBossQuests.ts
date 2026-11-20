import pickups from "../../assets/boss_battle_multi_pickup.json";

/**
 * Boss battle quests whose master window is the last of several reruns (the three Queens, whose final master rows read
 * 2024-05-28 to 07-25, while the same bosses were already spotlit in earlier seasons) are treated like the other bosses:
 * open from the boss's first spotlight and with no end. The client lists a boss's Boss Coin shop only while the boss's
 * first quest is inside its period (`BossCoinExchangeTopScene.resetCategoryList` -> `isViewable` -> `isWithinPeriod`)
 * and opens a season's lineup choice only while one of the shop's seasons runs, so a window that starts after those
 * seasons hides the Jade Queen shop during its own lineup campaign (docs/event-scheduling.md, "Boss quest windows").
 * A boss whose window already covers its seasons (Arch Guardian, 2023-09-27 to 10-10) is left alone.
 */

interface Season { spotlights: { stageNodeId: number, start: string }[] }

/** Master dates are JST (this file stays free of imports from the clock modules, which import the overlay in turn). */
const jstTime = (text: string) => new Date(`${text.replace(" ", "T")}+09:00`).getTime()

let firstSpotlights: Map<number, number> | undefined

function spotlightStarts(): Map<number, number> {
    if (firstSpotlights !== undefined) return firstSpotlights
    const first = new Map<number, number>()
    for (const season of Object.values((pickups as { seasons: Record<string, Season> }).seasons)) {
        for (const spotlight of season.spotlights) {
            const start = jstTime(spotlight.start)
            const known = first.get(spotlight.stageNodeId)
            if (known === undefined || start < known) first.set(spotlight.stageNodeId, start)
        }
    }
    return firstSpotlights = first
}

/**
 * The time (master time, ms) a boss quest should open at instead of its window, or null when its window is kept: the
 * quest has an end and the boss was spotlit before its window's start.
 */
export function bossQuestOpening(stageNodeId: number, windowStart: number, windowEnd: number | null): number | null {
    if (windowEnd === null) return null
    const first = spotlightStarts().get(stageNodeId)
    return first !== undefined && first < windowStart ? first : null
}
