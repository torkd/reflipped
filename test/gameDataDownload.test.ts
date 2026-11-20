// SH-25: whether a server offers the game's base files (`/shell/config` assets.download), the GAME_DATA_DOWNLOAD
// switch that stops it handing them out, and the game data pack tool's list digests the app pins.
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { createTestServer } from "./helpers"

async function assets(server: Awaited<ReturnType<typeof createTestServer>>) {
    const response = await server.fastify.inject({ method: "GET", url: "/shell/config" })
    assert.equal(response.statusCode, 200)
    return response.json().assets as { base: string, download: boolean }
}

function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
    const before = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    return run().finally(() => {
        if (before === undefined) delete process.env[name]
        else process.env[name] = before
    })
}

test("a server without the base archives doesn't offer the download; one with them does", async () => {
    await withEnv("GAME_DATA_DOWNLOAD", undefined, () => withEnv("SHELL_CDN", undefined, async () => {
        const server = await createTestServer()
        try {
            assert.equal((await assets(server)).download, false)
            mkdirSync(path.join(process.env.CDN_DIR!, "en", "archive-android-full"), { recursive: true })
            assert.equal((await assets(server)).download, true)
        } finally {
            await server.cleanup()
        }
    }))
})

test("an external CDN offers the download", async () => {
    await withEnv("GAME_DATA_DOWNLOAD", undefined, () => withEnv("SHELL_CDN", "https://cdn.example.org/patch/Live/2.0.0", async () => {
        const server = await createTestServer()
        try {
            assert.equal((await assets(server)).download, true)
        } finally {
            await server.cleanup()
        }
    }))
})

test("GAME_DATA_DOWNLOAD=off: no download reported, the CDN route serves only the mods", async () => {
    await withEnv("GAME_DATA_DOWNLOAD", "off", () => withEnv("SHELL_CDN", undefined, async () => {
        const server = await createTestServer()
        try {
            const cdn = process.env.CDN_DIR!
            mkdirSync(path.join(cdn, "en", "archive-android-full"), { recursive: true })
            writeFileSync(path.join(cdn, "en", "archive-android-full", "asset-2.1.0-1-test.zip"), "base")
            mkdirSync(path.join(cdn, "mods"), { recursive: true })
            writeFileSync(path.join(cdn, "mods", "mod.zip"), "mod")
            assert.equal((await assets(server)).download, false)
            const base = await server.fastify.inject({ method: "GET", url: "/patch/Live/2.0.0/en/archive-android-full/asset-2.1.0-1-test.zip" })
            assert.equal(base.statusCode, 404)
            const mod = await server.fastify.inject({ method: "GET", url: "/patch/Live/2.0.0/mods/mod.zip" })
            assert.equal(mod.statusCode, 200)
            assert.equal(mod.body, "mod")
        } finally {
            await server.cleanup()
        }
    }))
})

test("the app pins the digests of the official asset lists that npm run gamepack writes", async () => {
    // @ts-ignore: a plain ES module script without types
    const { archiveList, listDigest } = await import("../scripts/gamepack.mjs")
    const java = readFileSync(path.join(__dirname, "..", "client", "air-shell", "java", "src", "reflipped", "shell",
        "pinball", "GamePack.java"), "utf8")
    for (const lang of ["en", "ko", "th"]) {
        const { archives } = archiveList(lang)
        const pinned = new RegExp(`lists\\.put\\("${lang}", "([0-9a-f]{64})"\\)`).exec(java)
        assert.ok(pinned, `GamePack.java pins ${lang}`)
        assert.equal(listDigest(archives), pinned[1], `${lang}: run npm run gamepack -- --digests and update GamePack.java`)
        assert.equal(archives[0].path.startsWith(`${lang}/archive-android-full/`), true)
    }
})
