// Raid events (FT-12, src/lib/raid.ts): the boss (get_boss, also on the home screen), the event screen (summary, with
// the kill tally rewards), the raid party sets (party, category 3), battles (battle/start, finished through
// single_battle_quest/finish), the rankings by quest and their parties, and the ranking rewards.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPlayerPartyGroupListSync } from "../../data/wdfpData";
import { atomicHandler } from "../../lib/atomic";
import { getQuestFromCategorySync } from "../../lib/assets";
import { eventPartyGroupListSync, RAID_PARTY_CATEGORY } from "../../lib/eventParties";
import {
    isRaidBattlePeriod, isRaidEventPeriod, isRaidRewardPeriod, RAID_OUT_OF_PERIOD, RAID_OUT_OF_RECEIVABLE_PERIOD, raidBossReply, raidEventId,
    raidRankingPartyReply, raidRankingReply, raidSummarySync, receiveRaidRankingRewardSync, spendRaidAutoStartSync
} from "../../lib/raid";
import { multiplierForCategory } from "../../lib/rewardPolicy";
import { captureEventContext, scheduledContentEnabled } from "../../lib/eventSchedule";
import { QuestCategory } from "../../lib/types";
import { generateDataHeaders, getServerDate } from "../../utils";
import { boolean, gameBody, ignoredBody, integer, string } from "../schemas";
import { insertActiveQuest } from "./singleBattleQuest";
import { battleClientChecks } from "../../lib/missions";
import { questStaminaCost, serializeStamina, spendStaminaSync } from "../../lib/stamina";
import { setRaidBattleParty } from "../../lib/raidParties";
import raidQuests from "../../../assets/raid_event_quest.json";

const eventSchema = gameBody({ event_id: integer }, ["event_id"])

const battleStartSchema = gameBody({
    quest_id: integer,
    party_group_id: integer,
    play_id: string,
    use_auto_start_point: boolean,
    is_auto_start_mode: boolean
}, ["quest_id", "party_group_id"])

const rankingSchema = gameBody({ event_id: integer, quest_id: integer, page: integer, aggregated_time: string })

const rankingPartySchema = gameBody({ quest_id: integer, rank_number: integer, aggregated_time: string }, ["quest_id", "rank_number"])

function send(reply: FastifyReply, viewerId: number, data: unknown, resultCode?: number) {
    reply.header("content-type", "application/x-msgpack")
    return reply.status(200).send({
        "data_headers": generateDataHeaders(resultCode === undefined ? { viewer_id: viewerId } : { viewer_id: viewerId, result_code: resultCode }),
        "data": data
    })
}

/** An event's quest ids (`event id * 1000 + difficulty`). */
function eventQuestIds(eventId: number): number[] {
    return Object.keys(raidQuests).map(Number).filter(questId => raidEventId(questId) === eventId).sort((a, b) => a - b)
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_boss", { schema: eventSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { event_id: number }
        return send(reply, request.viewer.viewerId, { "raid_boss": raidBossReply(body.event_id) })
    })

    // atomic: opening the raid mails the kill tally rewards the server's kills reached
    fastify.post("/summary", { schema: eventSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { event_id: number }
        const now = getServerDate()
        if (!isRaidEventPeriod(body.event_id, now)) return send(reply, request.viewer.viewerId, [], RAID_OUT_OF_PERIOD)
        return send(reply, request.viewer.viewerId, raidSummarySync(request.viewer.playerId, body.event_id, now))
    }))

    // atomic: the first visit builds the raid sets (6 sets of Main, Sub 1 and Sub 2, from the parties the player built;
    // FT-76), and rebuilds sets stored in the old layout of 10 parties, which the client's battle can't play
    fastify.post("/party", { schema: ignoredBody }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        return send(reply, request.viewer.viewerId, { "user_party_group_list": eventPartyGroupListSync(request.viewer.playerId, RAID_PARTY_CATEGORY) })
    }))

    fastify.post("/battle/start", { schema: battleStartSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { quest_id: number, party_group_id: number, use_auto_start_point?: boolean, is_auto_start_mode?: boolean }
        const playerId = request.viewer.playerId
        const now = getServerDate()
        const quest = getQuestFromCategorySync(QuestCategory.RAID_EVENT, body.quest_id)
        const eventId = raidEventId(body.quest_id)
        if (quest === null || !("rankPointReward" in quest) || eventId === null) return reply.status(400).send({ "error": "Bad Request", "message": "Quest doesn't exist." })
        if (!isRaidBattlePeriod(eventId, now)) return reply.status(400).send({ "error": "Bad Request", "message": "This raid's battles are over." })
        // the raid set the client plays: every party of it is a member of the battle (src/lib/eventParties.ts)
        const group = getPlayerPartyGroupListSync(playerId, RAID_PARTY_CATEGORY)[String(body.party_group_id)]
        if (group === undefined) return reply.status(400).send({ "error": "Bad Request", "message": "Raid set doesn't exist." })
        if (body.use_auto_start_point === true && !spendRaidAutoStartSync(playerId, eventId, now)) {
            return reply.status(400).send({ "error": "Bad Request", "message": "No auto-battles left today." })
        }
        // stamina (FT-25)
        const staminaCost = questStaminaCost(QuestCategory.RAID_EVENT, body.quest_id, quest.staminaCost, now)
        const stamina = spendStaminaSync(playerId, staminaCost, now)
        if (stamina === null) return reply.status(400).send({ "error": "Bad Request", "message": "Not enough stamina." })

        // the set's three parties (Main, Sub 1, Sub 2), kept for the ranking if this battle sets the best score
        const parties = Object.entries(group.list).sort(([a], [b]) => Number(a) - Number(b)).map(([, party]) => party)
        setRaidBattleParty(playerId, parties.map(party => ({
            characterIds: party.characterIds, unisonCharacterIds: party.unisonCharacterIds,
            equipmentIds: party.equipmentIds, abilitySoulIds: party.abilitySoulIds
        })))

        const rewardMultiplier = multiplierForCategory(QuestCategory.RAID_EVENT)
        insertActiveQuest(playerId, {
            questId: body.quest_id,
            category: QuestCategory.RAID_EVENT,
            useBoostPoint: false,
            useBossBoostPoint: false,
            isAutoStartMode: body.is_auto_start_mode === true,
            rewardMultiplier,
            eventContext: scheduledContentEnabled() ? Object.freeze({ ...captureEventContext(), rewardMultiplier }) : undefined,
            staminaCost
        })
        return send(reply, request.viewer.viewerId, { "user_info": serializeStamina(stamina), "client_checks": battleClientChecks(QuestCategory.RAID_EVENT, body.quest_id, false, now) })
    }))

    fastify.post("/ranking", { schema: rankingSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { event_id?: number, quest_id?: number, page?: number }
        const eventId = body.event_id ?? (body.quest_id === undefined ? null : raidEventId(body.quest_id))
        if (eventId === null || eventId === undefined) return reply.status(400).send({ "error": "Bad Request", "message": "Invalid request body." })
        const questIds = body.quest_id === undefined ? eventQuestIds(eventId) : [body.quest_id]
        return send(reply, request.viewer.viewerId, raidRankingReply(request.viewer.playerId, eventId, questIds, body.page ?? 1, getServerDate()))
    })

    fastify.post("/ranking/party", { schema: rankingPartySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { quest_id: number, rank_number: number }
        const eventId = raidEventId(body.quest_id)
        if (eventId === null) return reply.status(400).send({ "error": "Bad Request", "message": "Quest doesn't exist." })
        return send(reply, request.viewer.viewerId, { "raid_ranking_party": raidRankingPartyReply(eventId, body.quest_id, body.rank_number) })
    })

    fastify.post("/ranking_reward", { schema: eventSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { event_id: number }
        if (!isRaidRewardPeriod(body.event_id, getServerDate())) return send(reply, request.viewer.viewerId, [], RAID_OUT_OF_RECEIVABLE_PERIOD)
        const { status, rewards } = receiveRaidRankingRewardSync(request.viewer.playerId, body.event_id)
        return send(reply, request.viewer.viewerId, { "status": status, "reward_list": rewards })
    }))
}

export default routes;
