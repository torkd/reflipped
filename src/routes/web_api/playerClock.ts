import { getEventPolicy } from "../../lib/eventPolicy";
import { scheduledContentEnabled } from "../../lib/eventSchedule";
// A player's own clock (FT-5, src/lib/playerClock.ts), from the admin player page: POSTs, so the admin guard refuses
// them from other sites like the server clock's (SEC-11).
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { setPlayerClockSync } from "../../lib/playerClock";
import { PlayerDayResult, setPlayerDaySync } from "../../lib/playerClockChange";
import { ignoredBody, jsonBody, query, string } from "../schemas";

const digits = { type: "string", pattern: "^[0-9]{1,15}$" }
const playerQuery = query({ id: digits }, ["id"])
const setClockSchema = { ...playerQuery, ...jsonBody({ date: { type: "string", maxLength: 10 }, force: string }, ["date"]) }
const resetClockSchema = { ...playerQuery, ...ignoredBody }

/** The player page's notice for each outcome, spelled out (test/playerClock.test.ts checks each one renders). */
const CLOCK_NOTICES: Record<Exclude<PlayerDayResult, "no-player">, string> = {
    "clock-set": "?message=clock-set",
    "clock-cooldown": "?error=clock-cooldown",
    "clock-invalid": "?error=clock-invalid",
    "clock-out-of-range": "?error=clock-out-of-range",
    "clock-no-portal": "?error=clock-no-portal"
}

const routes = async (fastify: FastifyInstance) => {
    // Puts the player on a game day ("YYYY-MM-DD", the page's date picker) at the server clock's time of day.
    fastify.post("/", { schema: setClockSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (scheduledContentEnabled() && !getEventPolicy().adminTimeTravel) return reply.code(403).send({ code: "admin-time-travel-disabled", message: "Enable admin time travel in Settings first." })
        const playerId = Number((request.query as { id: string }).id)
        const { date, force } = request.body as { date: string, force?: string }
        // as for the server clock: with no portal open the client fails with C8601, so only on request
        const result = setPlayerDaySync(playerId, date, force === "1", true)
        if (result === "no-player") return reply.redirect("/player")
        const page = `/player/${playerId}`
        return reply.redirect(page + CLOCK_NOTICES[result])
    })

    // The player follows the server clock again.
    fastify.post("/reset", { schema: resetClockSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (scheduledContentEnabled() && !getEventPolicy().adminTimeTravel) return reply.code(403).send({ code: "admin-time-travel-disabled", message: "Enable admin time travel in Settings first." })
        const playerId = Number((request.query as { id: string }).id)
        if (setPlayerClockSync(playerId, null) === null) return reply.redirect("/player")
        return reply.redirect(`/player/${playerId}?message=clock-reset`)
    })
}

export default routes;
