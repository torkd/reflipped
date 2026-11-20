// Free or paid campaign bundles (FT-39, FT-44): each Scouting / Dream Armament Selection season (special exchange
// campaigns) and the Start Dash bundle is either
// - "paid": the bundle is sold, once, for its price in any beads (src/lib/beads.ts), in the season's Shop screen;
// - "free": every player gets the bundle's rewards by mail, once, at their first login of its period
//   (src/lib/campaignGifts.ts), and it isn't sold.
// The default is what the original server did: the paid seasons (campaigns 1-11) and Start Dash were sold, the ticket
// gift promos (12-17) were free. The server's owner can change each one (Settings, Campaign bundles). Only the changes
// are stored. Before this setting, an admin could turn a "campaign gift" on for a sold season; those stored lists
// (campaignGifts.*) still count as "free" until the page is saved.
//
// No data layer beyond the settings table: the schedule overlay's view (src/lib/scheduleAssets.ts) reads it too.

import specialExchangeCampaigns from "../../assets/special_exchange_campaign.json";
import startDashCampaigns from "../../assets/start_dash_exchange_campaign.json";
import { getStoredText, setStoredText } from "../data/serverSettings";

export type CampaignMode = "free" | "paid"
export const CAMPAIGN_MODES: readonly CampaignMode[] = ["paid", "free"]
export type CampaignFamily = "specialExchange" | "startDash"

const KEY = "campaigns.modes"
const LEGACY_KEYS: Record<CampaignFamily, string> = { specialExchange: "campaignGifts.specialExchange", startDash: "campaignGifts.startDash" }

const ids: Record<CampaignFamily, Set<number>> = {
    specialExchange: new Set(Object.keys(specialExchangeCampaigns).map(Number)),
    startDash: new Set(Object.keys(startDashCampaigns).map(Number))
}

/** What the original server did: a ticket gift promo was free, everything else sold. */
export function originalCampaignMode(family: CampaignFamily, campaignId: number): CampaignMode {
    if (family === "startDash") return "paid"
    const campaign = (specialExchangeCampaigns as Record<string, { gift: boolean }>)[String(campaignId)]
    return campaign?.gift ? "free" : "paid"
}

export type CampaignModeOverrides = Record<CampaignFamily, Record<number, CampaignMode>>

function legacyOverrides(family: CampaignFamily): Record<number, CampaignMode> {
    const overrides: Record<number, CampaignMode> = {}
    try {
        const stored = JSON.parse(getStoredText(LEGACY_KEYS[family]) ?? "[]")
        if (Array.isArray(stored)) for (const id of stored) {
            if (ids[family].has(id) && originalCampaignMode(family, id) !== "free") overrides[id] = "free"
        }
    } catch { /* an invalid stored value counts as none */ }
    return overrides
}

/** The campaigns whose mode differs from the original. */
export function campaignModeOverrides(): CampaignModeOverrides {
    const text = getStoredText(KEY)
    if (text === null) return { specialExchange: legacyOverrides("specialExchange"), startDash: legacyOverrides("startDash") }
    const result: CampaignModeOverrides = { specialExchange: {}, startDash: {} }
    try {
        const stored = JSON.parse(text) as Partial<Record<CampaignFamily, Record<string, unknown>>>
        for (const family of ["specialExchange", "startDash"] as const) {
            for (const [id, mode] of Object.entries(stored?.[family] ?? {})) {
                const campaignId = Number(id)
                if (!ids[family].has(campaignId) || !CAMPAIGN_MODES.includes(mode as CampaignMode)) continue
                if (mode !== originalCampaignMode(family, campaignId)) result[family][campaignId] = mode as CampaignMode
            }
        }
    } catch { /* an invalid stored value counts as none */ }
    return result
}

export function campaignMode(family: CampaignFamily, campaignId: number): CampaignMode {
    return campaignModeOverrides()[family][campaignId] ?? originalCampaignMode(family, campaignId)
}

/**
 * Sets every campaign's mode: the ones given, and the original for the rest. Throws a RangeError for an unknown
 * campaign or mode, changing nothing.
 */
export function setCampaignModes(modes: Partial<Record<CampaignFamily, Record<number, string>>>): void {
    const overrides: CampaignModeOverrides = { specialExchange: {}, startDash: {} }
    for (const family of ["specialExchange", "startDash"] as const) {
        for (const [id, mode] of Object.entries(modes[family] ?? {})) {
            const campaignId = Number(id)
            if (!ids[family].has(campaignId)) throw new RangeError(`unknown ${family} campaign ${id}`)
            if (!CAMPAIGN_MODES.includes(mode as CampaignMode)) throw new RangeError(`unknown campaign mode ${mode}`)
            if (mode !== originalCampaignMode(family, campaignId)) overrides[family][campaignId] = mode as CampaignMode
        }
    }
    setStoredText(KEY, JSON.stringify(overrides))
    for (const key of Object.values(LEGACY_KEYS)) setStoredText(key, null)
}
