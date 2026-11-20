import { inflateRawSync } from "zlib";
import { CdnIndex, digestPath, regionCdnDir } from "./cdnIndex";
import { decodeOrderedMap } from "./orderedmap";
import { getItemCatalog } from "./catalog";

/** The atlas is an AMF3 dense array of dynamic objects. Reject other shapes and bound all references. */
export function readAtlas(bytes: Buffer): Map<string, { x: number, y: number, w: number, h: number, r: boolean }> {
    let pos = 0
    const strings: string[] = []
    const objects: unknown[] = []
    const byte = () => { if (pos >= bytes.length) throw new Error("truncated atlas"); return bytes[pos++] }
    const u29 = () => { let n = 0; for (let i = 0; i < 4; i++) { const b = byte(); n = i === 3 ? (n << 8) | b : (n << 7) | (b & 127); if (i === 3 || !(b & 128)) return n } return n }
    const str = (): string => { const ref = u29(); if (!(ref & 1)) { const s = strings[ref >> 1]; if (s === undefined) throw new Error("bad atlas string reference"); return s } const len = ref >> 1; if (!len) return ""; if (pos + len > bytes.length) throw new Error("truncated atlas string"); const s = bytes.toString("utf8", pos, pos + len); pos += len; strings.push(s); return s }
    const value = (depth = 0): any => {
        if (depth > 8) throw new Error("atlas nesting")
        const marker = byte()
        if (marker === 1) return null
        if (marker === 2) return false
        if (marker === 3) return true
        if (marker === 4) { const n = u29(); return n & 0x10000000 ? n - 0x20000000 : n }
        if (marker === 6) return str()
        if (marker === 9) { const ref = u29(); if (!(ref & 1)) return objects[ref >> 1]; const len = ref >> 1; if (len > 20000 || str() !== "") throw new Error("bad atlas array"); const a: unknown[] = []; objects.push(a); for (let i = 0; i < len; i++) a.push(value(depth + 1)); return a }
        if (marker === 10) { const traits = u29(); if (!(traits & 1)) return objects[traits >> 1]; if (traits === 11) { if (str() !== "") throw new Error("unsupported atlas class") } else if (traits !== 1) throw new Error("unsupported atlas object"); const o: Record<string, unknown> = Object.create(null); objects.push(o); for (;;) { const k = str(); if (!k) break; o[k] = value(depth + 1) } return o }
        throw new Error("unsupported atlas value")
    }
    const rows = value()
    if (!Array.isArray(rows)) throw new Error("bad atlas")
    const out = new Map<string, { x: number, y: number, w: number, h: number, r: boolean }>()
    for (const v of rows) if (v && typeof v.n === "string" && [v.x, v.y, v.w, v.h].every((n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 8192) && v.w > 0 && v.h > 0) out.set(v.n, { x: v.x, y: v.y, w: v.w, h: v.h, r: v.r === true })
    return out
}

type Rect = { x: number, y: number, w: number, h: number, r: boolean }
export class CatalogImages {
    private index: CdnIndex | null = null
    private readonly icons = new Map<string, Rect>()
    private readonly names = new Map<number, string>()
    private readonly present = new Set<string>()
    constructor(root = regionCdnDir()) {
        try {
            const index = CdnIndex.build(root)
            this.index = index
            const sheet = this.image("sheet")
            const sheetWidth = sheet?.readUInt32BE(16) ?? 0
            const sheetHeight = sheet?.readUInt32BE(20) ?? 0
            const atlasEntry = index.entry("item/sprite_sheet.atlas.amf3.deflate")
            const atlas = atlasEntry && atlasEntry.size <= 1_000_000 && atlasEntry.compressedSize <= 1_000_000 ? index.read("item/sprite_sheet.atlas.amf3.deflate") : undefined
            try {
                if (atlas) for (const [key, rect] of readAtlas(inflateRawSync(atlas, { maxOutputLength: 2_000_000 }))) this.icons.set(key, rect)
            } catch { /* individual portraits still work without a usable atlas */ }
            for (const [table, col, prefix] of [["item/item", 2, "items"], ["item/equipment", 6, "equipment"], ["character/character", 0, "units"]] as const) {
                const masterEntry = index.entry(`master/${table}.orderedmap`)
                const raw = masterEntry && masterEntry.size <= 20_000_000 && masterEntry.compressedSize <= 20_000_000 ? index.readMaster(table) : undefined; if (!raw) continue
                const map = decodeOrderedMap(raw); if (map.kind !== "map") continue
                const allowed = new Set(getItemCatalog()[prefix].map(v => v.id))
                for (const { key, value } of map.entries) {
                    const id = Number(key); if (!allowed.has(id) || value.kind !== "leaf") continue
                    const path = value.getCell(0, col); if (!path || !/^[a-z0-9_/-]+$/.test(path)) continue
                    if (prefix === "units") { if (!path.includes("/")) this.names.set(id, path) }
                    else { const rect = this.icons.get(path); if (rect && rect.w <= 64 && rect.h <= 64 && rect.x + rect.w <= sheetWidth && rect.y + rect.h <= sheetHeight) this.present.add(`${prefix}/${id}`) }
                }
                if (prefix !== "units") {
                    for (const { key, value } of map.entries) {
                        const id = Number(key); if (!allowed.has(id) || value.kind !== "leaf") continue
                        const path = value.getCell(0, col); const rect = path && this.icons.get(path)
                        if (rect && this.present.has(`${prefix}/${id}`)) this.icons.set(`${prefix}/${id}`, rect)
                    }
                }
            }
        } catch { /* missing or unreadable CDN: leave picker text-only */ }
    }
    rect(kind: string, id: number): Rect | undefined { return this.present.has(`${kind}/${id}`) ? this.icons.get(`${kind}/${id}`) : undefined }
    image(kind: string, id?: number): Buffer | undefined {
        if (!this.index) return undefined
        let asset: string
        if (kind === "sheet") asset = "item/sprite_sheet.png"
        else if (kind === "units" && id !== undefined && this.names.has(id)) asset = `character/${this.names.get(id)}/ui/square_132_132_0.png`
        else return undefined
        const digest = digestPath(asset).replace("production/upload/", "")
        const entry = this.index.entryByMember(`production/${kind === "sheet" ? "upload" : "medium_upload"}/${digest}`)
        if (!entry || entry.size > 8_000_000 || entry.compressedSize > 8_000_000) return undefined
        let bytes: Buffer | undefined
        try { bytes = this.index.readMember(entry.member) } catch { return undefined }
        if (!bytes || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 112, 110, 103, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
        if (!width || !height || width > 8192 || height > 8192) return undefined
        bytes.write("PNG", 1, "ascii")
        return bytes
    }
}
