import Fastify, { FastifyInstance, FastifyRequest, FastifyServerOptions } from "fastify";
import { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser";
import fastifyStatic from "@fastify/static";
import { pack, unpack } from "msgpackr";
import { appPath, cdnDir } from "./lib/paths";
import { downloadsDisabled } from "./lib/gameDataDownload";
import { dataPackDir } from "./lib/dataPack";
import { createReadStream, existsSync, statSync } from "fs";
// api routes
import apiPlugin from "./routes/api";
import assetApiPlugin from "./routes/api/asset";
import toolApiPlugin from "./routes/api/tool";
import reproduceApiPlugin from "./routes/api/reproduce"
import tutorialApiPlugin from "./routes/api/tutorial"
import gachaApiPlugin from "./routes/api/gacha"
import partyApiPlugin from "./routes/api/party"
import expodApiPlugin from "./routes/api/expod"
import storyQuestApiPlugin from "./routes/api/storyQuest"
import optionApiPlugin from "./routes/api/option"
import singleBattleQuestApiPlugin from "./routes/api/singleBattleQuest"
import multiBattleQuestApiPlugin from "./routes/api/multiBattleQuest"
import multiInvitationApiPlugin from "./routes/api/multiInvitation"
import friendApiPlugin from "./routes/api/friend"
import attentionApiPlugin from "./routes/api/attention"
import characterApiPlugin from "./routes/api/character"
import partyGroupApiPlugin from "./routes/api/partyGroup"
import equipmentApiPlugin from "./routes/api/equipment"
import exBoostApiPlugin from "./routes/api/exBoost"
import boxGachaApiPlugin from "./routes/api/boxGacha"
import shopApiPlugin from "./routes/api/shop"
import itemApiPlugin from "./routes/api/item"
import characterElectionApiPlugin from "./routes/api/characterElection"
import encyclopediaApiPlugin from "./routes/api/encyclopedia"
import mailApiPlugin from "./routes/api/mail"
import historyApiPlugin from "./routes/api/history"
import rankingEventApiPlugin from "./routes/api/rankingEvent"
import missionApiPlugin from "./routes/api/mission"
import bonusApiPlugin from "./routes/api/bonus"
import activeMissionApiPlugin from "./routes/api/activeMission"
import profileApiPlugin from "./routes/api/profile"
import followApiPlugin from "./routes/api/follow"
import specialExchangeApiPlugin from "./routes/api/specialExchange"
import startDashExchangeApiPlugin from "./routes/api/startDashExchange"
import exchangeApiPlugin from "./routes/api/exchange"
import paymentApiPlugin from "./routes/api/payment"
import newsApiPlugin from "./routes/api/news"
import raidEventApiPlugin from "./routes/api/raidEvent"
import rushEventApiPlugin from "./routes/api/rushEvent"
import carnivalEventApiPlugin from "./routes/api/carnivalEvent"
import multiSpecialExchangeApiPlugin from "./routes/api/multiSpecialExchange"
import loungeApiPlugin from "./routes/api/lounge"
import howToGetApiPlugin from "./routes/api/howToGet"
import snsApiPlugin from "./routes/api/sns"
import agreementApiPlugin from "./routes/api/agreement"
import questApiPlugin from "./routes/api/quest"
// web routes
import indexWebPlugin, { newsWebPlugin } from "./routes/web"
// web api routes
import indexWebApiPlugin from "./routes/web_api"
// misc routes
import openapiPlugin from "./routes/openapi";
import infodeskPlugin from "./routes/infodesk";
import shellPlugin from "./routes/shell";
import datapackServePlugin from "./routes/datapackServe";
import portalPlugin from "./routes/portal";
import { createGameAuthPreHandler, GameViewer, ParamCheckMode } from "./lib/gameAuth";
import { registerRateLimit, RateLimitOptions } from "./lib/rateLimit";
import { adminApiTokenFromEnv, adminAuthFromEnv, createAdminLoginGuard } from "./lib/adminAuth";
import adminLoginWebPlugin from "./routes/web/login";
import { ADMIN_BODY_LIMIT, checkDecodedBody, GAME_BODY_LIMIT } from "./lib/bodyLimits";
import { registerReplayGuard } from "./lib/replayGuard";
import { registerPlayerClock } from "./lib/playerClock";
import { registerAdminGuard } from "./lib/adminGuard";
import { genReqId, registerSafeErrors, withSafeLogging } from "./lib/logging";
import { OVERLAY_URL_DIR, overlayRoot } from "./lib/assetLayers";
import { CN_PATCH_URL_DIR, cnPatchArchivePath } from "./lib/cnPatches";
import { scheduleArchivePath, SCHEDULE_URL_DIR } from "./lib/scheduleAssets";
import { registerScheduleAssetUpdates } from "./lib/scheduleAssetUpdates";
import { Metrics } from "./lib/metrics";
import { query } from "./routes/schemas";

// gc-openapi-zinny3.kakaogames.com
// gc-infodesk-zinny3.kakaogames.com
// na.wdfp.kakaogames.com

// content-type parsers

/** A 400 for a body that decodes but is too deep or too large (`src/lib/bodyLimits.ts`). */
function bodyLimitError(message: string): Error {
    return Object.assign(new Error(message), { statusCode: 400, code: "FST_ERR_BODY_LIMITS" })
}

function jsonParser(_: FastifyRequest, body: string, done: ContentTypeParserDoneFunction) {
    let json: unknown
    try {
        json = JSON.parse(body)
    } catch (err) {
        // the routes' schemas reject a missing body where one is needed
        return done(null, undefined)
    }
    const problem = checkDecodedBody(json)
    if (problem !== null) return done(bodyLimitError(problem), undefined)
    done(null, json)
}

export interface BuildOptions {
    /** Optional shared collector for game and admin listener metrics. */
    metrics?: Metrics
    logger?: FastifyServerOptions["logger"]
    /** What the game API does with unsigned requests (`src/lib/gameAuth.ts`); defaults to `PARAM_CHECK`. */
    paramCheck?: ParamCheckMode
    /** per-IP rate limits; none when omitted (the real server passes them from the environment, see `src/lib/rateLimit.ts`) */
    rateLimit?: RateLimitOptions
    /** Fastify `trustProxy`: set it behind a reverse proxy so `request.ip` is the real client (`TRUST_PROXY`) */
    trustProxy?: FastifyServerOptions["trustProxy"]
    /** raw body limit in bytes; each server has its default (`src/lib/bodyLimits.ts`) */
    bodyLimit?: number
    /** whether the admin site needs a login (ACC-5, `src/lib/adminAuth.ts`); defaults to `ADMIN_AUTH` (on unless `off`) */
    adminAuth?: boolean
    /** the Bearer token that opens `/api/*` without a login; defaults to `ADMIN_API_TOKEN` */
    adminApiToken?: string | null
}

/**
 * Creates a Fastify instance with the msgpack serializer and the content-type parsers.
 */
function createInstance(options: BuildOptions): FastifyInstance {
    const fastify = Fastify({
        // request IDs, masked URLs and generic 5xx bodies (src/lib/logging.ts)
        logger: withSafeLogging(options.logger),
        genReqId,
        trustProxy: options.trustProxy ?? false,
        bodyLimit: options.bodyLimit,
        // route schemas (src/routes/schemas.ts) use type lists such as ["string", "integer"]
        ajv: { customOptions: { allowUnionTypes: true } }
    })

    // before the rate limit, so a 429 carries the request ID too
    registerSafeErrors(fastify)
    registerRateLimit(fastify, options.rateLimit)

    // serializers
    fastify.addHook('onSend', (_, reply, payload, done) => {
        try {
            switch (reply.getHeader('content-type')) {
                case "application/x-msgpack": {
                    done(null, pack(payload).toString('base64'))
                    break;
                }
                default:
                    done(null, payload)
            }
        } catch (error) {
            done(null, payload)
        }

    })

    // content-type parsers
    fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: 'string' }, (request: FastifyRequest, body: string, done) => {
        // on IOS, for some reason, requests to infodesk and openapi are JSON, but the content-type header is set as 'application/x-www-form-urlencoded'
        const routeUrl = request.routeOptions.url || ''
        if (routeUrl.startsWith("/openapi") || routeUrl.startsWith("/infodesk"))
            return jsonParser(request, body, done);

        let unpacked: unknown
        try {
            unpacked = unpack(Buffer.from(body, "base64"))
        } catch (err) {
            return done(Object.assign(err as Error, { statusCode: 400 }), undefined)
        }
        const problem = checkDecodedBody(unpacked)
        if (problem !== null) return done(bodyLimitError(problem), undefined)
        // the game signs the body as sent (PARAM, src/lib/gameAuth.ts)
        request.rawBody = body
        done(null, unpacked)
    })
    fastify.addContentTypeParser('application/json', { parseAs: 'string' }, jsonParser)
    fastify.decorateRequest("rawBody", null)

    return fastify
}

/** Serves the shared stylesheet, scripts and images of the web pages under /public. */
function registerWebStatic(fastify: FastifyInstance) {
    fastify.register(fastifyStatic, {
        root: appPath("web", "public"),
        prefix: "/public",
        decorateReply: false
    })
}

/**
 * Builds the public game server: game API, Kakao openapi/infodesk, the news page, the player portal and the CDN.
 * It has no admin routes; those are on `buildAdminServer()`, which listens separately.
 * Does not start listening, so tests can use `fastify.inject()`.
 */
export function buildServer(options: BuildOptions = {}): FastifyInstance {
    const fastify = createInstance({ bodyLimit: GAME_BODY_LIMIT, ...options })
    const metrics = options.metrics ?? new Metrics()
    metrics.register(fastify, "game")
    // in a plugin so it loads after the rate limiter: @fastify/rate-limit only limits routes added once it is loaded
    fastify.register(async (instance) => {
        instance.get("/healthz", async (_request, reply) => reply.header("cache-control", "no-store").send({ status: "ok" }))
    })

    // SEC-16: no MIME sniffing of any reply, and no framing of a page that doesn't set its own policy (the portal's
    // helmet CSP already has frame-ancestors 'none'); the game reads its replies itself and ignores both
    fastify.addHook("onSend", (_request, reply, payload, done) => {
        if (!reply.hasHeader("x-content-type-options")) reply.header("x-content-type-options", "nosniff")
        if (!reply.hasHeader("content-security-policy")) reply.header("content-security-policy", "frame-ancestors 'none'")
        done(null, payload)
    })

    // register plugins

    // api: every route goes through the game auth preHandler unless it opts out (src/lib/gameAuth.ts)
    fastify.register(async (api) => {
        // set by the game auth preHandler; null on routes that opt out
        api.decorateRequest("viewer", null as unknown as GameViewer)
        api.addHook("preHandler", createGameAuthPreHandler(options.paramCheck))
        // after game auth: the rest of each request runs on its player's clock (src/lib/playerClock.ts)
        registerPlayerClock(api)
        registerScheduleAssetUpdates(api)
        // a retried request (same api_count and body) gets the reply it already had (src/lib/replayGuard.ts)
        registerReplayGuard(api)

        api.register(apiPlugin)
        api.register(assetApiPlugin, { prefix: "/asset" })
        api.register(toolApiPlugin, { prefix: "/tool" })
        api.register(reproduceApiPlugin, { prefix: "/reproduce" })
        api.register(tutorialApiPlugin, { prefix: "/tutorial" })
        api.register(gachaApiPlugin, { prefix: "/gacha" })
        api.register(partyApiPlugin, { prefix: "/party" })
        api.register(expodApiPlugin, { prefix: "/expod" })
        api.register(storyQuestApiPlugin, { prefix: "/story_quest" })
        api.register(optionApiPlugin, { prefix: "/option" })
        api.register(singleBattleQuestApiPlugin, { prefix: "/single_battle_quest" })
        api.register(multiBattleQuestApiPlugin, { prefix: "/multi_battle_quest" })
        // the web page a shared co-op room link opens
        api.register(multiInvitationApiPlugin, { prefix: "/multi_invitation" })
        // the web page a shared profile link opens
        api.register(friendApiPlugin, { prefix: "/friend" })
        api.register(attentionApiPlugin, { prefix: "/attention" })
        api.register(characterApiPlugin, { prefix: "/character" })
        api.register(partyGroupApiPlugin, { prefix: "/party_group" })
        api.register(equipmentApiPlugin, { prefix: "/equipment" })
        api.register(exBoostApiPlugin, { prefix: "/ex_boost" })
        api.register(boxGachaApiPlugin, { prefix: "/box_gacha" })
        api.register(shopApiPlugin, { prefix: "/shop" })
        api.register(itemApiPlugin, { prefix: "/item" })
        api.register(characterElectionApiPlugin, { prefix: "/character_election" })
        api.register(encyclopediaApiPlugin, { prefix: "/encyclopedia" })
        api.register(mailApiPlugin, { prefix: "/mail" })
        api.register(historyApiPlugin, { prefix: "/history" })
        api.register(questApiPlugin, { prefix: "/quest" })
        api.register(rankingEventApiPlugin, { prefix: "/ranking_event" })
        api.register(missionApiPlugin, { prefix: "/mission" })
        api.register(bonusApiPlugin, { prefix: "/bonus" })
        api.register(activeMissionApiPlugin, { prefix: "/active_mission" })
        api.register(profileApiPlugin, { prefix: "/profile" })
        api.register(followApiPlugin, { prefix: "/follow" })
        api.register(specialExchangeApiPlugin, { prefix: "/special_exchange" })
        api.register(startDashExchangeApiPlugin, { prefix: "/start_dash_exchange" })
        api.register(exchangeApiPlugin, { prefix: "/exchange" })
        api.register(paymentApiPlugin, { prefix: "/payment" })
        api.register(newsApiPlugin, { prefix: "/news" })
        api.register(raidEventApiPlugin, { prefix: "/event/raid" })
        api.register(rushEventApiPlugin, { prefix: "/event/rush" })
        api.register(carnivalEventApiPlugin, { prefix: "/carnival_event" })
        api.register(multiSpecialExchangeApiPlugin, { prefix: "/multi_special_exchange" })
        api.register(loungeApiPlugin, { prefix: "/lounge" })
        api.register(howToGetApiPlugin, { prefix: "/how_to_get" })
        api.register(snsApiPlugin, { prefix: "/sns" })
        api.register(agreementApiPlugin, { prefix: "/agreement" })
    }, { prefix: "/latest/api/index.php" })

    // openapi
    fastify.register(openapiPlugin, { prefix: "/openapi/service" })

    // infodesk
    fastify.register(infodeskPlugin, { prefix: "/infodesk" })

    // the AIR shell checks a typed server address here (SH-2)
    fastify.register(shellPlugin, { prefix: "/shell" })
    // the data pack for the app's Local play setup, when the owner serves one (DATA_PACK_SERVE_DIR)
    fastify.register(datapackServePlugin, { prefix: "/shell/datapack" })

    // the news page the game opens
    fastify.register(newsWebPlugin, { prefix: "/" })

    // the player portal: accounts, login (ACC-2)
    fastify.register(portalPlugin, { prefix: "/portal" })

    // web static
    registerWebStatic(fastify)

    // translation overlays built by `npm run i18n:build` (src/lib/assetLayers.ts), before the CDN's own route:
    // /patch/Live/2.0.0/overlay/<lang>/<archive>.zip from CDN_OVERLAY_DIR; the manifest stays private
    fastify.register(fastifyStatic, {
        root: overlayRoot(),
        prefix: `/patch/Live/2.0.0/${OVERLAY_URL_DIR}/`,
        decorateReply: false,
        // the folder only exists once an overlay is built
        suppressWarning: true,
        allowedPath: (pathName) => /^\/[a-z]{2}\/[\w.-]+\.zip$/.test(pathName)
    })

    // the archive of client files from the Chinese CDN the server built at startup (src/lib/cnPatches.ts)
    fastify.get<{ Params: { file: string } }>(`/patch/Live/2.0.0/${CN_PATCH_URL_DIR}/:file`, {
        schema: { params: { type: "object", properties: { file: { type: "string", pattern: "^cn-patches-[0-9a-f]{16}\\.zip$" } }, required: ["file"] } }
    }, async (request, reply) => {
        const file = cnPatchArchivePath(request.params.file)
        if (!file) return reply.status(404).send({ error: "Not Found" })
        return reply.type("application/zip").header("cache-control", "public, max-age=31536000, immutable").send(createReadStream(file))
    })

    // Public immutable master metadata, served here even when the bulk CDN is hosted elsewhere.
    fastify.get<{ Params: { file: string } }>(`/patch/Live/2.0.0/${SCHEDULE_URL_DIR}/:file`, {
        schema: { params: { type: "object", properties: { file: { type: "string", pattern: "^[0-9a-f]{64}\\.zip$" } }, required: ["file"] } }
    }, async (request, reply) => {
        const file = scheduleArchivePath(request.params.file)
        if (!file) return reply.status(404).send({ error: "Not Found" })
        return reply.type("application/zip").header("cache-control", "public, max-age=31536000, immutable")
            .header("etag", `"${request.params.file.slice(0, -4)}"`)
            .header("last-modified", statSync(file).mtime.toUTCString()).send(createReadStream(file))
    })

    // static CDN. A server on a data pack (SH-13) has no game files to serve unless it also has a CDN folder; with
    // GAME_DATA_DOWNLOAD=off (SH-25) it serves only the mods, and players install the base files from a pack
    if (!dataPackDir() || existsSync(cdnDir())) fastify.register(fastifyStatic, {
        root: cdnDir(),
        prefix: "/patch/Live/2.0.0",
        decorateReply: false,
        ...(downloadsDisabled() ? { allowedPath: (pathName: string) => /^\/mods\/[^/]+$/.test(pathName) } : {})
    })

    return fastify
}

/**
 * Builds the admin server: the web admin UI and every `/api/*` route (save import, developer mode, mail, clock).
 * Every page and route needs an admin login (ACC-5, `src/lib/adminAuth.ts`) unless `adminAuth` is false.
 */
export function buildAdminServer(options: BuildOptions = {}): FastifyInstance {
    // No proxy sits in front of the admin site. Trusting one would let X-Forwarded-Host from a trusted address (the
    // operator's own browser on 127.0.0.1, or the Docker gateway) pass the host check (SEC-12).
    const fastify = createInstance({ bodyLimit: ADMIN_BODY_LIMIT, ...options, trustProxy: false })
    const metrics = options.metrics ?? new Metrics()
    metrics.register(fastify, "admin")

    // host check, CSRF check and security headers (SEC-10)
    registerAdminGuard(fastify)

    // the admin login (ACC-5): after the host and cross-site checks, before any route
    const adminAuth = options.adminAuth ?? adminAuthFromEnv()
    fastify.decorateRequest("adminUser", null)
    fastify.addHook("onRequest", createAdminLoginGuard({
        enabled: adminAuth,
        apiToken: options.adminApiToken === undefined ? adminApiTokenFromEnv() : options.adminApiToken
    }))

    // the admin site's plain HTML forms (the dashboard clock); game msgpack never comes here
    fastify.removeContentTypeParser("application/x-www-form-urlencoded")
    fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
    })

    // in a plugin so it loads after the rate limiter, like /healthz
    fastify.register(async (instance) => {
        instance.get("/api/server/metrics", { schema: query() }, async (_request, reply) => reply.header("cache-control", "no-store").send(metrics.snapshot()))
    })

    // login, logout and the first admin's setup
    fastify.register(adminLoginWebPlugin, { enabled: adminAuth })

    // web routes
    fastify.register(indexWebPlugin, { prefix: "/" })

    // web api routes
    fastify.register(indexWebApiPlugin, { prefix: "/api" })

    // web static
    registerWebStatic(fastify)

    return fastify
}
