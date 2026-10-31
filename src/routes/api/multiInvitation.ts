import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRoomByAccessToken } from "../../lib/coop/rooms";
import { escapeHtml, readPage } from "../web/layout";
import { query, string } from "../schemas";

/**
 * The page a co-op room link opens (docs/coop-research.md, "Room links").
 *
 * The host's game shares `room_url` from create_room, rewritten onto its own `urlFriendFollowServer`:
 * `<server>/latest/api/index.php/multi_invitation/join?k=<token>`, the original server's form (its captured create_room
 * reply; the request log masks `k`). A browser can't hand that to the game, so this page links to the game's own
 * scheme, `wdfp://social-room?k=<token>`, which the game turns into `InvokeUrl.Room(token)` → `verify_access_token` → `select_room` (accepted_type 4). Android needs an
 * app that declares the `wdfp` scheme: the original APK and the AIR shell do.
 */

/** What `CoopRoom.accessToken` looks like; anything else is answered without a lookup. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/join", {
        config: { gameAuth: "none" },
        schema: query({ k: string })
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const token = String((request.query as { k?: string }).k ?? "")
        const room = TOKEN.test(token) ? getRoomByAccessToken(token) : undefined
        reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store")
        if (!room) return reply.status(404).send(readPage("invitation-closed"))

        // Chrome on Android opens other apps more reliably through an intent: URL than through a bare custom scheme
        const android = /Android/i.test(String(request.headers["user-agent"] ?? ""))
        const link = android
            ? `intent://social-room?k=${token}#Intent;scheme=wdfp;end`
            : `wdfp://social-room?k=${token}`
        return reply.status(200).send(readPage("invitation")
            .replace("{{link}}", escapeHtml(link))
            .replace("{{roomNumber}}", escapeHtml(room.roomNumber)))
    })
}

export default routes
