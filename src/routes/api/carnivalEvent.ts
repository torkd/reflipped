// The Hanifolk Carnival's own routes (FT-11): its top screen (carnival_event/index: the bosses' records and the party
// sets) and its party sets alone (carnival_event/get_party). Battles go through single_battle_quest (src/lib/carnival.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { atomicHandler } from "../../lib/atomic";
import { carnivalRecordsReply } from "../../lib/carnival";
import { CARNIVAL_PARTY_CATEGORY, eventPartyGroupListSync } from "../../lib/eventParties";
import { isQuestOpen } from "../../lib/questPeriods";
import { QuestCategory } from "../../lib/types";
import { generateDataHeaders, getServerDate } from "../../utils";
import { gameBody, ignoredBody, integer } from "../schemas";

/** The client's "out of period" result code for carnival_event/index (CarnivalEventIndexRemoteInput.OutOfPeriod). */
const OUT_OF_PERIOD = 5303

interface IndexBody {
    event_id: number,
    viewer_id: number
}

const indexSchema = gameBody({
    event_id: integer
}, ["event_id"])

const routes = async (fastify: FastifyInstance) => {
    // atomic: the first visit copies the normal parties into the event's party sets
    fastify.post("/index", { schema: indexSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as IndexBody
        const playerId = request.viewer.playerId
        reply.header("content-type", "application/x-msgpack")

        // the event's period, as its quests have it (an event's quest ids are `event id * 1000 + number`)
        if (!isQuestOpen(QuestCategory.CARNIVAL_EVENT, body.event_id * 1000 + 1, getServerDate())) {
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId, result_code: OUT_OF_PERIOD }),
                "data": []
            })
        }

        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            "data": {
                "records": carnivalRecordsReply(playerId, body.event_id),
                "user_party_group_list": eventPartyGroupListSync(playerId, CARNIVAL_PARTY_CATEGORY)
            }
        })
    }))

    fastify.post("/get_party", { schema: ignoredBody }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            "data": {
                "user_party_group_list": eventPartyGroupListSync(request.viewer.playerId, CARNIVAL_PARTY_CATEGORY)
            }
        })
    }))
}

export default routes;
