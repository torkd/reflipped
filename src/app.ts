import Fastify, { FastifyInstance, FastifyRequest, FastifyServerOptions } from "fastify";
import { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser";
import fastifyStatic from "@fastify/static";
import { pack, unpack } from "msgpackr";
import path from "path";
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
import attentionApiPlugin from "./routes/api/attention"
import characterApiPlugin from "./routes/api/character"
import partyGroupApiPlugin from "./routes/api/partyGroup"
import equipmentApiPlugin from "./routes/api/equipment"
import exBoostApiPlugin from "./routes/api/exBoost"
import boxGachaApiPlugin from "./routes/api/boxGacha"
import shopApiPlugin from "./routes/api/shop"
import encyclopediaApiPlugin from "./routes/api/encyclopedia"
import mailApiPlugin from "./routes/api/mail"
import rankingEventApiPlugin from "./routes/api/rankingEvent"
import missionApiPlugin from "./routes/api/mission"
import activeMissionApiPlugin from "./routes/api/activeMission"
import profileApiPlugin from "./routes/api/profile"
import paymentApiPlugin from "./routes/api/payment"
import newsApiPlugin from "./routes/api/news"
import raidEventApiPlugin from "./routes/api/raidEvent"
import rushEventApiPlugin from "./routes/api/rushEvent"
import multiSpecialExchangeApiPlugin from "./routes/api/multiSpecialExchange"
import loungeApiPlugin from "./routes/api/lounge"
// web routes
import indexWebPlugin, { newsWebPlugin } from "./routes/web"
// web api routes
import indexWebApiPlugin from "./routes/web_api"
// misc routes
import openapiPlugin from "./routes/openapi";
import infodeskPlugin from "./routes/infodesk";
import shellPlugin from "./routes/shell";
import { createGameAuthPreHandler, GameViewer, ParamCheckMode } from "./lib/gameAuth";
import { registerRateLimit, RateLimitOptions } from "./lib/rateLimit";
import { ADMIN_BODY_LIMIT, checkDecodedBody, GAME_BODY_LIMIT } from "./lib/bodyLimits";
import { registerReplayGuard } from "./lib/replayGuard";
import { registerAdminGuard } from "./lib/adminGuard";
import { genReqId, registerSafeErrors, withSafeLogging } from "./lib/logging";
import { OVERLAY_URL_DIR, overlayRoot } from "./lib/assetLayers";

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
    logger?: FastifyServerOptions["logger"]
    /** What the game API does with unsigned requests (`src/lib/gameAuth.ts`); defaults to `PARAM_CHECK`. */
    paramCheck?: ParamCheckMode
    /** per-IP rate limits; none when omitted (the real server passes them from the environment, see `src/lib/rateLimit.ts`) */
    rateLimit?: RateLimitOptions
    /** Fastify `trustProxy`: set it behind a reverse proxy so `request.ip` is the real client (`TRUST_PROXY`) */
    trustProxy?: FastifyServerOptions["trustProxy"]
    /** raw body limit in bytes; each server has its default (`src/lib/bodyLimits.ts`) */
    bodyLimit?: number
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
        root: path.join(__dirname, "..", "web/public"),
        prefix: "/public",
        decorateReply: false
    })
}

/**
 * Builds the public game server: game API, Kakao openapi/infodesk, the news page and the CDN.
 * It has no admin routes; those are on `buildAdminServer()`, which listens separately.
 * Does not start listening, so tests can use `fastify.inject()`.
 */
export function buildServer(options: BuildOptions = {}): FastifyInstance {
    const fastify = createInstance({ bodyLimit: GAME_BODY_LIMIT, ...options })

    // register plugins

    // api: every route goes through the game auth preHandler unless it opts out (src/lib/gameAuth.ts)
    fastify.register(async (api) => {
        // set by the game auth preHandler; null on routes that opt out
        api.decorateRequest("viewer", null as unknown as GameViewer)
        api.addHook("preHandler", createGameAuthPreHandler(options.paramCheck))
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
        api.register(attentionApiPlugin, { prefix: "/attention" })
        api.register(characterApiPlugin, { prefix: "/character" })
        api.register(partyGroupApiPlugin, { prefix: "/party_group" })
        api.register(equipmentApiPlugin, { prefix: "/equipment" })
        api.register(exBoostApiPlugin, { prefix: "/ex_boost" })
        api.register(boxGachaApiPlugin, { prefix: "/box_gacha" })
        api.register(shopApiPlugin, { prefix: "/shop" })
        api.register(encyclopediaApiPlugin, { prefix: "/encyclopedia" })
        api.register(mailApiPlugin, { prefix: "/mail" })
        api.register(rankingEventApiPlugin, { prefix: "/ranking_event" })
        api.register(missionApiPlugin, { prefix: "/mission" })
        api.register(activeMissionApiPlugin, { prefix: "/active_mission" })
        api.register(profileApiPlugin, { prefix: "/profile" })
        api.register(paymentApiPlugin, { prefix: "/payment" })
        api.register(newsApiPlugin, { prefix: "/news" })
        api.register(raidEventApiPlugin, { prefix: "/event/raid" })
        api.register(rushEventApiPlugin, { prefix: "/event/rush" })
        api.register(multiSpecialExchangeApiPlugin, { prefix: "/multi_special_exchange" })
        api.register(loungeApiPlugin, { prefix: "/lounge" })
    }, { prefix: "/latest/api/index.php" })

    // openapi
    fastify.register(openapiPlugin, { prefix: "/openapi/service" })

    // infodesk
    fastify.register(infodeskPlugin, { prefix: "/infodesk" })

    // the AIR shell checks a typed server address here (SH-2)
    fastify.register(shellPlugin, { prefix: "/shell" })

    // the news page the game opens
    fastify.register(newsWebPlugin, { prefix: "/" })

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

    // static CDN
    const cdnDir = process.env.CDN_DIR || ".cdn"
    fastify.register(fastifyStatic, {
        root: path.isAbsolute(cdnDir) ? cdnDir : path.join(__dirname, "..", process.env.CDN_DIR || ".cdn"),
        prefix: "/patch/Live/2.0.0",
        decorateReply: false
    })

    return fastify
}

/**
 * Builds the admin server: the web admin UI and every `/api/*` route (save import, developer mode, mail, clock).
 * None of it requires a login yet, so it must only listen on localhost or a VPN (`ADMIN_HOST`).
 */
export function buildAdminServer(options: BuildOptions = {}): FastifyInstance {
    // No proxy sits in front of the admin site. Trusting one would let X-Forwarded-Host from a trusted address (the
    // operator's own browser on 127.0.0.1, or the Docker gateway) pass the host check (SEC-12).
    const fastify = createInstance({ bodyLimit: ADMIN_BODY_LIMIT, ...options, trustProxy: false })

    // host check, CSRF check and security headers (SEC-10)
    registerAdminGuard(fastify)

    // the admin site's plain HTML forms (the dashboard clock); game msgpack never comes here
    fastify.removeContentTypeParser("application/x-www-form-urlencoded")
    fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)))
    })

    // web routes
    fastify.register(indexWebPlugin, { prefix: "/" })

    // web api routes
    fastify.register(indexWebApiPlugin, { prefix: "/api" })

    // web static
    registerWebStatic(fastify)

    return fastify
}
