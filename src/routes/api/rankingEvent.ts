// Ranking events (FT-33): the event screen's summary and the rank rewards (src/lib/ranking.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, getServerDate } from "../../utils";
import { isRankingRewardPeriod, RANKING_OUT_OF_RECEIVABLE_PERIOD, rankingSummarySync, receiveRankingRewardSync } from "../../lib/ranking";
import { atomicHandler } from "../../lib/atomic";
import { gameBody, integer } from "../schemas";

interface ReceiveRewardBody {
    api_count: number,
    viewer_id: number,
    ranking_event_id: number
}

interface GetSummaryBody {
    viewer_id: number,
    ranking_event_id: number,
    quest_kind: number
}

const getSummarySchema = gameBody({
    ranking_event_id: integer,
    quest_kind: integer
})

const receiveRewardSchema = gameBody({
    api_count: integer,
    ranking_event_id: integer
})

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_summary", { schema: getSummarySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetSummaryBody

        const viewerId = request.viewer.viewerId
        const eventId = body.ranking_event_id
        if (isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        const summary = rankingSummarySync(playerId, eventId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": summary
        })
    })

    fastify.post("/receive_reward", { schema: receiveRewardSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveRewardBody

        const viewerId = request.viewer.viewerId
        const eventId = body.ranking_event_id
        if (isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        // rewards only in the results announcement (the client's OutOfReceivablePeriod)
        if (!isRankingRewardPeriod(eventId, getServerDate())) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: RANKING_OUT_OF_RECEIVABLE_PERIOD }),
                "data": []
            })
        }

        const { status, summary } = receiveRankingRewardSync(playerId, eventId)
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "status": status,
                ...(summary ?? {})
            }
        })
    }))
}

export default routes;