/**
 * Online backup of the player database: `node out/backup.js` (or `npm run backup`).
 *
 * Copies `wdfp_data.db` with `VACUUM INTO` (a consistent snapshot, safe while the server runs), checks
 * the copy with `PRAGMA quick_check`, and keeps the `.version` file (a restore without it would re-run
 * every migration) and `developer-mode-backups/` beside it. Each backup is a folder named after the UTC
 * time, written under a temporary name and renamed when complete; only the newest BACKUP_KEEP are kept.
 *
 * Env: DATABASE_DIR (default .database), BACKUP_DIR (default .backups), BACKUP_KEEP (default 14, 0 keeps all).
 * To restore, stop the server, copy one folder's contents into DATABASE_DIR, delete any
 * `wdfp_data.db-wal`/`-shm` there, and start it again.
 */
import sqlite3 from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import path from "path";

const DATABASE_FILE = "wdfp_data.db"
const VERSION_FILE = `${DATABASE_FILE}.version`
const DEVELOPER_MODE_DIR = "developer-mode-backups"
// 20261029T181500Z
const BACKUP_NAME = /^\d{8}T\d{6}Z$/

function resolveDir(value: string | undefined, fallback: string): string {
    const dir = value || fallback
    return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir)
}

/**
 * Copies a file or a folder tree (small files only). Not `cpSync` or `copyFileSync`: both chown the copy,
 * which the systemd unit's syscall filter forbids.
 */
function copy(from: string, to: string) {
    if (!statSync(from).isDirectory()) return writeFileSync(to, readFileSync(from))
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from)) copy(path.join(from, entry), path.join(to, entry))
}

function timestamp(date: Date): string {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
}

function backup(): string {
    const dataDir = resolveDir(process.env.DATABASE_DIR, ".database")
    const backupRoot = resolveDir(process.env.BACKUP_DIR, ".backups")
    const keep = Number.parseInt(process.env.BACKUP_KEEP ?? "14", 10)
    if (!Number.isInteger(keep) || keep < 0) throw new Error(`BACKUP_KEEP must be a whole number, got "${process.env.BACKUP_KEEP}"`)

    const source = path.join(dataDir, DATABASE_FILE)
    if (!existsSync(source)) throw new Error(`no database at ${source} (check DATABASE_DIR)`)

    const name = timestamp(new Date())
    const target = path.join(backupRoot, name)
    const partial = path.join(backupRoot, `.${name}.partial`)
    if (existsSync(target)) throw new Error(`${target} already exists`)
    // leftovers of a run that was killed half-way
    if (existsSync(backupRoot))
        for (const entry of readdirSync(backupRoot).filter(entry => entry.endsWith(".partial")))
            rmSync(path.join(backupRoot, entry), { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })

    try {
        // a read-only connection: VACUUM INTO reads one snapshot and leaves the live database alone
        const db = new sqlite3(source, { readonly: true, fileMustExist: true })
        try {
            db.prepare("VACUUM INTO ?").run(path.join(partial, DATABASE_FILE))
        } finally {
            db.close()
        }

        const snapshot = new sqlite3(path.join(partial, DATABASE_FILE), { readonly: true })
        try {
            const result = snapshot.pragma("quick_check", { simple: true })
            if (result !== "ok") throw new Error(`quick_check on the copy failed: ${result}`)
        } finally {
            snapshot.close()
        }

        if (existsSync(path.join(dataDir, VERSION_FILE)))
            copy(path.join(dataDir, VERSION_FILE), path.join(partial, VERSION_FILE))
        if (existsSync(path.join(dataDir, DEVELOPER_MODE_DIR)))
            copy(path.join(dataDir, DEVELOPER_MODE_DIR), path.join(partial, DEVELOPER_MODE_DIR))

        renameSync(partial, target)
    } catch (error) {
        rmSync(partial, { recursive: true, force: true })
        throw error
    }

    // prune: names sort by time, so drop all but the newest `keep`
    if (keep > 0) {
        const backups = readdirSync(backupRoot).filter(entry => BACKUP_NAME.test(entry)).sort()
        for (const old of backups.slice(0, Math.max(0, backups.length - keep)))
            rmSync(path.join(backupRoot, old), { recursive: true, force: true })
    }
    return target
}

try {
    console.log(`backup written to ${backup()}`)
} catch (error) {
    console.error(`backup failed: ${(error as Error).message}`)
    process.exitCode = 1
}
