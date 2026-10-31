import { createHash, randomUUID } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { pack, unpack } from "msgpackr";
import type { FastifyInstance } from "fastify";
import type { BuildOptions } from "../src/app";

const docsRoutesDir = path.join(__dirname, "..", "docs", "routes")

export interface CapturedRoute {
    requestHeaders: Record<string, string>
    requestBody: any
    responseHeaders: Record<string, string>
    responseBody: any
}

function parseHeaderBlock(block: string): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const line of block.split("\n")) {
        const separator = line.indexOf(":")
        if (separator <= 0) continue
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
    }
    return headers
}

function parseBodyBlock(block: string): any {
    const trimmed = block.trim()
    if (trimmed === "" || trimmed.startsWith("No ")) return undefined
    return JSON.parse(trimmed)
}

/**
 * Reads a captured route from `docs/routes/<name>.md`.
 * The docs hold four fenced blocks in order: request headers, request body, response headers, response body.
 * Redacted values are left as the string "<redacted>"; callers replace the ones they need.
 */
export function readCapturedRoute(name: string): CapturedRoute {
    const markdown = readFileSync(path.join(docsRoutesDir, `${name}.md`), "utf-8")
    const blocks = [...markdown.matchAll(/```\n([\s\S]*?)```/g)].map(match => match[1])
    if (blocks.length < 4) throw new Error(`docs/routes/${name}.md has ${blocks.length} fenced blocks, expected 4`)

    return {
        requestHeaders: parseHeaderBlock(blocks[0]),
        requestBody: parseBodyBlock(blocks[1]),
        responseHeaders: parseHeaderBlock(blocks[2]),
        responseBody: parseBodyBlock(blocks[3])
    }
}

/**
 * Points the database and CDN at fresh temporary directories, then builds the game server (`fastify`)
 * and the admin server (`admin`, web UI and `/api/*`).
 * The CDN directory starts empty; tests may write files into `process.env.CDN_DIR`.
 * `options` (e.g. `rateLimit`, `trustProxy`, `paramCheck`) go to both servers; rate limiting is off by default and
 * `PARAM_CHECK` is `log` (most tests send unsigned requests; test/requestSignature.test.ts covers `enforce`).
 * Must run before anything imports `src/data`, because the database opens at import time.
 */
export async function createTestServer(options: BuildOptions = {}): Promise<{ fastify: FastifyInstance, admin: FastifyInstance, cleanup: () => Promise<void> }> {
    const tempDir = mkdtempSync(path.join(tmpdir(), "reflipped-test-"))
    process.env.DATABASE_DIR = path.join(tempDir, "database")
    process.env.CDN_DIR = path.join(tempDir, "cdn")
    mkdirSync(process.env.CDN_DIR)
    // the translation overlay is on by default: never pick up one built in the checkout's .cdn-overlay
    process.env.CDN_OVERLAY_DIR ??= path.join(tempDir, "cdn-overlay")
    // exact timestamps in assertions: a frozen server clock unless the test picked one
    process.env.SERVER_CLOCK ??= "frozen"

    const { buildAdminServer, buildServer } = await import("../src/app")
    const fastify = buildServer({ paramCheck: "log", ...options })
    const admin = buildAdminServer(options)
    await fastify.ready()
    await admin.ready()

    return {
        fastify,
        admin,
        cleanup: async () => {
            await fastify.close()
            await admin.close()
            rmSync(tempDir, { recursive: true, force: true })
        }
    }
}

/** Encodes a game API request body the way the client does: base64 msgpack. */
export function encodeGameBody(body: unknown): string {
    return pack(body).toString("base64")
}

/** Decodes a base64 msgpack game API response body. */
export function decodeGameBody(payload: string): any {
    return unpack(Buffer.from(payload, "base64"))
}

/** Headers the game client sends on every API request, taken from the /load capture. */
export function gameHeaders(udid: string): Record<string, string> {
    const captured = readCapturedRoute("load").requestHeaders
    return {
        "content-type": "application/x-www-form-urlencoded",
        "udid": udid,
        "short_udid": captured["short_udid"],
        "app_ver": captured["app_ver"],
        "res_ver": captured["res_ver"],
        "device": captured["device"],
        "device_lang": captured["device_lang"]
    }
}

/**
 * Headers for a signed game request, as the client sends them after signup: `GAME-APP-ID` and
 * `PARAM = sha1_hex(UDID + viewer_id + path + body)` (docs/apk-analysis.md, "Request signing").
 */
export function signedGameHeaders(udid: string, viewerId: number, path: string, payload: string): Record<string, string> {
    return {
        ...gameHeaders(udid),
        "game-app-id": String(viewerId),
        "param": createHash("sha1").update(udid + viewerId + path + payload).digest("hex")
    }
}

export interface TestPlayer {
    udid: string
    zat: string
    viewerId: number
}

/** Logs in a new guest device and signs it up, as the client does on first launch. */
export async function createTestPlayer(fastify: FastifyInstance): Promise<TestPlayer> {
    const deviceId = randomUUID()
    const udid = randomUUID().toUpperCase()

    const login = await fastify.inject({
        method: "POST",
        url: "/openapi/service/v4/auth/loginDevice",
        headers: { "content-type": "application/json;charset=UTF-8" },
        payload: { ...readCapturedRoute("service_v4_auth_loginDevice").requestBody, deviceId, idpId: deviceId, whiteKey: randomUUID(), accessToken: "" }
    })
    if (login.statusCode !== 200) throw new Error(`loginDevice failed: ${login.body}`)
    const zat: string = login.json().zat

    const captured = readCapturedRoute("load").requestBody
    const signup = await fastify.inject({
        method: "POST",
        url: "/latest/api/index.php/tool/signup",
        headers: gameHeaders(udid),
        payload: encodeGameBody({
            app_secret: captured.app_secret,
            access_token: zat,
            storage_directory_path: captured.storage_directory_path,
            app_admin: captured.app_admin,
            kakao_pid: captured.kakao_pid,
            device_id: captured.device_id,
            idp_code: "zd3"
        })
    })
    if (signup.statusCode !== 200) throw new Error(`signup failed: ${signup.body}`)

    return { udid, zat, viewerId: decodeGameBody(signup.body).data_headers.viewer_id }
}
