// Lineup choices (FT-38): during a select item campaign the player picks one lineup of a shop's items, once ("you can
// only select one event armament lineup, and you can't change it afterward": worldflipper.wiki.gg, "Co-Op Challenge").
// Two shops have them: the Boss Coin shop (the client's shop_type 7: the Co-Op Challenge seasons) and the event item
// shop (shop_type 4: the Beast of the Abyss shop). `assets/select_item_campaign.json` (scripts/converter.py) lists each
// campaign's choosing period, the end of its exchange and each lineup's shop items. shop/get_campaign_lineup_id and
// set_campaign_lineup_id answer 1652 (OutOfPeriodError) outside their periods, and shop/buy refuses an item of a lineup
// the player didn't choose while its campaign's exchange runs; shop/get_sales_list leaves those items out (FT-71), since
// the client lists what it gets and a tap on a refused one ends in H400. The choosing screens read the client's own
// master data (getLineupDetail, getCampaignSelectLineups), not the sales list.

import selectItemCampaigns from "../../assets/select_item_campaign.json";
import { getPlayerLineupChoiceSync, setPlayerLineupChoiceSync } from "../data/wdfpData";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";

interface SelectItemCampaign {
    selectStart: string
    selectEnd: string
    exchangeEnd: string
    lineups: Record<string, number[]>
}

const campaignsByShop = selectItemCampaigns as Record<string, Record<string, SelectItemCampaign>>

/** The client's OutOfPeriodError for both lineup routes. */
export const LINEUP_OUT_OF_PERIOD = 1652

function campaignOf(shopType: number, campaignId: number): SelectItemCampaign | null {
    return campaignsByShop[String(shopType)]?.[String(campaignId)] ?? null
}

const open = (start: string, end: string, date: Date) => isContentPeriodOpen(masterDate(start).getTime(), masterDate(end).getTime(), date)

export type LineupLookup = { outcome: "out-of-period" } | { outcome: "ok", lineupId: number | null }

/** shop/get_campaign_lineup_id: the player's lineup (null if none yet), from the campaign's start to its exchange's end. */
export function lineupChoiceSync(playerId: number, shopType: number, campaignId: number, date: Date): LineupLookup {
    const campaign = campaignOf(shopType, campaignId)
    if (campaign === null || !open(campaign.selectStart, campaign.exchangeEnd, date)) return { outcome: "out-of-period" }
    return { outcome: "ok", lineupId: getPlayerLineupChoiceSync(playerId, shopType, campaignId) }
}

export type LineupChoiceOutcome = "chosen" | "out-of-period" | "unknown-lineup" | "already-chosen"

/** shop/set_campaign_lineup_id: once, during the choosing period, a lineup of the campaign. */
export function chooseLineupSync(playerId: number, shopType: number, campaignId: number, lineupId: number, date: Date): LineupChoiceOutcome {
    const campaign = campaignOf(shopType, campaignId)
    if (campaign === null || !open(campaign.selectStart, campaign.selectEnd, date)) return "out-of-period"
    if (campaign.lineups[String(lineupId)] === undefined) return "unknown-lineup"
    if (getPlayerLineupChoiceSync(playerId, shopType, campaignId) !== null) return "already-chosen"
    setPlayerLineupChoiceSync(playerId, shopType, campaignId, lineupId)
    return "chosen"
}

/**
 * FT-71: the shop items shop/get_sales_list leaves out for the player: during a campaign's exchange, the items of the
 * lineups they didn't choose (all of them while they have chosen none). Exactly the items lineupPurchaseRefusal refuses.
 */
export function hiddenLineupItemsSync(playerId: number, shopType: number, date: Date): Set<number> {
    const hidden = new Set<number>()
    for (const [campaignId, campaign] of Object.entries(campaignsByShop[String(shopType)] ?? {})) {
        if (!open(campaign.selectStart, campaign.exchangeEnd, date)) continue
        const chosen = getPlayerLineupChoiceSync(playerId, shopType, Number(campaignId))
        const allowed = new Set(chosen === null ? [] : campaign.lineups[String(chosen)] ?? [])
        for (const itemIds of Object.values(campaign.lineups))
            for (const itemId of itemIds) if (!allowed.has(itemId)) hidden.add(itemId)
    }
    return hidden
}

/**
 * Why shop/buy refuses an item, or null: during a campaign's exchange, an item of one of its lineups sells only to
 * a player who chose that lineup.
 */
export function lineupPurchaseRefusal(playerId: number, shopType: number, shopItemId: number, date: Date): string | null {
    for (const [campaignId, campaign] of Object.entries(campaignsByShop[String(shopType)] ?? {})) {
        const lineups = Object.entries(campaign.lineups).filter(([, itemIds]) => itemIds.includes(shopItemId)).map(([lineupId]) => Number(lineupId))
        if (lineups.length === 0 || !open(campaign.selectStart, campaign.exchangeEnd, date)) continue
        const chosen = getPlayerLineupChoiceSync(playerId, shopType, Number(campaignId))
        if (chosen === null) return "Choose a lineup first."
        if (!lineups.includes(chosen)) return "Not in the chosen lineup."
    }
    return null
}
