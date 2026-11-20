// Free campaign bundles (FT-39, FT-44): a campaign in "free" mode (src/lib/campaignModes.ts; by default the ticket gift
// promos, as in the original) isn't sold: a player whose /load falls in its period gets its rewards by mail instead,
// once, at that first login of the period.
// The special exchange campaigns: their reward is the exchange ticket, plus the Star Slivers a sold bundle came with
// (20 with a unit ticket, 10 with an armament ticket, as the bundle's purchase dialog says); a ticket gift promo gave
// the ticket alone, and does so when free. A gift box too full for the whole gift sends nothing and records nothing, so
// it comes at a later login of the period.
// Sending the gift also enters the player in its campaign (status 1, FT-85): the client never sends enter_campaign
// for a campaign whose ticket it already holds, and only an entered campaign takes a ticket still held after its
// exchange period (the "no longer available" exchange, FT-81). Without this a gifted ticket left over after the
// period would never be offered for its own campaign.
// The Start Dash bundle (FT-44): when free, a new player whose 7 days are running gets the whole bundle (its exchange
// ticket, a 10-Pull Summoning Ticket and 20 Star Slivers) at their first login of those days.

import { MailType } from "../data/types";
import { CampaignMode, campaignMode } from "./campaignModes";
import { getPlayerReceivableMailCountSync, getPlayerSpecialExchangeSync, hasPlayerCampaignGiftSync, insertPlayerCampaignGiftSync, setPlayerSpecialExchangeSync } from "../data/wdfpData";
import { mailLimits } from "./limits";
import { sendPlayerMailSync, SendMailOptions } from "./mail";
import { getSpecialExchangeCampaign, isSaleOpen, listSpecialExchangeCampaigns, SpecialExchangeCampaign, SpecialExchangeStatus } from "./specialExchange";
import {
    getStartDashCampaign, isWithinStartDashPeriod, listStartDashCampaigns, START_DASH_BUNDLE_REASON, START_DASH_GACHA_TICKET,
    START_DASH_STAR_SLIVERS, StartDashStatus, startDashEntrySync
} from "./startDash";

/** Mail reasons from the client's table: "A Gift from the Team", and the Scouting / Armory bundle bonuses. */
const GIFT_REASON = 2
const UNIT_BUNDLE_BONUS_REASON = 99000
const ARMAMENT_BUNDLE_BONUS_REASON = 99001

/** The special exchange campaigns that are free (mailed, not sold). */
export function enabledSpecialExchangeGifts(): Set<number> {
    return new Set(listSpecialExchangeCampaigns().map(([id]) => id).filter(id => campaignMode("specialExchange", id) === "free"))
}

/** The Start Dash campaigns that are free. */
export function enabledStartDashGifts(): Set<number> {
    return new Set(listStartDashCampaigns().map(([id]) => id).filter(id => campaignMode("startDash", id) === "free"))
}

/** The Start Dash bundle as a gift: its exchange ticket, the 10-Pull Summoning Ticket and the Star Slivers. */
export function startDashGiftMails(campaignId: number): SendMailOptions[] {
    const campaign = getStartDashCampaign(campaignId)!
    const text = { subject: campaign.bundleName, description: `A gift: ${campaign.bundleName}.` }
    return [
        { type: MailType.ITEM, typeId: campaign.ticketItemId, number: 1, reasonId: GIFT_REASON, durableReward: true, ...text },
        { type: MailType.ITEM, typeId: START_DASH_GACHA_TICKET, number: 1, reasonId: START_DASH_BUNDLE_REASON, durableReward: true, ...text },
        { type: MailType.STAR_CRUMB, number: START_DASH_STAR_SLIVERS, reasonId: START_DASH_BUNDLE_REASON, durableReward: true, ...text }
    ]
}

/** The Star Slivers a special exchange bundle comes with in a mode: none for a ticket gift promo given free. */
export function specialExchangeStarSlivers(campaign: SpecialExchangeCampaign, mode: CampaignMode): number {
    if (campaign.gift && mode === "free") return 0
    return campaign.kind === "character" ? 20 : 10
}

/** A sold bundle's Star Sliver mail (the ticket itself joins the inventory). */
export function specialExchangeBonusMail(campaign: SpecialExchangeCampaign): SendMailOptions {
    return {
        type: MailType.STAR_CRUMB, number: specialExchangeStarSlivers(campaign, "paid"), durableReward: true,
        reasonId: campaign.kind === "character" ? UNIT_BUNDLE_BONUS_REASON : ARMAMENT_BUNDLE_BONUS_REASON,
        subject: campaign.name, description: `A bonus for ${campaign.name}.`
    }
}

/** A free special exchange campaign's gift: its ticket, and a sold bundle's Star Slivers. */
export function specialExchangeGiftMails(campaign: SpecialExchangeCampaign): SendMailOptions[] {
    const mails: SendMailOptions[] = [{
        type: MailType.ITEM, typeId: campaign.ticketItemId, number: 1, reasonId: GIFT_REASON, durableReward: true,
        subject: campaign.name, description: `A gift for ${campaign.name}.`
    }]
    if (specialExchangeStarSlivers(campaign, "free") > 0) mails.push(specialExchangeBonusMail(campaign))
    return mails
}

/** /load: the free campaigns open now whose gift the player hasn't had yet; returns how many gifts were sent. */
export function applyCampaignGiftsSync(playerId: number, now: Date): number {
    let sent = 0
    const enabled = enabledSpecialExchangeGifts()
    for (const [campaignId, campaign] of listSpecialExchangeCampaigns()) {
        if (!enabled.has(campaignId) || !isSaleOpen(campaign, now)) continue
        const key = `special_exchange:${campaignId}`
        if (hasPlayerCampaignGiftSync(playerId, key)) continue
        const mails = specialExchangeGiftMails(campaign)
        if (getPlayerReceivableMailCountSync(playerId, now) + mails.length > mailLimits.pendingMails) continue
        for (const mail of mails) sendPlayerMailSync(playerId, mail)
        insertPlayerCampaignGiftSync(playerId, key, now)
        // entered, unless the player already is (or has exchanged)
        if (!getPlayerSpecialExchangeSync(playerId).has(campaignId)) setPlayerSpecialExchangeSync(playerId, campaignId, SpecialExchangeStatus.ENTERED)
        sent++
    }
    const startDash = enabledStartDashGifts()
    for (const [campaignId] of listStartDashCampaigns()) {
        if (!startDash.has(campaignId)) continue
        const entry = startDashEntrySync(playerId, campaignId)
        if (entry === null || entry.status === StartDashStatus.EXCHANGED || !isWithinStartDashPeriod(entry, now)) continue
        const key = `start_dash:${campaignId}`
        if (hasPlayerCampaignGiftSync(playerId, key)) continue
        const mails = startDashGiftMails(campaignId)
        if (getPlayerReceivableMailCountSync(playerId, now) + mails.length > mailLimits.pendingMails) continue
        for (const mail of mails) sendPlayerMailSync(playerId, mail)
        insertPlayerCampaignGiftSync(playerId, key, now)
        sent++
    }
    return sent
}
