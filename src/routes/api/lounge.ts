// lounge/*: the multi special exchange lounge (CO-3). Only a stub for now: the campaign scene calls `get_list`
// on entry to fill its lounge list, and a 404 there sends the client back to the title screen (H404), so the
// solo draw and the exchange (FT-13) would be unreachable. No lounge exists yet, so the list is always empty.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { gameBody, integer } from "../schemas";

const getListSchema = gameBody({
    use_case: integer,
    api_count: integer
}, ["use_case"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_list", { schema: getListSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: request.viewer.viewerId
            }),
            "data": {
                "lounge_list": []
            }
        })
    })
}

export default routes;
