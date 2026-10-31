import { FastifyInstance } from "fastify";

/**
 * What the AIR shell asks before it trusts an address the player typed (client/air-shell, SH-2).
 * Plain JSON, no game auth: it runs before any viewer exists. `cdn` is `SHELL_CDN` (an absolute
 * base URL for the asset archives) or null, which makes the shell use `<server>/patch/Live/2.0.0`.
 */
const routes = async (fastify: FastifyInstance) => {
    fastify.get("/config", { config: { gameAuth: "none" } }, (_, reply) => {
        reply.header("cache-control", "no-store").status(200).send({
            reflipped: 1,
            name: process.env.SERVER_NAME || "Reflipped",
            cdn: process.env.SHELL_CDN || null
        })
    })
}

export default routes
