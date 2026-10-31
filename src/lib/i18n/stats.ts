// Length limits for the checker: the 95th percentile of the English text length per translatable column.

import { hasJapanese, masterRows } from "./text"

export function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[index]
}

/** Longest line of a text, as the client shows it (tags and placeholders are not stripped; they are rare). */
export const textLength = (text: string): number => text.length

/**
 * Percentile of the length of the English cells (non-empty, no Japanese) of each column in `columns`.
 * Columns with fewer than `minSamples` English cells get no limit.
 */
export function columnLimits(
    table: unknown,
    columns: number[],
    p = 95,
    minSamples = 20,
): Record<string, number> {
    const lengths = new Map<number, number[]>(columns.map((c) => [c, []]))
    for (const row of masterRows(table)) {
        for (const col of columns) {
            const cell = row.cells[col]
            if (cell !== undefined && cell.trim() !== "" && !hasJapanese(cell)) lengths.get(col)!.push(textLength(cell))
        }
    }
    const out: Record<string, number> = {}
    for (const [col, values] of lengths) if (values.length >= minSamples) out[String(col)] = percentile(values, p)
    return out
}
