import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import playerRoutePlugin from "./player"
import { getServerDate } from "../../utils";
import { getAllPlayersSync } from "../../data/wdfpData";
import { readPage, renderPage } from "./layout";
import settingsRoutePlugin from "./settings";

export { staticPagesDir } from "./layout";

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", async (_: FastifyRequest, reply: FastifyReply) => {
        const currentServerTime = getServerDate().toISOString().replace(/\.\d\d\dZ/, "")
        const html = renderPage("index", "Dashboard", "dashboard", {
            currentServerTime,
            currentServerTimeText: currentServerTime.replace("T", " ").slice(0, 16),
            playerCount: String(getAllPlayersSync(0, Number.MAX_SAFE_INTEGER).length)
        })
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })

    fastify.get("/credits", async (_: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(renderPage("credits", "Credits", "credits"))
    })

    fastify.register(playerRoutePlugin, { prefix: "/player" })
    fastify.register(settingsRoutePlugin, { prefix: "/settings" })
}

// served by the public game server, not the admin one
export const newsWebPlugin = async (fastify: FastifyInstance) => {
    // the page the game opens for its news / notice links (appOption urlHomeNews etc., answered by the AIR shell)
    fastify.get("/news", async (_: FastifyRequest, reply: FastifyReply) => {
        const currentServerTime = getServerDate().toISOString().replace(/\.\d\d\dZ/, "").replace("T", " ")
        const html = readPage("news").replace("{{currentServerTime}}", currentServerTime)
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(html)
    })
}

export default routes;
