import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScheduleArchiveCache, ScheduleAssetUnavailableError, ScheduleBuildBudget, SCHEDULE_CACHE_GRACE_MS } from "../src/lib/scheduleArchiveCache";

function fixture(maxBytes: number) {
    const root = mkdtempSync(path.join(tmpdir(), "reflipped-schedule-cache-"))
    let time = 1_700_000_000_000
    const cache = new ScheduleArchiveCache({ root, maxBytes, now: () => time })
    return { root, cache, advance: (ms: number) => { time += ms }, now: () => time,
        cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test("a full cache rejects new archives with503 while retaining every recent advertised URL", () => {
    const f = fixture(12)
    try {
        const first = f.cache.put(Buffer.from("aaaaaa"))
        const second = f.cache.put(Buffer.from("bbbbbb"))
        assert.throws(() => f.cache.put(Buffer.from("cccccc")), (error: unknown) =>
            error instanceof ScheduleAssetUnavailableError && error.statusCode === 503 && error.code === "SCHEDULE_ASSET_CACHE_FULL")
        assert.ok(f.cache.get(first.file))
        assert.ok(f.cache.get(second.file))
        assert.equal(readdirSync(f.root).length, 2)
        // Reusing existing bytes needs no additional admission, even if the configured cap shrinks.
        const smaller = new ScheduleArchiveCache({ root: f.root, maxBytes: 1, now: f.now })
        assert.equal(smaller.put(Buffer.from("aaaaaa")).file, first.file)
    } finally { f.cleanup() }
})

test("capacity evicts the oldest eligible archive while refreshed downloads keep their grace", () => {
    const f = fixture(12)
    try {
        const oldest = f.cache.put(Buffer.from("aaaaaa"))
        f.advance(1000)
        const active = f.cache.put(Buffer.from("bbbbbb"))
        const originalModified = statSync(active.fullPath).mtimeMs
        f.advance(SCHEDULE_CACHE_GRACE_MS + 1000)
        assert.ok(f.cache.get(active.file))
        const newest = f.cache.put(Buffer.from("cccccc"))
        assert.equal(existsSync(oldest.fullPath), false)
        assert.equal(existsSync(active.fullPath), true)
        assert.equal(existsSync(newest.fullPath), true)
        assert.equal(statSync(active.fullPath).mtimeMs, originalModified)
        assert.equal(readdirSync(f.root).reduce((sum, file) => sum + statSync(path.join(f.root, file)).size, 0), 12)
    } finally { f.cleanup() }
})

test("recent archive grace persists on disk across cache instances and expires after30minutes", () => {
    const f = fixture(6)
    try {
        const saved = f.cache.put(Buffer.from("aaaaaa"))
        f.advance(SCHEDULE_CACHE_GRACE_MS - 1000)
        const restarted = new ScheduleArchiveCache({ root: f.root, maxBytes: 6, now: f.now })
        assert.throws(() => restarted.put(Buffer.from("bbbbbb")), ScheduleAssetUnavailableError)
        f.advance(1001)
        restarted.put(Buffer.from("bbbbbb"))
        assert.equal(restarted.get(saved.file), null)
    } finally { f.cleanup() }
})

test("oversized archives and recent crash temporaries cannot grow the disk beyond its cap", () => {
    const f = fixture(6)
    try {
        assert.throws(() => f.cache.put(Buffer.from("toolarge")), ScheduleAssetUnavailableError)
        assert.equal(readdirSync(f.root).length, 0)
        const temporary = path.join(f.root, `${"a".repeat(64)}.zip.123.tmp`)
        writeFileSync(temporary, "aaaaaa")
        utimesSync(temporary, new Date(f.now()), new Date(f.now()))
        assert.throws(() => f.cache.put(Buffer.from("bbbbbb")), ScheduleAssetUnavailableError)
        f.advance(SCHEDULE_CACHE_GRACE_MS + 1)
        f.cache.put(Buffer.from("bbbbbb"))
        assert.equal(existsSync(temporary), false)
        assert.equal(readdirSync(f.root).length, 1)
    } finally { f.cleanup() }
})

test("uncached generation uses a rolling global budget independent of view count", () => {
    let now = 0
    const budget = new ScheduleBuildBudget(() => now)
    budget.take(2)
    now += 1000
    budget.take(2)
    assert.throws(() => budget.take(2), (error: unknown) => error instanceof ScheduleAssetUnavailableError
        && error.statusCode === 503 && error.code === "SCHEDULE_ASSET_BUILD_LIMIT")
    now = 60_000
    budget.take(2)
    assert.throws(() => budget.take(2), ScheduleAssetUnavailableError)
    now = 61_000
    budget.take(2)
})
