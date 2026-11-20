// FT-79: client files taken from the Chinese version's CDN (src/lib/cnPatches.ts). The real files are game data and
// never in the repository, so these tests build a small Chinese CDN folder with made-up bytes and pass a patch list
// pinned to them.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";
import { writeZip } from "../src/lib/zipWriter";
import { archiveVersion, digestPath, readArchiveMember, readCentralDirectory } from "../src/lib/cdnIndex";
import type { CnPatch } from "../src/lib/cnPatches";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let cn: typeof import("../src/lib/cnPatches")

const LAYOUT = "scene/party_select/party_select_top_panel.ui.amf3.deflate"
const OLD = Buffer.from("layout of 1.4.0")
const NEW = Buffer.from("layout of 1.4.2")
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex")

/** A Chinese CDN folder: a full archive with the old copy, a later diff archive with the new one. */
function chineseCdn(root: string): string {
    const full = path.join(root, "archive-common-full"), diff = path.join(root, "archive-common-diff")
    mkdirSync(full, { recursive: true })
    mkdirSync(diff, { recursive: true })
    writeFileSync(path.join(full, "pinball-1.4.0-37-927b7026.zip"), writeZip([
        { name: digestPath(LAYOUT), data: OLD },
        { name: digestPath("master/item/item.orderedmap"), data: Buffer.from("other") }
    ]))
    writeFileSync(path.join(diff, "pinball-1.4.1-1.4.2-1-1499eb9f.zip"), writeZip([{ name: digestPath(LAYOUT), data: NEW }]))
    return root
}

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
    cn = await import("../src/lib/cnPatches")
})

after(async () => {
    delete process.env.CN_CDN_DIR
    delete process.env.CN_PATCHES
    await cleanup()
})

test("the CDN index reads the Chinese archives' names", () => {
    assert.deepEqual(archiveVersion("pinball-1.4.0-37-927b7026.zip"), [1, 4, 0])
    assert.deepEqual(archiveVersion("pinball-1.4.1-1.4.2-1-1499eb9f.zip"), [1, 4, 2])
    assert.deepEqual(archiveVersion("asset-2.1.0-31-a2bd74e9.zip"), [2, 1, 0])
    assert.equal(archiveVersion("pinball-notes.zip"), null)
})

test("the archive holds the newest copy when it is the pinned one, byte for byte, under the global member name", () => {
    const root = chineseCdn(path.join(process.env.CDN_DIR!, "cn-a"))
    const built = cn.buildCnPatchArchive(root, [{ assetPath: LAYOUT, sha256: sha(NEW), reason: "test" }])!
    assert.deepEqual(built.included, [LAYOUT])
    assert.deepEqual(built.skipped, [])
    const file = path.join(root, "out.zip")
    writeFileSync(file, built.data)
    const members = readCentralDirectory(file)
    assert.deepEqual(members.map(m => m.name), [digestPath(LAYOUT)])
    assert.deepEqual(readArchiveMember(file, members[0]), NEW)
})

test("a copy other than the pinned one, or a file the CDN lacks, is left out", () => {
    const root = chineseCdn(path.join(process.env.CDN_DIR!, "cn-b"))
    const pinnedOld: CnPatch = { assetPath: LAYOUT, sha256: sha(OLD), reason: "test" }
    const missing: CnPatch = { assetPath: "scene/nowhere.ui.amf3.deflate", sha256: sha(NEW), reason: "test" }
    assert.equal(cn.buildCnPatchArchive(root, [pinnedOld, missing]), null, "the newest copy isn't the pinned one")
    const built = cn.buildCnPatchArchive(root, [{ ...pinnedOld, sha256: sha(NEW) }, missing])!
    assert.deepEqual(built.included, [LAYOUT])
    assert.deepEqual(built.skipped.map(s => [s.assetPath, s.reason]), [["scene/nowhere.ui.amf3.deflate", "not in the Chinese CDN"]])
})

test("at startup: the archive is written by content name, older ones removed, and served; nothing without a Chinese CDN or with CN_PATCHES=off", async () => {
    const patches = [{ assetPath: LAYOUT, sha256: sha(NEW), reason: "test" }]
    const lines: string[] = []
    process.env.CN_CDN_DIR = path.join(process.env.CDN_DIR!, "no-such-folder")
    assert.equal(cn.prepareCnPatchArchive(line => lines.push(line), patches), null)

    process.env.CN_CDN_DIR = chineseCdn(path.join(process.env.CDN_DIR!, "cn-c"))
    mkdirSync(cn.cnPatchDir(), { recursive: true })
    const stale = path.join(cn.cnPatchDir(), "cn-patches-0123456789abcdef.zip")
    writeFileSync(stale, "old")
    const prepared = cn.prepareCnPatchArchive(line => lines.push(line), patches)!
    assert.match(prepared.file, /^cn-patches-[0-9a-f]{16}\.zip$/)
    assert.equal(prepared.file, cn.cnPatchFileName(prepared.data))
    assert.ok(!existsSync(stale), "an older archive is removed")
    assert.deepEqual(readFileSync(path.join(cn.cnPatchDir(), prepared.file)), prepared.data)
    assert.equal(lines.length, 0, lines.join("\n"))

    const served = await fastify.inject({ method: "GET", url: `/patch/Live/2.0.0/cn-patches/${prepared.file}` })
    assert.equal(served.statusCode, 200)
    assert.deepEqual(served.rawPayload, prepared.data)
    assert.equal((await fastify.inject({ method: "GET", url: "/patch/Live/2.0.0/cn-patches/cn-patches-0123456789abcdef.zip" })).statusCode, 404)
    assert.equal((await fastify.inject({ method: "GET", url: "/patch/Live/2.0.0/cn-patches/..%2Fwdfp_data.db" })).statusCode, 400)

    process.env.CN_PATCHES = "off"
    assert.equal(cn.prepareCnPatchArchive(line => lines.push(line), patches), null)
    delete process.env.CN_PATCHES
})

test("the schedule layer finds the archive like the other local layers (it answered H503 without)", async () => {
    const { localLayer } = await import("../src/lib/scheduleAssets")
    process.env.CN_CDN_DIR = chineseCdn(path.join(process.env.CDN_DIR!, "cn-d"))
    const prepared = cn.prepareCnPatchArchive(() => {}, [{ assetPath: LAYOUT, sha256: sha(NEW), reason: "test" }])!
    assert.equal(localLayer(`{$cdnAddress}/cn-patches/${prepared.file}`, "/cdn", "/overlay"), path.join(cn.cnPatchDir(), prepared.file))
    assert.throws(() => localLayer("{$cdnAddress}/cn-patches/cn-patches-0123456789abcdef.zip", "/cdn", "/overlay"))
})
