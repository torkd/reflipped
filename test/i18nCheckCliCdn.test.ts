// New synthetic regression coverage for I18N-9; invokes only the checker CLI.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { digestPath, masterAssetPath } from "../src/lib/cdnIndex"
import { buildOrderedMap } from "../src/lib/orderedmap"
import { writeZip } from "../src/lib/zipWriter"
import { srcHash } from "../src/i18n/cells"

const cli = path.resolve("src/lib/i18n/cli.ts")
const tsx = path.resolve("node_modules/tsx/dist/loader.mjs")
const table = "item/item"
const scenario = "story/test/unit/scenario"
const masterSource = "値 ::count::"
const storySource = "こんにちは ::name::"
function fixture(t: { after: (fn: () => void) => void }) {
    const root = mkdtempSync(path.join(tmpdir(), "i18n-check-cli-"))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const json = (name: string, value: unknown) => {
        mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
        writeFileSync(path.join(root, name), JSON.stringify(value))
    }
    const archive = "cdn/en/archive-common-full"
    mkdirSync(path.join(root, archive), { recursive: true })
    writeFileSync(path.join(root, archive, "asset-2.1.0-1-abcd.zip"), writeZip([
        { name: digestPath(masterAssetPath(table)), data: buildOrderedMap([["1", [[masterSource], ["second record"]]]]).encode() },
        { name: digestPath(masterAssetPath(scenario)), data: buildOrderedMap([[scenario, buildOrderedMap([["1", [["0", "", "", "", "speaker", storySource]]]])]]).encode() },
    ]))
    json("i18n/en/master/item__item.json", { "1": { "0": { text: "Value ::count::", srcHash: srcHash(masterSource) }, "1": { text: "Second", srcHash: srcHash("second record") } } })
    json("i18n/en/story/test/unit/scenario.json", { "1": { "5": { text: "Hello ::name::", srcHash: srcHash(storySource) } } })
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", tsx, cli, "check", ...args], {
        cwd: root, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, CDN_DIR: path.join(root, "cdn") },
    })
    return { root, json, run }
}

test("default checks master and nested story against CDN, stripping scenario wrapper and flattening records", (t) => {
    const { run } = fixture(t)
    const result = run("--strict")
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /3 cells checked, 0 errors, 0 warnings/)
})

test("scenario placeholder and line errors fail, quiet hides only warnings", (t) => {
    const { json, run } = fixture(t)
    json("i18n/en/story/test/unit/scenario.json", { "1": { "5": { text: "a\nb\nc\nd", srcHash: "stale" } } })
    const result = run("--quiet")
    assert.equal(result.status, 1)
    assert.match(result.stdout, /story\/test\/unit\/scenario 1 \[5\] placeholder/)
    assert.match(result.stdout, /\[5\] lines:/)
    assert.doesNotMatch(result.stdout, /warning .*stale:/)
    assert.match(result.stdout, /3 cells checked, 2 errors, 1 warnings/)
})

test("stale and missing source warnings affect strict exit and story line-length rules apply", (t) => {
    const { json, run } = fixture(t)
    json("i18n/en/story/test/unit/scenario.json", {
        "1": { "5": { text: "Hello ::name:: " + "a".repeat(36), srcHash: "stale" } },
        "999": { "5": { text: "Missing source" } },
    })
    const normal = run()
    assert.equal(normal.status, 0, normal.stdout + normal.stderr)
    assert.match(normal.stdout, /stale:/)
    assert.match(normal.stdout, /source:/)
    assert.match(normal.stdout, /line-length:/)
    assert.equal(run("--strict").status, 1)
})

test("explicit dump and flat master dir preserve scope and override CDN; wrapped story dumps work", (t) => {
    const { json, run } = fixture(t)
    json("dump/item/item.json", { "1": [masterSource, "second record"] })
    json("dump/story/test/unit/scenario.json", { [scenario]: { "1": ["0", "", "", "", "speaker", storySource] } })
    const masterOnly = run("--dir", "i18n/en/master", "--master", "dump", "--cdn", "missing", "--strict")
    assert.equal(masterOnly.status, 0, masterOnly.stdout + masterOnly.stderr)
    assert.match(masterOnly.stdout, /2 cells checked/)
    const storyOnly = run("--dir", "i18n/en/story", "--master", "dump", "--strict")
    assert.equal(storyOnly.status, 0, storyOnly.stdout + storyOnly.stderr)
    assert.match(storyOnly.stdout, /1 cells checked/)
})

test("unreadable CDN and malformed translations report operational errors", (t) => {
    const { json, run } = fixture(t)
    const missing = run("--cdn", "does-not-exist")
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /CDN directory not found/)
    json("i18n/en/master/item__item.json", { "1": { "0": null } })
    assert.equal(run().status, 2)
})

test("explicit CDN region and max version select source versions", (t) => {
    const { root, run } = fixture(t)
    const archive = path.join(root, "cdn", "en", "archive-common-full", "asset-2.1.0-2.1.1-1-abcd.zip")
    writeFileSync(archive, writeZip([{ name: digestPath(masterAssetPath(table)), data: buildOrderedMap([["1", [["changed", "second record"]]]]).encode() }]))
    assert.equal(run("--cdn", "cdn", "--region", "en", "--max-version", "2.1.0", "--strict").status, 0)
    const latest = run("--cdn", "cdn", "--region", "en")
    assert.equal(latest.status, 1)
    assert.match(latest.stdout, /stale:/)
    assert.match(latest.stdout, /placeholder:/)
})
