/**
 * `npm run i18n:extract` (I18N-1): lists every master-table and scenario cell that holds Japanese, with
 * context, as JSON in a work directory outside the repository. See docs/i18n.md, "Extract".
 *
 *   npm run i18n:extract -- [--out DIR] [--cdn DIR] [--region en] [--max-version 2.1.125]
 *                           [--columns FILE | --no-columns] [--tables a/b,c/d] [--no-scenarios]
 *                           [--include-punctuation]
 * In the Docker image (no tsc there): node out/i18n/extract.js [options].
 *
 * Tables come from `src/i18n/masterTables.json` (the paths the client's master loader names), plus every
 * orderedmap a table cell names (`story/…/scenario` paths, 1,636 of them in the en CDN). Never commit the
 * output: it is game text.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { CdnIndex, formatAssetVersion, masterAssetPath, masterTableName, regionCdnDir } from "../lib/cdnIndex";
import { decodeOrderedMap, OrderedMapNode } from "../lib/orderedmap";
import { hasJapanese, hasOnlyCjkPunctuation, srcHash, tableCells, TableCell } from "./cells";
import masterTables from "./masterTables.json";

interface ColumnsFile {
    version: number
    tables: Record<string, { translate?: number[], reading?: number[], note?: string }>
}

interface Options {
    out: string
    cdn: string
    region: string
    maxVersion?: string
    columns: string | null
    tables: string[]
    scenarios: boolean
    punctuation: boolean
}

export interface ExtractedCell {
    row: string
    col: number
    text: string
    srcHash: string
    /** `translate` (named in columns.json) or `unclassified` (table or column not classified yet). */
    class: "translate" | "unclassified" | "punctuation"
    /** Other text cells of the same record (Japanese or English prose), by column. */
    context?: Record<string, string>
    /** Scenarios: the command (col 0) and, for a line, the speaker id (col 4) and name. */
    command?: string
    speaker?: { id: string, name?: string }
}

export interface ExtractedFile {
    version: 1
    kind: "master" | "scenario"
    table: string
    source: string
    assetVersion: string
    classified: boolean
    referencedBy?: { table: string, row: string, col: number }[]
    cells: ExtractedCell[]
}

interface TableSummary {
    table: string
    kind: "master" | "scenario"
    assetVersion: string
    classified: boolean
    cells: number
    unique: number
    characters: number
    /** Japanese cells left out: in reading columns, or (classified tables) in other unlisted columns. */
    skippedReading: number
    unlistedColumns?: Record<string, number>
    punctuationOnly: number
}

const PATH_LIKE = /^[a-z0-9_]+(?:\/[a-z0-9_]+)+$/
const CONTEXT_LIMIT = 10
const CONTEXT_LENGTH = 200

function usage(message?: string): never {
    if (message) console.error(message)
    console.error("usage: npm run i18n:extract -- [--out DIR] [--cdn DIR] [--region en] [--max-version X]\n" +
        "         [--columns FILE | --no-columns] [--tables a/b,c/d] [--no-scenarios] [--include-punctuation]")
    process.exit(2)
}

function parseArgs(argv: string[]): Options {
    const opts: Options = {
        out: path.join(os.tmpdir(), "reflipped-i18n-extract"),
        cdn: process.env.CDN_DIR || ".cdn",
        region: "en",
        columns: "i18n/columns.json",
        tables: [],
        scenarios: true,
        punctuation: false
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const value = () => argv[++i] ?? usage(`${arg} needs a value`)
        switch (arg) {
            case "--out": opts.out = value(); break
            case "--cdn": opts.cdn = value(); break
            case "--region": opts.region = value(); break
            case "--max-version": opts.maxVersion = value(); break
            case "--columns": opts.columns = value(); break
            case "--no-columns": opts.columns = null; break
            case "--tables": opts.tables.push(...value().split(",").filter(Boolean).map(masterTableName)); break
            case "--no-scenarios": opts.scenarios = false; break
            case "--include-punctuation": opts.punctuation = true; break
            case "-h": case "--help": usage()
            default: usage(`unknown option ${arg}`)
        }
    }
    return opts
}

function loadColumns(file: string | null): ColumnsFile | null {
    if (!file || !existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ColumnsFile
    if (parsed.version !== 1 || typeof parsed.tables !== "object") throw new Error(`${file}: expected {"version":1,"tables":{…}}`)
    return parsed
}

/** Other cells of the record that read as text (by column), so a translator sees the row's name, English text, etc. */
function rowContext(cell: TableCell): Record<string, string> | undefined {
    const context: Record<string, string> = {}
    let n = 0
    const first = cell.col - cell.indexInRecord
    cell.recordCells.forEach((text, i) => {
        if (i === cell.indexInRecord || n >= CONTEXT_LIMIT || text === "") return
        if (!hasJapanese(text) && !/[A-Za-z]{2,}[^\n]*\s/.test(text)) return
        context[first + i] = text.length > CONTEXT_LENGTH ? text.slice(0, CONTEXT_LENGTH) + "…" : text
        n++
    })
    return n > 0 ? context : undefined
}

/** The file a table's or scenario's extract (and translation) goes to, relative to the language folder. */
export function translationFileName(kind: "master" | "scenario", table: string): string {
    return kind === "master"
        ? path.join("master", table.replace(/\//g, "__") + ".json")
        : path.join("story", table.replace(/^story\//, "") + ".json")
}

function main() {
    const opts = parseArgs(process.argv.slice(2))
    const started = Date.now()
    const root = regionCdnDir(opts.region, opts.cdn)
    const index = CdnIndex.build(root, { maxVersion: opts.maxVersion })
    const columns = loadColumns(opts.columns)
    const outDir = path.resolve(opts.out)
    if (outDir.startsWith(process.cwd() + path.sep)) {
        console.warn(`warning: ${outDir} is inside the working directory; never commit extracted game text`)
    }
    console.error(`indexed ${index.stats.members} assets from ${index.stats.archives} archives in ${root}` +
        (columns ? `; columns from ${opts.columns}` : "; no columns.json, every column listed"))

    const tableNames = [...new Set([...(opts.tables.length ? opts.tables : (masterTables as { tables: string[] }).tables)])]
    const listed = new Set(tableNames)
    const referenced = new Map<string, { table: string, row: string, col: number }[]>()
    const files: ExtractedFile[] = []
    const summaries: TableSummary[] = []
    const missing: string[] = []
    let speakers: Map<string, string> | undefined

    const process_ = (table: string, kind: "master" | "scenario", node: OrderedMapNode, assetVersion: string) => {
        const spec = kind === "master" ? columns?.tables[table] : undefined
        const translate = new Set(spec?.translate ?? [])
        const reading = new Set(spec?.reading ?? [])
        const summary: TableSummary = {
            table, kind, assetVersion, classified: spec !== undefined,
            cells: 0, unique: 0, characters: 0, skippedReading: 0, punctuationOnly: 0
        }
        const file: ExtractedFile = {
            version: 1, kind, table, source: masterAssetPath(table), assetVersion, classified: spec !== undefined, cells: []
        }
        const unique = new Set<string>()
        for (const cell of tableCells(node, table)) {
            if (cell.text === "") continue
            if (kind === "master" && PATH_LIKE.test(cell.text) && !listed.has(cell.text) && index.has(masterAssetPath(cell.text))) {
                const refs = referenced.get(cell.text) ?? []
                refs.push({ table, row: cell.row, col: cell.col })
                referenced.set(cell.text, refs)
            }
            const japanese = hasJapanese(cell.text)
            const punctuation = !japanese && hasOnlyCjkPunctuation(cell.text)
            if (!japanese && !punctuation) continue
            if (reading.has(cell.col)) {
                if (japanese) summary.skippedReading++
                continue
            }
            if (spec && !translate.has(cell.col)) {
                if (japanese) {
                    summary.unlistedColumns ??= {}
                    summary.unlistedColumns[cell.col] = (summary.unlistedColumns[cell.col] ?? 0) + 1
                }
                continue
            }
            if (punctuation) {
                summary.punctuationOnly++
                if (!opts.punctuation) continue
            } else {
                summary.cells++
                summary.characters += [...cell.text].length
                unique.add(cell.text)
            }
            const entry: ExtractedCell = {
                row: cell.row, col: cell.col, text: cell.text, srcHash: srcHash(cell.text),
                class: punctuation ? "punctuation" : spec ? "translate" : "unclassified"
            }
            if (kind === "scenario") {
                entry.command = cell.recordCells[0]
                const id = cell.recordCells[4]
                if (entry.command === "0" && id) entry.speaker = { id, name: speakers?.get(id) }
            }
            const context = rowContext(cell)
            if (context) entry.context = context
            file.cells.push(entry)
        }
        summary.unique = unique.size
        summaries.push(summary)
        if (file.cells.length) files.push(file)
    }

    for (const table of tableNames) {
        const entry = index.entry(masterAssetPath(table))
        if (!entry) {
            missing.push(table)
            continue
        }
        const node = decodeOrderedMap(index.read(masterAssetPath(table))!)
        if (table === "story/story_character") speakers = speakerNames(node)
        process_(table, "master", node, formatAssetVersion(entry.version))
    }
    if (opts.scenarios) {
        if (!speakers) {
            const data = index.readMaster("story/story_character")
            if (data) speakers = speakerNames(decodeOrderedMap(data))
        }
        // a referenced scenario's speaker names are only known once story_character is read, hence the second pass
        for (const [table, refs] of [...referenced].sort(([a], [b]) => a.localeCompare(b))) {
            const entry = index.entry(masterAssetPath(table))!
            const kind = /^story\/.+\/scenario$/.test(table) ? "scenario" : "master"
            process_(table, kind, decodeOrderedMap(index.read(masterAssetPath(table))!), formatAssetVersion(entry.version))
            const file = files.find(f => f.table === table)
            if (file) file.referencedBy = refs
        }
    }

    // write: replace a previous extract in the same folder, nothing else
    mkdirSync(outDir, { recursive: true })
    if (existsSync(path.join(outDir, "summary.json"))) {
        for (const sub of ["master", "story"]) rmSync(path.join(outDir, sub), { recursive: true, force: true })
    }
    for (const file of files) {
        const target = path.join(outDir, translationFileName(file.kind, file.table))
        mkdirSync(path.dirname(target), { recursive: true })
        writeFileSync(target, JSON.stringify(file, null, 2) + "\n")
    }
    const withText = summaries.filter(s => s.cells > 0)
    const masters = withText.filter(s => s.kind === "master")
    const scenarios = withText.filter(s => s.kind === "scenario")
    const uniqueAll = new Set(files.filter(f => f.kind === "master").flatMap(f => f.cells.filter(c => c.class !== "punctuation").map(c => c.text)))
    const totals = {
        tables: masters.length,
        cells: masters.reduce((n, s) => n + s.cells, 0),
        uniqueStrings: uniqueAll.size,
        characters: masters.reduce((n, s) => n + s.characters, 0),
        scenarios: scenarios.length,
        scenarioCells: scenarios.reduce((n, s) => n + s.cells, 0),
        scenarioCharacters: scenarios.reduce((n, s) => n + s.characters, 0),
        scenariosScanned: summaries.filter(s => s.kind === "scenario").length,
        punctuationOnlyCells: summaries.reduce((n, s) => n + s.punctuationOnly, 0),
        skippedReadingCells: summaries.reduce((n, s) => n + s.skippedReading, 0),
        unclassifiedTables: columns ? masters.filter(s => !s.classified).map(s => s.table) : undefined
    }
    const summary = {
        version: 1,
        generated: new Date().toISOString(),
        cdn: root,
        region: opts.region,
        maxVersion: opts.maxVersion,
        columns: columns ? path.resolve(opts.columns!) : null,
        totals,
        missingTables: missing,
        tables: summaries.filter(s => s.cells > 0 || s.unlistedColumns || s.punctuationOnly > 0)
            .sort((a, b) => b.cells - a.cells || a.table.localeCompare(b.table))
    }
    writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n")

    console.log(`Japanese cells: ${totals.cells} in ${totals.tables} tables (${totals.uniqueStrings} unique, ${totals.characters} characters); ` +
        `${totals.scenarioCells} in ${totals.scenarios} of ${totals.scenariosScanned} scenarios (${totals.scenarioCharacters} characters)`)
    console.log(`left out: ${totals.skippedReadingCells} in reading columns, ${totals.punctuationOnlyCells} with only CJK punctuation` +
        (opts.punctuation ? " (listed)" : ""))
    if (missing.length) console.log(`not in this CDN: ${missing.length} tables`)
    if (totals.unclassifiedTables?.length) console.log(`unclassified tables with Japanese: ${totals.unclassifiedTables.join(", ")}`)
    console.log(`wrote ${files.length} files and summary.json to ${outDir} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

/** story_character row key -> display name (col 0). */
function speakerNames(node: OrderedMapNode): Map<string, string> {
    const names = new Map<string, string>()
    for (const cell of tableCells(node, "story/story_character")) {
        if (cell.col === 0) names.set(cell.row, cell.text)
    }
    return names
}

if (require.main === module) main()
