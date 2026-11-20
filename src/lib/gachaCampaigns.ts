// Free portal pull campaigns (`gacha/gacha_campaign`, assets/gacha_campaign_periods.json): while a campaign is open,
// each of its portals gives one free pull or 10-pull a day. The original /load listed every portal of an open campaign
// in `gacha_campaign_list` with `count` 1 until the day's pull (docs/routes/load.md: campaign 19's three portals), and
// the client shows the free pull button only for a listed portal with a count left. The stored rows only exist once a
// player has pulled (gacha/exec) and are set back to 1 at the daily reset (src/lib/resets.ts), so /load adds the open
// campaigns' portals a player has no row for yet.

import campaignPeriods from "../../assets/gacha_campaign_periods.json";
import { getPlayerGachaCampaignListSync } from "../data/wdfpData";
import { UserGachaCampaign } from "../data/types";
import { serializeGachaCampaign } from "../data/utils";
import { masterDate } from "../utils";
import { getGachaSync } from "./assets";
import { comebackGachaPeriodSync, isComebackGacha } from "./comebackGacha";
import { isContentPeriodOpen } from "./eventSchedule";

interface CampaignPeriod {
    start: string
    end: string
    gachaIds: number[]
}

const periods = campaignPeriods as Record<string, CampaignPeriod>

/** Whether a free pull campaign is open at a date (projected like every event period when event scheduling is on). */
export function isGachaCampaignOpen(campaignId: number, date: Date): boolean {
    const period = periods[String(campaignId)]
    return period !== undefined && isContentPeriodOpen(masterDate(period.start).getTime(), masterDate(period.end).getTime(), date)
}

/**
 * The player's `gacha_campaign_list` for /load: their stored rows, plus a row with a free pull left (count 1) for each
 * portal of an open campaign they have none for. Portals the server can't draw are left out, so the client doesn't offer a
 * pull that would fail: those it hasn't converted, and the Welcome Back Portals other than the one open to the player
 * (src/lib/comebackGacha.ts; campaigns 12, 19 and 20 list them).
 */
export function clientGachaCampaignListSync(playerId: number, date: Date): UserGachaCampaign[] {
    const stored = getPlayerGachaCampaignListSync(playerId)
    const list = stored.map(serializeGachaCampaign)
    const has = new Set(stored.map(row => `${row.campaignId}:${row.gachaId}`))
    const comebackGachaId = comebackGachaPeriodSync(playerId, date)?.gachaId
    for (const [campaignId, period] of Object.entries(periods)) {
        if (!isGachaCampaignOpen(Number(campaignId), date)) continue
        for (const gachaId of period.gachaIds) {
            if (has.has(`${campaignId}:${gachaId}`) || getGachaSync(gachaId) === null) continue
            if (isComebackGacha(gachaId) && gachaId !== comebackGachaId) continue
            list.push({ campaign_id: Number(campaignId), gacha_id: gachaId, count: 1 })
        }
    }
    return list
}
