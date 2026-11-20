// An online server offering its data pack (SH-13 step 3): GET /shell/datapack and the archive, from DATA_PACK_SERVE_DIR.
// Synthetic archive bytes only.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";
import { sha256Hex } from "../src/lib/dataPack";

let fastify: FastifyInstance
let cleanup: () => Promise<void>
let dir: string
const archive = Buffer.from("PK pretend archive bytes")

function writePack(version: string, bytes: Buffer, listedSize = bytes.length) {
    const name = `reflipped-datapack-${version}`
    writeFileSync(path.join(dir, `${name}.zip`), bytes)
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
        format: 1, cdnVersion: version, archive: `${name}.zip`, size: listedSize, sha256: sha256Hex(bytes),
        manifestSha256: "a".repeat(64), assetsDigest: "b".repeat(64)
    }))
}

before(async () => {
    ;({ fastify, cleanup } = await createTestServer())
    dir = mkdtempSync(path.join(os.tmpdir(), "datapack-serve-"))
})

after(async () => {
    delete process.env.DATA_PACK_SERVE_DIR
    rmSync(dir, { recursive: true, force: true })
    await cleanup()
})

test("without DATA_PACK_SERVE_DIR there is nothing to download", async () => {
    delete process.env.DATA_PACK_SERVE_DIR
    assert.equal((await fastify.inject({ method: "GET", url: "/shell/datapack" })).statusCode, 404)
    assert.equal((await fastify.inject({ method: "GET", url: "/shell/datapack/reflipped-datapack-2.1.125.zip" })).statusCode, 404)
})

test("an empty folder, or an archive of another size than its descriptor says, is not offered", async () => {
    process.env.DATA_PACK_SERVE_DIR = dir
    assert.equal((await fastify.inject({ method: "GET", url: "/shell/datapack" })).statusCode, 404)
    writePack("2.1.100", archive, archive.length + 1)
    assert.equal((await fastify.inject({ method: "GET", url: "/shell/datapack" })).statusCode, 404)
    rmSync(path.join(dir, "reflipped-datapack-2.1.100.json"))
})

test("the descriptor names the newest pack and its URL on the address the app asked", async () => {
    process.env.DATA_PACK_SERVE_DIR = dir
    mkdirSync(dir, { recursive: true })
    writePack("2.1.9", Buffer.from("older"))
    writePack("2.1.125", archive)
    const reply = await fastify.inject({ method: "GET", url: "/shell/datapack", headers: { host: "wf.example.org" } })
    assert.equal(reply.statusCode, 200)
    assert.equal(reply.headers["cache-control"], "no-store")
    const body = reply.json()
    assert.equal(body.cdnVersion, "2.1.125")
    assert.equal(body.size, archive.length)
    assert.equal(body.sha256, sha256Hex(archive))
    assert.match(body.url, /^https?:\/\/wf\.example\.org\/shell\/datapack\/reflipped-datapack-2\.1\.125\.zip$/)
})

test("the archive downloads whole; other names are refused", async () => {
    process.env.DATA_PACK_SERVE_DIR = dir
    const ok = await fastify.inject({ method: "GET", url: "/shell/datapack/reflipped-datapack-2.1.125.zip" })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.headers["content-type"], "application/zip")
    assert.equal(ok.headers.etag, `"${sha256Hex(archive)}"`)
    assert.deepEqual(ok.rawPayload, archive)
    // an older pack in the folder is not the offered one
    assert.equal((await fastify.inject({ method: "GET", url: "/shell/datapack/reflipped-datapack-2.1.9.zip" })).statusCode, 404)
    // a name that isn't an archive name never reaches the file system
    assert.equal((await fastify.inject({ method: "GET", url: "/shell/datapack/..%2Fsecret.zip" })).statusCode, 400)
    assert.equal((await fastify.inject({ method: "GET", url: "/shell/datapack/reflipped-datapack-2.1.125.json" })).statusCode, 400)
})
