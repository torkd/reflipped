// Handles mail.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { gameBody, integer } from "../schemas";

interface GetBossBody {
    event_id: number,
    viewer_id: number
}

const getBossSchema = gameBody({ event_id: integer })

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_boss", { schema: getBossSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetBossBody

        const viewerId = request.viewer.viewerId
        const eventId = body.event_id
        if (isNaN(eventId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const playerId = request.viewer.playerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "raid_boss": {
                    "hp_percentage": 100,
                    "total_kill_count": 0
                }
            }
        })
    })
}

export default routes;