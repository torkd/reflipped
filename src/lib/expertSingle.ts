// Solo Boss Challenges and Nostalgia Trials (FT-7, `EXPERT_SINGLE_EVENT`). Their attempts (each event's daily
// challenge point, spent by a clear) are handled with every other quest's in src/lib/questAttempts.ts.
//
// A quest starts only at the player rank it needs (`selectable_player_rank`: 80 for the Godly+ quests, 90 for the
// Nostalgia Trials) and once the quest the game shows it after is cleared (`viewable_need_quest_1`: main quest 1-8-2
// and the like for a Godly+ quest, the Godly+ one for its Hell quest, a world story boss for a Nostalgia Trial). The
// client already hides or greys out what isn't startable; this refuses a client that asks anyway. A quest's first S+
// clear pays its S+ chest (`battle_rank_ss_reward_id`, a Summoning Ticket here), like every quest's.

import expertSingleEventQuests from "../../assets/expert_single_event_quest.json";
import { getPlayerSync } from "../data/wdfpData";
import { playerRankSync } from "./assets";
import { referencedQuestClearedSync } from "./questAttempts";
import { RawQuest } from "./types";

const quests = expertSingleEventQuests as unknown as Record<string, RawQuest>

/** Why an expert quest can't start, or null when its rank and the quest before it allow it. */
export function expertQuestStartRefusal(playerId: number, questId: number): string | null {
    const quest = quests[String(questId)]
    if (quest === undefined) return "This quest isn't a Solo Boss Challenge."

    const player = getPlayerSync(playerId)
    if (quest.playerRank !== undefined && playerRankSync(player?.rankPoint ?? 0) < quest.playerRank) return `Needs rank ${quest.playerRank}.`

    const need = quest.needQuest
    if (need !== undefined && !referencedQuestClearedSync(playerId, need.kind, need.questId)) return `Needs quest ${need.questId} cleared first.`
    return null
}
