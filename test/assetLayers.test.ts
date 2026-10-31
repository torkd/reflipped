// Asset layers (I18N-3): `asset/get_path` sends [restore, mods…, overlay] to en devices, mods only to ko/th, under
// a version that rises whenever the layers change (I18N on → off → on), the overlay's static route, and the
// migration from the old `metadata.json`. Synthetic fixtures only (test/overlayFixtures.ts).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { FastifyInstance } from "fastify";
import { createTestPlayer, createTestServer, decodeGameBody, encodeGameBody, gameHeaders, readCapturedRoute } from "./helpers";
import { translationSet, writeMiniCdn, writeTranslations } from "./overlayFixtures";
import type { buildOverlay as BuildOverlay } from "../src/i18n/overlay";
import type * as AssetLayers from "../src/lib/assetLayers";
import type * as ServerSettings from "../src/data/serverSettings";

const apiPrefix = "/latest/api/index.php"
let fastify: FastifyInstance
let cleanup: () => Promise<void>
let work: string
let overlayDir: string
let buildOverlay: typeof BuildOverlay
let layers: typeof AssetLayers
let settings: typeof ServerSettings

before(async () => {
    work = mkdtempSync(path.join(os.tmpdir(), "reflipped-layers-"))
    overlayDir = path.join(work, "cdn-overlay")
    mkdirSync(overlayDir)
    process.env.CDN_OVERLAY_DIR = overlayDir
    delete process.env.I18N
    ;({ fastify, cleanup } = await createTestServer())
    ;({ buildOverlay } = await import("../src/i18n/overlay"))
    layers = await import("../src/lib/assetLayers")
    settings = await import("../src/data/serverSettings")
})

after(async () => {
    await cleanup()
    rmSync(work, { recursive: true, force: true })
    delete process.env.CDN_OVERLAY_DIR
    delete process.env.I18N
})

/** Applies a new I18N setting and re-reads the folders, as a restart does. */
function restart(i18n?: "on" | "off") {
    if (i18n === undefined) delete process.env.I18N
    else process.env.I18N = i18n
    layers.resetAssetLayers()
    return layers.getAssetLayers()
}

function buildFrom(files: Record<string, unknown>, name: string) {
    const i18nDir = path.join(work, name)
    writeTranslations(i18nDir, files)
    return buildOverlay({ lang: "en", i18nDir, cdn: path.join(process.env.CDN_DIR!, "en"), cdnDir: process.env.CDN_DIR!, outDir: overlayDir, limitsFile: null, glossaryFile: null }).manifest
}

async function getPath(lang: string, resVer?: string) {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", "device_lang": lang, "udid": "TEST" }
    if (resVer !== undefined) headers["res_ver"] = resVer
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/asset/get_path`, headers,
        payload: encodeGameBody({ target_asset_version: "", viewer_id: 1 })
    })
    assert.equal(response.statusCode, 200, response.body)
    return decodeGameBody(response.body).data
}

/** The archive file names a device on an old version gets, and the version they bring it to. */
async function update(lang: string, from = "2.1.100") {
    const data = await getPath(lang, from)
    assert.equal(data.info.is_initial, false)
    assert.equal(data.full.version, data.info.target_asset_version)
    return { version: data.full.version as string, files: (data.full.archive as { location: string }[]).map(a => a.location.replace("{$cdnAddress}/", "")) }
}

let restoreFile: string
let overlayFile: string

test("no mods and no overlay: the asset lists' own version and no extra archives", async () => {
    const state = restart()
    assert.equal(state.versionString, "2.1.125")
    assert.deepEqual(await update("en"), { version: "2.1.125", files: [] })
})

test("a built overlay changes nothing while I18N is off and it was never served", async () => {
    writeMiniCdn(process.env.CDN_DIR!)
    const manifest = buildFrom(translationSet(), "i18n-a")
    overlayFile = `overlay/en/${manifest.overlay!.file}`
    restoreFile = `overlay/en/${manifest.restore!.file}`
    const state = restart("off")
    assert.equal(state.versionString, "2.1.125")
    assert.deepEqual((await update("en")).files, [])
})

test("mods are sent to every language, in file name order, under a raised version", async () => {
    mkdirSync(path.join(process.env.CDN_DIR!, "mods"))
    writeFileSync(path.join(process.env.CDN_DIR!, "mods", "b_mod.zip"), "mod b")
    writeFileSync(path.join(process.env.CDN_DIR!, "mods", "a_mod.zip"), "mod a")
    const state = restart("off")
    assert.equal(state.versionString, "2.1.126")
    for (const lang of ["en", "ko", "th"]) {
        assert.deepEqual(await update(lang), { version: "2.1.126", files: ["mods/a_mod.zip", "mods/b_mod.zip"] }, lang)
    }
})

test("I18N=on: en gets restore, mods, overlay; ko and th only the mods", async () => {
    const state = restart("on")
    assert.equal(state.versionString, "2.1.127")
    assert.deepEqual(await update("en"), { version: "2.1.127", files: [restoreFile, "mods/a_mod.zip", "mods/b_mod.zip", overlayFile] })
    for (const lang of ["ko", "th", "de"]) {
        assert.deepEqual((await update(lang)).files, ["mods/a_mod.zip", "mods/b_mod.zip"], lang)
    }
    const archive = (await getPath("en", "2.1.100")).full.archive.at(-1)
    const bytes = readFileSync(path.join(overlayDir, "en", overlayFile.split("/").pop()!))
    assert.equal(archive.size, bytes.length)
    assert.equal(archive.sha256, createHash("sha256").update(bytes).digest("base64"))
})

test("/load announces the current version", async () => {
    const player = await createTestPlayer(fastify)
    const captured = readCapturedRoute("load").requestBody
    const response = await fastify.inject({
        method: "POST", url: `${apiPrefix}/load`, headers: gameHeaders(player.udid),
        payload: encodeGameBody({ ...captured, access_token: player.zat, viewer_id: player.viewerId })
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(decodeGameBody(response.body).data.available_asset_version, "2.1.127")
})

test("a device already on the current version, or a fresh install, gets the asset lists unchanged", async () => {
    for (const resVer of ["2.1.127", undefined]) {
        const data = await getPath("en", resVer)
        assert.equal(data.info.target_asset_version, "2.1.125")
        assert.ok(data.full.archive.every((a: { location: string }) => !a.location.includes("/overlay/")))
    }
})

test("the overlay archives are served under /patch/Live/2.0.0/overlay/, the manifest is not", async () => {
    for (const file of [overlayFile, restoreFile]) {
        const response = await fastify.inject({ method: "GET", url: `/patch/Live/2.0.0/${file}` })
        assert.equal(response.statusCode, 200, file)
        assert.ok(response.rawPayload.equals(readFileSync(path.join(overlayDir, "en", file.split("/").pop()!))), file)
    }
    const manifest = await fastify.inject({ method: "GET", url: "/patch/Live/2.0.0/overlay/en/manifest.json" })
    assert.equal(manifest.statusCode, 404)
    // the CDN's own files are still served
    writeFileSync(path.join(process.env.CDN_DIR!, "probe.txt"), "cdn")
    assert.equal((await fastify.inject({ method: "GET", url: "/patch/Live/2.0.0/probe.txt" })).body, "cdn")
})

test("I18N=off after it was on: en gets the restore archive and the mods, under a higher version", async () => {
    const state = restart("off")
    assert.equal(state.versionString, "2.1.128")
    assert.deepEqual(await update("en", "2.1.127"), { version: "2.1.128", files: [restoreFile, "mods/a_mod.zip", "mods/b_mod.zip"] })
    assert.deepEqual((await update("ko", "2.1.127")).files, ["mods/a_mod.zip", "mods/b_mod.zip"])
})

test("on again: a new version, never an old one reused; an unchanged restart keeps it", async () => {
    assert.equal(restart("on").versionString, "2.1.129")
    assert.equal(restart("on").versionString, "2.1.129")
    assert.equal(restart("on").bumped, false)
})

test("a rebuilt overlay raises the version again, with the dropped file still restored", async () => {
    const onlyUi = { "master/string__ui_string.json": (translationSet() as Record<string, unknown>)["master/string__ui_string.json"] }
    const manifest = buildFrom(onlyUi, "i18n-b")
    assert.equal(manifest.entries.length, 1)
    assert.equal(manifest.restored.length, 3)
    const state = restart("on")
    assert.equal(state.versionString, "2.1.130")
    const { files } = await update("en", "2.1.129")
    assert.deepEqual(files, [`overlay/en/${manifest.restore!.file}`, "mods/a_mod.zip", "mods/b_mod.zip", `overlay/en/${manifest.overlay!.file}`])
})

test("first start after metadata.json: its version is carried on, raised only if the layers differ", async () => {
    // forget the registry and the overlay, as on a server that ran the old mods code
    settings.setStoredText("assets.version", null)
    settings.setStoredText("assets.layers", null)
    settings.setStoredText("assets.i18n_served.en", null)
    rmSync(path.join(overlayDir, "en"), { recursive: true })
    const mods = ["a_mod.zip", "b_mod.zip"].map(name => {
        const data = readFileSync(path.join(process.env.CDN_DIR!, "mods", name))
        return { location: `{$cdnAddress}/mods/${name}`, size: data.length, sha256: createHash("sha256").update(data).digest("base64") }
    })
    // the old code kept the directory's order, not necessarily sorted
    writeFileSync(path.join(process.env.CDN_DIR!, "metadata.json"), JSON.stringify({ version: 140, mods: [mods[1], mods[0]] }))
    assert.equal(restart("off").versionString, "2.1.140")
    assert.deepEqual((await update("en")).files, ["mods/a_mod.zip", "mods/b_mod.zip"])
    // from now on the registry has its own record; metadata.json is not read again
    writeFileSync(path.join(process.env.CDN_DIR!, "metadata.json"), JSON.stringify({ version: 300, mods: [] }))
    assert.equal(restart("off").versionString, "2.1.140")

    settings.setStoredText("assets.version", null)
    settings.setStoredText("assets.layers", null)
    writeFileSync(path.join(process.env.CDN_DIR!, "metadata.json"), JSON.stringify({ version: 141, mods: [mods[0]] }))
    assert.equal(restart("off").versionString, "2.1.142")
})
