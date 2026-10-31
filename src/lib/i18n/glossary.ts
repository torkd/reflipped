// Glossary miner: official JA -> EN pairs from the parallel columns of the master data (docs/i18n.md, "Translation
// tables"). The functions are pure (rows in, entries out); `cli.ts` reads the dumps of `scripts/extract_master.py`.

import { hasJapanese, masterRows, rowKey } from "./text"

export interface GlossaryEntry {
    ja: string
    en: string
    kind: "character" | "encyclopedia" | "ui_string"
    /** Table, row key and columns the pair comes from, e.g. `character/character_text#111001:1->0`. */
    source: string
    /** Cross-check reference (wiki page), filled by hand; null when none. */
    ref: string | null
}

/** A cell that is not a usable English side: empty, still Japanese, or a placeholder. */
export function isUsableEnglish(en: string, ja: string): boolean {
    const text = en.trim()
    if (text === "" || hasJapanese(text)) return false
    if (text === ja.trim()) return false
    if (/^[-_ー–—.・*]+$/.test(text)) return false // "-", "--", "..."
    if (/^\(?(none|null|todo|tbd|dummy|temp)\)?$/i.test(text)) return false
    return true
}

interface PairSpec {
    table: string
    kind: GlossaryEntry["kind"]
    jaCol: number
    enCol: number
    /** Skip pairs whose Japanese side is longer or has a line break: the glossary holds terms, not paragraphs. */
    maxJaLength?: number
}

export const PAIR_SPECS: readonly PairSpec[] = [
    { table: "character/character_text", kind: "character", jaCol: 1, enCol: 0 },
    { table: "encyclopedia/encyclopedia", kind: "encyclopedia", jaCol: 17, enCol: 16 },
    { table: "string/ui_string", kind: "ui_string", jaCol: 0, enCol: 2, maxJaLength: 40 },
]

/** Pairs the Japanese and English columns of one table dump; rows whose English side is unusable are skipped. */
export function minePairs(table: unknown, spec: PairSpec): GlossaryEntry[] {
    const out: GlossaryEntry[] = []
    for (const row of masterRows(table)) {
        const ja = (row.cells[spec.jaCol] ?? "").trim()
        const en = (row.cells[spec.enCol] ?? "").trim()
        if (spec.maxJaLength !== undefined && ([...ja].length > spec.maxJaLength || ja.includes("\n"))) continue
        if (ja === "" || !hasJapanese(ja) || !isUsableEnglish(en, ja)) continue
        out.push({
            ja,
            en,
            kind: spec.kind,
            source: `${spec.table}#${rowKey(row.keyPath)}:${spec.jaCol}->${spec.enCol}`,
            ref: null,
        })
    }
    return out
}

/** Drops exact duplicates (same ja and en), keeping the first source; sorted by kind, then source for stable diffs. */
export function dedupe(entries: GlossaryEntry[]): GlossaryEntry[] {
    const seen = new Set<string>()
    const out: GlossaryEntry[] = []
    for (const entry of entries) {
        const key = `${entry.kind}\u0000${entry.ja}\u0000${entry.en}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(entry)
    }
    return out
}

/** Japanese terms with more than one English rendering (for review; the glossary keeps them all). */
export function conflicts(entries: GlossaryEntry[]): Map<string, string[]> {
    const byJa = new Map<string, Set<string>>()
    for (const entry of entries) {
        if (!byJa.has(entry.ja)) byJa.set(entry.ja, new Set())
        byJa.get(entry.ja)!.add(entry.en)
    }
    return new Map([...byJa].filter(([, ens]) => ens.size > 1).map(([ja, ens]) => [ja, [...ens]]))
}
