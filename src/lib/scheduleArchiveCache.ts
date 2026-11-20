/** Bounded immutable archives; recently advertised/downloaded URLs survive cache pressure. */
import { createHash } from "crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import path from "path";

export const DEFAULT_SCHEDULE_CACHE_BYTES = 1024 * 1024 * 1024
export const SCHEDULE_CACHE_GRACE_MS = 30 * 60 * 1000
const ARCHIVE_NAME = /^[0-9a-f]{64}\.zip$/
const TEMPORARY_NAME = /^[0-9a-f]{64}\.zip\.\d+\.tmp$/

export class ScheduleAssetUnavailableError extends Error {
    readonly statusCode = 503
    constructor(message: string, readonly code = "SCHEDULE_ASSETS_UNAVAILABLE") { super(message) }
}

interface CachedFile { file: string, bytes: number, usedAt: number }

export interface ScheduleArchiveCacheOptions {
    root: string
    maxBytes: number
    graceMs?: number
    now?: () => number
}

export class ScheduleArchiveCache {
    readonly root: string
    private readonly maxBytes: number
    private readonly graceMs: number
    private readonly now: () => number

    constructor(options: ScheduleArchiveCacheOptions) {
        if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
            || !Number.isSafeInteger(options.graceMs ?? SCHEDULE_CACHE_GRACE_MS) || (options.graceMs ?? SCHEDULE_CACHE_GRACE_MS) < 0)
            throw new RangeError("Invalid schedule archive cache limits")
        this.root = options.root
        this.maxBytes = options.maxBytes
        this.graceMs = options.graceMs ?? SCHEDULE_CACHE_GRACE_MS
        this.now = options.now ?? Date.now
    }

    /** Advertisements and downloads renew the grace period, including after a process restart. */
    get(file: string): string | null {
        if (!ARCHIVE_NAME.test(file)) return null
        const full = path.join(this.root, file)
        if (!existsSync(full)) return null
        const stat = lstatSync(full)
        if (!stat.isFile()) return null
        utimesSync(full, new Date(this.now()), stat.mtime)
        return full
    }

    private files(): CachedFile[] {
        if (!existsSync(this.root)) return []
        return readdirSync(this.root).filter(file => ARCHIVE_NAME.test(file) || TEMPORARY_NAME.test(file)).flatMap(file => {
            const stat = lstatSync(path.join(this.root, file))
            return stat.isFile() ? [{ file, bytes: stat.size, usedAt: Math.max(stat.atimeMs, stat.mtimeMs) }] : []
        })
    }

    private admission(incomingBytes: number): { files: CachedFile[], bytes: number } {
        const files = this.files()
        const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
        const expired = files.filter(file => this.now() - file.usedAt >= this.graceMs)
        const protectedBytes = bytes - expired.reduce((sum, file) => sum + file.bytes, 0)
        if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0 || incomingBytes > this.maxBytes
            || protectedBytes + incomingBytes > this.maxBytes)
            throw new ScheduleAssetUnavailableError("Schedule archive cache is full; recent downloads are protected. Retry later or raise SCHEDULE_ASSET_CACHE_BYTES.", "SCHEDULE_ASSET_CACHE_FULL")
        return { files: expired.sort((a, b) => a.usedAt - b.usedAt || a.file.localeCompare(b.file)), bytes }
    }

    /** Cheap capacity preflight before a synchronous master build. Does not evict existing files. */
    assertCanStore(incomingBytes: number): void { this.admission(incomingBytes) }

    put(data: Buffer): { file: string, fullPath: string } {
        const file = `${createHash("sha256").update(data).digest("hex")}.zip`
        const existing = this.get(file)
        if (existing) return { file, fullPath: existing }
        const admission = this.admission(data.length)
        let bytes = admission.bytes
        for (const old of admission.files) {
            if (bytes + data.length <= this.maxBytes) break
            unlinkSync(path.join(this.root, old.file))
            bytes -= old.bytes
        }
        mkdirSync(this.root, { recursive: true })
        const fullPath = path.join(this.root, file)
        const temporary = `${fullPath}.${process.pid}.tmp`
        try {
            writeFileSync(temporary, data)
            renameSync(temporary, fullPath)
            // Explicit timestamps make protection independent of relatime/noatime mount settings.
            utimesSync(fullPath, new Date(this.now()), new Date(this.now()))
        } finally {
            if (existsSync(temporary)) unlinkSync(temporary)
        }
        return { file, fullPath }
    }
}

/** A small rolling budget bounds uncached synchronous CPU work, independently of player/IP count. */
export class ScheduleBuildBudget {
    private starts: number[] = []
    constructor(private readonly now: () => number = Date.now) {}
    take(maxPerMinute: number): void {
        if (!Number.isInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > 120)
            throw new RangeError("SCHEDULE_ASSET_BUILDS_PER_MINUTE must be an integer from 1 to 120")
        const now = this.now()
        this.starts = this.starts.filter(time => now - time < 60_000)
        if (this.starts.length >= maxPerMinute)
            throw new ScheduleAssetUnavailableError("Schedule archive build budget exhausted; retry in one minute.", "SCHEDULE_ASSET_BUILD_LIMIT")
        this.starts.push(now)
    }
}
