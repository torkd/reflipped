import { FastifyInstance, FastifyRequest } from "fastify";
import { getTextSetting } from "../data/serverSettings";
import { isSameSiteRequest } from "../lib/adminGuard";
import { shellSession } from "../lib/shellSession";
import { getEventPolicy } from "../lib/eventPolicy";
import { scheduledContentEnabled } from "../lib/eventSchedule";
import { jsonBody, query } from "./schemas";
import { thumbnailUrl, uploadedThumbnailData } from "../data/serverThumbnail";
import { reportedApp } from "../lib/appVersion";
import { shellHandshake } from "../lib/shellHandshake";
import { isLocalProfile } from "../lib/serverProfile";
import { BASE_ASSET_VERSION, getAssetLayers } from "../lib/assetLayers";
import { servedPack } from "./datapackServe";
import { gameDataDownloadOffered } from "../lib/gameDataDownload";
import { buildRestoreArchive, MAX_RESTORE_PATHS, RESTORE_LANGS, RestoreLang, restoreAvailable, restoreLangs, RestoreTooLargeError } from "../lib/baseRestore";

/**
 * What the app needs to tell whether game files downloaded from another server can stay (SH-13): the base files every
 * Reflipped server lists (`2.1.<BASE_ASSET_VERSION>`), and the layers this server puts on top. A server whose schedule
 * layer rewrites the date-bearing masters and that has no other layers replaces whatever another server's schedule
 * layer left; translation overlays and mods would stay behind, so the app downloads everything again then.
 * `download` (SH-25): whether this server hands out the base files; without them the app installs a game data pack.
 * `restore` (SH-27): the languages whose base copies this server can send (`POST /shell/restore`), so files with another
 * server's overlays or mods can stay too: the app puts back what those layers changed instead of downloading everything.
 */
export function assetsInfo(): { base: string, schedule: boolean, layers: boolean, download: boolean, restore: RestoreLang[] } {
    let layers = false
    try {
        layers = Object.values(getAssetLayers().layers).some(list => list.length > 0)
    } catch {
        layers = true // unknown: the app plays safe
    }
    return { base: `2.1.${BASE_ASSET_VERSION}`, schedule: scheduledContentEnabled(), layers, download: gameDataDownloadOffered(), restore: restoreLangs() }
}

/**
 * The address the app asked for, as an origin ("https://wf.example.org"), or null. Like the asset base URL
 * (src/routes/api/asset.ts), it follows TRUST_PROXY for the scheme, so the app is sent back to the address it used.
 */
export function requestOrigin(request: FastifyRequest): string | null {
    try {
        const url = new URL(`${request.protocol}://${request.host}`)
        return url.username || url.password || url.pathname !== "/" || url.search || url.hash ? null : url.origin
    } catch { return null }
}

/** Public pre-login metadata stays additive for older shells. No account or administrator information here. */
const routes = async (fastify: FastifyInstance) => {
    fastify.addHook("onRequest", async (_request, reply) => { reply.header("cache-control", "no-store") })
    // SH-15: the app names its version and build in headers (src/lib/appVersion.ts); the reply carries the handshake
    // (server version and commit, shell protocol, oldest supported app version) for the app to check
    fastify.get("/config", { config: { gameAuth: "none" } }, (request, reply) => {
        // Report the active scheduling policy, independently of the owner's free-text card label.
        const policy = scheduledContentEnabled() ? getEventPolicy() : null
        const progression = { mode: policy?.mode ?? "legacy", acceleration: policy?.mode === "accelerated" ? policy.acceleration : 1 }
        // the server on the phone (SH-13): the app signs in by device, without the portal page
        const local = isLocalProfile()
        reply.status(200).send({
            reflipped: 1, name: getTextSetting("server.name"), description: getTextSetting("server.description"),
            ...shellHandshake(reportedApp(request.headers)),
            type: getTextSetting("server.type"), thumbnail: thumbnailUrl(requestOrigin(request)), mode: local ? "local" : "online", progression,
            cdn: process.env.SHELL_CDN || null, portal: local ? 0 : 1,
            // SH-13: whether downloaded game files fit this server, and whether it offers the data pack for Local play
            assets: assetsInfo(), datapack: servedPack() === null ? 0 : 1,
            login: { account: !local, guest: true, local }
        })
    })
    // The server card image uploaded on the admin Settings page (src/data/serverThumbnail.ts). `v` names the version, so
    // a new upload gets a new URL and the reply may be cached; the app never follows redirects or sends credentials.
    fastify.get("/thumbnail", { config: { gameAuth: "none" }, schema: query({ v: { type: "string", maxLength: 64 } }) }, (_request, reply) => {
        const upload = uploadedThumbnailData()
        if (upload === null) return reply.code(404).send({ error: "Not Found" })
        return reply.header("cache-control", "public, max-age=86400")
            .header("x-content-type-options", "nosniff")
            .header("content-security-policy", "default-src 'none'; sandbox")
            .type(upload.image.type).send(upload.data)
    })
    // SH-27: the base copies of the files another server's layers wrote or deleted (src/lib/baseRestore.ts). `base` is
    // the `assets.base` of the server the files came from; another base can't be restored, the app downloads everything.
    fastify.post("/restore", {
        config: { gameAuth: "none" },
        bodyLimit: 8 * 1024 * 1024,
        schema: jsonBody({
            lang: { type: "string", enum: [...RESTORE_LANGS] },
            base: { type: "string", maxLength: 32 },
            paths: { type: "array", maxItems: MAX_RESTORE_PATHS, items: { type: "string", minLength: 1, maxLength: 256, pattern: "^(?!.*(^|/)\\.\\.?(/|$))[\\w./-]+$" } }
        }, ["lang", "base", "paths"])
    }, (request, reply) => {
        const { lang, base, paths } = request.body as { lang: RestoreLang, base: string, paths: string[] }
        if (base !== `2.1.${BASE_ASSET_VERSION}`) return reply.code(409).send({ error: "Conflict", message: "other base files" })
        if (!restoreAvailable(lang)) return reply.code(404).send({ error: "Not Found" })
        let result: ReturnType<typeof buildRestoreArchive>
        try {
            result = buildRestoreArchive(lang, paths)
        } catch (error) {
            if (error instanceof RestoreTooLargeError) return reply.code(413).send({ error: "Payload Too Large", message: error.message })
            throw error
        }
        request.log.info({ lang, paths: paths.length, restored: result.restored, removed: result.removed, bytes: result.archive.length }, "restore archive sent")
        return reply.type("application/zip").header("x-content-type-options", "nosniff")
            .header("x-restored", result.restored).header("x-removed", result.removed).send(result.archive)
    })
    // The current device secret proves the account. Viewer IDs, cookies and playerid headers never confer a role.
    fastify.post("/session", { schema: jsonBody({ whiteKey: { type: "string", minLength: 16, maxLength: 128 } }, ["whiteKey"]) }, (request, reply) => {
        if (!isSameSiteRequest(request)) return reply.code(403).send({ error: "Forbidden" })
        return reply.send(shellSession(request, (request.body as { whiteKey: string }).whiteKey))
    })
}
export default routes
