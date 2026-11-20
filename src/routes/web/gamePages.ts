// Read-only public pages opened by the AIR shell. No viewer IDs, account credentials or SDK URLs are accepted.
import type { FastifyInstance, FastifyReply } from "fastify"
import calendar from "../../../assets/event_calendar.json"
import gachas from "../../../assets/gacha.json"
import tickets from "../../../assets/ticket_gacha.json"
import heroes from "../../../assets/star_heroes_gacha.json"
import { getGachaSync, getOpenGachaIdsSync } from "../../lib/assets"
import { getItemCatalog } from "../../lib/catalog"
import { listEvents } from "../../lib/eventCalendar"
import { isContentPeriodOpen } from "../../lib/eventSchedule"
import { oddsPercent, portalOdds } from "../../lib/gachaOdds"
import { GachaType } from "../../lib/types"
import { getServerDate } from "../../utils"
import { getLinkSetting, getTextSetting } from "../../data/serverSettings"
import { countNewsPosts, listNewsPosts, NEWS_PAGE_SIZE } from "../../data/news"
import { publishDueNews } from "../../lib/newsAuto"
import { renderNewsBody } from "../../lib/newsFormat"
import { newsDateText } from "../../lib/newsContent"
import { query } from "../schemas"
import { escapeHtml as esc, fillTemplate, readPage } from "./layout"
import { PublicTheme, publicThemeCookie, publicThemeOf, safeBackPath, themeAttribute, themeSwitchHtml } from "../../lib/publicTheme"

const portalNames = calendar.portals as Record<string, string>
const ids = [...Object.keys(gachas), ...Object.keys(tickets), ...Object.keys(heroes)].sort((a,b) => Number(a)-Number(b))
const portalName = (id: string) => portalNames[id] || `${getGachaSync(id)?.type === GachaType.WEAPON ? "Armament" : "Character"} portal #${id}`
const card = (title: string, content: string) => `<section class="card"><h2 class="card-title">${esc(title)}</h2>${content}</section>`

/** Optional owner contacts only: no publisher identity or guessed customer-service destination. */
export function ownerLink(raw: string | undefined): string | null {
    try {
        const url = new URL(raw ?? "")
        return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : null
    } catch { return null }
}

function send(reply: FastifyReply, title: string, content: string, status = 200) {
    const request = reply.request
    const html = fillTemplate(readPage("game-info"), {
        title: esc(title), serverName: esc(getTextSetting("server.name")), content,
        themeAttr: themeAttribute(publicThemeOf(request.headers.cookie)), themeSwitch: themeSwitchHtml(safeBackPath(request.url))
    })
    reply.code(status).type("text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        .header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store").send(html)
}

const routes = async (fastify: FastifyInstance) => {
    // the theme switch of the public pages: a cookie, then back to the page (no script runs in the app's page windows)
    fastify.get<{ Querystring: { to?: string, back?: string } }>("/theme", { schema: query({ to: { type: "string", enum: ["light", "dark"] }, back: { type: "string", maxLength: 200 } }, ["to"]) }, (request, reply) => {
        reply.header("set-cookie", publicThemeCookie(request.query.to as PublicTheme)).header("cache-control", "no-store")
        return reply.redirect(safeBackPath(request.query.back))
    })
    // the page the game opens for its news and notice links (appOption urlHomeNews etc., answered by the AIR shell)
    fastify.get<{ Querystring: { page?: string } }>("/news", { schema: query({ page: { type: "string", maxLength: 9 } }) }, (request, reply) => {
        // the automatic event posts whose time has come go live now, whichever page asked first (ADM-4)
        publishDueNews()
        const pages = Math.max(1, Math.ceil(countNewsPosts(false) / NEWS_PAGE_SIZE))
        const asked = Number(request.query.page)
        const page = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, pages) : 1
        const clock = getServerDate().toISOString().replace(/\.\d\d\dZ/, "").replace("T", " ")
        const posts = listNewsPosts(page, false).map(post => `<article class="card"><h2 class="card-title">${esc(post.title)}</h2>`
            + `<p class="text-sm"><time datetime="${new Date(post.publishedAt).toISOString()}">Published ${esc(newsDateText(post.publishedAt))}</time></p>${renderNewsBody(post.body)}</article>`).join("")
        // shown only once there are more posts than one page holds
        const pager = pages > 1 ? `<nav class="page-nav" aria-label="News pages">${page > 1 ? `<a href="/game/news?page=${page - 1}">Newer</a>` : ""}<span class="px-2 py-1">Page ${page} of ${pages}</span>${page < pages ? `<a href="/game/news?page=${page + 1}">Older</a>` : ""}</nav>` : ""
        send(reply, "News", card("Welcome to Reflipped", "<p>This is a community-run server for the flipper game. It has no connection to Kakao Games or Cygames.</p>"
            + `<p>The server clock currently reads <b>${esc(clock)} UTC</b>, which decides which summons and events are open.</p>`) + posts + pager)
    })
    fastify.get<{ Querystring: { id?: string } }>("/odds", { schema: query({ id: { type: "string", pattern: "^[1-9][0-9]{0,8}$" } }) }, (request, reply) => {
        if (request.query.id) return reply.redirect(`/game/odds/${request.query.id}`)
        const current = getOpenGachaIdsSync(getServerDate())
        const links = current.map(id => `<li><a class="underline" href="/game/odds/${id}">${esc(portalName(id))}</a></li>`).join("")
        send(reply, "Summon odds", card("Open on the server calendar", `<p>Your game may show different portals if your calendar differs. Ticket and one-time eligibility are shown in the game.</p><ul class="flex flex-col gap-2">${links || "<li>No regular portals are open on this calendar.</li>"}</ul>`)
            + card("Find a portal", `<form method="get" action="/game/odds" class="flex flex-col gap-3"><label for="portal-id">All portals, including tickets and special offers</label><select class="input w-full min-w-0" id="portal-id" name="id">${ids.map(id => `<option value="${id}">${esc(portalName(id))} (#${id})</option>`).join("")}</select><button class="btn-primary" type="submit">View odds</button></form>`))
    })
    fastify.get<{ Params: { id: string } }>("/odds/:id", { schema: { params: { type: "object", properties: { id: { type: "string", pattern: "^[1-9][0-9]{0,8}$" } }, required: ["id"] } } }, (request, reply) => {
        const { id } = request.params
        const gacha = getGachaSync(id)
        if (!gacha) return send(reply, "Portal not found", '<p>Choose a portal from <a class="underline" href="/game/odds">the odds list</a>.</p>', 404)
        let odds
        try { odds = portalOdds(gacha) }
        catch { return send(reply, "Odds unavailable", '<p>These odds are unavailable. Please contact the server owner or choose another portal.</p>', 503) }
        const catalog = getItemCatalog()
        const names = new Map((gacha.type === GachaType.CHARACTER ? catalog.units : catalog.equipment).map(item => [item.id, item.name]))
        const guaranteedSlots = Math.min(10, Math.floor(Math.max(0, gacha.guaranteeNumber)))
        const explanation = guaranteedSlots ? `In each complete 10-pull, the last ${guaranteedSlots} draw${guaranteedSlots === 1 ? " uses" : "s use"} the guaranteed rates (at least ${gacha.guaranteeRarity} stars). Other draws use the standard rates.` : "This portal has no separate guaranteed slot in a 10-pull."
        const rows = odds.map(row => `<tr><th scope="row" class="p-2 text-left font-normal">${esc(names.get(row.id) || `${gacha.type === GachaType.CHARACTER ? "Unit" : "Armament"} #${row.id}`)}<span class="block text-xs">#${row.id}${row.featured ? " · Featured" : ""}</span></th><td class="p-2">${row.stars}★</td><td class="p-2 tabular-nums" data-id="${row.id}" data-standard="${row.standard}">${esc(oddsPercent(row.standard))}</td><td class="p-2 tabular-nums" data-guaranteed="${row.guaranteed}">${esc(oddsPercent(row.guaranteed))}</td></tr>`).join("")
        send(reply, portalName(id), card("How to read these rates", `<p>${explanation}</p><p>When a ticket guarantees at least ${gacha.guaranteeRarity} stars, every draw from that ticket uses the guaranteed rates. Availability and costs are shown in the game.</p><p>Rates are per draw, not the chance across a whole 10-pull. Percentages are rounded to six decimal places.</p>`)
            + `<section class="card"><h2 class="card-title">Summon rates</h2><div class="overflow-x-auto"><table class="w-full text-sm"><caption class="text-left pb-3">Portal #${id}</caption><thead><tr><th scope="col" class="p-2 text-left">${gacha.type === GachaType.CHARACTER ? "Unit" : "Armament"}</th><th scope="col" class="p-2">Stars</th><th scope="col" class="p-2">Standard</th><th scope="col" class="p-2">Guaranteed</th></tr></thead><tbody>${rows}</tbody></table></div></section>`)
    })
    fastify.get("/events", (_, reply) => {
        const now = getServerDate()
        const active = listEvents().filter(event => isContentPeriodOpen(event.start.getTime(), event.end.getTime(), now))
        send(reply, "Events", card("On the server calendar", `<p>These events are open on the server calendar. Your personal calendar may differ; open Events in the game for your quests and progress.</p><ul class="flex flex-col gap-3">${active.map(event => `<li><strong>${esc(event.name)}</strong><span class="block text-sm">${esc(event.kind)}</span></li>`).join("") || "<li>No events are open on this calendar.</li>"}</ul>`))
    })
    fastify.get("/support", (_, reply) => {
        const contact = ownerLink(getLinkSetting("links.support"))
        send(reply, "Help with this server", card("Contact", contact ? `<p>For account or server problems, contact this server's team.</p><a class="underline" href="${esc(contact)}" rel="noreferrer">Contact the server team</a>` : "<p>This server has not listed a contact page. Ask the person who gave you its address for help.</p>")
            + card("Connection problems", "<p>Check your internet connection and confirm the server address with its owner. If the server is restarting, wait a moment and try again.</p>")
            + card("Account access", '<p>Use the server website to sign in or recover access. If you cannot access your account, contact this server\'s owner.</p><a class="underline" href="/portal/login">Open account sign-in</a>')
            + card("A feature does not open", "<p>If the game shows H404, that feature is not available on this server yet. Tell the server owner which screen you opened and the error shown. Do not send your password or sign-in codes.</p>"))
    })
    fastify.get("/credits", (_, reply) => {
        send(reply, "Credits", card("Reflipped", '<p>Reflipped is an independent server and app project built with AI assistance and best-effort human review.</p><a class="underline" href="https://github.com/torkd/reflipped" rel="noreferrer">Reflipped source and credits</a>')
            + card("Starpoint", '<p>Reflipped is built on Starpoint. Thank you to the original project and its contributors.</p><a class="underline" href="https://github.com/Duosion/starpoint" rel="noreferrer">Starpoint project</a>')
            + card("Game materials", "<p>The original game's artwork, music and other materials belong to their respective creators. This independent server does not represent the original publisher.</p>"))
    })
    fastify.get("/terms", (_, reply) => {
        const terms = ownerLink(getLinkSetting("links.terms"))
        send(reply, "Server terms", card("About this server", "<p>This is an independent Reflipped server. Your account and progress belong to this server; they do not sign you into the original publisher's services.</p>")
            + card("Server rules", terms ? `<p>The server owner publishes their rules here.</p><a class="underline" href="${esc(terms)}" rel="noreferrer">Read the server rules</a>` : '<p>The server owner has not published additional terms. Ask them about access, backups and acceptable use before playing.</p><a class="underline" href="/game/support">Contact and help</a>')
            + card("Accounts", '<p>Account deletion from the game is not available. Contact the server owner about your account. Signing out keeps your save.</p>'))
    })
    fastify.get("/privacy", (_, reply) => {
        const privacy = ownerLink(getLinkSetting("links.privacy"))
        send(reply, "Server privacy", card("Information kept by this server", "<p>The server stores your account name, a password hash, optional email and two-step sign-in information, game progress, device bindings and sign-in sessions. Its request logs include connection addresses and request information. Server owners control their deployment, logs and backups.</p>")
            + card("Owner's privacy information", privacy ? `<p>The server owner provides further privacy information here.</p><a class="underline" href="${esc(privacy)}" rel="noreferrer">Read the owner's privacy information</a>` : '<p>The server owner has not published a separate privacy notice. Ask them about storage, retention, access and removal of your information.</p><a class="underline" href="/game/support">Contact and help</a>')
            + card("Protect your account", "<p>Use HTTPS when connecting over the internet. Do not share passwords, sign-in codes, device tokens or save files in support messages.</p>"))
    })
    fastify.get("/community", (_, reply) => {
        const community = ownerLink(getLinkSetting("links.community"))
        send(reply, "Server community", card("Play together", community ? `<p>Meet other players in this server's community.</p><a class="underline" href="${esc(community)}" rel="noreferrer">Open the community</a>` : "<p>This server has not listed a community page. Ask the person who gave you its address where players meet.</p>")
            + card("In the game", "<p>Use Follow to keep in touch with players and Co-op to join or recruit a room. Share a room link with the players you want to invite.</p>"))
    })
}
export default routes
