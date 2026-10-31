// Handles mail.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { gameBody, integer } from "../schemas";

interface ItemListBody {
    api_count: number,
    viewer_id: number,
}

const itemListSchema = gameBody({ api_count: integer })

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/item_list", { schema: itemListSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ItemListBody

        const viewerId = request.viewer.viewerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "payment_item_list": []
            }
        })
    })
}

export default routes;