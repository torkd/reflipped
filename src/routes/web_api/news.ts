// Admin actions on the news posts (ADM-4), from the admin News page (src/routes/web/news.ts): POSTs, so the admin
// guard refuses them from other sites (SEC-10). Each redirects back with a fixed notice code.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { addNewsPost, getNewsPost, NEWS_BODY_MAX, NEWS_TITLE_MAX, removeNewsPost, setNewsPostHidden, updateNewsPost } from "../../data/news";
import { publishDueNews, setNewsAutoEnabled } from "../../lib/newsAuto";
import { ignoredBody, jsonBody, query } from "../schemas";

const digits = { type: "string", pattern: "^[0-9]{1,15}$" }
const postQuery = query({ id: digits, page: digits }, ["id"])
const textFields = { title: { type: "string", maxLength: NEWS_TITLE_MAX * 4 }, body: { type: "string", maxLength: NEWS_BODY_MAX * 2 } }
const postSchema = jsonBody(textFields, ["title", "body"])
const editSchema = { ...postQuery, ...postSchema }
const hideSchema = { ...postQuery, ...jsonBody({ hidden: { type: "string", enum: ["0", "1"] } }, ["hidden"]) }
const deleteSchema = { ...postQuery, ...ignoredBody }
const autoSchema = jsonBody({ enabled: { type: "string", enum: ["0", "1"] } }, ["enabled"])

/** A title or text an admin may post: a single-line title and a body, within the limits, with no control characters but newlines. */
function checked(body: { title: string, body: string }): { title: string, body: string } | "title" | "body" {
    const title = body.title.trim()
    if (title.length === 0 || title.length > NEWS_TITLE_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(title)) return "title"
    const text = body.body.replace(/\r\n?/g, "\n").trim()
    if (text.length === 0 || text.length > NEWS_BODY_MAX || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)) return "body"
    return { title, body: text }
}

const back = (request: FastifyRequest) => {
    const page = Number((request.query as { page?: string }).page)
    return Number.isInteger(page) && page > 1 ? `&page=${page}` : ""
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/", { schema: postSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const result = checked(request.body as { title: string, body: string })
        if (typeof result === "string") return reply.redirect(`/news?error=invalid-${result}`)
        addNewsPost(result.title, result.body, "admin", Date.now())
        request.log.info({ userId: request.adminUser?.id ?? null }, "news post published")
        return reply.redirect("/news?message=posted")
    })

    fastify.post("/edit", { schema: editSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const id = Number((request.query as { id: string }).id)
        const result = checked(request.body as { title: string, body: string })
        if (getNewsPost(id) === null) return reply.redirect("/news?error=unknown-post")
        if (typeof result === "string") return reply.redirect(`/news?error=invalid-${result}${back(request)}`)
        updateNewsPost(id, result.title, result.body)
        return reply.redirect(`/news?message=saved${back(request)}`)
    })

    fastify.post("/hide", { schema: hideSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const id = Number((request.query as { id: string }).id)
        const { hidden } = request.body as { hidden: "0" | "1" }
        if (!setNewsPostHidden(id, hidden === "1")) return reply.redirect("/news?error=unknown-post")
        return reply.redirect(`/news?message=${hidden === "1" ? "hidden" : "shown"}${back(request)}`)
    })

    fastify.post("/delete", { schema: deleteSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const id = Number((request.query as { id: string }).id)
        if (!removeNewsPost(id)) return reply.redirect("/news?error=unknown-post")
        return reply.redirect("/news?message=deleted")
    })

    // the automatic event posts on or off; turning them on publishes the ones that are due
    fastify.post("/auto", { schema: autoSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { enabled } = request.body as { enabled: "0" | "1" }
        setNewsAutoEnabled(enabled === "1")
        if (enabled === "1") publishDueNews()
        request.log.info({ userId: request.adminUser?.id ?? null, enabled: enabled === "1" }, "automatic news posts switched")
        return reply.redirect(`/news?message=${enabled === "1" ? "auto-on" : "auto-off"}`)
    })
}

export default routes;
