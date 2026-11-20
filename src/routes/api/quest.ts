// Quest lookups: the suggested parties under a battle's quest detail (FT-50, src/lib/recentParties.ts).

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { gameBody, integer } from "../schemas";
import { recentOtherPlayerPartiesSync } from "../../lib/recentParties";

const recentPartySchema = gameBody({
    category: integer,
    quest_id: integer
}, ["category", "quest_id"])

const routes = async (fastify: FastifyInstance) => {
    // other players' parties that cleared the quest; an empty list for a quest nobody else cleared or that doesn't exist
    fastify.post("/get_recent_other_player_party", { schema: recentPartySchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { category: number, quest_id: number }
        const { viewerId, playerId } = request.viewer
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "recent_other_player_party": recentOtherPlayerPartiesSync(playerId, body.category, body.quest_id)
            }
        })
    })
}

export default routes;
