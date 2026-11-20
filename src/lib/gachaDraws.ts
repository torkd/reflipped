// Portal draw kinds (FT-14): what each `gacha/exec` `type` (the client's GachaDrawKind) costs and gives, from the
// client's getCostWithOption, getPaymentType and getOnceTicketNumber. Payment types: 1 beads (free first), 2 paid beads
// only, 3 a ticket, 4 a free campaign pull.
//
//  kind  payment  draw
//   1     1       a pull (beads)                     2     1     a 10-pull (beads)
//   3     3       the portal's own single ticket     4     3     the portal's own 10-pull ticket
//   5     2       the daily paid pull                7     2     the once-per-account paid 10-pull
//   8     4       a free campaign pull               11    4     a free campaign pull
//   9     3       10-Pull Summoning Ticket (999001)  10    3     Summoning Ticket (999003)
//   12    3       Armament Ticket (999005)           13    3     10-Pull Armament Ticket (999004)
//   20    3       4 & 5-Star Portal Ticket (999008): a pull of at least 4 stars
//
// The portals' own tickets come from gacha/gacha (assets/gacha_tickets.json); a free campaign gives what its row says
// (assets/gacha_campaign_draws.json: a pull or a 10-pull a day), whichever free kind the client sends. The wildcard
// tickets (9, 10, 12, 13, 20) work only on a portal whose gacha/gacha row allows them (assets/gacha_wildcard_tickets.json,
// FIX-9): the client offers them nowhere else, and no ticket-only or Star Heroes portal allows them.

import gachaTickets from "../../assets/gacha_tickets.json";
import gachaCampaignDraws from "../../assets/gacha_campaign_draws.json";
import gachaWildcardTickets from "../../assets/gacha_wildcard_tickets.json";
import { GachaType } from "./types";
import { getGachaSync, isGachaOpenSync } from "./assets";
import { isContentPeriodOpen } from "./eventSchedule";
import { masterDate } from "../utils";

interface OwnTickets {
    once: number | null
    tenTimes: number | null
    /** "YYYY-MM-DD HH:MM:SS" Japan time: until when its tickets still draw after the portal closed (FT-52) */
    expiry: string | null
}
const ownTickets = gachaTickets as Record<string, OwnTickets>

export interface TicketDraw {
    itemId: number
    /** pulls per ticket */
    pulls: number
    /** every pull at least 4 stars (the 4 & 5-Star Portal Ticket) */
    guaranteed: boolean
}

const wildcardTickets: Record<number, { itemId: number, pulls: number, gachaType: GachaType, guaranteed?: boolean }> = {
    9: { itemId: 999001, pulls: 10, gachaType: GachaType.CHARACTER },
    10: { itemId: 999003, pulls: 1, gachaType: GachaType.CHARACTER },
    12: { itemId: 999005, pulls: 1, gachaType: GachaType.WEAPON },
    13: { itemId: 999004, pulls: 10, gachaType: GachaType.WEAPON },
    20: { itemId: 999008, pulls: 1, gachaType: GachaType.CHARACTER, guaranteed: true }
}

/** The portals that take the wildcard tickets. */
const wildcardTicketGachaIds = new Set<number>(gachaWildcardTickets)

/** The ticket a ticket draw kind spends on a portal, or null when that portal doesn't take it. */
export function ticketDraw(gachaId: number, gachaType: GachaType, kind: number): TicketDraw | null {
    if (isOwnTicketDraw(kind)) {
        const own = ownTickets[String(gachaId)]
        const itemId = kind === 3 ? own?.once : own?.tenTimes
        return itemId === null || itemId === undefined ? null : { itemId, pulls: kind === 3 ? 1 : 10, guaranteed: false }
    }
    const wildcard = wildcardTickets[kind]
    if (wildcard === undefined || wildcard.gachaType !== gachaType || !wildcardTicketGachaIds.has(gachaId)) return null
    return { itemId: wildcard.itemId, pulls: wildcard.pulls, guaranteed: wildcard.guaranteed === true }
}

/** The pulls a free campaign gives per draw: its row's (a pull or a 10-pull), 1 if unknown. */
export function campaignPulls(campaignId: number): number {
    return (gachaCampaignDraws as Record<string, number>)[String(campaignId)] ?? 1
}

/**
 * Which draws a portal takes at a date (FT-52), as the client offers them:
 * - "open": within the portal's period (`isGachaOpenSync`), every draw it has;
 * - "own-ticket": past its end but before its ticket expiry (gacha/gacha column 31). The client keeps such a portal
 *   listed for a player holding one of its own tickets (getExtendedEndTime) and then shows only draw kinds 3 and 4,
 *   those tickets (refreshButtons, isGachaExpiredWithoutTicket);
 * - "closed": nothing; `gacha/exec` answers result code 1351, the client's GachaInvalidPeriodError.
 */
export function gachaDrawPeriodSync(gachaId: number, date: Date): "open" | "own-ticket" | "closed" {
    if (isGachaOpenSync(gachaId, date)) return "open"
    const gacha = getGachaSync(gachaId)
    const expiry = ownTickets[String(gachaId)]?.expiry
    if (gacha === null || expiry === null || expiry === undefined) return "closed"
    return isContentPeriodOpen(masterDate(gacha.startDate).getTime(), masterDate(expiry).getTime(), date) ? "own-ticket" : "closed"
}

/** The draw kinds of a portal's own tickets, the only ones it takes in its "own-ticket" period. */
export function isOwnTicketDraw(kind: number): boolean {
    return kind === 3 || kind === 4
}
