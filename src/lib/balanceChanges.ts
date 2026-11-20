/**
 * Balance changes on the replayed timeline (FT-47 phases 2 and 3, docs/balance-history.md "Balance values"): Japan's
 * adjustments from 2021-09 to 2023-06, each landing on Japan's schedule, anchored to its event like the second board
 * waves (src/lib/boardRelease.ts): the 2023 ones exact from global's 2.1.108 patch, the earlier ones from global's
 * patch notes (number-only changes). Pure functions of a content time.
 *
 * `assets/balance_changes.json` (scripts/balance_research/cdn_patch.py and balance_changes.py) holds, per change, the
 * values of the final master tables before it: single cells (table, key path, record, column) and whole entries
 * rebuilt in the final layout (abilities reworked with another number of records), and script patches for skills whose
 * battle script it altered. The final master holds the values after it. Before a change lands, the schedule overlay ships its tables with the earlier values.
 *
 * A balance epoch counts the board waves and the changes landed: two content times in the same epoch show every unit
 * the same way (the asset view's identity and co-op rooms use it).
 */
import { createHash } from "crypto";
import balanceChanges from "../../assets/balance_changes.json";
import board2Dates from "../../assets/board2_dates.json";
import { board2Landings, board2WaveTimes, waveLandingTime } from "./boardRelease";
import type { ScriptPatch } from "./skillScripts";

export interface BalanceCell {
    table: string
    key: string[]
    record: number
    column: number
    before: string
    /** from the notes: a leader's lower value taken from the table's convention, not stated */
    inferred?: boolean
    /** from the notes: placed by the text's order among cells holding the same value */
    ordered?: boolean
    /** a text cell: the masters' language it is written in (other languages keep theirs) */
    language?: string
}

export interface BalanceEntry {
    table: string
    key: string[]
    records: string[][]
}

export interface BalanceChange {
    id: string
    jpDate: string
    jpNotices: number[]
    /**
     * `cdn 2.1.108` (exact, from global's CDN), `note 1241` / `note 2610` / `note 1242` (global's patch notes; 1241's round
     * also takes Japan's detail notices 1056 and 1058 for the units the note doesn't cover) or `jp 817` (Japan's notice)
     */
    source: string
    event: string | null
    jpEventNotice: number | null
    offsetDays: number | null
    date: string
    units: string[]
    /** armament ids whose abilities (`ability/ability_soul`) the change touches */
    armaments?: string[]
    cells: BalanceCell[]
    entries: BalanceEntry[]
    /** skills whose battle script the change altered: the scripts before it (src/lib/skillScripts.ts) */
    scripts?: ScriptPatch[]
}

const changes = (balanceChanges as { changes: BalanceChange[] }).changes

/**
 * A digest of the balance data (the changes and the second board dates). The schedule view's identity carries it, so a
 * server updated with new or corrected balance data builds new views even where the epoch stays the same; before it,
 * a data-only update kept serving the views built from the old data until the epoch next moved.
 */
export const BALANCE_DATA_DIGEST = createHash("sha256").update(JSON.stringify([balanceChanges, board2Dates])).digest("hex").slice(0, 16)
const landings = changes.map(change => ({ change, time: waveLandingTime(change) }))

/** The CDN battle scripts the changes' script patches start from (a data pack carries them). */
export const BALANCE_SCRIPT_SOURCES: readonly string[] = [...new Set(changes.flatMap(c => (c.scripts ?? []).map(s => s.source)))].sort()

/** The master tables the changes touch, which the overlay ships with every view. */
export const BALANCE_CHANGE_TABLES: readonly string[] = [...new Set(changes.flatMap(c => [...c.cells, ...c.entries].map(x => x.table)))].sort()

/** When a change lands on the archive's timeline. */
export function balanceChangeTime(id: string): number | undefined {
    return landings.find(l => l.change.id === id)?.time
}

/** The changes not landed yet at a content time, latest first (so earlier values, applied last, win). */
export function pendingBalanceChanges(contentTime: number): BalanceChange[] {
    return landings.filter(l => contentTime < l.time).sort((a, b) => b.time - a.time).map(l => l.change)
}

const epochBoundaries = [...new Set([...board2WaveTimes, ...landings.map(l => l.time)])].sort((a, b) => a - b)

/** The balance epoch of a content time: how many board waves and balance changes have landed. */
export function balanceEpochAt(contentTime: number): number {
    let epoch = 0
    while (epoch < epochBoundaries.length && contentTime >= epochBoundaries[epoch]) epoch++
    return epoch
}

/** The final epoch: everything landed (event scheduling off, or after the archive). */
export const FINAL_BALANCE_EPOCH = epochBoundaries.length

/**
 * A unit's HP and ATK key rows before the changes not landed yet at a content time (`character/character_status`):
 * [level, hp, atk] rows with the earlier values, for the server's own party power.
 */
export function statusRowsAt(characterId: number, rows: readonly [number, number, number][], contentTime: number): [number, number, number][] {
    const out = rows.map(row => [...row] as [number, number, number])
    // latest first, so the earliest change's values are written last and win
    for (const change of pendingBalanceChanges(contentTime)) {
        for (const cell of change.cells) {
            if (cell.table !== "character/character_status" || cell.key[0] !== String(characterId)) continue
            const row = out.find(r => r[0] === Number(cell.key[1]))
            if (row && (cell.column === 0 || cell.column === 1)) row[cell.column + 1] = Number(cell.before)
        }
    }
    return out
}

/** One landing on the balance timeline, for the admin calendar. */
export interface BalanceLanding {
    time: number
    kind: "board2" | "change"
    /** what lands, in a few words */
    label: string
    /** the global event it is anchored to */
    event: string | null
}

/** Everything that lands on the balance timeline, in order: second board waves and balance changes. */
export function balanceLandings(): BalanceLanding[] {
    const boards: BalanceLanding[] = board2Landings().map(l => ({
        time: l.time, kind: "board2", event: l.event, label: `Second mana boards for ${l.units} unit${l.units === 1 ? "" : "s"}`
    }))
    const values: BalanceLanding[] = landings.map(({ change, time }) => {
        const armaments = change.armaments?.length ?? 0
        const what = armaments > 0 ? `Armament buffs (${armaments} armaments)` : `Unit buffs (${change.units.length} unit${change.units.length === 1 ? "" : "s"})`
        return { time, kind: "change", event: change.event, label: `${what}, Japan's update of ${change.jpDate}` }
    })
    return [...boards, ...values].sort((a, b) => a.time - b.time || a.kind.localeCompare(b.kind))
}
