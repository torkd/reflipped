import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";
import { readArchiveMember, readCentralDirectory } from "../src/lib/cdnIndex";
import { writeZip } from "../src/lib/zipWriter";

// SH-27: POST /shell/restore sends the base copies of the paths another server's layers wrote or deleted.
let fastify: FastifyInstance
let cleanup: () => Promise<void>
let scratch: string

const list = JSON.parse(readFileSync(path.join(__dirname, "..", "assets", "asset_lists", "en-android-full.json"), "utf8")) as {
    full: { archive: { location: string }[] }, diff: { archive: { location: string }[] }[]
}
const locations = [...list.full.archive, ...list.diff.flatMap(d => d.archive)].map(a => a.location.replace("{$cdnAddress}/", ""))

const A = "production/upload/aa/0001"
const B = "production/upload/bb/0002"
const GONE = "production/upload/cc/0003"
const SHORT = "production/medium_upload/hash/dd/0004.hash"
const SHORT_ACTUAL = "production/medium_upload/dd/0004"

function writeCdn(cdn: string, contents: Map<number, { name: string, data: Buffer }[]>) {
    locations.forEach((location, i) => {
        const file = path.join(cdn, location)
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, writeZip(contents.get(i) ?? []))
    })
}

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    scratch = mkdtempSync(path.join(tmpdir(), "restore-test-"))
    const last = locations.length - 1
    writeCdn(process.env.CDN_DIR!, new Map([
        [0, [{ name: A, data: Buffer.from("a old") }, { name: GONE, data: Buffer.from("gone") }, { name: SHORT, data: Buffer.from("short") }]],
        [1, [{ name: B, data: Buffer.from("b") }]],
        // a later diff: a newer copy of A, and GONE removed
        [last, [{ name: A, data: Buffer.from("a new") }, { name: ".removed.csv", data: Buffer.from(`rowid,path\n1,${GONE}\n`) }]]
    ]))
})

after(async () => {
    rmSync(scratch, { recursive: true, force: true })
    await cleanup()
})

function entries(body: Buffer): Map<string, string> {
    const file = path.join(scratch, `reply-${Math.random()}.zip`)
    writeFileSync(file, body)
    return new Map(readCentralDirectory(file).map(m => [m.name, readArchiveMember(file, m).toString("utf8")]))
}

const restore = (payload: object) => fastify.inject({ method: "POST", url: "/shell/restore", payload })

test("/shell/config lists the languages it can restore", async () => {
    const { assets } = (await fastify.inject({ method: "GET", url: "/shell/config" })).json()
    assert.deepEqual(assets.restore, ["en"])
})

test("the restore archive holds the base's last copy of each path, under the base's name, and removes the rest", async () => {
    const response = await restore({ lang: "en", base: "2.1.125", paths: [A, B, B, GONE, SHORT_ACTUAL, "production/upload/ee/mod-only"] })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers["content-type"], "application/zip")
    assert.equal(response.headers["x-restored"], "3")
    assert.equal(response.headers["x-removed"], "2")
    const files = entries(response.rawPayload)
    assert.deepEqual([...files.keys()], [".removed.csv", SHORT, A, B])
    assert.equal(files.get(A), "a new")
    assert.equal(files.get(B), "b")
    // the layer's shortened twin is replaced through the base's name; GONE was deleted by a diff
    assert.equal(files.get(SHORT), "short")
    assert.equal(files.get(".removed.csv"), `rowid,path\n1,${GONE}\n2,production/upload/ee/mod-only\n`)
})

test("GAME_DATA_DOWNLOAD=off restores nothing", async () => {
    process.env.GAME_DATA_DOWNLOAD = "off"
    try {
        assert.deepEqual((await fastify.inject({ method: "GET", url: "/shell/config" })).json().assets.restore, [])
        assert.equal((await restore({ lang: "en", base: "2.1.125", paths: [A] })).statusCode, 404)
    } finally {
        delete process.env.GAME_DATA_DOWNLOAD
    }
})

test("another base, a language without archives and paths leaving the folder are refused", async () => {
    assert.equal((await restore({ lang: "en", base: "2.1.124", paths: [A] })).statusCode, 409)
    assert.equal((await restore({ lang: "ko", base: "2.1.125", paths: [A] })).statusCode, 404)
    assert.equal((await restore({ lang: "en", base: "2.1.125", paths: ["production/../../x"] })).statusCode, 400)
    assert.equal((await restore({ lang: "en", base: "2.1.125", paths: ["./x"] })).statusCode, 400)
    assert.equal((await restore({ lang: "de", base: "2.1.125", paths: [A] })).statusCode, 400)
})
