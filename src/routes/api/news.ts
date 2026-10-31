// Handles news.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { clientSerializeDate } from "../../data/utils";
import { gameBody, integer } from "../schemas";

interface GetInfoBody {
    api_count: number,
    viewer_id: number,
    news_id: number
}

const getInfoSchema = gameBody({
    api_count: integer,
    news_id: integer
})

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_info", { schema: getInfoSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetInfoBody

        const viewerId = request.viewer.viewerId

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "id": body.news_id,
                "title": "New Halloween Event!",
                "date": clientSerializeDate(new Date()),
                "label": 3,
                "thumbnail": 1,
                // The game's rich-text parser needs <html><body>...</body></html> (C7606 otherwise) and knows only a few tags
                "html": "<html><body><h1>New Halloween Event!</h1><p>There is a new Halloween event!</p></body></html>"
            }
        })
    })
}

export default routes;