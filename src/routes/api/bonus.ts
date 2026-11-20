import { FastifyInstance } from "fastify";
import { acknowledgeLoginBonuses } from "../../lib/loginBonus";
import { atomicHandler } from "../../lib/atomic";
import { generateDataHeaders } from "../../utils";
import { gameBody, integer } from "../schemas";

const routes = async (fastify: FastifyInstance) => {
    // The client sends this immediately before showing the animations. Rewards were already earned by /load.
    fastify.post("/shown", { schema: gameBody({ api_count: integer }) }, atomicHandler((request, reply) => {
        acknowledgeLoginBonuses(request.viewer.playerId)
        return reply.header("content-type", "application/x-msgpack").send({
            data_headers: generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            data: []
        })
    }))

    // Sent without waiting for the reply after the "premium login bonus has ended" reminder. /load never lists an
    // expired premium bonus (`expired_premium_bonus_list` is null), so there is nothing to record.
    fastify.post("/shown_expired_premium", { schema: gameBody({ bonus_group_id: integer }) }, (request, reply) => {
        return reply.header("content-type", "application/x-msgpack").send({
            data_headers: generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            data: []
        })
    })
}

export default routes;
