import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getGachaDateRange, getOpenGachaIdsSync } from "../../lib/assets";
import { parseServerTime, setServerTime } from "../../utils";
import { ignoredBody, jsonBody, string, stringOrInteger } from "../schemas";
import { applyPreset, resetSettings, setSettings, SETTINGS } from "../../data/serverSettings";

interface TimeBody {
    time: string | undefined
    force: string | undefined
}

// SEC-6; parseServerTime checks the format
const timeSchema = jsonBody({ time: { type: "string", maxLength: 32 }, force: string }, ["time"])

// every setting is optional, so a caller can change one (`curl -d coop.companion_delay_seconds=20`); ranges are checked
// by setSettings
const settingsSchema = jsonBody(Object.fromEntries(SETTINGS.map(setting => [setting.key, stringOrInteger])))
const settingsPresetSchema = jsonBody({ preset: { type: "string", maxLength: 32 } }, ["preset"])

// Server-wide state only the admin site changes (SEC-11): these are POSTs (the site's forms, or `curl -d ...`), which
// the admin guard refuses from other sites (src/lib/adminGuard.ts).
const routes = async (fastify: FastifyInstance) => {

    // The Settings page (src/data/serverSettings.ts): all or nothing, so one value out of range changes nothing.
    fastify.post("/settings", { schema: settingsSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const invalid = setSettings(request.body as Record<string, unknown>)
        return reply.redirect(invalid.length > 0 ? `/settings?error=invalid_setting` : `/settings?message=settings_saved`)
    })

    // A preset from the Settings page (SETTING_PRESETS): sets every setting at once.
    fastify.post("/settingsPreset", { schema: settingsPresetSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { preset } = request.body as { preset: string }
        return reply.redirect(applyPreset(preset) ? `/settings?message=preset_applied` : `/settings?error=unknown_preset`)
    })

    fastify.post("/resetSettings", { schema: ignoredBody }, async (_: FastifyRequest, reply: FastifyReply) => {
        resetSettings()
        return reply.redirect(`/settings?message=settings_reset`)
    })

    fastify.post("/resetTime", { schema: ignoredBody }, async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            // convert string to date
            setServerTime(null)
        } catch (error) { }

        return reply.redirect(`/`);
    })

    fastify.post("/time", { schema: timeSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as TimeBody
        const newTime = body.time
        if (!newTime) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid query parameters."
        })

        // the web page's date picker sends "YYYY-MM-DDTHH:MM" (no seconds); API callers send "YYYY-MM-DDTHH:MM:SS"
        const time = parseServerTime(newTime)
        if (!time) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid time. Use YYYY-MM-DDTHH:MM[:SS] (UTC)."
        })

        // With no summoning portal open the client fails with C8601, and a new player can't finish the tutorial
        // (it ends with a pull). Refuse such a time unless the caller insists.
        const range = getGachaDateRange()
        if (getOpenGachaIdsSync(time).length === 0 && body.force !== "1") return reply.status(400).send({
            "error": "Bad Request",
            "message": `No summoning portal is open at that time, so the game fails to load it and new players cannot finish the tutorial. Pick a time between ${range.start} and ${range.end} (UTC), or add force=1 to set it anyway.`
        })

        setServerTime(time)

        return reply.redirect(`/`);
    })
}

export default routes;