import { FastifyInstance } from "fastify";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { dataPath } from "../lib/paths";
import { DATA_PACK_FORMAT, PackDescriptor } from "../lib/dataPack";
import { requestOrigin } from "./shell";

/**
 * An online server offers its data pack for download (SH-13 step 3, docs/on-device-server.md "Server data pack"), so the
 * app's Local play setup can fetch it. `DATA_PACK_SERVE_DIR` names the folder `npm run datapack -- --out <dir>` wrote
 * (the archive and its descriptor); unset, both routes answer 404. The pack holds the data the app's server needs
 * and is the same for every server of one version, so the choice of server only decides where it comes from.
 *
 *   GET /shell/datapack        the descriptor plus the archive's URL on the address the app asked
 *   GET /shell/datapack/<file> the archive; the app checks it against the descriptor's size and SHA-256
 */
const DESCRIPTOR_RE = /^reflipped-datapack-[\w.-]+\.json$/
const ARCHIVE_RE = /^reflipped-datapack-[\w.-]+\.zip$/

function serveDir(): string | null {
    const setting = (process.env.DATA_PACK_SERVE_DIR ?? "").trim()
    return setting === "" ? null : dataPath(setting)
}

function versionKey(version: string): number[] {
    return version.split(".").map(Number)
}

/** The descriptor of the newest pack in the folder whose archive is there, whole; null if there is none. */
export function servedPack(): { descriptor: PackDescriptor, archive: string } | null {
    const dir = serveDir()
    if (!dir || !existsSync(dir)) return null
    let best: { descriptor: PackDescriptor, archive: string } | null = null
    for (const name of readdirSync(dir).filter(n => DESCRIPTOR_RE.test(n))) {
        let d: PackDescriptor
        try { d = JSON.parse(readFileSync(path.join(dir, name), "utf8")) } catch { continue }
        if (!d || d.format !== DATA_PACK_FORMAT || typeof d.archive !== "string" || !ARCHIVE_RE.test(d.archive)
            || typeof d.cdnVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(d.cdnVersion)
            || !Number.isSafeInteger(d.size) || !/^[0-9a-f]{64}$/.test(d.sha256)) continue
        const archive = path.join(dir, d.archive)
        try { if (statSync(archive).size !== d.size) continue } catch { continue }
        if (!best || compare(versionKey(d.cdnVersion), versionKey(best.descriptor.cdnVersion)) > 0) best = { descriptor: d, archive }
    }
    return best
}

function compare(a: number[], b: number[]): number {
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

const routes = async (fastify: FastifyInstance) => {
    fastify.addHook("onRequest", async (_request, reply) => { reply.header("cache-control", "no-store") })
    fastify.get("/", { config: { gameAuth: "none" } }, (request, reply) => {
        const pack = servedPack()
        const origin = requestOrigin(request)
        if (!pack || !origin) return reply.code(404).send({ error: "Not Found" })
        const { format, cdnVersion, size, sha256, manifestSha256, assetsDigest, archive } = pack.descriptor
        return reply.send({ format, cdnVersion, size, sha256, manifestSha256, assetsDigest, url: `${origin}/shell/datapack/${archive}` })
    })
    fastify.get<{ Params: { file: string } }>("/:file", {
        config: { gameAuth: "none" },
        schema: { params: { type: "object", properties: { file: { type: "string", pattern: "^reflipped-datapack-[\\w.-]+\\.zip$", maxLength: 100 } }, required: ["file"] } }
    }, (request, reply) => {
        const pack = servedPack()
        if (!pack || pack.descriptor.archive !== request.params.file) return reply.code(404).send({ error: "Not Found" })
        return reply.type("application/zip").header("content-length", pack.descriptor.size)
            .header("etag", `"${pack.descriptor.sha256}"`).header("cache-control", "no-cache")
            .header("x-content-type-options", "nosniff").send(createReadStream(pack.archive))
    })
}
export default routes
