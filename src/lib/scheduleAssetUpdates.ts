/** Let the stock client return to title and reload masters when its content view changes. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pack, unpack } from "msgpackr";
import { availableAssetVersion } from "./assetLayers";
import { scheduledContentEnabled } from "./eventSchedule";
import { hasActiveBattleQuest } from "../routes/api/singleBattleQuest";
import { generateDataHeaders } from "../utils";

const CONTINUE = /\/(single_battle_quest|multi_battle_quest)\/play_continue$/
const SETTLEMENT = /\/(?:single_battle_quest|multi_battle_quest|story_quest)\/(?:finish|abort)$/
// The co-op invitation poll (every 15 s in battle) and its client log: neither spends nor awards anything, and a 214
// to either throws a running battle back to title before it can settle (device test, FT-32).
const BATTLE_POLL = /\/attention\/(?:check|logger)$/

/** Register after authentication and content-clock binding, before the replay guard. */
export function registerScheduleAssetUpdates(api: FastifyInstance): void {
    const settleBeforeUpdating = new WeakSet<FastifyRequest>()
    api.addHook("preHandler", async (request, reply) => {
        if (!scheduledContentEnabled() || !request.viewer) return
        const clientVersion = request.headers.res_ver
        // Old tools and fixture clients without a resource version keep their normal API contract.
        if (typeof clientVersion !== "string" || clientVersion === availableAssetVersion()) return
        const route = request.routeOptions.url ?? request.url.split("?")[0]
        const continuation = CONTINUE.exec(route)
        if (continuation && hasActiveBattleQuest(request.viewer.playerId, continuation[1] === "multi_battle_quest")) {
            // A continue has a fixed cost and uses the already pinned battle. Refresh only when it finishes or
            // aborts, so an automatic rotation cannot return the player to title halfway through that battle.
            return
        }
        const inBattle = () => hasActiveBattleQuest(request.viewer!.playerId, false) || hasActiveBattleQuest(request.viewer!.playerId, true)
        if (BATTLE_POLL.test(route) && inBattle()) return
        if (SETTLEMENT.test(route)) {
            settleBeforeUpdating.add(request)
            return
        }
        // SWF RemoteErrorKind.ResourceVersionError(214) returns to title. No gameplay handler has
        // run, so switching a profile/TT view cannot spend or award through stale local masters.
        return reply.type("application/x-msgpack").send({
            data_headers: generateDataHeaders({ result_code: 214, asset_update: true,
                viewer_id: request.viewer.viewerId }),
            data: {}
        })
    })
    api.addHook("onSend", (request, reply, payload, done) => {
        if (!settleBeforeUpdating.has(request) || reply.statusCode !== 200
            || reply.getHeader("content-type") !== "application/x-msgpack") return done(null, payload)
        // The root msgpack hook has encoded this already. Atomic handlers only reach onSend after
        // COMMIT; failed settlements therefore keep their error and never advertise a success.
        // This work is synchronous: another async onSend yield races async legacy handlers that
        // send without returning their reply, allowing an implicit second response on real HTTP.
        let result = payload
        try {
            const response = typeof payload === "string" ? unpack(Buffer.from(payload, "base64")) : payload
            if (response && typeof response === "object" && response.data_headers?.result_code === 1) {
                response.data_headers.asset_update = true
                result = pack(response).toString("base64")
            }
        } catch (error) {
            done(error as Error)
            return
        }
        done(null, result)
    })
}
