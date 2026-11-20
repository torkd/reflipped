// The gift box's received history (history/receive), the Score Scramble battle history (FT-11) and the Practice
// Combat battle history (FT-17).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { clientSerializeMailHistory, listMailHistorySync, mailHistoryPageSize } from "../../lib/mail";
import { generateDataHeaders, getServerDate } from "../../utils";
import { gameBody, ignoredBody, integer, pageNumber } from "../schemas";
import { scoreAttackHistorySync } from "../../lib/scoreAttack";
import { practiceHistorySync } from "../../lib/practice";

interface ReceiveBody {
    page: number,
    viewer_id: number
}

const receiveSchema = gameBody({
    page: pageNumber
})

interface ScoreAttackBattleBody {
    event_id: number,
    viewer_id: number
}

const scoreAttackBattleSchema = gameBody({
    event_id: integer
}, ["event_id"])

const routes = async (fastify: FastifyInstance) => {
    // the player's recent Practice Combat battles, cleared or given up, the latest first (src/lib/practice.ts); the
    // client sends no parameters; read-only
    fastify.post("/practice_battle", { schema: ignoredBody }, async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: request.viewer.viewerId
            }),
            "data": {
                "history": practiceHistorySync(request.viewer.playerId)
            }
        })
    })

    // read-only, so no atomicHandler
    // the player's recent Score Scramble battles of an event, the latest first (src/lib/scoreAttack.ts); read-only
    fastify.post("/score_attack_event_battle", { schema: scoreAttackBattleSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ScoreAttackBattleBody
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: request.viewer.viewerId
            }),
            "data": {
                "history": scoreAttackHistorySync(request.viewer.playerId, body.event_id)
            }
        })
    })

    fastify.post("/receive", { schema: receiveSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody
        const playerId = request.viewer.playerId

        // pages start at 1; a page past the end is empty. The client sizes its list from total_count, so both
        // count the same mail: the last received in the last week (at most mailLimits.historyMails are kept).
        const page = Math.max(1, Math.floor(Number(body.page) || 1))
        const history = listMailHistorySync(playerId, getServerDate())

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: request.viewer.viewerId
            }),
            "data": {
                "total_count": history.length,
                "history": history.slice((page - 1) * mailHistoryPageSize, page * mailHistoryPageSize).map(clientSerializeMailHistory)
            }
        })
    })
}

export default routes;
