/**
 * Run profiles (SH-13, docs/on-device-server.md "Local-mode settings"). `REFLIPPED_PROFILE=local` is the server inside
 * the Reflipped app, for one player on the same phone: it fills in defaults for the settings below that are not set,
 * so the app's launcher passes one variable instead of a list. Anything set explicitly still wins. The default
 * profile, `server`, changes nothing.
 *
 * Imported first by src/server.ts, before any module reads its settings (the database opens on import).
 */

export type ServerProfile = "server" | "local"

/** What the local profile sets when the variable is unset. */
export const LOCAL_PROFILE_DEFAULTS: Readonly<Record<string, string>> = {
    // only the phone itself reaches the server; the co-op socket follows LISTEN_HOST
    LISTEN_HOST: "127.0.0.1",
    ADMIN_HOST: "127.0.0.1",
    // no admin site until the app opens it with a one-time login (SH-13 step 5): every app on the phone reaches
    // 127.0.0.1, and on a new server the first one to POST /setup would become its admin
    ADMIN_PORT: "0",
    // one player: the per-address limits only get in the way; a small hourly cap on new accounts still stops another
    // app on the phone from flooding sign-ups (security review 2026-11-13)
    RATE_LIMIT: "0",
    NEW_ACCOUNTS_PER_HOUR: "30",
    // warnings and errors to the console (Android's log); no log file growing in the app's storage
    LOG_LEVEL: "warn",
    LOG_FILE: "",
    // the event overlay cache: 100 MB instead of 1 GiB
    SCHEDULE_ASSET_CACHE_BYTES: String(100 * 1024 * 1024)
}

/** `REFLIPPED_PROFILE`: `local`, or `server` (the default, also for an unknown value). */
export function serverProfile(value = process.env.REFLIPPED_PROFILE): ServerProfile {
    return value?.trim().toLowerCase() === "local" ? "local" : "server"
}

export function isLocalProfile(): boolean {
    return serverProfile() === "local"
}

/** Fills in the profile's defaults for the settings `env` doesn't have; returns the names it set. */
export function applyProfileDefaults(env: NodeJS.ProcessEnv = process.env): string[] {
    if (serverProfile(env.REFLIPPED_PROFILE) !== "local") return []
    const applied: string[] = []
    for (const [name, value] of Object.entries(LOCAL_PROFILE_DEFAULTS)) {
        if (env[name] !== undefined) continue
        env[name] = value
        applied.push(name)
    }
    return applied
}
