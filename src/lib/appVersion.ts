// SH-15: Reflipped app versions and build IDs, as the AIR shell reports them (client/air-shell/VERSION, build.py).
//
// The app version scheme is defined by client/air-shell/build.py (`app_version`, `version_code`), and the app's
// AppVersion.java follows it too: MAJOR.MINOR.PATCH with an optional pre-release `-alpha`, `-beta` or `-pre`, optionally
// followed by `.N` (0.2.0, 0.2.0-alpha, 0.2.0-beta.3, 1.0.0-pre.1). Leading zeros are dropped; anything else is refused.
// Each version maps to its Android version code, which also orders versions as semver does:
//     code = MAJOR * 1000000 + MINOR * 10000 + PATCH * 100 + stage
// with stage alpha.N = N, beta.N = 30 + N, pre.N = 60 + N (a missing N is 0; N is 0-29) and 99 for a final release;
// MINOR and PATCH are 0-99 and MAJOR 0-999 (ADT's limit for a versionNumber part; build.py writes the code as one).
// 0.2.0-alpha < 0.2.0-alpha.1 < 0.2.0-beta < 0.2.0-pre.1 < 0.2.0 < 0.2.1-alpha < 0.2.1.

/** The request headers the shell sends on /shell/config and at sign-in. */
export const APP_VERSION_HEADER = "reflipped-app-version"
export const APP_BUILD_HEADER = "reflipped-app-build"

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-(alpha|beta|pre)(?:\.(\d{1,6}))?)?$/
const STAGE_BASE = { alpha: 0, beta: 30, pre: 60 } as const
const MAX_MAJOR = 999, MAX_MINOR = 99, MAX_PATCH = 99, MAX_STAGE_NUMBER = 29, FINAL_STAGE = 99
/** commit[-dirty].yyyymmdd.baked|picker from build.py; any short token of these characters is kept as given */
const BUILD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/

export interface AppVersion {
    /** The normalized text, e.g. "0.2.0-beta.1" */
    text: string
    /** The Android version code, which orders versions (see the scheme above) */
    code: number
}

/** The version, or null when it isn't one the scheme above accepts. */
export function parseAppVersion(text: unknown): AppVersion | null {
    if (typeof text !== "string") return null
    const match = VERSION.exec(text.trim())
    if (!match) return null
    const [major, minor, patch] = [match[1], match[2], match[3]].map(Number)
    const stage = match[4] as keyof typeof STAGE_BASE | undefined
    const number = match[5] === undefined ? undefined : Number(match[5])
    if (major > MAX_MAJOR || minor > MAX_MINOR || patch > MAX_PATCH || (number ?? 0) > MAX_STAGE_NUMBER) return null
    const stageCode = stage === undefined ? FINAL_STAGE : STAGE_BASE[stage] + (number ?? 0)
    return {
        text: `${major}.${minor}.${patch}` + (stage === undefined ? "" : `-${stage}`) + (number === undefined ? "" : `.${number}`),
        code: major * 1000000 + minor * 10000 + patch * 100 + stageCode
    }
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
export function compareAppVersions(a: AppVersion, b: AppVersion): number {
    return a.code - b.code
}

/** The normalized version text ("0.1.0", "0.2.0-beta.1"), or null. */
export function normalizeAppVersion(text: unknown): string | null {
    return parseAppVersion(text)?.text ?? null
}

/** A build ID safe to store and show, or null. */
export function normalizeAppBuild(text: unknown): string | null {
    if (typeof text !== "string") return null
    const value = text.trim()
    return BUILD.test(value) ? value : null
}

export interface ReportedApp {
    version: string
    build: string | null
}

/** What a request says about the app that sent it: null when it names no valid version (an older app, or the original game). */
export function reportedApp(headers: Record<string, string | string[] | undefined>): ReportedApp | null {
    const one = (value: string | string[] | undefined) => Array.isArray(value) ? undefined : value
    const version = normalizeAppVersion(one(headers[APP_VERSION_HEADER]))
    if (version === null) return null
    return { version, build: normalizeAppBuild(one(headers[APP_BUILD_HEADER])) }
}
