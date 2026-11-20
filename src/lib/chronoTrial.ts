// Chrono Trials (FT-11, `SOLO_TIME_ATTACK_EVENT`): their attempts and unlock are in src/lib/questAttempts.ts (FT-30).
// A clear pays the border rewards of the clear-time tiers it reaches (`quest/event/solo_time_attack_clear_time_reward`:
// one tier per 10 seconds from 7 minutes down to 1, beads, and a title at 5 and 3 minutes), each once: a tier is
// newly reached when the clear is within its limit and the previous best wasn't (the finish reply carries the
// previous best for that comparison). The rewards are mailed under the tier's mail reason ("::item:: earned from the
// 1-minute Border Reward for Chrono Trials", 15001-15007), and the finish reply's `solo_time_attack_event` lists them
// (`reward_ids`) with the clear time and the party's units.

import clearTimeRewards from "../../assets/solo_time_attack_clear_time_reward.json";
import { BorderTier, mailBorderRewardsSync, mainCharacterIds } from "./borderRewards";

type ClearTimeTier = BorderTier & { seconds: number }

const tiersByEvent = clearTimeRewards as Record<string, Record<string, ClearTimeTier[]>>

/** The tiers a clear in `clearMs` newly reaches, given the previous best (none before the first clear). */
export function newBorderTiers(eventId: number, questId: number, clearMs: number, previousBestMs: number | null): ClearTimeTier[] {
    const tiers = tiersByEvent[String(eventId)]?.[String(questId % 1000)] ?? []
    return tiers.filter(tier => clearMs <= tier.seconds * 1000 && (previousBestMs === null || previousBestMs > tier.seconds * 1000))
}

export interface ChronoTrialResult {
    /** the finish reply's `solo_time_attack_event` */
    reply: Record<string, unknown>
    mailArrived: boolean
}

/**
 * A Chrono Trial's finish: mails the border rewards a clear newly reaches and builds `solo_time_attack_event`. A lost
 * battle (a time-out or game over) reaches none.
 */
export function finishChronoTrialSync(
    playerId: number,
    eventId: number,
    questId: number,
    cleared: boolean,
    elapsedMs: number,
    previousBestMs: number | null,
    partyCharacterIds: (number | null)[]
): ChronoTrialResult {
    const tiers = cleared ? newBorderTiers(eventId, questId, elapsedMs, previousBestMs) : []
    const mailArrived = mailBorderRewardsSync(playerId, tiers, "Chrono Trials")
    return {
        reply: {
            "elapsed_time_ms": elapsedMs,
            "main_character_ids": mainCharacterIds(partyCharacterIds),
            "new_degree_ids": [],
            ...(previousBestMs === null ? {} : { "previous_best_elapsed_time_ms": previousBestMs }),
            "reward_ids": tiers.map(tier => tier.id)
        },
        mailArrived
    }
}
