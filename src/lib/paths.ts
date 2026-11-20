import path from "path";

/**
 * Where the server finds its files (SH-13 step 2). Two kinds:
 * - files that ship with the code (`assets/`, `web/`, `i18n/`, `build-info.json`): under the app root, found from this
 *   file's own location, so they work whatever the working directory is;
 * - data the server writes or is given (`DATABASE_DIR`, `CDN_DIR`, `CDN_OVERLAY_DIR`, `LOG_FILE`, …): a relative
 *   setting is taken from the working directory, as the systemd unit, the container and `npm run dev` already run in the
 *   repository. The on-device server's launcher sets it to the app's private storage.
 *
 * The esbuild bundle (`scripts/bundle.mjs`) defines `REFLIPPED_BUNDLE`: there `server.js` sits in the app root, beside
 * `assets/` and `web/`. Built with tsc (`out/lib/paths.js`) or run from the sources (`src/lib/paths.ts`), the root is
 * two folders up. A bundle built with `--no-assets` has no `assets/` beside it: it reads them from the data pack
 * (`DATA_PACK_DIR`, src/lib/dataPack.ts), and `assetPath()` says where.
 */
declare const REFLIPPED_BUNDLE: boolean | undefined
/** Set by `scripts/bundle.mjs --no-assets`: the converted game data is not beside `server.js` but in the data pack. */
declare const REFLIPPED_PACK_ASSETS: string | undefined

const bundled = typeof REFLIPPED_BUNDLE !== "undefined" && REFLIPPED_BUNDLE

/** The folder holding the server's code: the bundle's folder, `out/` (tsc) or `src/` (tsx). */
const codeDirectory = bundled ? __dirname : path.resolve(__dirname, "..")

/** The folder holding `assets/`, `web/` and `i18n/`: the repository, or the bundle's folder. */
const rootDirectory = bundled ? __dirname : path.resolve(__dirname, "..", "..")

export function codeDir(): string {
    return codeDirectory
}

export function appRoot(): string {
    return rootDirectory
}

/** A file or folder that ships with the code, e.g. `appPath("web", "public")`. */
export function appPath(...parts: string[]): string {
    return path.join(rootDirectory, ...parts)
}

/** A file of the converted game data (`assets/`): beside the code, or in the data pack for a bundle without them. */
export function assetPath(...parts: string[]): string {
    if (typeof REFLIPPED_PACK_ASSETS === "undefined") return appPath("assets", ...parts)
    const pack = (process.env.DATA_PACK_DIR ?? "").trim()
    if (pack === "") throw new Error("this server build ships without the game data (assets/): set DATA_PACK_DIR to the data pack")
    return path.join(dataPath(pack), "assets", ...parts)
}

/** A data path from a setting: absolute as given, or relative to the working directory. */
export function dataPath(setting: string): string {
    return path.resolve(setting)
}

/** `DATABASE_DIR` (default `.database`), absolute. */
export function databaseDir(): string {
    return dataPath(process.env.DATABASE_DIR || ".database")
}

/** `CDN_DIR` (default `.cdn`), absolute. */
export function cdnDir(): string {
    return dataPath(process.env.CDN_DIR || ".cdn")
}
