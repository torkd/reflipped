/**
 * Codec for the game's "orderedmap" master files (I18N-1), ported from `scripts/extract_master.py`.
 *
 * Format:
 *  - a plain table is a zlib-compressed CSV;
 *  - an orderedmap is `int32le headerSize`, then a zlib-compressed header (`int32le count`, `count` pairs of
 *    `int32le keyEnd, int32le valueEnd`, both cumulative byte offsets, then the concatenated UTF-8 keys), then
 *    the concatenated values; each value is a zlib-compressed CSV or, recursively, another orderedmap.
 *
 * The originals are compressed with zlib level 9 (Node's zlib reproduces them byte for byte), and their CSV
 * uses minimal quoting, `\n` between records and no final newline; most rows hold one record, some several.
 *
 * Patching keeps everything that didn't change: an untouched leaf keeps its compressed bytes, an untouched
 * map its whole original bytes, and a map whose keys and value lengths are unchanged keeps its compressed
 * header. Only the changed leaves are re-encoded (and the headers above them when a value length changed,
 * since the header holds the value offsets).
 */
import { deflateSync, inflateSync } from "zlib";

export const ZLIB_LEVEL = 9

export type OrderedMapNode = OrderedMapLeaf | OrderedMapBranch

/** A zlib-compressed CSV: a list of records, each a list of cells. */
export class OrderedMapLeaf {
    readonly kind = "leaf"
    private raw: Buffer | null
    private text: string | null
    private parsed: CsvDocument | null = null
    private dirty = false

    constructor(raw: Buffer | null, text: string | null, parsed?: CsvDocument) {
        this.raw = raw
        this.text = text
        if (parsed) {
            this.parsed = parsed
            this.dirty = true
        }
    }

    /** A new leaf from records (encoded on the next `encode()`). */
    static fromRecords(records: string[][]): OrderedMapLeaf {
        return new OrderedMapLeaf(null, null, { records: records.map(r => [...r]), lineTerminator: "\n", trailingNewline: false })
    }

    /** The records of this leaf. Treat them as read-only; change cells with `setCell()`. */
    get records(): string[][] {
        return this.document().records
    }

    /** The cell at `col` of record `record`, or undefined. */
    getCell(record: number, col: number): string | undefined {
        return this.records[record]?.[col]
    }

    /** Sets a cell; marks the leaf changed only if the value differs. Throws if the cell doesn't exist. */
    setCell(record: number, col: number, value: string): boolean {
        const rec = this.records[record]
        if (!rec || col < 0 || col >= rec.length) throw new RangeError(`no cell ${record}:${col}`)
        if (rec[col] === value) return false
        rec[col] = value
        this.dirty = true
        return true
    }

    get changed(): boolean {
        return this.dirty
    }

    encode(): Buffer {
        if (!this.dirty && this.raw) return this.raw
        return deflateSync(Buffer.from(encodeCsv(this.document()), "utf8"), { level: ZLIB_LEVEL })
    }

    private document(): CsvDocument {
        if (!this.parsed) {
            if (this.text === null) this.text = inflateSync(this.raw!).toString("utf8")
            this.parsed = parseCsv(this.text)
        }
        return this.parsed
    }
}

/** An orderedmap: ordered (key, value) entries, each value a leaf or another map. */
export class OrderedMapBranch {
    readonly kind = "map"
    readonly entries: { key: string, value: OrderedMapNode }[]
    private raw: Buffer | null
    private header: Buffer | null
    private valueLengths: number[] | null

    constructor(entries: { key: string, value: OrderedMapNode }[], raw: Buffer | null = null, header: Buffer | null = null, valueLengths: number[] | null = null) {
        this.entries = entries
        this.raw = raw
        this.header = header
        this.valueLengths = valueLengths
    }

    get(key: string): OrderedMapNode | undefined {
        return this.entries.find(e => e.key === key)?.value
    }

    /** The node at a key path (empty path: this map). */
    at(keys: readonly string[]): OrderedMapNode | undefined {
        let node: OrderedMapNode | undefined = this
        for (const key of keys) {
            if (node?.kind !== "map") return undefined
            node = node.get(key)
        }
        return node
    }

    get changed(): boolean {
        return this.raw === null || this.entries.some(e => e.value.changed)
    }

    encode(): Buffer {
        if (this.raw && !this.entries.some(e => e.value.changed)) return this.raw
        const values = this.entries.map(e => e.value.encode())
        const sameLayout = this.header !== null && this.valueLengths !== null
            && this.valueLengths.length === values.length && values.every((v, i) => v.length === this.valueLengths![i])
        const header = sameLayout ? this.header! : encodeHeader(this.entries.map(e => e.key), values.map(v => v.length))
        const size = Buffer.alloc(4)
        size.writeInt32LE(header.length, 0)
        return Buffer.concat([size, header, ...values])
    }
}

function encodeHeader(keys: string[], valueLengths: number[]): Buffer {
    const keyBytes = keys.map(k => Buffer.from(k, "utf8"))
    const table = Buffer.alloc(4 + keys.length * 8)
    table.writeInt32LE(keys.length, 0)
    let keyEnd = 0, valueEnd = 0
    keyBytes.forEach((k, i) => {
        keyEnd += k.length
        valueEnd += valueLengths[i]
        table.writeInt32LE(keyEnd, 4 + i * 8)
        table.writeInt32LE(valueEnd, 8 + i * 8)
    })
    return deflateSync(Buffer.concat([table, ...keyBytes]), { level: ZLIB_LEVEL })
}

function tryInflate(data: Buffer): Buffer | null {
    // a zlib stream starts with CMF/FLG: deflate method, and the pair is a multiple of 31
    if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) return null
    try {
        return inflateSync(data)
    } catch {
        return null
    }
}

/**
 * Decodes an orderedmap file (or a plain zlib CSV table). Like the Python decoder, a value that inflates is
 * a CSV leaf, anything else a nested map. Leaves are inflated here and parsed on first use.
 */
export function decodeOrderedMap(data: Buffer): OrderedMapNode {
    const inflated = tryInflate(data)
    if (inflated) return new OrderedMapLeaf(data, inflated.toString("utf8"))
    return decodeBranch(data)
}

function decodeBranch(data: Buffer): OrderedMapBranch {
    if (data.length < 4) throw new Error("orderedmap too short")
    const headerSize = data.readInt32LE(0)
    if (headerSize < 0 || 4 + headerSize > data.length) throw new Error("bad orderedmap header size")
    const headerRaw = data.subarray(4, 4 + headerSize)
    const header = inflateSync(headerRaw)
    const count = header.readInt32LE(0)
    if (count < 0 || 4 + count * 8 > header.length) throw new Error("bad orderedmap entry count")
    const keys = header.subarray(4 + count * 8)
    const content = data.subarray(4 + headerSize)
    const entries: { key: string, value: OrderedMapNode }[] = []
    const lengths: number[] = []
    let keyStart = 0, valueStart = 0
    for (let i = 0; i < count; i++) {
        const keyEnd = header.readInt32LE(4 + i * 8)
        const valueEnd = header.readInt32LE(8 + i * 8)
        if (keyEnd < keyStart || keyEnd > keys.length || valueEnd < valueStart || valueEnd > content.length) {
            throw new Error(`bad orderedmap offsets at entry ${i}`)
        }
        const key = keys.subarray(keyStart, keyEnd).toString("utf8")
        const value = content.subarray(valueStart, valueEnd)
        entries.push({ key, value: decodeOrderedMap(value) })
        lengths.push(value.length)
        keyStart = keyEnd
        valueStart = valueEnd
    }
    if (valueStart !== content.length) throw new Error("orderedmap has trailing bytes")
    return new OrderedMapBranch(entries, data, headerRaw, lengths)
}

/** Builds a new map (for tests and new files); `encode()` writes it from scratch. */
export function buildOrderedMap(entries: [string, OrderedMapNode | string[][]][]): OrderedMapBranch {
    return new OrderedMapBranch(entries.map(([key, value]) => ({
        key,
        value: Array.isArray(value) ? OrderedMapLeaf.fromRecords(value) : value
    })))
}

/** A leaf reached by its key path. */
export interface LeafVisit {
    keys: string[]
    leaf: OrderedMapLeaf
}

/** Every leaf in file order, with its key path. */
export function* walkLeaves(node: OrderedMapNode, keys: string[] = []): Generator<LeafVisit> {
    if (node.kind === "leaf") {
        yield { keys, leaf: node }
        return
    }
    for (const entry of node.entries) yield* walkLeaves(entry.value, [...keys, entry.key])
}

// ---- CSV ----

export interface CsvDocument {
    records: string[][]
    /** "\n" in every original; kept so a re-encoded row matches its neighbours. */
    lineTerminator: "\n" | "\r\n"
    trailingNewline: boolean
}

/**
 * Parses CSV like Python's `csv.reader` (the decoder this ports): `,` separates cells, `"` quotes, `""` is a
 * quote inside a quoted cell, a quote inside an unquoted cell is literal, and `\n`, `\r\n` or `\r` ends a
 * record (an empty line is an empty record). Empty text has no records.
 */
export function parseCsv(text: string): CsvDocument {
    const records: string[][] = []
    const lineTerminator = text.includes("\r\n") ? "\r\n" : "\n"
    const trailingNewline = text.endsWith("\n") || text.endsWith("\r")
    let i = 0
    const n = text.length
    while (i < n) {
        const record: string[] = []
        if (text[i] === "\n" || text[i] === "\r") {
            // an empty line
            i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1
            records.push(record)
            continue
        }
        for (;;) {
            let cell = ""
            if (text[i] === '"') {
                i++
                for (;;) {
                    if (i >= n) break
                    const c = text[i]
                    if (c === '"') {
                        if (text[i + 1] === '"') {
                            cell += '"'
                            i += 2
                            continue
                        }
                        i++
                        break
                    }
                    cell += c
                    i++
                }
            }
            // unquoted cell, or what follows a closing quote up to the next separator
            const start = i
            while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") i++
            cell += text.slice(start, i)
            record.push(cell)
            if (i < n && text[i] === ",") {
                i++
                continue
            }
            break
        }
        if (i < n) i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1
        records.push(record)
    }
    return { records, lineTerminator, trailingNewline }
}

const NEEDS_QUOTES = /[",\r\n]/

/** Quotes a cell the way the originals do (minimal quoting, `"` doubled). */
export function encodeCsvCell(cell: string): string {
    return NEEDS_QUOTES.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

/** Encodes records back to CSV; `parseCsv(encodeCsv(doc))` gives the same records. */
export function encodeCsv(doc: CsvDocument | string[][]): string {
    const d: CsvDocument = Array.isArray(doc) ? { records: doc, lineTerminator: "\n", trailingNewline: false } : doc
    const lines = d.records.map(record =>
        // a lone empty cell must be quoted, or it would read back as an empty line
        record.length === 1 && record[0] === "" ? '""' : record.map(encodeCsvCell).join(","))
    const text = lines.join(d.lineTerminator)
    return d.trailingNewline && lines.length > 0 ? text + d.lineTerminator : text
}
