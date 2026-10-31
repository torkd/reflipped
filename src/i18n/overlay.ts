/**
 * Translation overlay build (I18N-3; docs/i18n.md, "Overlay"). Reads the translation files of one language,
 * applies the entries that still match their source and pass the status floor and the checker, and writes
 * `<out>/<lang>/`:
 *  - `i18n-<lang>-<hash>.zip`: patched copies of only the tables, scenarios and images that change, each under
 *    its hashed CDN member name (`production/upload/xx/…`), laid out like the original archives;
 *  - `restore-<hash>.zip`: the original bytes of every member any build of this folder has put in an overlay,
 *    so a device that drops an entry, or the whole overlay, gets the originals back;
 *  - `manifest.json`: the two archives, what each holds and a report of what was skipped.
 * The same inputs give the same bytes (sorted entries, fixed zip timestamps, no build time in the manifest).
 *
 * `npm run i18n:build` (`src/i18n/build.ts`) is the command line; `src/lib/assetLayers.ts` serves the result.
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";
import { CdnIndex, digestPath, masterAssetPath } from "../lib/cdnIndex";
import { decodeOrderedMap } from "../lib/orderedmap";
import { writeZip } from "../lib/zipWriter";
import { checkTranslation, Issue } from "../lib/i18n/checker";
import { CellPatch, getCell, patchTable, srcHash } from "./cells";

export const STATUSES = ["machine", "reviewed", "official"] as const
export type TranslationStatus = typeof STATUSES[number]
/**
 * Default status floor: every status ships. The overlay passed its device test (I18N-5) and is on by default, the
 * checker still blocks broken entries, and a machine translation reads better than the kana-only text the
 * English client shows for untranslated Japanese. Raise it with `I18N_MIN_STATUS=reviewed`.
 */
export const DEFAULT_MIN_STATUS: TranslationStatus = "machine"

/** Image folders in the CDN, in lookup order when an image entry doesn't name one. */
export const IMAGE_FOLDERS = ["upload", "medium_upload", "android_upload", "android_medium_upload", "android_small_upload"]

export const MANIFEST_NAME = "manifest.json"

export interface OverlayBuildOptions {
    lang: string
    /** Folder holding `<lang>/master`, `<lang>/story`, `<lang>/images.json` (default `i18n`). */
    i18nDir: string
    /** The region folder of the CDN (`.cdn/en`), or an index already built from it. */
    cdn: string | CdnIndex
    /** The CDN folder itself (`CDN_DIR`); the output must not be inside it. */
    cdnDir?: string
    /** Overlay root (`.cdn-overlay`); the build writes `<out>/<lang>/`. */
    outDir: string
    minStatus?: TranslationStatus
    /** Base folder for relative `file` paths in `images.json`. */
    imagesDir?: string
    /** `columns.json`, `limits.json` and the glossary; null skips that check, undefined looks for the default. */
    columnsFile?: string | null
    limitsFile?: string | null
    glossaryFile?: string | null
    /** Only compute the manifest, write nothing. */
    dryRun?: boolean
}

export interface OverlayArchive {
    file: string
    size: number
    /** hex SHA-256 of the archive */
    sha256: string
}

export interface OverlayEntry {
    kind: "master" | "story" | "image"
    /** Asset path (`master/item/item.orderedmap`, `dynamic/home_banner/….png`). */
    asset: string
    /** Member name in the archives (`production/upload/xx/…`). */
    member: string
    /** Table or scenario name (`item/item`, `story/…/scenario`). */
    table?: string
    /** Translation file the entries came from, relative to the language folder. */
    source: string
    /** Cells applied (tables and scenarios). */
    cells?: number
    sha256: string
    originalSha256: string
}

export interface RestoredMember {
    kind: OverlayEntry["kind"]
    asset: string
    member: string
}

export interface ReportItem {
    file: string
    row?: string
    col?: number
    asset?: string
    reason: string
}

export interface OverlayReport {
    files: number
    entries: number
    applied: number
    /** Entries below the status floor, or without a known status. */
    belowStatus: number
    /** `srcHash` doesn't match the current source: the source changed, the entry needs a new look. */
    stale: (ReportItem & { currentSrcHash: string })[]
    /** Table, scenario, row, column or image not in the CDN. */
    missing: ReportItem[]
    /** Entries skipped: malformed, checker errors, a column that isn't translatable. */
    errors: ReportItem[]
    /** Checker warnings of entries that were applied. */
    warnings: ReportItem[]
    /** Members the restore archive should hold but whose original isn't in the CDN (left out). */
    restoreMissing: string[]
}

export interface OverlayManifest {
    format: 1
    lang: string
    minStatus: TranslationStatus
    overlay: OverlayArchive | null
    restore: OverlayArchive | null
    entries: OverlayEntry[]
    /** Everything the restore archive holds: every member any overlay of this folder has carried. */
    restored: RestoredMember[]
    report: OverlayReport
}

export interface OverlayBuildResult {
    manifest: OverlayManifest
    dir: string
    /** Old archives deleted from the folder. */
    pruned: string[]
}

interface TranslationEntry {
    srcHash?: unknown
    text?: unknown
    status?: unknown
    note?: unknown
}

interface ImageEntry {
    srcHash?: unknown
    file?: unknown
    status?: unknown
    folder?: unknown
    note?: unknown
}

interface ColumnsFile {
    tables: Record<string, { translate?: number[], reading?: number[] }>
}

const sha256Hex = (data: Buffer): string => createHash("sha256").update(data).digest("hex")

export function parseStatus(value: string | undefined): TranslationStatus | undefined {
    return STATUSES.find(s => s === value)
}

const statusRank = (status: unknown): number => STATUSES.indexOf(status as TranslationStatus)

/** The archive member of an asset in an image folder: `production/<folder>/<h[:2]>/<h[2:]>`. */
export function memberIn(assetPath: string, folder = "upload"): string {
    return digestPath(assetPath).replace(/^production\/upload\//, `production/${folder}/`)
}

function readJson(file: string): unknown {
    return JSON.parse(readFileSync(file, "utf8"))
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `sha256:<hex>` or a bare hex digest, lower case; undefined if neither. */
function normalizeHash(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const hex = value.toLowerCase().replace(/^sha256:/, "")
    return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined
}

/** Translation files of a language, sorted: [file relative to the language folder, table name, kind]. */
function translationFiles(langDir: string): { file: string, table: string, kind: "master" | "story" }[] {
    const out: { file: string, table: string, kind: "master" | "story" }[] = []
    const master = path.join(langDir, "master")
    if (existsSync(master)) {
        for (const name of readdirSync(master).sort()) {
            if (!name.endsWith(".json")) continue
            out.push({ file: `master/${name}`, table: name.slice(0, -5).replace(/__/g, "/"), kind: "master" })
        }
    }
    const story = path.join(langDir, "story")
    const walk = (dir: string, rel: string) => {
        for (const name of readdirSync(dir).sort()) {
            const full = path.join(dir, name)
            const relName = rel ? `${rel}/${name}` : name
            if (statSync(full).isDirectory()) walk(full, relName)
            else if (name.endsWith(".json")) out.push({ file: `story/${relName}`, table: `story/${relName.slice(0, -5)}`, kind: "story" })
        }
    }
    if (existsSync(story)) walk(story, "")
    return out
}

/** `explicit` if given, null if explicitly off, else the first default that exists. */
function pickFile(explicit: string | null | undefined, defaults: string[]): string | null {
    if (explicit === null) return null
    if (explicit !== undefined) return explicit
    return defaults.find(f => existsSync(f)) ?? null
}

function isInside(child: string, parent: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child))
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function issueItems(issues: Issue[], at: Omit<ReportItem, "reason">): { errors: ReportItem[], warnings: ReportItem[] } {
    const errors: ReportItem[] = []
    const warnings: ReportItem[] = []
    for (const issue of issues) {
        const item = { ...at, reason: `${issue.rule}: ${issue.message}` }
        if (issue.severity === "error") errors.push(item)
        else warnings.push(item)
    }
    return { errors, warnings }
}

/** The PNG width and height (IHDR), if the data looks like a PNG with either magic case. */
function pngSize(data: Buffer): [number, number] | undefined {
    if (data.length < 24 || data[0] !== 0x89 || data.subarray(1, 4).toString("latin1").toLowerCase() !== "png") return undefined
    return [data.readUInt32BE(16), data.readUInt32BE(20)]
}

/** Reads the manifest of a built overlay folder (`<out>/<lang>`), or undefined. */
export function readManifest(dir: string): OverlayManifest | undefined {
    const file = path.join(dir, MANIFEST_NAME)
    if (!existsSync(file)) return undefined
    const manifest = readJson(file) as OverlayManifest
    if (!isObject(manifest) || manifest.format !== 1) throw new Error(`${file}: not an overlay manifest`)
    return manifest
}

export function buildOverlay(options: OverlayBuildOptions): OverlayBuildResult {
    const lang = options.lang
    if (!/^[a-z]{2}$/.test(lang)) throw new Error(`bad language: ${lang}`)
    const minStatus = options.minStatus ?? DEFAULT_MIN_STATUS
    const langDir = path.join(options.i18nDir, lang)
    const outDir = path.join(options.outDir, lang)
    const index = typeof options.cdn === "string" ? CdnIndex.build(options.cdn) : options.cdn
    for (const cdn of [index.root, options.cdnDir].filter((d): d is string => !!d)) {
        if (isInside(outDir, cdn)) throw new Error(`the overlay (${outDir}) must not be inside the CDN folder (${cdn})`)
    }

    // the checker's inputs: the column map, the length limits and the glossary (I18N-2)
    const repoI18n = path.join(__dirname, "..", "..", "i18n")
    const defaults = (name: string) => [path.join(options.i18nDir, name), path.join(repoI18n, name)]
    const columnsFile = pickFile(options.columnsFile, defaults("columns.json"))
    const limitsFile = pickFile(options.limitsFile, defaults("limits.json"))
    const glossaryFile = pickFile(options.glossaryFile, defaults(`glossary/${lang}.json`))
    const columns = columnsFile ? (readJson(columnsFile) as ColumnsFile).tables : undefined
    const limits: Record<string, Record<string, number>> = limitsFile ? (readJson(limitsFile) as { tables: Record<string, Record<string, number>> }).tables : {}
    const glossary: { ja: string, en: string }[] = glossaryFile
        ? ((readJson(glossaryFile) as { entries: { ja: string, en: string, kind: string }[] }).entries)
            .filter(e => e.kind !== "ui_string" && [...e.ja].length >= 3)
        : []

    const report: OverlayReport = { files: 0, entries: 0, applied: 0, belowStatus: 0, stale: [], missing: [], errors: [], warnings: [], restoreMissing: [] }
    const files = new Map<string, Buffer>()
    const entries: OverlayEntry[] = []

    // ---- tables and scenarios ----
    for (const { file, table, kind } of translationFiles(langDir)) {
        report.files++
        const at = { file }
        let content: unknown
        try {
            content = readJson(path.join(langDir, file))
        } catch (error) {
            report.errors.push({ ...at, reason: `unreadable: ${(error as Error).message}` })
            continue
        }
        if (!isObject(content)) {
            report.errors.push({ ...at, reason: "not an object of rows" })
            continue
        }
        const asset = masterAssetPath(table)
        const original = index.read(asset)
        const rows = Object.keys(content).sort()
        const count = rows.reduce((n, row) => n + (isObject(content[row]) ? Object.keys(content[row] as object).length : 1), 0)
        report.entries += count
        if (!original) {
            report.missing.push({ ...at, asset, reason: `${table} is not in the CDN (${count} entries)` })
            continue
        }
        const root = decodeOrderedMap(original)
        const spec = kind === "master" ? columns?.[table] : undefined
        if (kind === "master" && columns && !spec) report.warnings.push({ ...at, reason: `${table} is not in columns.json` })
        const patches: CellPatch[] = []
        for (const row of rows) {
            const cols = content[row]
            if (!isObject(cols)) {
                report.errors.push({ ...at, row, reason: "row is not an object of columns" })
                continue
            }
            for (const colKey of Object.keys(cols).sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1))) {
                const entry = cols[colKey] as TranslationEntry
                const col = Number(colKey)
                const here = { ...at, row, col }
                if (!/^\d+$/.test(colKey) || !isObject(entry) || typeof entry.text !== "string" || typeof entry.srcHash !== "string") {
                    report.errors.push({ ...here, reason: "malformed entry (needs a column number, text and srcHash)" })
                    continue
                }
                if (statusRank(entry.status) < 0 || statusRank(entry.status) < statusRank(minStatus)) {
                    report.belowStatus++
                    continue
                }
                const current = getCell(root, table, row, col)
                if (current === undefined) {
                    report.missing.push({ ...here, reason: "row or column not in the source" })
                    continue
                }
                const currentHash = srcHash(current)
                if (entry.srcHash !== currentHash) {
                    report.stale.push({ ...here, reason: "srcHash does not match the current source", currentSrcHash: currentHash })
                    continue
                }
                if (spec?.reading?.includes(col)) {
                    report.errors.push({ ...here, reason: "hidden reading column (stays Japanese, see columns.json)" })
                    continue
                }
                if (spec && !(spec.translate ?? []).includes(col)) {
                    report.errors.push({ ...here, reason: "column is not translatable in columns.json" })
                    continue
                }
                const issues = checkTranslation(current, entry.text, {
                    kind: kind === "story" ? "scenario" : "text",
                    maxLength: kind === "master" ? limits[table]?.[colKey] : undefined,
                    glossary
                })
                const { errors, warnings } = issueItems(issues, here)
                if (errors.length > 0) {
                    report.errors.push(...errors)
                    continue
                }
                report.warnings.push(...warnings)
                patches.push({ row, col, text: entry.text, srcHash: entry.srcHash })
            }
        }
        if (patches.length === 0) continue
        const result = patchTable(original, table, patches)
        report.applied += result.applied.length
        if (result.applied.length === 0 || result.data.equals(original)) continue
        const member = digestPath(asset)
        files.set(member, result.data)
        entries.push({
            kind, asset, member, table, source: file, cells: result.applied.length,
            sha256: sha256Hex(result.data), originalSha256: sha256Hex(original)
        })
    }

    // ---- images (I18N-7): whole replacement files ----
    const imagesFile = path.join(langDir, "images.json")
    if (existsSync(imagesFile)) {
        const file = "images.json"
        report.files++
        let images: unknown
        try {
            images = readJson(imagesFile)
        } catch (error) {
            report.errors.push({ file, reason: `unreadable: ${(error as Error).message}` })
            images = {}
        }
        if (!isObject(images)) {
            report.errors.push({ file, reason: "not an object of asset paths" })
            images = {}
        }
        for (const asset of Object.keys(images as object).sort()) {
            const entry = (images as Record<string, unknown>)[asset] as ImageEntry
            const here = { file, asset }
            report.entries++
            const wanted = normalizeHash(isObject(entry) ? entry.srcHash : undefined)
            if (!isObject(entry) || !wanted || typeof entry.file !== "string" || (entry.folder !== undefined && typeof entry.folder !== "string")) {
                report.errors.push({ ...here, reason: "malformed entry (needs srcHash, file and status)" })
                continue
            }
            if (statusRank(entry.status) < 0 || statusRank(entry.status) < statusRank(minStatus)) {
                report.belowStatus++
                continue
            }
            const folders = typeof entry.folder === "string" ? [entry.folder] : IMAGE_FOLDERS
            const member = folders.map(f => memberIn(asset, f)).find(m => index.entryByMember(m))
            const original = member ? index.readMember(member) : undefined
            if (!member || !original) {
                report.missing.push({ ...here, reason: `not in the CDN (${folders.join(", ")})` })
                continue
            }
            const currentHash = sha256Hex(original)
            if (currentHash !== wanted) {
                report.stale.push({ ...here, reason: "srcHash does not match the current image", currentSrcHash: `sha256:${currentHash}` })
                continue
            }
            if (!path.isAbsolute(entry.file) && !options.imagesDir) {
                report.errors.push({ ...here, reason: `relative file ${entry.file} needs --images-dir` })
                continue
            }
            const replacementPath = path.resolve(options.imagesDir ?? "", entry.file)
            if (!existsSync(replacementPath)) {
                report.errors.push({ ...here, reason: `replacement ${replacementPath} not found` })
                continue
            }
            const replacement = readFileSync(replacementPath)
            if (!replacement.subarray(0, 4).equals(original.subarray(0, 4))) {
                report.errors.push({ ...here, reason: "replacement doesn't start like the original (use the encoded .asset output, same PNG magic)" })
                continue
            }
            const [ow, oh] = pngSize(original) ?? []
            const [rw, rh] = pngSize(replacement) ?? []
            if (ow !== rw || oh !== rh) {
                report.errors.push({ ...here, reason: `size ${rw}x${rh} differs from the original's ${ow}x${oh}` })
                continue
            }
            if (files.has(member)) {
                report.errors.push({ ...here, reason: "member already in the overlay" })
                continue
            }
            report.applied++
            if (replacement.equals(original)) continue
            files.set(member, replacement)
            entries.push({ kind: "image", asset, member, source: file, sha256: sha256Hex(replacement), originalSha256: currentHash })
        }
    }

    // ---- restore: every member this folder's overlays ever held ----
    const previous = readManifest(outDir)
    const restoredByMember = new Map<string, RestoredMember>()
    for (const r of previous?.restored ?? []) restoredByMember.set(r.member, { kind: r.kind, asset: r.asset, member: r.member })
    for (const e of entries) restoredByMember.set(e.member, { kind: e.kind, asset: e.asset, member: e.member })
    const restored = [...restoredByMember.values()].sort((a, b) => (a.member < b.member ? -1 : 1))
    const restoreFiles: { name: string, data: Buffer }[] = []
    for (const r of restored) {
        const data = index.readMember(r.member)
        if (data) restoreFiles.push({ name: r.member, data })
        else report.restoreMissing.push(r.member)
    }

    entries.sort((a, b) => (a.member < b.member ? -1 : 1))
    const archive = (prefix: string, zipFiles: { name: string, data: Buffer }[]) => {
        if (zipFiles.length === 0) return null
        const data = writeZip(zipFiles)
        const hash = sha256Hex(data)
        return { info: { file: `${prefix}-${hash.slice(0, 16)}.zip`, size: data.length, sha256: hash }, data }
    }
    const overlay = archive(`i18n-${lang}`, [...files].map(([name, data]) => ({ name, data })))
    const restore = archive("restore", restoreFiles)
    const manifest: OverlayManifest = {
        format: 1, lang, minStatus,
        overlay: overlay?.info ?? null,
        restore: restore?.info ?? null,
        entries, restored, report
    }
    if (options.dryRun) return { manifest, dir: outDir, pruned: [] }

    // write the archives, then the manifest (the server reads only what the manifest names)
    mkdirSync(outDir, { recursive: true })
    for (const a of [overlay, restore]) {
        if (!a) continue
        const target = path.join(outDir, a.info.file)
        if (existsSync(target) && statSync(target).size === a.info.size) continue
        writeFileSync(target + ".tmp", a.data)
        renameSync(target + ".tmp", target)
    }
    writeFileSync(path.join(outDir, MANIFEST_NAME + ".tmp"), JSON.stringify(manifest, null, 1) + "\n")
    renameSync(path.join(outDir, MANIFEST_NAME + ".tmp"), path.join(outDir, MANIFEST_NAME))

    // keep this build's and the previous build's archives (a running server still names those until it restarts)
    const keep = new Set([manifest.overlay?.file, manifest.restore?.file, previous?.overlay?.file, previous?.restore?.file])
    const archiveName = new RegExp(`^(?:i18n-${lang}|restore)-[0-9a-f]+\\.zip$`)
    const pruned: string[] = []
    for (const name of readdirSync(outDir).sort()) {
        if (archiveName.test(name) && !keep.has(name)) {
            rmSync(path.join(outDir, name))
            pruned.push(name)
        }
    }
    return { manifest, dir: outDir, pruned }
}
