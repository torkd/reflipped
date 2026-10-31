/**
 * `npm run i18n:build` (I18N-3): builds the translation overlay of a language into `.cdn-overlay/<lang>/`
 * (`src/i18n/overlay.ts`; docs/i18n.md, "Overlay").
 *
 *   npm run i18n:build -- [--lang en] [--i18n-dir i18n] [--out .cdn-overlay] [--cdn DIR] [--region en]
 *                         [--max-version 2.1.125] [--min-status machine|reviewed|official]
 *                         [--images-dir DIR] [--columns FILE | --no-columns] [--limits FILE | --no-limits]
 *                         [--glossary FILE | --no-glossary] [--dry-run] [--strict] [--verbose]
 * In the Docker image (no tsc there): node out/i18n/build.js [options].
 *
 * `I18N_MIN_STATUS` and `CDN_OVERLAY_DIR` give the defaults of `--min-status` and `--out`. Restart Reflipped
 * afterwards; it serves the overlay only with `I18N=on`.
 */
import path from "path";
import { CdnIndex, regionCdnDir } from "../lib/cdnIndex";
import { buildOverlay, DEFAULT_MIN_STATUS, OverlayBuildOptions, parseStatus, ReportItem, STATUSES, TranslationStatus } from "./overlay";

interface CliOptions extends Omit<OverlayBuildOptions, "cdn"> {
    cdnDir: string
    region?: string
    maxVersion?: string
    strict: boolean
    verbose: boolean
}

function usage(message?: string): never {
    if (message) console.error(message)
    console.error("usage: npm run i18n:build -- [--lang en] [--i18n-dir i18n] [--out .cdn-overlay] [--cdn DIR] [--region en]\n" +
        "         [--max-version X] [--min-status machine|reviewed|official] [--images-dir DIR]\n" +
        "         [--columns FILE | --no-columns] [--limits FILE | --no-limits] [--glossary FILE | --no-glossary]\n" +
        "         [--dry-run] [--strict] [--verbose]")
    process.exit(2)
}

function minStatus(value: string | undefined, from: string): TranslationStatus {
    if (value === undefined || value === "") return DEFAULT_MIN_STATUS
    return parseStatus(value) ?? usage(`${from} must be one of ${STATUSES.join(", ")}, not ${value}`)
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        lang: "en",
        i18nDir: "i18n",
        outDir: process.env.CDN_OVERLAY_DIR || ".cdn-overlay",
        cdnDir: process.env.CDN_DIR || ".cdn",
        minStatus: minStatus(process.env.I18N_MIN_STATUS, "I18N_MIN_STATUS"),
        strict: false,
        verbose: false
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const value = () => argv[++i] ?? usage(`${arg} needs a value`)
        switch (arg) {
            case "--lang": opts.lang = value(); break
            case "--i18n-dir": opts.i18nDir = value(); break
            case "--out": opts.outDir = value(); break
            case "--cdn": opts.cdnDir = value(); break
            case "--region": opts.region = value(); break
            case "--max-version": opts.maxVersion = value(); break
            case "--min-status": opts.minStatus = minStatus(value(), "--min-status"); break
            case "--images-dir": opts.imagesDir = value(); break
            case "--columns": opts.columnsFile = value(); break
            case "--no-columns": opts.columnsFile = null; break
            case "--limits": opts.limitsFile = value(); break
            case "--no-limits": opts.limitsFile = null; break
            case "--glossary": opts.glossaryFile = value(); break
            case "--no-glossary": opts.glossaryFile = null; break
            case "--dry-run": opts.dryRun = true; break
            case "--strict": opts.strict = true; break
            case "--verbose": opts.verbose = true; break
            case "-h": case "--help": usage()
            default: usage(`unknown option ${arg}`)
        }
    }
    return opts
}

const where = (item: ReportItem) =>
    [item.file, item.asset, item.row !== undefined ? `row ${item.row || "(root)"}` : undefined, item.col !== undefined ? `col ${item.col}` : undefined]
        .filter(Boolean).join(" ")

function list(title: string, items: ReportItem[], limit: number) {
    if (items.length === 0) return
    console.log(`${title}: ${items.length}`)
    for (const item of items.slice(0, limit)) console.log(`  ${where(item)}: ${item.reason}`)
    if (items.length > limit) console.log(`  … ${items.length - limit} more in manifest.json`)
}

function main() {
    const opts = parseArgs(process.argv.slice(2))
    const started = Date.now()
    const root = regionCdnDir(opts.region ?? opts.lang, opts.cdnDir)
    const index = CdnIndex.build(root, { maxVersion: opts.maxVersion })
    console.error(`indexed ${index.stats.members} assets from ${index.stats.archives} archives in ${root}`)
    const { manifest, dir, pruned } = buildOverlay({ ...opts, cdn: index, cdnDir: path.resolve(opts.cdnDir) })
    const r = manifest.report
    const limit = opts.verbose ? Infinity : 20
    list("errors (skipped)", r.errors, limit)
    list("stale (skipped)", r.stale, limit)
    list("missing (skipped)", r.missing, limit)
    list("warnings", r.warnings, opts.verbose ? Infinity : 10)
    if (r.restoreMissing.length) console.log(`restore: ${r.restoreMissing.length} originals not in the CDN, left out`)
    console.log(`${r.files} files, ${r.entries} entries: ${r.applied} applied, ${r.belowStatus} below ${manifest.minStatus}, ` +
        `${r.stale.length} stale, ${r.missing.length} missing, ${r.errors.length} errors, ${r.warnings.length} warnings`)
    const describe = (a: typeof manifest.overlay) => (a ? `${a.file} (${a.size} bytes)` : "none")
    console.log(`overlay: ${describe(manifest.overlay)}, ${manifest.entries.length} files; restore: ${describe(manifest.restore)}, ${manifest.restored.length} files`)
    console.log(opts.dryRun ? "dry run: nothing written" : `wrote ${dir}${pruned.length ? `, removed ${pruned.join(", ")}` : ""} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    if (!opts.dryRun) console.log("restart Reflipped to serve it (I18N=on, the default, sends the overlay; I18N=off sends the restore archive once one was served)")
    if (opts.strict && (r.errors.length || r.stale.length || r.missing.length)) process.exitCode = 1
}

if (require.main === module) main()
