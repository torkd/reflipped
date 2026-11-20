/**
 * When each unit's second mana board comes out on the replayed timeline (FT-47, docs/balance-history.md "Second
 * boards, dated"). Pure functions of a content time (the archive's historical time, as the event schedule replays
 * it); src/lib/balance.ts says which content time applies.
 *
 * `assets/board2_dates.json` (scripts/balance_research/jp_anchor.py) anchors each of Japan's second board waves to an
 * event of the global calendar and the days after its start. A wave lands at the start of the game day it falls on
 * (05:00 Japan time), kept inside its event. Units the list doesn't name (released with their second board, or
 * without one) are never held back.
 */
import board2Dates from "../../assets/board2_dates.json";
import calendar from "../../assets/event_calendar.json";
import manaNodes from "../../assets/mana_node.json";
import { GAME_DAY_MS, gameDayOf, gameDayStart } from "./calendar";

interface Board2Wave {
    wave: number | null
    notice: number
    jpDate: string
    event: string | null
    jpEventNotice: number | null
    offsetDays: number | null
    date: string
}

const masterTime = (text: string) => Date.parse(`${text.replace(" ", "T")}+09:00`)
const events = new Map(calendar.events.map(event => [event.id, { start: masterTime(event.start), end: masterTime(event.end) + 1000 }]))

/** When a wave lands: its event's start plus its offset, kept inside the event, at the start of that game day. */
export function waveLandingTime(wave: Pick<Board2Wave, "event" | "offsetDays" | "date">): number {
    const event = wave.event === null ? undefined : events.get(wave.event)
    if (event === undefined || wave.offsetDays === null) return gameDayStart(wave.date)
    const lastDay = Math.max(event.start, event.end - GAME_DAY_MS)
    const time = Math.min(Math.max(event.start + wave.offsetDays * GAME_DAY_MS, event.start), lastDay)
    return gameDayStart(gameDayOf(time))
}

const waves = (board2Dates as { waves: Board2Wave[] }).waves
const waveTimes = waves.map(waveLandingTime)
/** unit id -> when its second board comes out */
const releaseTimes = new Map<string, number>(Object.entries((board2Dates as { units: Record<string, number> }).units)
    .map(([unit, wave]) => [unit, waveTimes[wave]]))
/** When each wave lands, ascending (src/lib/balanceChanges.ts counts epochs from them and the adjustments). */
export const board2WaveTimes: readonly number[] = [...new Set(waveTimes)].sort((a, b) => a - b)

/** The board waves as they land (waves landing at the same time together): when, the event, how many units. */
export function board2Landings(): { time: number, event: string | null, units: number }[] {
    const counts = new Map<number, number>()
    for (const wave of Object.values((board2Dates as { units: Record<string, number> }).units)) counts.set(wave, (counts.get(wave) ?? 0) + 1)
    const byTime = new Map<number, { time: number, event: string | null, units: number }>()
    waves.forEach((wave, index) => {
        const units = counts.get(index) ?? 0
        if (units === 0) return
        const landing = byTime.get(waveTimes[index]) ?? { time: waveTimes[index], event: wave.event, units: 0 }
        landing.units += units
        byTime.set(waveTimes[index], landing)
    })
    return [...byTime.values()].sort((a, b) => a.time - b.time)
}

/** When a unit's second board comes out on the archive's timeline, or undefined when it is never held back. */
export function board2ReleaseTime(characterId: number | string): number | undefined {
    return releaseTimes.get(String(characterId))
}

/** Whether a unit's second board is out at a content time (Infinity: every board, as at the end of the archive). */
export function isBoard2Out(characterId: number | string, contentTime: number): boolean {
    const release = releaseTimes.get(String(characterId))
    return release === undefined || contentTime >= release
}

/** The units whose second board isn't out at a content time. */
export function unitsWithHiddenBoard2(contentTime: number): Set<string> {
    const hidden = new Set<string>()
    for (const [unit, release] of releaseTimes) if (contentTime < release) hidden.add(unit)
    return hidden
}

const board2Nodes = new Map<string, Set<number>>()
for (const [unit, boards] of Object.entries(manaNodes as Record<string, Record<string, Record<string, unknown>>>)) {
    const nodes = boards["2"]
    if (nodes) board2Nodes.set(unit, new Set(Object.keys(nodes).map(Number)))
}

/** Whether a mana node is on a unit's second board. */
export function isBoard2Node(characterId: number | string, nodeId: number): boolean {
    return board2Nodes.get(String(characterId))?.has(nodeId) ?? false
}
