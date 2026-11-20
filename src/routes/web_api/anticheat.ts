// Admin actions for the anti-cheat review (SEC-18 phase 2): the mode, dismissing a flag, restricting, unrestricting and
// blocking a player. POSTs, so the admin guard refuses them from other sites (SEC-10); each redirects with a fixed
// notice code to the page it came from (`back`: the review page, or the player's page).
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ANTICHEAT_MODES, AnticheatMode, setAnticheatMode } from "../../lib/anticheat";
import { blockPlayer, dismissFlag, restrictPlayer, unrestrictPlayer } from "../../lib/anticheatReview";
import { getPlayerSync } from "../../data/wdfpData";
import { isLocalProfile } from "../../lib/serverProfile";
import { jsonBody } from "../schemas";
import { setSettings } from "../../data/serverSettings";

const digits = { type: "string", pattern: "^[0-9]{1,15}$" }
const back = { enum: ["review", "player"] }
const settingsSchema = jsonBody({ "anticheat.wall_clock_slack_seconds": { type: ["string", "number"] } }, ["anticheat.wall_clock_slack_seconds"])
const modeSchema = jsonBody({ mode: { enum: [...ANTICHEAT_MODES, "default"] } }, ["mode"])
const flagSchema = jsonBody({ flagId: digits, back, status: { enum: ["open", "dismissed", "all"] }, player: digits }, ["flagId"])
const playerSchema = jsonBody({ playerId: digits, back, status: { enum: ["open", "dismissed", "all"] }, player: digits }, ["playerId"])

interface Context { back?: "review" | "player", status?: string, player?: string }

/** Where to return: the player's page, or the review page with the filters it had. */
function returnTo(context: Context, playerId: number | null, code: string, kind: "message" | "error" = "message"): string {
    if (context.back === "player" && playerId !== null) return `/player/${playerId}?${kind}=${code}`
    const filters = [context.status && context.status !== "open" ? `status=${context.status}` : "", context.player ? `player=${context.player}` : ""].filter(Boolean)
    return `/security?${[...filters, `${kind}=${code}`].join("&")}#review`
}

const routes = async (fastify: FastifyInstance) => {
    // the mode: off, log (rules record flags, nobody notices) or enforce (impossible finishes stay off shared boards)
    fastify.post("/mode", { schema: modeSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (isLocalProfile()) return reply.code(409).send({ message: "Anti-cheat is always off on the server on the phone." })
        const { mode } = request.body as { mode: AnticheatMode | "default" }
        setAnticheatMode(mode === "default" ? null : mode)
        request.log.info({ userId: request.adminUser?.id ?? null, mode }, "anti-cheat mode saved")
        return reply.redirect(`/security?message=mode_${mode}#anticheat`)
    })

    // the timing tolerance, the one anti-cheat number an owner may tune (src/data/serverSettings.ts)
    fastify.post("/settings", { schema: settingsSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (isLocalProfile()) return reply.code(409).send({ message: "Anti-cheat is always off on the server on the phone." })
        const value = (request.body as Record<string, unknown>)["anticheat.wall_clock_slack_seconds"]
        const invalid = setSettings({ "anticheat.wall_clock_slack_seconds": value })
        return reply.redirect(`/security?${invalid.length > 0 ? "error=invalid_setting" : "message=settings_saved"}#anticheat`)
    })

    fastify.post("/dismiss", { schema: flagSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Context & { flagId: string }
        const done = dismissFlag(Number(body.flagId), request.adminUser?.id ?? null)
        return reply.redirect(returnTo(body, null, done ? "dismissed" : "flag_closed", done ? "message" : "error"))
    })

    fastify.post("/restrict", { schema: playerSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Context & { playerId: string }
        const playerId = Number(body.playerId)
        if (getPlayerSync(playerId) === null) return reply.redirect(returnTo(body, null, "unknown_player", "error"))
        restrictPlayer(playerId, request.adminUser?.id ?? null)
        request.log.info({ userId: request.adminUser?.id ?? null, playerId }, "anti-cheat: player restricted")
        return reply.redirect(returnTo(body, playerId, "restricted"))
    })

    fastify.post("/unrestrict", { schema: playerSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Context & { playerId: string }
        const playerId = Number(body.playerId)
        if (getPlayerSync(playerId) === null) return reply.redirect(returnTo(body, null, "unknown_player", "error"))
        unrestrictPlayer(playerId, request.adminUser?.id ?? null)
        request.log.info({ userId: request.adminUser?.id ?? null, playerId }, "anti-cheat: player unrestricted")
        return reply.redirect(returnTo(body, playerId, "unrestricted"))
    })

    fastify.post("/block", { schema: playerSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Context & { playerId: string }
        const playerId = Number(body.playerId)
        if (getPlayerSync(playerId) === null) return reply.redirect(returnTo(body, null, "unknown_player", "error"))
        if (!blockPlayer(playerId, request.adminUser?.id ?? null)) return reply.redirect(returnTo(body, playerId, "unknown_player", "error"))
        request.log.info({ userId: request.adminUser?.id ?? null, playerId }, "anti-cheat: player blocked")
        return reply.redirect(returnTo(body, playerId, "blocked"))
    })
}

export default routes;
