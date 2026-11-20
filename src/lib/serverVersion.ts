// SH-15: what this server reports about itself: its release version (package.json), the commit it was built from and
// the shell protocol version. The commit comes from out/build-info.json, written by `npm run build`
// (scripts/build-info.mjs), so the running server needs neither git nor a .git folder; REFLIPPED_COMMIT overrides it.
import { readFileSync } from "fs";
import path from "path";
import { codeDir } from "./paths";
import { version } from "../../package.json";

/**
 * The shell protocol: what /shell/config, the sign-in and the shell's other requests mean. Bump it only for a change
 * an older Reflipped app can't handle; such an app then says it needs an update instead of failing later. Apps
 * declare the protocols they support (AppVersion.java in client/air-shell).
 */
export const SHELL_PROTOCOL = 1

export interface ServerVersion {
    /** the release version, e.g. 1.0.1 */
    version: string
    /** the short commit, with a `-dirty` suffix for a build with uncommitted changes; null when unknown */
    commit: string | null
    /** when it was built (ISO 8601), null when unknown */
    builtAt: string | null
}

const COMMIT = /^[0-9a-f]{7,40}(-dirty)?$/

function readBuildInfo(): { commit: string | null, builtAt: string | null } {
    try {
        const info = JSON.parse(readFileSync(path.join(codeDir(), "build-info.json"), "utf8")) as Record<string, unknown>
        return {
            commit: typeof info.commit === "string" && COMMIT.test(info.commit) ? info.commit : null,
            builtAt: typeof info.builtAt === "string" && !Number.isNaN(Date.parse(info.builtAt)) ? info.builtAt : null
        }
    } catch {
        // run from the sources (tsx, ts-node-dev) or built without the script
        return { commit: null, builtAt: null }
    }
}

let cached: ServerVersion | null = null

export function getServerVersion(): ServerVersion {
    if (cached) return cached
    const info = readBuildInfo()
    const override = process.env.REFLIPPED_COMMIT?.trim().toLowerCase()
    cached = { version, commit: override && COMMIT.test(override) ? override : info.commit, builtAt: info.builtAt }
    return cached
}

/** "1.0.1 (abc123def456)", or "1.0.1" without a known commit. */
export function serverVersionText(): string {
    const { version, commit } = getServerVersion()
    return commit ? `${version} (${commit})` : version
}
