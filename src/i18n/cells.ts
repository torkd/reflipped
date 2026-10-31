/**
 * Cell addressing, source hashes and patching for the translation tables (I18N-1; see docs/i18n.md,
 * "Translation tables").
 *
 * A cell is addressed by its row key path and column index, the same way `scripts/extract_master.py` dumps
 * a table (and the I18N-2 tools and `i18n/columns.json` read it):
 *  - row key path: the keys from the table's root down to the CSV leaf, joined with `/`
 *    (`141171`, `2000004/1`); a table that is one plain CSV has the row `` (empty);
 *  - column: the index in the leaf's cells, all its CSV records read as one list (most leaves hold one
 *    record; `character/character_speech` holds several, so its voice lines are cols 3, 8, 13, …).
 * The root map of every scenario holds a single key equal to the scenario's own name (`story/…/scenario`);
 * that wrapper is left out, so scenario rows are `1`, `2`, … .
 * Some keys contain `/` themselves (asset paths used as keys, e.g. `asset/bgm_asset`, `rich_text/rich_text_html`);
 * a row key path is resolved against the table's actual keys, and listing a table whose paths collide
 * throws, so the joined form stays unambiguous.
 */
import { createHash } from "crypto";
import { decodeOrderedMap, OrderedMapLeaf, OrderedMapNode, walkLeaves } from "../lib/orderedmap";

export const KEY_SEPARATOR = "/"

/** `sha256:<hex>` of a cell's UTF-8 text: the `srcHash` of a translation entry. */
export function srcHash(text: string): string {
    return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex")
}

export function formatRowKey(keys: readonly string[]): string {
    return keys.join(KEY_SEPARATOR)
}

/** The key the root wrapper of a table would have (see the file comment), or undefined if it has none. */
export function rootWrapperKey(root: OrderedMapNode, table: string): string | undefined {
    if (root.kind !== "map" || root.entries.length !== 1) return undefined
    const key = root.entries[0].key
    return key === table.replace(/^\/+/, "") ? key : undefined
}

// ---- Japanese text ----

// kana (without the long-vowel mark ー, the middle dot ・ and the sound marks ゛゜), kanji and 々〆〇
const JAPANESE_RE = /[ぁ-ゖゝ-ゟァ-ヺヽ-ヿㇰ-ㇿｦ-ｯｱ-ﾝ々-〇㐀-䶿一-鿿豈-﫿\u{20000}-\u{3134F}]/u
// CJK punctuation and full-width forms (。、「」・ー！？～ …): no reading text by themselves
const CJK_PUNCTUATION_RE = /[　-〄〈-〿゛゜・ー！-･ｰﾞﾟ]/

/** Whether a cell holds kana or kanji: text the English client can't show (see docs/i18n.md). */
export function hasJapanese(text: string): boolean {
    return JAPANESE_RE.test(text)
}

/** Whether a cell holds CJK punctuation or full-width forms but no kana or kanji. */
export function hasOnlyCjkPunctuation(text: string): boolean {
    return !JAPANESE_RE.test(text) && CJK_PUNCTUATION_RE.test(text)
}

// ---- leaves as flat cell lists ----

/** Maps a column (index in the leaf's flattened cells) to its record and index in that record. */
export function locateCell(leaf: OrderedMapLeaf, col: number): { record: number, index: number } | undefined {
    if (!Number.isInteger(col) || col < 0) return undefined
    let rest = col
    const records = leaf.records
    for (let r = 0; r < records.length; r++) {
        if (rest < records[r].length) return { record: r, index: rest }
        rest -= records[r].length
    }
    return undefined
}

// ---- listing ----

export interface TableCell {
    /** Row key path (see the file comment). */
    row: string
    keys: string[]
    /** Index in the leaf's flattened cells: the column of `i18n/columns.json` and the translation files. */
    col: number
    text: string
    /** The CSV record the cell is in, and the cell's index in it. */
    record: number
    recordCells: readonly string[]
    indexInRecord: number
}

/** Every cell of a decoded table or scenario, in file order. Throws if two rows have the same key path. */
export function* tableCells(root: OrderedMapNode, table: string): Generator<TableCell> {
    const wrapper = rootWrapperKey(root, table)
    const seen = new Set<string>()
    for (const { keys, leaf } of walkLeaves(root)) {
        const rowKeys = wrapper !== undefined ? keys.slice(1) : keys
        const row = formatRowKey(rowKeys)
        if (seen.has(row)) throw new Error(`${table}: two rows have the key path "${row}"`)
        seen.add(row)
        let col = 0
        const records = leaf.records
        for (let record = 0; record < records.length; record++) {
            const cells = records[record]
            for (let indexInRecord = 0; indexInRecord < cells.length; indexInRecord++) {
                yield { row, keys: rowKeys, col: col++, text: cells[indexInRecord], record, recordCells: cells, indexInRecord }
            }
        }
    }
}

// ---- patching ----

export interface CellPatch {
    row: string
    col: number
    text: string
    /** When given, the patch applies only while the source cell still hashes to this. */
    srcHash?: string
}

export interface PatchResult {
    /** The patched file (the input bytes themselves if nothing changed). */
    data: Buffer
    applied: CellPatch[]
    /** Patches whose `srcHash` no longer matches the source cell. */
    stale: (CellPatch & { current: string })[]
    /** Patches whose row or column doesn't exist. */
    missing: CellPatch[]
}

function findLeaf(node: OrderedMapNode, rest: string): OrderedMapLeaf | undefined {
    if (node.kind === "leaf") return rest === "" ? node : undefined
    for (const { key, value } of node.entries) {
        if (rest === key) {
            if (value.kind === "leaf") return value
        } else if (rest.startsWith(key + KEY_SEPARATOR)) {
            const found = findLeaf(value, rest.slice(key.length + 1))
            if (found) return found
        }
    }
    return undefined
}

/** The leaf a row key path addresses, or undefined. */
export function resolveRow(root: OrderedMapNode, table: string, row: string): OrderedMapLeaf | undefined {
    const wrapper = rootWrapperKey(root, table)
    return findLeaf(root, wrapper === undefined ? row : row === "" ? wrapper : wrapper + KEY_SEPARATOR + row)
}

/** The current text of a cell, or undefined. */
export function getCell(root: OrderedMapNode, table: string, row: string, col: number): string | undefined {
    const leaf = resolveRow(root, table, row)
    const at = leaf && locateCell(leaf, col)
    return at ? leaf!.getCell(at.record, at.index) : undefined
}

/**
 * Applies cell patches to a decoded table; `srcHash` is checked against the cell as it was before any
 * patch. Returns which patches applied; call `root.encode()` for the bytes.
 */
export function patchCells(root: OrderedMapNode, table: string, patches: readonly CellPatch[]): Omit<PatchResult, "data"> {
    const result: Omit<PatchResult, "data"> = { applied: [], stale: [], missing: [] }
    const originals = new Map<string, string>()
    for (const patch of patches) {
        const leaf = resolveRow(root, table, patch.row)
        const at = leaf && locateCell(leaf, patch.col)
        if (!leaf || !at) {
            result.missing.push(patch)
            continue
        }
        const id = `${patch.row}\u0000${patch.col}`
        const current = originals.get(id) ?? leaf.getCell(at.record, at.index)!
        originals.set(id, current)
        if (patch.srcHash !== undefined && patch.srcHash !== srcHash(current)) {
            result.stale.push({ ...patch, current })
            continue
        }
        leaf.setCell(at.record, at.index, patch.text)
        result.applied.push(patch)
    }
    return result
}

/**
 * Applies cell patches to an orderedmap file. Only the leaves that change are re-encoded; every other
 * leaf keeps its original bytes (see `src/lib/orderedmap.ts`).
 */
export function patchTable(data: Buffer, table: string, patches: readonly CellPatch[]): PatchResult {
    const root = decodeOrderedMap(data)
    const result = patchCells(root, table, patches)
    return { data: root.changed ? root.encode() : data, ...result }
}
