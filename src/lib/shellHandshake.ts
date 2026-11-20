// SH-15: the version handshake between the Reflipped app and the server. The app sends its version and build ID
// (src/lib/appVersion.ts headers) with /shell/config and at sign-in; /shell/config answers with the server's version,
// the shell protocol and the oldest app version the server supports. The app compares them itself and shows "This
// server needs a newer Reflipped app" instead of joining; nothing here refuses a request. The optional update notice
// (latestAppVersion, updateAvailable, updateUrl, updateNotes) only tells an older app that a newer one exists.
import { getTextSetting } from "../data/serverSettings";
import { compareAppVersions, normalizeAppVersion, parseAppVersion, ReportedApp } from "./appVersion";
import { getServerVersion, SHELL_PROTOCOL } from "./serverVersion";

/** The admin setting `shell.min_app_version`, or null when every version is accepted. */
export function minimumAppVersion(): string | null {
    return normalizeAppVersion(getTextSetting("shell.min_app_version"))
}

/** Whether the server accepts this app; null when the request named no version (an older app or another client). */
export function appSupported(app: ReportedApp | null): boolean | null {
    if (app === null) return null
    const minimum = parseAppVersion(minimumAppVersion())
    return minimum === null || compareAppVersions(parseAppVersion(app.version)!, minimum) >= 0
}

/** The default update page: the public build guide. */
export const DEFAULT_UPDATE_URL = "https://github.com/torkd/reflipped/blob/main/docs/connecting-air-shell.md"

/**
 * The newest app version the owner announces (`shell.latest_app_version`), or null for none. One lower than the
 * oldest supported version makes no sense (the app couldn't join), so it is raised to that.
 */
export function latestAppVersion(): string | null {
    const latest = parseAppVersion(getTextSetting("shell.latest_app_version"))
    if (latest === null) return null
    const minimum = parseAppVersion(minimumAppVersion())
    return (minimum !== null && compareAppVersions(latest, minimum) < 0 ? minimum : latest).text
}

/** Whether a newer app is announced than the one that asked; null when the request named no version. */
export function updateAvailable(app: ReportedApp | null): boolean | null {
    if (app === null) return null
    const latest = parseAppVersion(latestAppVersion())
    return latest !== null && compareAppVersions(parseAppVersion(app.version)!, latest) < 0
}

/**
 * The APK the app may download and install itself (`shell.update_apk_url` with its `shell.update_apk_sha256`), or
 * null when the owner set no complete pair. The app checks the hash, the package and the signing key itself, and
 * Android's installer asks the player.
 */
export function updateApk(): { url: string, sha256: string } | null {
    const url = getTextSetting("shell.update_apk_url")
    const sha256 = getTextSetting("shell.update_apk_sha256").toLowerCase()
    return url !== "" && /^[0-9a-f]{64}$/.test(sha256) ? { url, sha256 } : null
}

/** The update notice fields of /shell/config: all null while no newer version is announced. */
export function updateNotice(app: ReportedApp | null) {
    const latest = latestAppVersion()
    return {
        latestAppVersion: latest,
        updateAvailable: updateAvailable(app),
        updateUrl: latest === null ? null : getTextSetting("shell.update_url") || DEFAULT_UPDATE_URL,
        updateNotes: latest === null ? null : getTextSetting("shell.update_notes") || null,
        updateApk: latest === null ? null : updateApk()
    }
}

/** The handshake fields of /shell/config. */
export function shellHandshake(app: ReportedApp | null) {
    const { version, commit } = getServerVersion()
    return { version, commit, protocol: SHELL_PROTOCOL, minAppVersion: minimumAppVersion(), appSupported: appSupported(app), ...updateNotice(app) }
}
