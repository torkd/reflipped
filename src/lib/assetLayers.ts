/**
 * Asset layers (I18N-3; docs/modding.md, docs/i18n.md "Overlay"): the archives `asset/get_path` sends on top of
 * the game's own assets, and the asset version that announces them.
 *
 * Per device language, in the order the client extracts them (a later archive overwrites a file of an earlier one):
 *  - `restore`: original bytes of every file a translation overlay ever changed (`en` only, see below);
 *  - mods: every file in `<CDN_DIR>/mods/`, in file name order;
 *  - `overlay`: the translation overlay built by `npm run i18n:build` (`en` only, with `I18N=on`, the default;
 *    nothing is sent until an overlay has been built).
 * `I18N=off` sends no overlay; it still sends the restore archive once an overlay has been served,
 * so devices get the original files back. ko and th devices get the mods only (the overlay patches the en tables).
 *
 * Every change of these lists, in any language, raises the asset version (`2.1.<n>`, kept in `server_settings`),
 * never lowers or reuses it: a device on any other version gets the whole list again, which brings it to the
 * current state from any earlier one. The lists are read once, at startup: restart after adding a mod or
 * rebuilding the overlay. Before this registry the version and mods were kept in `<CDN_DIR>/metadata.json`; its
 * version is taken over on the first start and the file is no longer read or written after that.
 */
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { getStoredText, setStoredText } from "../data/serverSettings";

export interface AssetArchive {
    location: string
    size: number
    /** base64 SHA-256 (the client doesn't check it) */
    sha256: string
}

export type I18nMode = "on" | "off"

export interface AssetLayerState {
    /** patch number of the asset version: `2.1.<version>` */
    version: number
    versionString: string
    i18n: I18nMode
    mods: AssetArchive[]
    /** per device language: restore, mods, overlay */
    layers: Record<string, AssetArchive[]>
    /** the built overlay and restore archives per overlay language (whether sent or not) */
    built: Record<string, { overlay?: AssetArchive, restore?: AssetArchive }>
    /** the version was raised at this start */
    bumped: boolean
}

/** Version of the asset lists in `assets/asset_lists/` (what a fresh install ends on). */
export const BASE_ASSET_VERSION = 125
/** Device languages with their own asset lists. */
export const LAYER_LANGS = ["en", "ko", "th"] as const
/** Languages that get the translation overlay. */
export const OVERLAY_LANGS = ["en"] as const
/** URL path of the overlay folder under the CDN address (`/patch/Live/2.0.0`). */
export const OVERLAY_URL_DIR = "overlay"

const VERSION_KEY = "assets.version"
const LAYERS_KEY = "assets.layers"
const servedKey = (lang: string) => `assets.i18n_served.${lang}`

const repoRoot = path.join(__dirname, "..", "..")

/** `CDN_DIR`, relative to the repository root unless absolute. */
export function cdnRoot(): string {
    const dir = process.env.CDN_DIR || ".cdn"
    return path.isAbsolute(dir) ? dir : path.join(repoRoot, dir)
}

/** `CDN_OVERLAY_DIR` (default `.cdn-overlay`), relative to the repository root unless absolute. */
export function overlayRoot(): string {
    const dir = process.env.CDN_OVERLAY_DIR || ".cdn-overlay"
    return path.isAbsolute(dir) ? dir : path.join(repoRoot, dir)
}

/** `I18N`: `on` (the default since the device test, I18N-13) or `off`. */
export function i18nMode(): I18nMode {
    const value = (process.env.I18N ?? "").trim().toLowerCase()
    if (value === "off") return "off"
    if (value !== "" && value !== "on") console.warn(`I18N=${process.env.I18N} is not on or off; the overlay stays on (the default)`)
    return "on"
}

function archive(file: string, location: string): AssetArchive {
    const data = readFileSync(file)
    return { location, size: data.length, sha256: createHash("sha256").update(data).digest("base64") }
}

function readMods(cdn: string): AssetArchive[] {
    const dir = path.join(cdn, "mods")
    if (!existsSync(dir)) return []
    return readdirSync(dir)
        .filter(name => !name.startsWith(".") && statSync(path.join(dir, name)).isFile())
        .sort()
        .map(name => archive(path.join(dir, name), `{$cdnAddress}/mods/${name}`))
}

/** The overlay and restore archives the manifest of `<overlay root>/<lang>/` names, if they are there. */
function readOverlay(lang: string): { overlay?: AssetArchive, restore?: AssetArchive } {
    const dir = path.join(overlayRoot(), lang)
    const manifestFile = path.join(dir, "manifest.json")
    if (!existsSync(manifestFile)) return {}
    try {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { overlay?: { file?: string } | null, restore?: { file?: string } | null }
        const pick = (entry: { file?: string } | null | undefined) => {
            const file = entry?.file
            if (typeof file !== "string" || !/^[\w.-]+\.zip$/.test(file)) return undefined
            const full = path.join(dir, file)
            if (!existsSync(full)) {
                console.warn(`${manifestFile} names ${file}, which is missing; rebuild with npm run i18n:build`)
                return undefined
            }
            return archive(full, `{$cdnAddress}/${OVERLAY_URL_DIR}/${lang}/${file}`)
        }
        return { overlay: pick(manifest.overlay), restore: pick(manifest.restore) }
    } catch (error) {
        console.warn(`can't read ${manifestFile}: ${(error as Error).message}`)
        return {}
    }
}

function fingerprint(layers: Record<string, AssetArchive[]>): string {
    return JSON.stringify(Object.fromEntries(LAYER_LANGS.map(lang => [lang, (layers[lang] ?? []).map(a => [a.location, a.sha256])])))
}

/** The version and layers `<CDN_DIR>/metadata.json` (the registry before I18N-3) recorded, if any. */
function legacyMetadata(cdn: string): { version: number, fingerprint: string } | undefined {
    const file = path.join(cdn, "metadata.json")
    if (!existsSync(file)) return undefined
    try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown, mods?: AssetArchive[] }
        if (!Number.isInteger(data.version)) return undefined
        const mods = (Array.isArray(data.mods) ? data.mods : []).slice().sort((a, b) => (a.location < b.location ? -1 : 1))
        return { version: data.version as number, fingerprint: fingerprint(Object.fromEntries(LAYER_LANGS.map(lang => [lang, mods]))) }
    } catch (error) {
        console.warn(`can't read ${file}: ${(error as Error).message}`)
        return undefined
    }
}

/** Reads the mods and overlays, raises the version if the layers changed, and returns the result. */
export function computeAssetLayers(): AssetLayerState {
    const cdn = cdnRoot()
    const i18n = i18nMode()
    const mods = readMods(cdn)
    const layers: Record<string, AssetArchive[]> = {}
    const built: AssetLayerState["built"] = {}
    for (const lang of LAYER_LANGS) {
        if (!(OVERLAY_LANGS as readonly string[]).includes(lang)) {
            layers[lang] = mods
            continue
        }
        const { overlay, restore } = built[lang] = readOverlay(lang)
        if (i18n === "on" && overlay) setStoredText(servedKey(lang), "1")
        const served = getStoredText(servedKey(lang)) === "1"
        layers[lang] = i18n === "on"
            ? [...(restore ? [restore] : []), ...mods, ...(overlay ? [overlay] : [])]
            : [...(restore && served ? [restore] : []), ...mods]
    }

    const current = fingerprint(layers)
    const storedVersion = Number(getStoredText(VERSION_KEY))
    let version: number
    let previous: string
    if (Number.isInteger(storedVersion) && storedVersion > 0) {
        version = storedVersion
        previous = getStoredText(LAYERS_KEY) ?? ""
    } else {
        // first start with the registry: carry on from metadata.json, or from the asset lists' version
        const legacy = legacyMetadata(cdn)
        version = Math.max(legacy?.version ?? BASE_ASSET_VERSION, BASE_ASSET_VERSION)
        previous = legacy?.fingerprint ?? fingerprint({})
    }
    let bumped = false
    const hasLayers = LAYER_LANGS.some(lang => layers[lang].length > 0)
    if (current !== previous || (hasLayers && version <= BASE_ASSET_VERSION)) {
        version += 1
        bumped = true
    }
    setStoredText(VERSION_KEY, String(version))
    setStoredText(LAYERS_KEY, current)
    return { version, versionString: `2.1.${version}`, i18n, mods, layers, built, bumped }
}

let state: AssetLayerState | null = null

/** The layers and version, computed on first use (the asset routes do it at startup). */
export function getAssetLayers(): AssetLayerState {
    return state ??= computeAssetLayers()
}

/** Forgets the computed layers, so the next use reads the folders again (tests, or after a rebuild). */
export function resetAssetLayers(): void {
    state = null
}

/** The asset version `/load` announces. */
export function availableAssetVersion(): string {
    return getAssetLayers().versionString
}

/** The archives a device of this language gets on top of the game's assets (unknown languages: the mods only). */
export function layersFor(lang: string): AssetArchive[] {
    const current = getAssetLayers()
    return current.layers[lang] ?? current.mods
}
