// Special exchange campaigns (FT-39, `campaign/special_exchange/*`, `assets/special_exchange_campaign.json`): Scouting
// Seasons (units) and Dream Armament Selection Seasons (armaments), where a ticket trades for one target of the
// campaign's list, once. The original sold the ticket in a bundle for paid beads only (`special_exchange/buy_ticket`);
// here the bundle takes any beads, free ones first (src/lib/beads.ts), during its sale period. Tickets also come by
// mail from an admin. The later "ticket gift promos" (campaigns 12-17) gave the ticket for free. Each campaign is paid
// or free (src/lib/campaignModes.ts, the original's way by default): a free one isn't sold but mailed
// (src/lib/campaignGifts.ts); a promo made paid sells at the paid seasons' prices (PROMO_BUNDLE_PRICES). The schedule
// overlay gives the client's rows the chosen mode (src/lib/scheduleOverlay.ts).
//
// The client keeps a status per campaign (ExchangeCampaignStatus, an Int): absent, not entered yet; 1 entered without a
// ticket; 2 holding the campaign's ticket; 3 exchanged (no further exchange). It gets them from the routes' replies
// (`special_exchange_campaign_list`) and from /load. Its Shop entries (Scout a Unit, the Dream Armament shop) show a
// campaign only with a status: ExchangeCampaign.isAvailableScene is true for 2, and for 1 inside the campaign period (3
// and an absent status are hidden), so /load must list every open campaign, entered or not (FT-80). The server stores
// 1 and 3 and reports 2 while the player owns the ticket item. An entered campaign stays listed after its period: with
// status 2 the client sends the player to its exchange to spend the ticket (exchangeRefusalSync, FT-81).

import specialExchangeCampaigns from "../../assets/special_exchange_campaign.json";
import { PROMO_BUNDLE_PRICES } from "./specialExchangePromo";
import { getPlayerItemSync, getPlayerSpecialExchangeSync } from "../data/wdfpData";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";

export interface SpecialExchangeCampaign {
    kind: "character" | "equipment"
    name: string
    saleStart: string
    saleEnd: string
    exchangeStart: string
    exchangeEnd: string
    ticketItemId: number
    /** a ticket gift promo: the ticket was free */
    gift: boolean
    /** the ticket bundle's price in paid beads */
    price: number | null
    targets: number[]
}

const campaigns = specialExchangeCampaigns as Record<string, SpecialExchangeCampaign>

/** The bundle's price when sold: the original's, or for a ticket gift promo made paid the paid seasons'. */
export function specialExchangeBundlePrice(campaign: SpecialExchangeCampaign): number {
    return campaign.price ?? PROMO_BUNDLE_PRICES[campaign.kind]
}

/** The client's result codes: enter_campaign and buy_ticket outside their periods (PeriodError). */
export const ENTER_OUT_OF_PERIOD = 4715
export const BUY_TICKET_OUT_OF_PERIOD = 4702
/**
 * An exchange outside its exchange period (before it, or after it on a campaign the player never entered). The exchange
 * remotes have no handler of their own for it (only the generic error dialog, "A4715"), so this is the family's period
 * code, the one enter_campaign uses, sent with HTTP 200 instead of a 400 (which the client retries five times and ends
 * in "H400", FT-81). The client doesn't offer such an exchange itself; an entered campaign's late exchange is taken.
 */
export const EXCHANGE_OUT_OF_PERIOD = ENTER_OUT_OF_PERIOD
export const EXCHANGE_PERIOD_OVER = "The exchange period is over."

export const SpecialExchangeStatus = { ENTERED: 1, HAS_TICKET: 2, EXCHANGED: 3 } as const

export function getSpecialExchangeCampaign(campaignId: number): SpecialExchangeCampaign | null {
    return campaigns[String(campaignId)] ?? null
}

export function listSpecialExchangeCampaigns(): [number, SpecialExchangeCampaign][] {
    return Object.entries(campaigns).map(([id, campaign]) => [Number(id), campaign])
}

const open = (start: string, end: string, date: Date) => isContentPeriodOpen(masterDate(start).getTime(), masterDate(end).getTime(), date)

export function isExchangeOpen(campaign: SpecialExchangeCampaign, date: Date): boolean {
    return open(campaign.exchangeStart, campaign.exchangeEnd, date)
}

/** Whether the exchange period has begun (it may be over). */
export function isExchangeStarted(campaign: SpecialExchangeCampaign, date: Date): boolean {
    return isContentPeriodOpen(masterDate(campaign.exchangeStart).getTime(), undefined, date)
}

export function isSaleOpen(campaign: SpecialExchangeCampaign, date: Date): boolean {
    return open(campaign.saleStart, campaign.saleEnd, date)
}

/** The status the client sees: the stored one, raised to 2 while the player holds the ticket and hasn't exchanged. */
function statusOf(playerId: number, campaign: SpecialExchangeCampaign, stored: number): number {
    if (stored === SpecialExchangeStatus.EXCHANGED) return stored
    return (getPlayerItemSync(playerId, campaign.ticketItemId) ?? 0) > 0 ? SpecialExchangeStatus.HAS_TICKET : SpecialExchangeStatus.ENTERED
}

/**
 * The `special_exchange_campaign_list` of /load and the routes' replies: every campaign the player entered, and every
 * campaign inside its sale or exchange period (status 1 until they enter, 2 holding the ticket, 3 exchanged).
 */
export function specialExchangeCampaignListSync(playerId: number, date: Date): { campaign_id: number, status: number }[] {
    const entered = getPlayerSpecialExchangeSync(playerId)
    const list: { campaign_id: number, status: number }[] = []
    for (const [campaignId, campaign] of listSpecialExchangeCampaigns()) {
        const stored = entered.get(campaignId)
        if (stored === undefined && !isSaleOpen(campaign, date) && !isExchangeOpen(campaign, date)) continue
        list.push({ "campaign_id": campaignId, "status": statusOf(playerId, campaign, stored ?? 0) })
    }
    return list
}

/**
 * Why an exchange is refused, or null: the campaign's kind, its exchange period, its list, its ticket, once.
 *
 * A ticket still held after the exchange period can be spent on a campaign the player entered (FT-81): the client
 * lists such a campaign with status 2 (ExchangeCampaign.isHavingExpiredTicket), and at Home it shows "the exchange
 * deadline of <ticket> has passed, moving to the exchange screen" (special_exchange_campaign_have_expired_ticket_
 * dialog_message) and opens the campaign's exchange without a back button, so the ticket has to be traded there.
 */
export function exchangeRefusalSync(playerId: number, campaignId: number, kind: SpecialExchangeCampaign["kind"], targetId: number, date: Date): string | null {
    const campaign = getSpecialExchangeCampaign(campaignId)
    if (campaign === null || campaign.kind !== kind) return "Unknown campaign."
    const entered = getPlayerSpecialExchangeSync(playerId).has(campaignId)
    if (!isExchangeOpen(campaign, date) && !(entered && isExchangeStarted(campaign, date))) return EXCHANGE_PERIOD_OVER
    if (!campaign.targets.includes(targetId)) return "Not in this campaign's list."
    if (getPlayerSpecialExchangeSync(playerId).get(campaignId) === SpecialExchangeStatus.EXCHANGED) return "Already exchanged in this campaign."
    if ((getPlayerItemSync(playerId, campaign.ticketItemId) ?? 0) < 1) return "No ticket to exchange."
    return null
}
