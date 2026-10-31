import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getItemCatalog } from "../../lib/catalog";
import { query } from "../schemas";

const routes = async (fastify: FastifyInstance) => {
    // units, equipment and items the admin mail picker offers
    fastify.get("/", { schema: query() }, async (request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(200).send(getItemCatalog())
    })
}

export default routes;
