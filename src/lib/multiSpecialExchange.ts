// Multi special exchange ("everyone's character choice", FT-13): during a campaign a player gets one exchange
// ticket, either alone (`single_draw_ticket`) or by clearing a battle with others in the campaign's lounge
// (CO-3), and trades it for one character from the ticket's list (`exchange_character`).
//
// Master data: `master/campaign/multi_special_exchange/multi_special_exchange_campaign` (periods and ticket items)
// and `..._campaign_character` (ticket item -> characters), converted into `assets/` by scripts/converter.py.
// The table's dates are Japan time, read with `masterDate()` like every master date, so the server agrees with the
// client's banner and period checks.

import campaigns from "../../assets/multi_special_exchange_campaign.json";
import campaignCharacters from "../../assets/multi_special_exchange_campaign_character.json";
import { MultiSpecialExchangeStatus, UserMultiSpecialExchangeCampaignList } from "../data/types";
import { serializeMultiSpecialExchangeCampaign } from "../data/utils";
import { getPlayerMultiSpecialExchangeCampaignsSync } from "../data/wdfpData";
import { masterDate } from "../utils";

export { MultiSpecialExchangeStatus }

/**
 * Refusals sent as `data_headers.result_code`. The client's `single_draw_ticket` error handler
 * (`MultiSpecialExchangeSingleDrawTicketRealRemote`) knows both; PERIOD_ERROR is also what `multi_draw_ticket` and
 * `exchange_character` send outside the exchange period, where the client's default error handler shows the code.
 */
export enum MultiSpecialExchangeResultCode {
    /** outside the campaign period: "out of date" dialog, back home */
    PERIOD_ERROR = 4901,
    /** a ticket was already drawn or decided: the client calls `multi_draw_ticket` instead */
    TICKET_ALREADY_DRAWN = 4902
}

export interface MultiSpecialExchangeCampaign {
    /** "YYYY-MM-DD HH:MM:SS", Japan time; tickets can be drawn from here until `endDate`, exchanged until `exchangeEndDate` */
    startDate: string
    endDate: string
    exchangeEndDate: string
    /** the campaign's ticket sets (A, B, C); most campaigns have one */
    ticketItemIds: number[]
}

const campaignTable = campaigns as Record<string, MultiSpecialExchangeCampaign>
const characterTable = campaignCharacters as Record<string, number[]>

export function getMultiSpecialExchangeCampaign(campaignId: number): MultiSpecialExchangeCampaign | null {
    return campaignTable[String(campaignId)] ?? null
}

/** Whether tickets can be drawn (and the lounge used) at a date. */
export function isWithinCampaignPeriod(campaign: MultiSpecialExchangeCampaign, date: Date): boolean {
    return masterDate(campaign.startDate) <= date && date <= masterDate(campaign.endDate)
}

/** Whether a drawn ticket can be exchanged at a date. */
export function isWithinExchangePeriod(campaign: MultiSpecialExchangeCampaign, date: Date): boolean {
    return masterDate(campaign.startDate) <= date && date <= masterDate(campaign.exchangeEndDate)
}

/** The characters a ticket can be exchanged for. */
export function getExchangeCharacterIds(ticketItemId: number): number[] {
    return characterTable[String(ticketItemId)] ?? []
}

/** How many more units an exchange gives besides the chosen one: in co-op the other two members' picks, alone random ones. */
export const bonusUnitCount = 2

/**
 * Mail reason (`master/mail/reason`) of the bonus units: 30001 and 30002 are both "People's Choice Bonus" ("A bonus
 * selected from the People's Choice Reward."). Which one the original used for which case is unknown; the server
 * uses 30002 for the random units and leaves 30001 to the co-op mates' picks (CO-3).
 */
export const bonusUnitMailReasonId = 30002
/** The mail's own text, used by the client only if the reason id is missing from its table. */
export const bonusUnitMailSubject = "People's Choice Bonus"
export const bonusUnitMailDescription = "A bonus selected from the People's Choice Reward."

/**
 * The bonus units of a solo exchange: "In addition to the unit you choose, 2 random units will be selected for you.
 * It is possible for the same units to randomly be chosen multiple times." Drawn from the ticket's list, with repeats.
 */
export function drawBonusCharacterIds(ticketItemId: number): number[] {
    const pool = getExchangeCharacterIds(ticketItemId)
    if (pool.length === 0) return []
    return Array.from({ length: bonusUnitCount }, () => pool[Math.floor(Math.random() * pool.length)])
}

/**
 * Picks the ticket a draw gives. Single-set campaigns have one; for the first campaign's three sets the original
 * server's rule is unknown, so the draw is random.
 */
export function drawTicketItemId(campaign: MultiSpecialExchangeCampaign): number {
    return campaign.ticketItemIds[Math.floor(Math.random() * campaign.ticketItemIds.length)]
}

/**
 * The campaign list `/load` sends: the player's stored statuses, plus every campaign open at `date` that the player
 * hasn't joined yet, as not participated. The client shows a campaign (home banner, scene) only if it is listed.
 *
 * A stored campaign that isn't exchanged is left out once its exchange period is over (or before it starts, after a
 * clock change or a save import): the client keeps the banner for a drawn ticket whatever the date and jumps to the
 * exchange scene on every launch, where `exchange_character` could only answer 4901. Exchanged campaigns stay, as the
 * original server kept them (the /load capture lists campaign 4 as exchanged six days after its exchange period).
 */
export function getClientMultiSpecialExchangeCampaignList(playerId: number, date: Date): UserMultiSpecialExchangeCampaignList[] {
    const stored = getPlayerMultiSpecialExchangeCampaignsSync(playerId)
    const list = stored.filter(entry => {
        if (entry.status === MultiSpecialExchangeStatus.EXCHANGED) return true
        const campaign = getMultiSpecialExchangeCampaign(entry.campaignId)
        return campaign !== null && isWithinExchangePeriod(campaign, date)
    })
    for (const [id, campaign] of Object.entries(campaignTable)) {
        const campaignId = Number(id)
        if (!stored.some(entry => entry.campaignId === campaignId) && isWithinCampaignPeriod(campaign, date))
            list.push({ campaignId, status: MultiSpecialExchangeStatus.NOT_PARTICIPATED, ticketItemId: null })
    }
    return list.sort((a, b) => a.campaignId - b.campaignId).map(serializeMultiSpecialExchangeCampaign)
}
