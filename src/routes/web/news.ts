// The admin News page (ADM-4): write posts, edit, hide or delete them, and switch the automatic event posts. The
// actions are POSTs in src/routes/web_api/news.ts. The game's own /news page is in src/routes/web/index.ts.
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { countNewsPosts, listNewsPosts, NEWS_BODY_MAX, NEWS_PAGE_SIZE, NEWS_TITLE_MAX, NewsPost } from "../../data/news";
import { EVENT_MODE_NAMES } from "./eventSettings";
import { getEventPolicy } from "../../lib/eventPolicy";
import { newsAutoEnabled, publishDueNews } from "../../lib/newsAuto";
import { newsDateText } from "../../lib/newsContent";
import { newsModeHasSchedule } from "../../lib/newsSchedule";
import { query, string } from "../schemas";
import { escapeHtml, noticeHtml, renderPage } from "./layout";

const notices = {
    errors: new Map([
        ["invalid-title", `Nothing was saved: the title needs 1 to ${NEWS_TITLE_MAX} characters on one line.`],
        ["invalid-body", `Nothing was saved: the text needs 1 to ${NEWS_BODY_MAX} characters.`],
        ["unknown-post", "Nothing was changed: that post no longer exists."]
    ]),
    messages: new Map([
        ["posted", "Posted. It is on the game's news page now."],
        ["saved", "Post saved."],
        ["hidden", "Post hidden: players no longer see it. Show it again any time."],
        ["shown", "Post shown on the news page again."],
        ["deleted", "Post removed. An automatic post is hidden instead, so its event isn't announced again."],
        ["auto-on", "Automatic event posts are on. Posts that are due were published."],
        ["auto-off", "Automatic event posts are off. Posts already published stay."]
    ])
}

function autoText(): string {
    const mode = EVENT_MODE_NAMES[getEventPolicy().mode]
    const when = "Each is published at the daily reset (05:00 Japan time, 20:00 UTC) seven days before the event's opening, with its dates and everything the server knows can be obtained from it."
    if (!newsAutoEnabled()) return `Off: no new event posts are published. Posts already published stay (hide or delete them below). ${when}`
    if (!newsModeHasSchedule()) return `On, but the ${mode} event mode has no set schedule, so nothing is announced; Classic, Accelerated and Manual mode publish them. ${when}`
    return `On (${mode} mode). ${when}`
}

function postCard(post: NewsPost, page: number): string {
    const back = page > 1 ? `&page=${page}` : ""
    const source = post.source === "auto" ? "Automatic" : "Written by an admin"
    return `                <article class="card${post.hidden ? " opacity-70" : ""}">
                    <div class="card-header">
                        <div class="flex flex-col gap-1">
                            <h3 class="card-title">${escapeHtml(post.title)}</h3>
                            <p class="card-text">Published ${escapeHtml(newsDateText(post.publishedAt))} · ${source}${post.hidden ? " · hidden from players" : ""}</p>
                        </div>
                        <div class="flex flex-wrap gap-2">
                            <form method="post" action="/api/news/hide?id=${post.id}${back}"><input type="hidden" name="hidden" value="${post.hidden ? 0 : 1}" /><button type="submit" class="btn-outline">${post.hidden ? "Show" : "Hide"}</button></form>
                            <form method="post" action="/api/news/delete?id=${post.id}${back}"><button type="submit" class="btn-danger">Delete</button></form>
                        </div>
                    </div>
                    <details>
                        <summary class="card-text cursor-pointer">Edit</summary>
                        <form class="flex flex-col gap-4 mt-3" method="post" action="/api/news/edit?id=${post.id}${back}">
                            <label class="field">Title <input class="input" name="title" required maxlength="${NEWS_TITLE_MAX}" value="${escapeHtml(post.title)}"></label>
                            <label class="field">Text <textarea class="input" name="body" rows="10" required maxlength="${NEWS_BODY_MAX}">${escapeHtml(post.body)}</textarea></label>
                            <div class="flex justify-end"><button type="submit" class="btn-primary">Save</button></div>
                        </form>
                    </details>
                </article>`
}

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/", { schema: query({ error: string, message: string, page: string }) }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { error, message, page: rawPage } = request.query as { error?: string, message?: string, page?: string }
        publishDueNews()
        const total = countNewsPosts(true)
        const pages = Math.max(1, Math.ceil(total / NEWS_PAGE_SIZE))
        const asked = Number(rawPage)
        const page = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, pages) : 1
        const posts = listNewsPosts(page, true).map(post => postCard(post, page)).join("\n")
        const pager = pages > 1 ? `                <nav class="flex items-center justify-between" aria-label="News pages">${page > 1 ? `<a class="btn-outline" href="/news?page=${page - 1}">Newer</a>` : "<span></span>"}<span class="card-text">Page ${page} of ${pages}</span>${page < pages ? `<a class="btn-outline" href="/news?page=${page + 1}">Older</a>` : "<span></span>"}</nav>` : ""
        const enabled = newsAutoEnabled()
        reply.header("content-type", "text/html; charset=utf-8")
        reply.send(renderPage("news-posts", "News", "news", {
            notice: noticeHtml(notices, error, message),
            autoText: escapeHtml(autoText()),
            autoNext: enabled ? "0" : "1",
            autoButton: enabled ? "Turn automatic posts off" : "Turn automatic posts on",
            autoButtonClass: enabled ? "btn-outline" : "btn-primary",
            titleMax: String(NEWS_TITLE_MAX),
            bodyMax: String(NEWS_BODY_MAX),
            postCount: String(total),
            posts: total === 0 ? `                <p class="card-text">No posts yet.</p>` : posts,
            pager
        }))
    })
}

export default routes;
