// how_to_get/get_list (FT-16): the "How to obtain" list of an item or armament (src/lib/howToGet.ts). The client sends
// `item_id` for an item and `equipment_id` for an armament.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, getServerDate } from "../../utils";
import { gameBody, integer } from "../schemas";
import { howToGetSync } from "../../lib/howToGet";

const getListSchema = gameBody({ item_id: integer, equipment_id: integer })

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_list", { schema: getListSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { item_id?: number, equipment_id?: number }
        const target = body.item_id !== undefined ? { kind: "item" as const, id: body.item_id }
            : body.equipment_id !== undefined ? { kind: "equipment" as const, id: body.equipment_id } : null
        if (target === null) return reply.status(400).send({ "error": "Bad Request", "message": "Name an item or an armament." })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            "data": howToGetSync(request.viewer.playerId, target, getServerDate())
        })
    })
}

export default routes;
