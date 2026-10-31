// Small helpers shared by the translation tools (docs/i18n.md): Japanese detection and master-dump walking.

import { createHash } from "node:crypto"

const KANJI = /[㐀-䶿一-鿿豈-﫿々]/u
// hiragana, katakana (with the long-vowel mark ー U+30FC and the middle dot ・ U+30FB) and halfwidth katakana
const KANA = /[぀-ゟ゠-ヿｦ-ﾟ]/u

export const hasKanji = (text: string): boolean => KANJI.test(text)
export const hasKana = (text: string): boolean => KANA.test(text)
export const hasJapanese = (text: string): boolean => KANJI.test(text) || KANA.test(text)

export function sha256(text: string): string {
    return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex")
}

/** A row of a decoded master table: the key path through nested orderedmaps and the cells (CSV fields) of the leaf. */
export interface MasterRow {
    keyPath: string[]
    cells: string[]
}

/**
 * Walks a table as dumped by `scripts/extract_master.py`: an object of row key -> cells, nested for orderedmaps of
 * orderedmaps. The key path convention (joined with "/" by `rowKey`) is provisional until I18N-1 fixes it.
 */
export function* masterRows(table: unknown, keyPath: string[] = []): Generator<MasterRow> {
    if (Array.isArray(table)) {
        yield { keyPath, cells: table.map((cell) => (typeof cell === "string" ? cell : String(cell ?? ""))) }
    } else if (table !== null && typeof table === "object") {
        for (const [key, value] of Object.entries(table)) yield* masterRows(value, [...keyPath, key])
    }
}

export const rowKey = (keyPath: string[]): string => keyPath.join("/")
