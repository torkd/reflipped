import { scheduledContentEnabled } from "../../lib/eventSchedule";
// Admin actions on portal users (ACC-2), from the admin site's Users pages: POSTs, so the admin guard refuses them
// from other sites (SEC-10). Each redirects back with a fixed notice code.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { countAdminsSync, createUserSync, deleteUserSync, getUserSync, setUserPasswordHashSync, setUserRoleSync, setUserTimeTravelSync, setUserTotpSync, User, UserRole } from "../../data/users";
import { deleteUserPortalSessionsSync } from "../../data/portalSessions";
import { attachSaveSync, detachSaveSync, findSaveSync } from "../../lib/saveAttach";
import { adminSessions } from "../../data/adminSessions";
import { hashPassword } from "../../lib/password";
import { PASSWORD_MAX_LENGTH, passwordProblem, usernameProblem } from "../../lib/portalAuth";
import { ignoredBody, jsonBody, query } from "../schemas";

const digits = { type: "string", pattern: "^[0-9]{1,15}$" }
const passwordField = { type: "string", maxLength: PASSWORD_MAX_LENGTH + 1 }
const role = { type: "string", enum: ["player", "admin"] }
const userQuery = query({ id: digits }, ["id"])

const createSchema = jsonBody({ username: { type: "string", maxLength: 64 }, password: passwordField, role }, ["username", "password"])
const passwordSchema = { ...userQuery, ...jsonBody({ password: passwordField }, ["password"]) }
const timeTravelSchema = { ...userQuery, ...jsonBody({ enabled: { type: "string", enum: ["0", "1"] } }, ["enabled"]) }
const roleSchema = { ...userQuery, ...jsonBody({ role }, ["role"]) }
const attachSchema = { ...userQuery, ...jsonBody({ playerId: digits, idKind: { type: "string", enum: ["player", "pid"] } }, ["playerId"]) }
const actionSchema = { ...userQuery, ...ignoredBody }

function userOf(request: FastifyRequest) {
    return getUserSync(Number((request.query as { id: string }).id))
}

/** Ends every portal and admin-site login of the user. */
function endLogins(userId: number) {
    deleteUserPortalSessionsSync(userId)
    adminSessions.deleteForUser(userId)
}

/** Whether `user` is the only admin, who must stay one: without an admin, nobody could log in to this site (ACC-5). */
function lastAdmin(user: User): boolean {
    return user.role === "admin" && countAdminsSync() <= 1
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/create", { schema: createSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { username, password, role } = request.body as { username: string, password: string, role?: UserRole }
        const problem = usernameProblem(username) ?? passwordProblem(password, username)
        if (problem !== null) return reply.redirect(`/user?error=${problem}`)
        const user = createUserSync({ username, passwordHash: await hashPassword(password), role: role ?? "player" })
        if (user === null) return reply.redirect("/user?error=taken")
        return reply.redirect(`/user/${user.id}?message=created`)
    })

    // a forgotten password: the admin sets one and every login of the user ends
    fastify.post("/password", { schema: passwordSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const user = userOf(request)
        if (user === null) return reply.redirect("/user")
        const { password } = request.body as { password: string }
        const problem = passwordProblem(password, user.username)
        if (problem !== null) return reply.redirect(`/user/${user.id}?error=${problem}`)
        setUserPasswordHashSync(user.id, await hashPassword(password))
        endLogins(user.id)
        return reply.redirect(`/user/${user.id}?message=password-set`)
    })

    fastify.post("/role", { schema: roleSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const user = userOf(request)
        if (user === null) return reply.redirect("/user")
        const role = (request.body as { role: UserRole }).role
        if (role !== "admin" && lastAdmin(user)) return reply.redirect(`/user/${user.id}?error=last-admin`)
        setUserRoleSync(user.id, role)
        // a former admin's admin-site logins end
        if (role !== "admin") adminSessions.deleteForUser(user.id)
        return reply.redirect(`/user/${user.id}?message=role-set`)
    })

    // lets the user move their own player's clock on the portal (ACC-8), or stops it; the clock itself stays
    fastify.post("/time-travel", { schema: timeTravelSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        if (scheduledContentEnabled()) return reply.code(409).send({ message: "Time travel is controlled globally by event settings." })
        const user = userOf(request)
        if (user === null) return reply.redirect("/user")
        const enabled = (request.body as { enabled: string }).enabled === "1"
        setUserTimeTravelSync(user.id, enabled)
        return reply.redirect(`/user/${user.id}?message=time-travel-${enabled ? "on" : "off"}`)
    })

    // a lost authenticator: the password alone logs in again
    fastify.post("/totp/reset", { schema: actionSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const user = userOf(request)
        if (user === null) return reply.redirect("/user")
        setUserTotpSync(user.id, null)
        return reply.redirect(`/user/${user.id}?message=totp-off`)
    })

    fastify.post("/logout", { schema: actionSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const user = userOf(request)
        if (user === null) return reply.redirect("/user")
        endLogins(user.id)
        return reply.redirect(`/user/${user.id}?message=logged-out`)
    })

    // a save (by its player number, or by its PID: ADM-3) becomes the user's; a save the user had is set aside as a guest
    // save (src/lib/saveAttach.ts). The user page's form gets here through the confirmation page (/user/<id>/attach),
    // which names the save first; a script posts here directly.
    fastify.post("/save/attach", { schema: attachSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const user = userOf(request)
        if (user === null) return reply.redirect("/user")
        const { playerId, idKind } = request.body as { playerId: string, idKind?: "player" | "pid" }
        const save = findSaveSync(Number(playerId), idKind ?? "player")
        if (save === null) return reply.redirect(`/user/${user.id}?error=save-unknown`)
        const result = attachSaveSync(user.id, save.accountId)
        switch (result.outcome) {
            case "attached": return reply.redirect(`/user/${user.id}?message=save-attached`)
            case "replaced": return reply.redirect(`/user/${user.id}?message=save-replaced`)
            case "already": return reply.redirect(`/user/${user.id}?message=save-already`)
            case "other-user": return reply.redirect(`/user/${user.id}?error=save-other-user`)
            default: return reply.redirect(`/user/${user.id}?error=save-unknown`)
        }
    })

    // the user's save becomes a guest save; its device keeps it
    fastify.post("/save/detach", { schema: actionSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const user = userOf(request)
        if (user === null) return reply.redirect("/user")
        const result = detachSaveSync(user.id)
        return reply.redirect(`/user/${user.id}?${result.outcome === "detached" ? "message=save-detached" : "error=save-none"}`)
    })

    fastify.post("/delete", { schema: actionSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const user = userOf(request)
        if (user !== null && lastAdmin(user)) return reply.redirect(`/user/${user.id}?error=last-admin`)
        if (user !== null) deleteUserSync(user.id)
        return reply.redirect("/user?message=deleted")
    })
}

export default routes;
