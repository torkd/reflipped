// Border rewards (FT-11): Chrono Trials' clear-time tiers and Score Scramble's score borders. Each tier pays once, the
// first time a battle passes its border, by mail under the tier's mail reason.

import { MailType } from "../data/types";
import { InvalidMailError, sendPlayerMailSync } from "./mail";

export interface BorderReward {
    /** GeneralRewardKind: 0 item, 1 equipment, 2 beads, 3 mana, 4 pooled exp, 5 unit, 6 title */
    kind: number
    id?: number
    number: number
}

export interface BorderTier {
    id: number
    reasonId: number
    rewards: BorderReward[]
}

/**
 * The mail type of each GeneralRewardKind. Reward lists in replies (e.g. the raid's reward dialogs) carry `kind` in this
 * numbering too: the client's reward converters read 1 item, 6 equipment, 13 title, and so on.
 */
export const MAIL_TYPES: Record<number, MailType> = {
    0: MailType.ITEM,
    1: MailType.EQUIPMENT,
    2: MailType.FREE_VMONEY,
    3: MailType.FREE_MANA,
    4: MailType.EXP_POOL,
    5: MailType.CHARACTER,
    6: MailType.DEGREE
}

/** Mails the rewards of the tiers a battle reached; returns whether any mail went out. A full gift box skips a mail. */
export function mailBorderRewardsSync(playerId: number, tiers: BorderTier[], subject: string): boolean {
    let sent = false
    for (const tier of tiers) {
        for (const reward of tier.rewards) {
            const type = MAIL_TYPES[reward.kind]
            if (type === undefined) continue
            try {
                sendPlayerMailSync(playerId, {
                    type,
                    typeId: reward.id ?? null,
                    number: reward.number,
                    subject,
                    description: "Border Reward",
                    reasonId: tier.reasonId,
                    durableReward: true
                })
                sent = true
            } catch (error) {
                if (!(error instanceof InvalidMailError)) throw error
            }
        }
    }
    return sent
}

/** A party slot of a finish body's `statistics.party` (`{id}`, or a bare id), as an id or null for an empty slot. */
export function partySlotIds(slots: unknown): (number | null)[] {
    return (Array.isArray(slots) ? slots : []).slice(0, 3).map(slot => {
        const id = slot !== null && typeof slot === "object" ? (slot as { id?: unknown }).id : slot
        return typeof id === "number" && Number.isSafeInteger(id) ? id : null
    })
}

/** The party's slots as the event replies' `main_character_ids` hold them: slot number to unit id. */
export function mainCharacterIds(partyCharacterIds: (number | null)[]): Record<string, number> {
    const ids: Record<string, number> = {}
    partyCharacterIds.forEach((characterId, slot) => { if (characterId !== null) ids[String(slot)] = characterId })
    return ids
}
