// The Start Dash bundle (FT-44, `campaign/start_dash_exchange/*`, `assets/start_dash_exchange_campaign.json`): a new
// player has 7 days from their start to buy the Start Dash bundle (its exchange ticket, a 10-Pull Summoning Ticket and 20
// Star Slivers by mail, as the client's purchase dialog says) and trade the ticket for one 4- or 5-star unit of a
// portal's pool. The original sold the bundle for paid beads only; here it takes any beads, free ones first (FT-46;
// the AIR shell's any-beads-ticket patch covers this dialog too), and the server's owner can make it free instead
// (src/lib/campaignModes.ts: mailed to each new player, src/lib/campaignGifts.ts).
//
// The client reads `start_dash_exchange_campaign_list` from /load and from both routes' replies: per campaign its
// `gacha_id` (the portal whose 4- and 5-star units, less its limited ones and the term's excluded units, can be
// chosen), `term_index`, the player's own period (epoch seconds) and the status (1 entered: the bundle is offered, 2
// holding the ticket: the exchange is offered, 3 exchanged). Absent, the campaign isn't shown.
//
// Who gets it: an account registered less than the campaign's days ago (real time; `accounts.reg_time`) gets an entry at
// its next /load, for those days from then. The campaign is always open (owner decision 2026-11-18): its master start
// (2022-06-12) isn't checked, so every new player gets the bundle whatever the server's date. The original server's
// choice of portal isn't known (no capture): the unit portal open at that moment with the largest 5-star pool.

import startDashCampaigns from "../../assets/start_dash_exchange_campaign.json";
import gachas from "../../assets/gacha.json";
import { PlayerStartDashExchangeCampaign, UserStartDashCampaignList } from "../data/types";
import {
    getAccountSync, getPlayerItemSync, getPlayerStartDashExchangeCampaignsSync, insertPlayerStartDashExchangeCampaignSync
} from "../data/wdfpData";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";

interface StartDashCampaign {
    name: string
    start: string
    end: string | null
    days: number
    ticketItemId: number
    price: number
    bundleName: string
    terms: Record<string, string>
    excluded: Record<string, number[]>
}

const campaigns = startDashCampaigns as Record<string, StartDashCampaign>

/** The bundle's 10-Pull Summoning Ticket (the client's gachaTicketItemId: wildcard_ten_times_character_ticket). */
export const START_DASH_GACHA_TICKET = 999001
/** The bundle's Star Slivers, by mail, and the mail reason "Bundle Bonus: The Start Dash Bundle". */
export const START_DASH_STAR_SLIVERS = 20
export const START_DASH_BUNDLE_REASON = 99002
/** The client's PeriodError for buy_ticket. */
export const START_DASH_OUT_OF_PERIOD = 4802

export const StartDashStatus = { ENTERED: 1, HAS_TICKET: 2, EXCHANGED: 3 } as const

const DAY_MS = 24 * 60 * 60 * 1000

export function getStartDashCampaign(campaignId: number): StartDashCampaign | null {
    return campaigns[String(campaignId)] ?? null
}

export function listStartDashCampaigns(): [number, StartDashCampaign][] {
    return Object.entries(campaigns).map(([id, campaign]) => [Number(id), campaign])
}

/** Always open (see the header): the master's start no longer gates the bundle. */
function campaignOpen(_campaign: StartDashCampaign, _date: Date): boolean {
    return true
}

/** The term a date falls in: the latest term started by then. */
function termAt(campaign: StartDashCampaign, date: Date): number {
    let term = 0
    for (const [index, start] of Object.entries(campaign.terms)) {
        if (masterDate(start).getTime() <= date.getTime() && Number(index) >= term) term = Number(index)
    }
    return term
}

type GachaAsset = { type: number, startDate: string, endDate: string, pool: Record<string, unknown[]> }

/** The unit portal open at a date with the largest 5-star pool, or null. */
export function startDashPortalAt(date: Date): number | null {
    let best: { id: number, size: number } | null = null
    for (const [id, gacha] of Object.entries(gachas as unknown as Record<string, GachaAsset>)) {
        if (gacha.type !== 0) continue
        if (!isContentPeriodOpen(masterDate(gacha.startDate).getTime(), masterDate(gacha.endDate).getTime(), date)) continue
        const size = gacha.pool["1"]?.length ?? 0   // the pool's "1" holds its 5-star units
        if (best === null || size > best.size) best = { id: Number(id), size }
    }
    return best?.id ?? null
}

/**
 * /load: gives a new player (account under the campaign's days old) an entry in each open campaign they don't have yet.
 * Returns how many were added.
 */
export function ensureStartDashEntriesSync(playerId: number, accountId: number, now: Date): number {
    const registered = getAccountSync(accountId)?.regTime
    if (registered === undefined || Number.isNaN(registered.getTime())) return 0
    const owned = new Set(getPlayerStartDashExchangeCampaignsSync(playerId).map(entry => entry.campaignId))
    let added = 0
    for (const [campaignId, campaign] of listStartDashCampaigns()) {
        if (owned.has(campaignId) || Date.now() - registered.getTime() >= campaign.days * DAY_MS || !campaignOpen(campaign, now)) continue
        const gachaId = startDashPortalAt(now)
        if (gachaId === null) continue
        insertPlayerStartDashExchangeCampaignSync(playerId, {
            campaignId, gachaId, termIndex: termAt(campaign, now), status: StartDashStatus.ENTERED,
            periodStartTime: now, periodEndTime: new Date(now.getTime() + campaign.days * DAY_MS)
        })
        added++
    }
    return added
}

/** The player's entry in a campaign, or null. */
export function startDashEntrySync(playerId: number, campaignId: number): PlayerStartDashExchangeCampaign | null {
    return getPlayerStartDashExchangeCampaignsSync(playerId).find(entry => entry.campaignId === campaignId) ?? null
}

export function isWithinStartDashPeriod(entry: PlayerStartDashExchangeCampaign, date: Date): boolean {
    return entry.periodStartTime.getTime() <= date.getTime() && date.getTime() <= entry.periodEndTime.getTime()
}

/** The status the client sees: the stored one, raised to 2 while the player holds the ticket and hasn't exchanged. */
function statusOf(playerId: number, entry: PlayerStartDashExchangeCampaign): number {
    if (entry.status === StartDashStatus.EXCHANGED) return entry.status
    const campaign = getStartDashCampaign(entry.campaignId)
    return campaign !== null && (getPlayerItemSync(playerId, campaign.ticketItemId) ?? 0) > 0 ? StartDashStatus.HAS_TICKET : entry.status
}

/** `start_dash_exchange_campaign_list` as /load and the routes send it (times in epoch seconds). */
export function startDashCampaignListSync(playerId: number): UserStartDashCampaignList[] {
    return getPlayerStartDashExchangeCampaignsSync(playerId).map(entry => ({
        "campaign_id": entry.campaignId,
        "gacha_id": entry.gachaId,
        "term_index": entry.termIndex,
        "status": statusOf(playerId, entry),
        "period_start_time": Math.floor(entry.periodStartTime.getTime() / 1000),
        "period_end_time": Math.floor(entry.periodEndTime.getTime() / 1000)
    }))
}

/**
 * The units the ticket can be traded for: the entry's portal's 5- and 4-star units, less the term's excluded ones. The
 * client also leaves out the portal's limited units (getLimitedCharacterIds); the converted pools don't mark them.
 */
export function startDashTargets(entry: PlayerStartDashExchangeCampaign): number[] {
    const gacha = (gachas as unknown as Record<string, GachaAsset>)[String(entry.gachaId)]
    if (gacha === undefined) return []
    const excluded = new Set(getStartDashCampaign(entry.campaignId)?.excluded[String(entry.termIndex)] ?? [])
    const ids: number[] = []
    for (const rank of ["1", "2"]) {   // the pool's keys: "1" five stars, "2" four stars, "3" three (assets/gacha.json)
        for (const unit of (gacha.pool[rank] ?? []) as { id: number, isRateUp?: boolean }[]) {
            if (!excluded.has(unit.id) && !ids.includes(unit.id)) ids.push(unit.id)
        }
    }
    return ids
}
