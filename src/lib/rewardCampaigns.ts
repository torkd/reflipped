// Reward boost campaigns (FT-37, `campaign/reward_campaign`, `assets/reward_campaign.json`): while a campaign is open, the
// quests in its range pay more of one kind of reward: Item (drops: score and rare rewards, Kaleidoscope materials,
// Boss Coins), Exp (unit exp and pooled exp) or Mana (the quest's mana and mana drops), at its rate (1.5 or 2). The
// client applies them the same way (`CampaignRepository.applyRewardCampaignFor`): overlapping campaigns don't stack, each
// kind takes the highest open rate. It only shows them (the 1.5×/2× badges, the quest detail's expected drops), so the
// server pays them; the result screen shows what the finish reply grants. Rank points, field mana, first-clear and S+
// rewards aren't boosted. Examples: Material Gathering Season (Kaleidoscope dailies and the Necropolis at 1.5×), the 2×
// drop weeks on main quests.

import rewardCampaigns from "../../assets/reward_campaign.json";
import { masterDate } from "../utils";
import { isContentPeriodOpen } from "./eventSchedule";
import { IdLists, rangeCovers } from "./questRanges";
import { QuestCategory } from "./types";

interface RewardCampaign {
    start: string
    end: string
    reward: "item" | "exp" | "mana"
    rate: number
    kind: number
    ids: IdLists
}

const campaigns = rewardCampaigns as RewardCampaign[]

/** The rate each kind of reward is boosted by; 1 when no campaign covers it. */
export interface RewardBoosts {
    item: number
    exp: number
    mana: number
    /** Boss Coins only, on top of `item`: a Co-Op Challenge spotlight (src/lib/bossBattlePickup.ts); absent is 1 */
    bossCoin?: number
}

export const NO_BOOSTS: Readonly<RewardBoosts> = Object.freeze({ item: 1, exp: 1, mana: 1 })

/** The open campaigns' boosts for a quest at a date (projected like every event period when event scheduling is on). */
export function rewardBoostsFor(category: QuestCategory, questId: number, date: Date): RewardBoosts {
    const boosts: RewardBoosts = { ...NO_BOOSTS }
    for (const campaign of campaigns) {
        if (campaign.rate <= boosts[campaign.reward]) continue
        if (!rangeCovers(campaign.kind, campaign.ids, category, questId)) continue
        if (!isContentPeriodOpen(masterDate(campaign.start).getTime(), masterDate(campaign.end).getTime(), date)) continue
        boosts[campaign.reward] = campaign.rate
    }
    return boosts
}
