// sns/get (FT-16): the profile's linked social account (`sns_type` 1, Twitter): `profile_image_url` and `twitter_id`
// when linked. Reflipped has no social login, so the answer is the original's for an unlinked player: no data.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { gameBody, integer } from "../schemas";

const getSchema = gameBody({ sns_type: integer })

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get", { schema: getSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: request.viewer.viewerId }),
            "data": []
        })
    })
}

export default routes;
