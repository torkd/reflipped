import { existsSync } from "node:fs";
import path from "node:path";
import { cdnDir } from "./paths";

/**
 * SH-25: whether this server hands out the game's base files (about 10 GB), reported to the app in `/shell/config`
 * (`assets.download`). Players of a server that doesn't install them from a game data pack (`npm run gamepack`,
 * docs/game-data-pack.md), which the app offers on every server; the server's own layers (schedule, translation, mods,
 * the Chinese CDN's files) don't need the base files and are always served.
 *
 * - `GAME_DATA_DOWNLOAD=off`: never, even with the files (an owner saving the traffic); the CDN route then serves only
 *   `mods/` (src/app.ts).
 * - otherwise: when the app is pointed at another CDN (`SHELL_CDN`), or the local CDN folder holds a language's full
 *   archives (`<CDN_DIR>/<lang>/archive-android-full`).
 */
export function downloadsDisabled(): boolean {
    return (process.env.GAME_DATA_DOWNLOAD ?? "").trim().toLowerCase() === "off"
}

export function gameDataDownloadOffered(): boolean {
    if (downloadsDisabled()) return false
    if ((process.env.SHELL_CDN ?? "").trim() !== "") return true
    return ["en", "ko", "th"].some(lang => existsSync(path.join(cdnDir(), lang, "archive-android-full")))
}
