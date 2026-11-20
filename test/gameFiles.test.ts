import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileListDigest, fileListText, filesOfArchives } from "../src/gamepack/baseFiles";
import { writeZip } from "../src/lib/zipWriter";

// SH-29: the base files an exported game data pack is checked against are what the app's extraction leaves.
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

test("the list follows extraction: later copies win, shortened twins and .removed.csv delete", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gamefiles-test-"))
    try {
        const A = "production/upload/aa/0001", G = "production/upload/cc/0003"
        const S = "production/medium_upload/hash/dd/0004.hash", S_ACTUAL = "production/medium_upload/dd/0004"
        const full = path.join(dir, "full.zip"), diff = path.join(dir, "diff.zip")
        writeFileSync(full, writeZip([{ name: A, data: Buffer.from("a old") }, { name: G, data: Buffer.from("g") }, { name: S, data: Buffer.from("s") }]))
        writeFileSync(diff, writeZip([{ name: A, data: Buffer.from("a new") }, { name: S_ACTUAL, data: Buffer.from("s actual") },
            { name: ".removed.csv", data: Buffer.from(`rowid,path\n1,${G}\n`) }]))
        const files = filesOfArchives([full, diff])
        assert.deepEqual(files, [
            { path: S_ACTUAL, size: 8, sha256: sha("s actual") },
            { path: A, size: 5, sha256: sha("a new") }
        ])
        const text = `${S_ACTUAL}\t8\t${sha("s actual")}\n${A}\t5\t${sha("a new")}\n`
        assert.equal(fileListText(files), text)
        assert.equal(fileListDigest(files), sha(text))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
