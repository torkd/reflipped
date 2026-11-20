/** Immutable client master overlays for the shared or per-player content view. */
import { createHash } from "crypto";
import path from "path";
import { dataPath, databaseDir } from "./paths";
import type { AssetArchive } from "./assetLayers";
import { getStoredText, setStoredText } from "../data/serverSettings";
import getDatabase, { Database } from "../data";
import { activeDataPack } from "./dataPack";
import { CdnIndex, readArchiveMember, readCentralDirectory, regionCdnDir, ZipMember } from "./cdnIndex";
import { getEventScheduleView, scheduledContentEnabled } from "./eventSchedule";
import { buildScheduleOverlay, ScheduleBalance, ScheduleProjection, SCHEDULE_MASTER_TABLES } from "./scheduleOverlay";
import { sharedBalanceTime } from "./balance";
import { unitsWithHiddenBoard2 } from "./boardRelease";
import { BALANCE_DATA_DIGEST, balanceEpochAt, pendingBalanceChanges } from "./balanceChanges";
import { DEFAULT_SCHEDULE_CACHE_BYTES, ScheduleArchiveCache, ScheduleAssetUnavailableError, ScheduleBuildBudget } from "./scheduleArchiveCache";
import { annualBonusViewIdentity } from "./scheduleAnnualBonus";
import { cnPatchArchivePath } from "./cnPatches";
import { campaignModeOverrides } from "./campaignModes";

// 5: the views carry the balance epoch and ship mana_board/mana_node (FT-47); 6: and the balance value tables;
// 7: the Haunt's cycles run back to back (FT-77)
const FORMAT_VERSION = 7
const SERVED_KEY = "assets.schedule.served"
const METADATA_KEY = "assets.schedule.archives"
const MAX_METADATA_ENTRIES = 256
export const SCHEDULE_URL_DIR = "schedule"

export interface ScheduleAssetView {
    identity: string
    projection: ScheduleProjection | null
    /** the second boards hidden in this view (FT-47); none when restoring; without it, the date overlay alone */
    balance?: ScheduleBalance
    /** special exchange campaigns whose free/paid mode the owner changed (src/lib/campaignModes.ts) */
    specialExchangeModes?: Record<string, "free" | "paid">
}

/** Stable throughout a full catalog cycle, or a selected manual window; TT offsets are separate views. */
export function currentScheduleAssetView(baseVersion: string): ScheduleAssetView | null {
    if (!scheduledContentEnabled()) return getStoredText(SERVED_KEY) === "1"
        ? { identity: JSON.stringify([FORMAT_VERSION, baseVersion, "restore"]), projection: null, balance: { hiddenBoard2: new Set(), pending: [] } }
        : null
    const { key, sourceStart, targetStart, rate, contentTime } = getEventScheduleView()
    // balance follows the shared timeline, not the player's own Time Travel (src/lib/balance.ts)
    const balanceTime = sharedBalanceTime()
    const modes = campaignModeOverrides().specialExchange
    const changedModes = Object.keys(modes).length > 0
    return {
        identity: JSON.stringify([FORMAT_VERSION, baseVersion, key, sourceStart, targetStart, rate, annualBonusViewIdentity(contentTime),
            balanceEpochAt(balanceTime), BALANCE_DATA_DIGEST, ...(changedModes ? [modes] : [])]),
        projection: { sourceStart, targetStart, rate, contentTime },
        balance: { hiddenBoard2: unitsWithHiddenBoard2(balanceTime), pending: pendingBalanceChanges(balanceTime) },
        specialExchangeModes: modes
    }
}

export function scheduleOverlayRoot(): string {
    return process.env.CDN_SCHEDULE_DIR
        ? dataPath(process.env.CDN_SCHEDULE_DIR)
        : path.join(databaseDir(), "schedule-assets")
}

export function scheduleArchivePath(file: string): string | null {
    return cachedPath(archiveCache(), file)
}

interface LayerIndex { file: string, sha256: string, entries: Map<string, ZipMember> }
const cdnIndexes = new Map<string, CdnIndex>()
const layerIndexes = new Map<string, LayerIndex>()
type ArchiveMetadata = Omit<AssetArchive, "location"> & { file: string }
const generated = new Map<string, ArchiveMetadata>()
const buildBudget = new ScheduleBuildBudget()
let metadataLoaded = false

function archiveCache(): ScheduleArchiveCache {
    const maxBytes = process.env.SCHEDULE_ASSET_CACHE_BYTES === undefined
        ? DEFAULT_SCHEDULE_CACHE_BYTES : Number(process.env.SCHEDULE_ASSET_CACHE_BYTES)
    return new ScheduleArchiveCache({ root: scheduleOverlayRoot(), maxBytes })
}

function cachedPath(cache: ScheduleArchiveCache, file: string): string | null {
    return getDatabase(Database.WDFP_DATA).transaction(() => cache.get(file)).immediate()
}

function loadMetadata(): void {
    if (metadataLoaded) return
    const stored = getStoredText(METADATA_KEY)
    if (stored !== null) {
        const entries: unknown = JSON.parse(stored)
        if (!Array.isArray(entries)) throw new Error("Invalid stored schedule archive metadata")
        for (const entry of entries.slice(-MAX_METADATA_ENTRIES)) {
            if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid stored schedule archive metadata")
            const [key, metadata] = entry as [string, ArchiveMetadata]
            if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)
                || !metadata || !/^[0-9a-f]{64}\.zip$/.test(metadata.file)
                || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || typeof metadata.sha256 !== "string")
                throw new Error("Invalid stored schedule archive metadata")
            generated.set(key, metadata)
        }
    }
    metadataLoaded = true
}

function remember(key: string, metadata: ArchiveMetadata): void {
    generated.delete(key)
    generated.set(key, metadata)
    while (generated.size > MAX_METADATA_ENTRIES) generated.delete(generated.keys().next().value!)
    setStoredText(METADATA_KEY, JSON.stringify([...generated]))
}

/** Reset caches after changing local CDN/layer files; immutable generated URLs remain valid on disk. */
export function resetScheduleAssetCache(): void {
    cdnIndexes.clear()
    layerIndexes.clear()
    generated.clear()
    metadataLoaded = false
}

/** The file of a local asset layer (a mod, a translation overlay, the Chinese CDN's files) from its manifest location. */
export function localLayer(location: string, cdn: string, overlay: string): string {
    const mod = /^\{\$cdnAddress\}\/mods\/([^/]+)$/.exec(location)
    if (mod) return path.join(cdn, "mods", mod[1])
    const translated = /^\{\$cdnAddress\}\/overlay\/([a-z]{2})\/([\w.-]+\.zip)$/.exec(location)
    if (translated) return path.join(overlay, translated[1], translated[2])
    const cn = /^\{\$cdnAddress\}\/cn-patches\/([\w.-]+\.zip)$/.exec(location)
    const cnFile = cn ? cnPatchArchivePath(cn[1]) : null
    if (cnFile) return cnFile
    throw new Error(`Schedule overlay cannot resolve local asset layer ${location}`)
}

/** A later existing layer wins, exactly as it does in the native archive downloader. */
function effectiveReader(index: Pick<CdnIndex, "readMaster"> & { readAsset?(assetPath: string): Buffer | undefined }, layers: readonly AssetArchive[], cdn: string, overlay: string) {
    const indexed = layers.map(layer => {
        const file = localLayer(layer.location, cdn, overlay)
        let cached = layerIndexes.get(file)
        if (!cached || cached.sha256 !== layer.sha256) {
            cached = { file, sha256: layer.sha256, entries: new Map(readCentralDirectory(file).map(entry => [entry.name, entry])) }
            layerIndexes.set(file, cached)
        }
        return cached
    }).reverse()
    return {
        readMaster: (table: string) => index.readMaster(table),
        readAsset: (assetPath: string) => index.readAsset?.(assetPath),
        readLayerMember: (member: string) => {
            for (const layer of indexed) {
                const entry = layer.entries.get(member)
                if (entry) return readArchiveMember(layer.file, entry)
            }
            return undefined
        }
    }
}

/**
 * Date-bearing masters must be present locally even with an external download CDN. Generated archives
 * are served by the API origin, independently of that external CDN. Missing sources fail explicitly.
 */
export function scheduleArchive(
    view: ScheduleAssetView,
    language: string,
    layers: readonly AssetArchive[],
    cdn: string,
    overlay: string,
    apiOrigin: string
): AssetArchive {
    const lang = language === "ko" || language === "th" ? language : "en"
    // with a data pack (SH-13) the masters come from it, not from the CDN folder: a new pack makes new overlays
    const pack = activeDataPack()
    const key = createHash("sha256").update(JSON.stringify([view.identity, lang,
        layers.map(layer => [layer.location, layer.sha256]), ...(pack ? [pack.id] : [])])).digest("hex")
    loadMetadata()
    const cache = archiveCache()
    let cached = generated.get(key)
    if (cached && !cachedPath(cache, cached.file)) {
        generated.delete(key)
        cached = undefined
    }
    if (!cached) {
        buildBudget.take(Number(process.env.SCHEDULE_ASSET_BUILDS_PER_MINUTE ?? 6))
        let result: ReturnType<typeof buildScheduleOverlay>
        try {
            let index: (Pick<CdnIndex, "readMaster"> & { readAsset?(assetPath: string): Buffer | undefined }) | undefined = pack ?? undefined
            if (!index) {
                const root = regionCdnDir(lang, cdn)
                let cdnIndex = cdnIndexes.get(root)
                if (!cdnIndex) { cdnIndex = CdnIndex.build(root); cdnIndexes.set(root, cdnIndex) }
                index = cdnIndex
            }
            result = buildScheduleOverlay(effectiveReader(index, layers, cdn, overlay), view.projection, SCHEDULE_MASTER_TABLES,
                view.balance ? { ...view.balance, language: lang } : null, view.specialExchangeModes ?? null)
        } catch (error) {
            throw new ScheduleAssetUnavailableError(`Cannot build schedule assets from the local CDN or data pack: ${(error as Error).message}`)
        }
        // Serialize final capacity admission/write across processes sharing this DB. Master encoding
        // remains outside the writer transaction; only the bounded archive write holds it briefly.
        const { file } = getDatabase(Database.WDFP_DATA).transaction(() => cache.put(result.archive)).immediate()
        cached = { file, size: result.archive.length,
            sha256: createHash("sha256").update(result.archive).digest("base64") }
        if (view.projection) setStoredText(SERVED_KEY, "1")
    }
    remember(key, cached)
    return { location: `${apiOrigin}/patch/Live/2.0.0/${SCHEDULE_URL_DIR}/${cached.file}`,
        size: cached.size, sha256: cached.sha256 }
}
