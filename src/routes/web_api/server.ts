import { setPlayerSaveImportSetting } from "../../lib/playerSaveImport";
import { COMEBACK_RULES, ComebackRule, setComebackRule } from "../../lib/comebackRule";
import { setEnabledPeriodicPacks } from "../../lib/periodicPacks";
import { campaignModeOverrides, setCampaignModes } from "../../lib/campaignModes";
import { runInTransactionSync } from "../../data/wdfpData";
import { saveEventSettings, EventSettingsUpdate } from "../../lib/eventSettings";
import { getRaidHpPolicy, RaidHpMode, setRaidHpPolicy } from "../../lib/raid";
import { getEventPolicy, setEventPolicy, EVENT_MODES } from "../../lib/eventPolicy";
import { eventCatalog, DEFAULT_MANUAL_WINDOWS, getEventScheduleView, getManualWindows, jumpToEventSync, setManualWindows, scheduledContentEnabled } from "../../lib/eventSchedule";
import { GAME_DAY_MS, gameDayOf } from "../../lib/calendar";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getGachaDateRange, getOpenGachaIdsSync } from "../../lib/assets";
import { parseServerTime, setServerTime } from "../../utils";
import { getCalendarWindows, getClockStatus, startCalendar, stopCalendar } from "../../lib/serverClock";
import { changeRotation, contentWarning, listEvents, RotationChange } from "../../lib/eventCalendar";
import { EARLIEST_CLOCK_YEAR, checkCalendarWindow, isClockYear, LATEST_CLOCK_YEAR, MAX_CALENDAR_WINDOWS, MAX_WINDOW_LABEL_LENGTH } from "../../lib/calendar";
import { ignoredBody, jsonBody, query, string, stringOrInteger } from "../schemas";
import "@fastify/multipart"; // request.file()
import { applyPreset, resetSettings, setSettings, SETTINGS, TEXT_SETTINGS } from "../../data/serverSettings";
import { removeUploadedThumbnail, saveUploadedThumbnail, THUMBNAIL_MAX_BYTES } from "../../data/serverThumbnail";
import { getServerVersion, SHELL_PROTOCOL } from "../../lib/serverVersion";
import { minimumAppVersion } from "../../lib/shellHandshake";

interface TimeBody {
    time: string | undefined
    force: string | undefined
}

// SEC-6; parseServerTime checks the format
const timeSchema = jsonBody({ time: { type: "string", maxLength: 32 }, force: string }, ["time"])

// every setting is optional, so a caller can change one (`curl -d coop.companion_delay_seconds=20`); ranges are checked
// by setSettings
// `tab` is the Settings page tab the form came from, so the reply goes back to it
const settingsSchema = jsonBody(Object.fromEntries([...SETTINGS.map(setting => [setting.key, stringOrInteger]),
    ...TEXT_SETTINGS.map(setting => [setting.key, { type: "string", maxLength: setting.maxLength }]),
    ["tab", { enum: ["identity"] }]]))
const settingsPresetSchema = jsonBody({ preset: { type: "string", maxLength: 32 } }, ["preset"])
// the event calendar (FT-5): its pages send forms, `back` names the page to return to
const calendarModeSchema = jsonBody({ mode: { enum: ["on", "off"] }, back: { enum: ["dashboard", "calendar"] } }, ["mode"])
const calendarWindowsSchema = jsonBody({
    action: { enum: ["add", "event", "remove", "up", "down", "default"] },
    // a window's 0-based position: digits from a form, or an integer from JSON
    index: { type: ["string", "integer"], pattern: "^[0-9]{1,3}$", minimum: 0, maximum: MAX_CALENDAR_WINDOWS - 1 },
    event: { type: "string", maxLength: 64 },
    from: { type: "string", maxLength: 10 },
    to: { type: "string", maxLength: 10 },
    label: { type: "string", maxLength: MAX_WINDOW_LABEL_LENGTH },
    force: string
}, ["action"])
const calendarJumpSchema = jsonBody({ event: { type: "string", maxLength: 64 }, day: stringOrInteger }, ["event"])

// Server-wide state only the admin site changes (SEC-11): these are POSTs (the site's forms, or `curl -d ...`), which
// the admin guard refuses from other sites (src/lib/adminGuard.ts).
const routes = async (fastify: FastifyInstance) => {
    fastify.post("/events", { schema: jsonBody({
        mode: { enum: [...EVENT_MODES] }, acceleration: stringOrInteger,
        adminTimeTravel: { enum: ["1", "0"] }, management: { enum: ["managed", "automatic"] },
        multiplierOverride: { type: ["string", "number", "null"], maxLength: 32 },
        bossMultiplierOverride: { type: ["string", "number", "null"], maxLength: 32 },
        multiplierPercent: stringOrInteger, bossMultiplierPercent: stringOrInteger
    }, ["mode", "management"]) }, async (request, reply) => {
        try { saveEventSettings(request.body as EventSettingsUpdate) }
        catch (error) {
            if (!(error instanceof RangeError)) throw error
            return reply.code(400).send({ code: "invalid-event-settings", message: error.message })
        }
        request.log.info({ userId: request.adminUser?.id ?? null, mode: getEventPolicy().mode }, "event and reward settings saved")
        return reply.redirect("/settings?message=events_saved")
    })

    // players importing their own save on the portal (ACC-15, src/lib/playerSaveImport.ts); an unticked box sends nothing
    fastify.post("/saveImport", { schema: jsonBody({ playerSaveImport: { enum: ["1", "0"] } }) }, async (request, reply) => {
        const on = (request.body as { playerSaveImport?: string } | undefined)?.playerSaveImport === "1"
        setPlayerSaveImportSetting(on)
        request.log.info({ userId: request.adminUser?.id ?? null, playerSaveImport: on }, "save import setting saved")
        return reply.redirect("/settings?message=save_import_saved")
    })

    // who the one-off comeback login calendars take (FT-65, src/lib/comebackRule.ts)
    fastify.post("/comebackRule", { schema: jsonBody({ comebackRule: { enum: [...COMEBACK_RULES] } }, ["comebackRule"]) }, async (request, reply) => {
        const rule = (request.body as { comebackRule: ComebackRule }).comebackRule
        setComebackRule(rule)
        request.log.info({ userId: request.adminUser?.id ?? null, comebackRule: rule }, "comeback rule saved")
        return reply.redirect("/settings?message=comeback_saved")
    })

    // periodic packs given to every player (FT-89, src/lib/periodicPacks.ts): a pack_<id> field for each one on, the rest off
    fastify.post("/periodicPacks", { schema: { body: { type: "object", additionalProperties: true } } }, async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>
        const ids = Object.entries(body)
            .filter(([key, value]) => /^pack_[a-z0-9_]+$/.test(key) && (value === "1" || value === 1 || value === true))
            .map(([key]) => key.slice("pack_".length))
        try { setEnabledPeriodicPacks(ids) }
        catch (error) {
            if (!(error instanceof RangeError)) throw error
            return reply.code(400).send({ code: "invalid-periodic-packs", message: error.message })
        }
        request.log.info({ userId: request.adminUser?.id ?? null, packs: ids }, "periodic packs saved")
        return reply.redirect("/settings?message=packs_saved")
    })

    // raid bosses (FT-12, src/lib/raid.ts): the shared HP pool's size; the players are left out when automatic locks them
    fastify.post("/raids", { schema: jsonBody({
        raidHpMode: { enum: ["fixed", "automatic"] }, raidHpPlayers: stringOrInteger
    }, ["raidHpMode"]) }, async (request, reply) => {
        const body = request.body as { raidHpMode: RaidHpMode, raidHpPlayers?: string | number }
        try { setRaidHpPolicy({ mode: body.raidHpMode, players: body.raidHpPlayers === undefined ? getRaidHpPolicy().players : Number(body.raidHpPlayers) }) }
        catch (error) {
            if (!(error instanceof RangeError)) throw error
            return reply.code(400).send({ code: "invalid-raid-settings", message: error.message })
        }
        request.log.info({ userId: request.adminUser?.id ?? null, raid: getRaidHpPolicy() }, "raid settings saved")
        return reply.redirect("/settings?message=raids_saved")
    })


    // campaign bundles (FT-39, FT-44, src/lib/campaignModes.ts): special_<id> and startdash_<id> fields, "paid" or
    // "free"; a campaign the form leaves out goes back to the original's mode
    fastify.post("/campaignGifts", { schema: { body: { type: "object", additionalProperties: true } } }, async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>
        const fields = (prefix: string) => Object.fromEntries(Object.entries(body)
            .filter(([key]) => new RegExp(`^${prefix}\\d+$`).test(key))
            .map(([key, value]) => [Number(key.slice(prefix.length)), String(value)]))
        const modes = { specialExchange: fields("special_"), startDash: fields("startdash_") }
        try { setCampaignModes(modes) }
        catch (error) {
            if (!(error instanceof RangeError)) throw error
            return reply.code(400).send({ code: "invalid-campaign-gifts", message: error.message })
        }
        request.log.info({ userId: request.adminUser?.id ?? null, campaigns: campaignModeOverrides() }, "campaign bundles saved")
        return reply.redirect("/settings?message=gifts_saved")
    })

    // The Settings page (src/data/serverSettings.ts): all or nothing, so one value out of range changes nothing.
    fastify.post("/settings", { schema: settingsSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { tab, ...values } = request.body as Record<string, unknown>
        const identity = tab === "identity"
        const back = identity ? "#identity" : ""
        try {
            const invalid = setSettings(values)
            const error = invalid.some(key => key === "shell.min_app_version" || key === "shell.latest_app_version") ? "invalid_app_version"
                : invalid.some(key => TEXT_SETTINGS.some(setting => setting.key === key)) ? "invalid_text_setting"
                : invalid.some(key => SETTINGS.find(setting => setting.key === key)?.unit === "MiB")
                ? "invalid_database_setting" : "invalid_setting"
            if (invalid.length > 0) return reply.redirect(`/settings?error=${error}${back}`)
            // an image URL takes over from an uploaded image, as an upload takes over from the URL
            if (typeof values["server.thumbnail"] === "string" && values["server.thumbnail"].trim() !== "") removeUploadedThumbnail()
            return reply.redirect(`/settings?message=${identity ? "identity_saved" : "settings_saved"}${back}`)
        } catch (error) {
            if (!(error instanceof RangeError)) throw error
            return reply.redirect(`/settings?error=invalid_database_default${back}`)
        }
    })

    // The server card image (Server identity tab): a PNG, JPEG or WebP the app can show, checked by its header. It
    // replaces the image URL setting. The page shows a fixed message per outcome.
    fastify.post("/thumbnail", { schema: query() }, async (request: FastifyRequest, reply: FastifyReply) => {
        let data: Buffer
        try {
            const file = await request.file({ limits: { fileSize: THUMBNAIL_MAX_BYTES, files: 1 } })
            if (file === undefined) return reply.redirect("/settings?error=thumbnail_missing#identity")
            data = await file.toBuffer()
        } catch (error) {
            const code = (error as { code?: string }).code
            if (code === "FST_REQ_FILE_TOO_LARGE") return reply.redirect("/settings?error=thumbnail_too_large#identity")
            if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE") return reply.redirect("/settings?error=thumbnail_missing#identity")
            throw error
        }
        if (data.length === 0) return reply.redirect("/settings?error=thumbnail_missing#identity")
        const result = saveUploadedThumbnail(data)
        if (!result.ok) {
            request.log.warn({ reason: result.reason, bytes: data.length }, "server image upload rejected")
            return reply.redirect(`/settings?error=${result.reason === "too-large" ? "thumbnail_too_large" : "thumbnail_invalid"}#identity`)
        }
        const { type, width, height, bytes } = result.image
        request.log.info({ userId: request.adminUser?.id ?? null, type, width, height, bytes }, "server image uploaded")
        return reply.redirect("/settings?message=thumbnail_uploaded#identity")
    })

    fastify.post("/thumbnail/remove", { schema: ignoredBody }, async (request: FastifyRequest, reply: FastifyReply) => {
        removeUploadedThumbnail()
        request.log.info({ userId: request.adminUser?.id ?? null }, "server image removed")
        return reply.redirect("/settings?message=thumbnail_removed#identity")
    })

    // A preset from the Settings page (SETTING_PRESETS): sets every setting at once.
    fastify.post("/settingsPreset", { schema: settingsPresetSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { preset } = request.body as { preset: string }
        return reply.redirect(applyPreset(preset) ? `/settings?message=preset_applied` : `/settings?error=unknown_preset`)
    })

    fastify.post("/resetSettings", { schema: ignoredBody }, async (_: FastifyRequest, reply: FastifyReply) => {
        // the timing and database settings only: the server identity has its own tab and keeps its values
        try { resetSettings({ keepIdentity: true }) }
        catch (error) {
            if (!(error instanceof RangeError)) throw error
            return reply.redirect("/settings?error=invalid_database_default")
        }
        return reply.redirect(`/settings?message=settings_reset`)
    })

    // SH-15: what is running, for scripts and monitoring: the release version and commit, the shell protocol and the
    // oldest app version accepted. Liveness alone is GET /healthz on the game listener.
    fastify.get("/health", { schema: query() }, async (_: FastifyRequest, reply: FastifyReply) => {
        const { version, commit, builtAt } = getServerVersion()
        return reply.header("cache-control", "no-store").send({
            status: "ok", version, commit, builtAt, protocol: SHELL_PROTOCOL, minAppVersion: minimumAppVersion(),
            uptimeSeconds: Math.floor(process.uptime())
        })
    })

    // The clock as JSON, for scripts: mode, date, the calendar's window and rotation, and the content warning.
    fastify.get("/clock", { schema: query() }, async (_: FastifyRequest, reply: FastifyReply) => {
        const status = getClockStatus()
        return reply.send(scheduledContentEnabled() ? { ...status, events: getEventPolicy(), view: getEventScheduleView(), windows: getManualWindows(), warning: null } : { ...status, windows: getCalendarWindows(), warning: contentWarning() })
    })

    // Runs the clock on the event calendar, or lets it run on freely (src/lib/serverClock.ts).
    fastify.post("/calendar/mode", { schema: calendarModeSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (scheduledContentEnabled()) return reply.code(409).send({ message: "Choose an event mode in Settings. The progression clock keeps advancing." })
        const { mode, back } = request.body as { mode: "on" | "off", back?: "dashboard" | "calendar" }
        const page = back === "dashboard" ? "/" : "/calendar"
        if (mode === "off") {
            stopCalendar()
            return reply.redirect(`${page}?message=calendar_off`)
        }
        return reply.redirect(startCalendar() ? `${page}?message=calendar_on` : `${page}?error=empty_calendar`)
    })

    // Adds, removes or moves a window of the rotation, or restores the default one (src/lib/eventCalendar.ts).
    fastify.post("/calendar/windows", { schema: calendarWindowsSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (scheduledContentEnabled()) {
            if (getEventPolicy().mode !== "manual") return reply.code(409).send({ message: "Choose Manual event mode in Settings first." })
            const change = request.body as RotationChange
            const windows = getManualWindows()
            if (change.action === "default") windows.splice(0, windows.length, ...DEFAULT_MANUAL_WINDOWS.map(window => ({ ...window })))
            else if (change.action === "event") {
                const event = eventCatalog.find(event => event.id === change.event)
                if (!event) return reply.code(400).send({ message: "Unknown event" })
                windows.push({ from: gameDayOf(event.startTime), to: gameDayOf(event.endTime - 1), label: event.name, eventId: event.id })
            } else if (change.action === "add") {
                const window = checkCalendarWindow(change.from, change.to, change.label)
                if (typeof window === "string") return reply.code(400).send({ message: window })
                windows.push(window)
            } else {
                const index = Number(change.index)
                if (!Number.isInteger(index) || index < 0 || index >= windows.length) return reply.code(400).send({ message: "Unknown playlist entry" })
                if (change.action === "remove") windows.splice(index, 1)
                else {
                    const other = index + (change.action === "up" ? -1 : 1)
                    if (other < 0 || other >= windows.length) return reply.code(400).send({ message: "Entry is already at that end" })
                    ;[windows[index], windows[other]] = [windows[other], windows[index]]
                }
            }
            if (!windows.length) return reply.code(400).send({ message: "Keep at least one period in the Manual playlist, or restore its default period." })
            if (windows.length > MAX_CALENDAR_WINDOWS) return reply.code(400).send({ message: "Playlist is full" })
            try { runInTransactionSync(() => {
                setManualWindows(windows)
                const policy = getEventPolicy()
                const now = Date.now()
                setEventPolicy({ ...policy, anchor: now, rotationId: now })
            }) } catch (error) {
                if (!(error instanceof RangeError)) throw error
                return reply.code(400).send({ message: error.message })
            }
            return reply.redirect("/calendar?message=playlist_saved")
        }
        const result = changeRotation(request.body as RotationChange)
        return reply.redirect(`/calendar?${result.ok ? "message" : "error"}=${result.code}`)
    })

    // The Calendar page's "Go to" for one event: the shared content timeline (or, with event scheduling off, the server
    // clock) moves to the event's opening, or to a later day of it (`day`, 1 = the opening), so a single event can be
    // tested, including what its later days unlock.
    fastify.post("/calendar/jump", { schema: calendarJumpSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { event: eventId, day: rawDay } = request.body as { event: string, day?: string | number }
        const day = rawDay === undefined || rawDay === "" ? 1 : Number(rawDay)
        if (scheduledContentEnabled()) {
            const result = jumpToEventSync(eventId, Date.now(), day)
            if (result !== "ok") return reply.redirect(`/calendar?error=${result}`)
            return reply.redirect(day > 1 ? "/calendar?message=event_day_jump" : "/calendar?message=event_jump")
        }
        const event = listEvents().find(event => event.id === eventId)
        if (event === undefined) return reply.redirect("/calendar?error=unknown_event")
        const days = Math.max(1, Math.ceil((event.end.getTime() + 1000 - event.start.getTime()) / GAME_DAY_MS))
        if (!Number.isSafeInteger(day) || day < 1 || day > days) return reply.redirect("/calendar?error=invalid_day")
        const target = new Date(event.start.getTime() + (day - 1) * GAME_DAY_MS)
        // the game fails with C8601 without a portal open (see /time)
        if (getOpenGachaIdsSync(target).length === 0) return reply.redirect("/calendar?error=no_portal")
        // a time set by hand runs on freely: the calendar stops
        setServerTime(target)
        return reply.redirect(day > 1 ? "/calendar?message=event_day_jump" : "/calendar?message=event_jump")
    })

    fastify.post("/resetTime", { schema: ignoredBody }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (scheduledContentEnabled()) return reply.code(409).send({ message: "The progression clock follows real time. Choose event settings instead." })
        try {
            // convert string to date
            setServerTime(null)
        } catch (error) { }

        return reply.redirect(`/`);
    })

    fastify.post("/time", { schema: timeSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (scheduledContentEnabled()) return reply.code(409).send({ message: "The progression clock follows real time. Use Calendar or personal time travel to select content." })
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

        // a hard limit, unlike the one below: past it a player's own save export may no longer import (src/lib/calendar.ts)
        if (!isClockYear(time.getTime())) return reply.status(400).send({
            "error": "Bad Request",
            "message": `Pick a time from ${EARLIEST_CLOCK_YEAR} to ${LATEST_CLOCK_YEAR} (UTC).`
        })

        // With no summoning portal open the client fails with C8601, and a new player can't finish the tutorial
        // (it ends with a pull). Refuse such a time unless the caller insists.
        const range = getGachaDateRange()
        if (getOpenGachaIdsSync(time).length === 0 && body.force !== "1") return reply.status(400).send({
            "error": "Bad Request",
            "message": `No summoning portal is open at that time, so the game fails to load it and new players cannot finish the tutorial. Pick a time between ${range.start} and ${range.end} (UTC), or add force=1 to set it anyway.`
        })

        // a time set by hand runs on freely: the calendar stops (it starts again from the Calendar page)
        setServerTime(time)

        return reply.redirect(`/`);
    })
}

export default routes;