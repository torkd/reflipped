// Dev tool entry: `npm run i18n:glossary`, `npm run i18n:limits`, `npm run i18n:check`. See docs/i18n.md.
// Reads the master dumps of `scripts/extract_master.py` (JSON per table); the game text itself is never committed.

import fs from "node:fs"
import path from "node:path"
import { checkTranslation, type Issue } from "./checker"
import { conflicts, dedupe, minePairs, PAIR_SPECS, type GlossaryEntry } from "./glossary"
import { columnLimits } from "./stats"
import { masterRows, rowKey, sha256 } from "./text"

function parseArgs(argv: string[]): { cmd: string; opts: Map<string, string>; flags: Set<string> } {
    const [cmd = "", ...rest] = argv
    const opts = new Map<string, string>()
    const flags = new Set<string>()
    for (let i = 0; i < rest.length; i++) {
        if (!rest[i].startsWith("--")) continue
        const name = rest[i].slice(2)
        if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) opts.set(name, rest[++i])
        else flags.add(name)
    }
    return { cmd, opts, flags }
}

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8"))
const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 1) + "\n")
}
const dumpPath = (master: string, table: string) => path.join(master, `${table}.json`)

function glossary(opts: Map<string, string>): void {
    const master = opts.get("master") ?? "master-out"
    const out = opts.get("out") ?? "i18n/glossary/en.json"
    const all: GlossaryEntry[] = []
    for (const spec of PAIR_SPECS) {
        const entries = dedupe(minePairs(readJson(dumpPath(master, spec.table)), spec))
        console.log(`${spec.table}: ${entries.length} pairs (${spec.kind})`)
        all.push(...entries)
    }
    const multi = conflicts(all)
    console.log(`${all.length} entries, ${multi.size} Japanese terms with more than one English rendering`)
    // one entry per line keeps the file small and its diffs readable
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, `{"version":1,"lang":"en","entries":[\n${all.map((e) => JSON.stringify(e)).join(",\n")}\n]}\n`)
}

function limits(opts: Map<string, string>): void {
    const master = opts.get("master") ?? "master-out"
    const columns = readJson(opts.get("columns") ?? "i18n/columns.json").tables
    const out = opts.get("out") ?? "i18n/limits.json"
    const tables: Record<string, Record<string, number>> = {}
    for (const [table, info] of Object.entries<any>(columns)) {
        const file = dumpPath(master, table)
        if (!fs.existsSync(file)) continue
        const result = columnLimits(readJson(file), info.translate)
        if (Object.keys(result).length > 0) tables[table] = result
    }
    writeJson(out, { version: 1, percentile: 95, tables })
    console.log(`limits for ${Object.keys(tables).length} tables written to ${out}`)
}

function check(opts: Map<string, string>, flags: Set<string>): number {
    const lang = opts.get("lang") ?? "en"
    const dir = opts.get("dir") ?? path.join("i18n", lang, "master")
    const master = opts.get("master")
    const limitsFile = opts.get("limits") ?? "i18n/limits.json"
    const glossaryFile = opts.get("glossary") ?? `i18n/glossary/${lang}.json`
    const limitTables: Record<string, Record<string, number>> = fs.existsSync(limitsFile) ? readJson(limitsFile).tables : {}
    const terms: { ja: string; en: string }[] = fs.existsSync(glossaryFile)
        ? readJson(glossaryFile).entries.filter((e: GlossaryEntry) => e.kind !== "ui_string" && [...e.ja].length >= 3)
        : []
    if (!fs.existsSync(dir)) {
        console.log(`no translation files in ${dir}`)
        return 0
    }
    let errors = 0
    let warnings = 0
    let checked = 0
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
        const table = file.slice(0, -5).replace(/__/g, "/")
        const entries: Record<string, Record<string, { srcHash?: string; text: string }>> = readJson(path.join(dir, file))
        const source = new Map<string, string[]>()
        if (master && fs.existsSync(dumpPath(master, table)))
            for (const row of masterRows(readJson(dumpPath(master, table)))) source.set(rowKey(row.keyPath), row.cells)
        for (const [key, cols] of Object.entries(entries)) {
            for (const [col, entry] of Object.entries(cols)) {
                const src = source.get(key)?.[Number(col)]
                const issues: Issue[] = []
                if (master && src === undefined) issues.push({ severity: "warning", rule: "source", message: "row/column not found in the source dump" })
                else if (src !== undefined && entry.srcHash !== undefined && entry.srcHash !== sha256(src))
                    issues.push({ severity: "warning", rule: "stale", message: "srcHash does not match the current source cell" })
                issues.push(
                    ...checkTranslation(src ?? "", entry.text, {
                        maxLength: limitTables[table]?.[col],
                        glossary: terms,
                    }),
                )
                checked++
                for (const issue of issues) {
                    if (issue.severity === "error") errors++
                    else warnings++
                    if (issue.severity === "error" || !flags.has("quiet")) console.log(`${issue.severity} ${table} ${key} [${col}] ${issue.rule}: ${issue.message}`)
                }
            }
        }
    }
    console.log(`${checked} cells checked, ${errors} errors, ${warnings} warnings`)
    return errors > 0 || (flags.has("strict") && warnings > 0) ? 1 : 0
}

const { cmd, opts, flags } = parseArgs(process.argv.slice(2))
if (cmd === "glossary") glossary(opts)
else if (cmd === "limits") limits(opts)
else if (cmd === "check") process.exitCode = check(opts, flags)
else {
    console.error("usage: cli.ts glossary|limits|check [--master <dump dir>] [--out file] [--lang en] [--dir dir] [--strict] [--quiet]")
    process.exitCode = 2
}
