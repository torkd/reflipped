// ADM-4: news posts: the store, the admin page and API, the game's news page with paging, the automatic event posts
// and their timing, and the owner link settings.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestServer } from "./helpers";

let fastify: Awaited<ReturnType<typeof createTestServer>>["fastify"]
let admin: Awaited<ReturnType<typeof createTestServer>>["admin"]
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, admin, cleanup } = await createTestServer())
})
after(async () => {
    await cleanup()
})

const DAY = 24 * 60 * 60 * 1000
const adminHeaders = { host: "localhost:8001", "content-type": "application/x-www-form-urlencoded" }
const form = (values: Record<string, string>) => new URLSearchParams(values).toString()

async function adminPost(url: string, values: Record<string, string> = {}) {
    return admin.inject({ method: "POST", url, remoteAddress: "127.0.0.1", headers: adminHeaders, payload: form(values) })
}

test("the store lists newest first, pages, hides, and keeps a deleted automatic post's key", async () => {
    const news = await import("../src/data/news")
    const first = news.addNewsPost("Old", "old text", "admin", 1000)!
    news.addNewsPost("New", "new text", "admin", 2000)
    assert.deepEqual(news.listNewsPosts(1, false).map(post => post.title), ["New", "Old"])
    assert.equal(news.addNewsPost("Auto", "x", "auto", 3000, "event:test:0") !== null, true)
    assert.equal(news.addNewsPost("Auto again", "x", "auto", 4000, "event:test:0"), null, "one post per key")
    const auto = news.listNewsPosts(1, false)[0]
    assert.equal(auto.source, "auto")
    news.removeNewsPost(auto.id)
    assert.equal(news.getNewsPost(auto.id)?.hidden, true, "an automatic post is hidden, not removed")
    assert.equal(news.addNewsPost("Auto once more", "x", "auto", 5000, "event:test:0"), null, "its event isn't announced again")
    news.setNewsPostHidden(first, true)
    assert.deepEqual(news.listNewsPosts(1, false).map(post => post.title), ["New"])
    assert.equal(news.countNewsPosts(true), 3)
    news.removeNewsPost(first)
    assert.equal(news.getNewsPost(first), null, "an admin post is removed")
})

test("a post's text is escaped; headings, lists and links are the only markup", async () => {
    const { renderNewsBody } = await import("../src/lib/newsFormat")
    const html = renderNewsBody("## Rewards\n- <b>Unit</b> & more\n- Item × 2\n\nSee https://example.org/a?b=1&c=2. Odds: /game/odds/185\nnext line <script>alert(1)</script>")
    assert.match(html, /<h3 class="card-title">Rewards<\/h3>/)
    assert.match(html, /<ul><li>&lt;b&gt;Unit&lt;\/b&gt; &amp; more<\/li><li>Item × 2<\/li><\/ul>/)
    assert.match(html, /<a class="underline" href="https:\/\/example\.org\/a\?b=1&amp;c=2" rel="noreferrer">https:\/\/example\.org\/a\?b=1&amp;c=2<\/a>\./)
    assert.match(html, /<a class="underline" href="\/game\/odds\/185">\/game\/odds\/185<\/a><br>next line &lt;script&gt;/)
    assert.doesNotMatch(html, /<script|<b>/)
})

test("the admin writes, edits, hides and deletes posts, and the game's news page shows them with their date", async () => {
    const created = await adminPost("/api/news", { title: "Maintenance <tonight>", body: "Servers restart at 20:00.\n\n- Back by 21:00" })
    assert.equal(created.statusCode, 302)
    assert.match(created.headers.location as string, /message=posted/)
    const page = await fastify.inject({ method: "GET", url: "/game/news" })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Maintenance &lt;tonight&gt;/)
    assert.match(page.body, /Published \d+ \w+ \d{4}, \d\d:\d\d UTC/)

    const { listNewsPosts } = await import("../src/data/news")
    const id = listNewsPosts(1, true).find(post => post.title.startsWith("Maintenance"))!.id
    const empty = await adminPost(`/api/news/edit?id=${id}`, { title: "  ", body: "text" })
    assert.match(empty.headers.location as string, /error=invalid-title/)
    const edited = await adminPost(`/api/news/edit?id=${id}`, { title: "Maintenance done", body: "All back." })
    assert.match(edited.headers.location as string, /message=saved/)
    assert.match((await fastify.inject({ method: "GET", url: "/game/news" })).body, /Maintenance done/)

    await adminPost(`/api/news/hide?id=${id}`, { hidden: "1" })
    assert.doesNotMatch((await fastify.inject({ method: "GET", url: "/game/news" })).body, /Maintenance done/)
    const adminPage = await admin.inject({ method: "GET", url: "/news", remoteAddress: "127.0.0.1", headers: { host: "localhost:8001" } })
    assert.match(adminPage.body, /Maintenance done/)
    assert.match(adminPage.body, /hidden from players/)

    await adminPost(`/api/news/delete?id=${id}`)
    assert.equal((await adminPost(`/api/news/delete?id=${id}`)).headers.location, "/news?error=unknown-post")
})

test("the news page pages once there are more posts than one page holds", async () => {
    const news = await import("../src/data/news")
    for (let i = 0; i < 12; i++) news.addNewsPost(`Paged ${String(i).padStart(2, "0")}`, "text", "admin", 10_000 + i)
    const first = (await fastify.inject({ method: "GET", url: "/game/news" })).body
    const shown = (body: string) => [...body.matchAll(/Paged (\d\d)/g)].map(match => match[1])
    assert.deepEqual(shown(first).slice(0, 3), ["11", "10", "09"])
    assert.equal(new Set(shown(first)).size, 10, "ten posts on a page")
    assert.match(first, /Page 1 of 2/)
    assert.match(first, /href="\/game\/news\?page=2">Older/)
    const second = (await fastify.inject({ method: "GET", url: "/game/news?page=2" })).body
    assert.match(second, /Page 2 of 2/)
    assert.match(second, /href="\/game\/news\?page=1">Newer/)
    assert.ok(shown(second).includes("00"))
    assert.match((await fastify.inject({ method: "GET", url: "/game/news?page=999" })).body, /Page 2 of 2/, "a page past the end shows the last")
})

test("an event's post goes live at the daily reset seven days before its opening game day", async () => {
    const { newsDueTime } = await import("../src/lib/newsSchedule")
    // opening on 17 December: the reset that starts game day 10 December is 20:00 UTC on the 9th
    assert.equal(newsDueTime(Date.parse("2026-12-17T14:00:00Z")), Date.parse("2026-12-09T20:00:00Z"))
    // just before the reset that starts game day 17 December (20:00 UTC on the 16th) the opening is still on the 16th
    assert.equal(newsDueTime(Date.parse("2026-12-16T19:59:00Z")), Date.parse("2026-12-08T20:00:00Z"))
    assert.equal(newsDueTime(Date.parse("2026-12-16T20:00:00Z")), Date.parse("2026-12-09T20:00:00Z"))
})

test("automatic posts: only in the modes with a schedule, once each, with the event's rewards, and the owner can switch them off", async () => {
    const previousClock = process.env.SERVER_CLOCK
    const previousScheduling = process.env.EVENT_SCHEDULING
    const { setEventPolicy, getEventPolicy } = await import("../src/lib/eventPolicy")
    const { eventCatalog } = await import("../src/lib/eventSchedule")
    const { publishDueNews, setNewsAutoEnabled } = await import("../src/lib/newsAuto")
    const { listNewsPosts, countNewsPosts } = await import("../src/data/news")
    const { eventsToAnnounce, newsDueTime } = await import("../src/lib/newsSchedule")
    const { newsSubjects } = await import("../src/lib/newsContent")
    const oldPolicy = getEventPolicy()
    try {
        process.env.SERVER_CLOCK = "running"
        process.env.EVENT_SCHEDULING = "on"
        // a raid event: its post lists the kill tally and ranking rewards
        const raid = eventCatalog.find(event => event.id === "raid_event/1")!
        const now = Date.parse("2026-11-10T12:00:00Z")
        // Classic, 1x: the event opens 5 days from now, so its post (7 days ahead) is due
        const anchorFor = (daysAhead: number) => now + daysAhead * DAY - (raid.startTime - Math.min(...eventCatalog.map(event => event.startTime)))
        setEventPolicy({ ...oldPolicy, mode: "classic", anchor: anchorFor(5) })
        const due = eventsToAnnounce(now, newsSubjects()).map(upcoming => upcoming.event.id)
        assert.ok(due.includes("event:raid_event/1"), "an event five days away is announced")
        assert.ok(eventsToAnnounce(now, newsSubjects()).every(upcoming => upcoming.due <= now && upcoming.opens > now), "only what is due and not open yet")

        // eight days away: not due yet
        setEventPolicy({ ...oldPolicy, mode: "classic", anchor: anchorFor(8) })
        assert.ok(!eventsToAnnounce(now, newsSubjects()).some(upcoming => upcoming.event.id === "event:raid_event/1"))
        const opens = Math.floor(anchorFor(8) + (raid.startTime - Math.min(...eventCatalog.map(event => event.startTime))))
        assert.ok(newsDueTime(opens) > now)

        // Time Travel has no schedule
        setEventPolicy({ ...oldPolicy, mode: "time-travel", anchor: anchorFor(5) })
        assert.deepEqual(eventsToAnnounce(now, newsSubjects()), [])

        // Manual and Accelerated do
        const archiveStart = Math.min(...eventCatalog.map(event => event.startTime))
        setEventPolicy({ ...oldPolicy, mode: "accelerated", acceleration: 2, anchor: now + 5 * DAY - (raid.startTime - archiveStart) / 2 })
        assert.ok(eventsToAnnounce(now, newsSubjects()).some(upcoming => upcoming.event.id === "event:raid_event/1"), "Accelerated announces on the real clock")
        setEventPolicy({ ...oldPolicy, mode: "manual", anchor: anchorFor(5) })
        assert.ok(Array.isArray(eventsToAnnounce(now, newsSubjects())), "Manual has a schedule too")
        setEventPolicy({ ...oldPolicy, mode: "classic", anchor: anchorFor(5) })

        // publishing: once each, however often it runs
        setNewsAutoEnabled(false)
        const before = countNewsPosts(true)
        assert.equal(publishDueNews(now), 0, "off: nothing is published")
        assert.equal(countNewsPosts(true), before)
        setNewsAutoEnabled(true)
        const published = publishDueNews(now)
        assert.ok(published > 0)
        assert.equal(publishDueNews(now), 0, "a second run publishes nothing new")
        assert.equal(publishDueNews(now + 60_000), 0)
        const post = listNewsPosts(1, true, 1000).find(candidate => candidate.autoKey === "event:raid_event/1:0")!
        assert.equal(post.source, "auto")
        assert.equal(post.publishedAt, now, "it shows the real time it went live")
        assert.equal(post.title, "Coming up: Raid Event: Sagas of Conquest")
        assert.match(post.body, /^Raid event: Raid Event: Sagas of Conquest\n/)
        assert.match(post.body, /Opens: \d+ \w+ \d{4}, \d\d:\d\d UTC/)
        assert.match(post.body, /## Kill tally rewards/)
        assert.match(post.body, /## Ranking rewards/)

        // switched off again: nothing new, and the published posts stay
        setNewsAutoEnabled(false)
        setEventPolicy({ ...oldPolicy, mode: "classic", anchor: anchorFor(4) })
        assert.equal(publishDueNews(now), 0)
        assert.ok(countNewsPosts(true) >= before + published)
    } finally {
        setEventPolicy(oldPolicy)
        process.env.SERVER_CLOCK = previousClock
        if (previousScheduling === undefined) delete process.env.EVENT_SCHEDULING; else process.env.EVENT_SCHEDULING = previousScheduling
    }
})

test("portals and boosted-drop campaigns are announced too, with their kind and what they give", async () => {
    const { newsSubjects, buildNewsPost } = await import("../src/lib/newsContent")
    const subjects = newsSubjects()
    const portal = subjects.find(subject => subject.kind === "portal" && subject.name === "Spotlight Portal")!
    const boost = subjects.find(subject => subject.kind === "boost")!
    const build = (subject: typeof portal) => buildNewsPost({ event: subject, opens: Date.parse("2026-12-17T14:00:00Z"), closes: Date.parse("2026-12-24T14:00:00Z"), cycle: 0, due: 0 })
    const portalPost = build(portal)
    assert.match(portalPost.body, /^(Summoning|Armament) portal: Spotlight Portal/)
    assert.match(portalPost.body, /Opens: 17 December 2026, 14:00 UTC\nCloses: 24 December 2026, 14:00 UTC \(about 7 days\)/)
    assert.match(portalPost.body, /## Everything this portal can give/)
    assert.match(portalPost.body, /\/game\/odds\/\d+/)
    const boostPost = build(boost)
    assert.match(boostPost.body, /^Boosted drops: /)
    assert.match(boostPost.body, /## What is boosted/)
})

test("the admin switches the automatic posts and sees what the event mode allows", async () => {
    const off = await adminPost("/api/news/auto", { enabled: "0" })
    assert.match(off.headers.location as string, /message=auto-off/)
    const page = await admin.inject({ method: "GET", url: "/news", remoteAddress: "127.0.0.1", headers: { host: "localhost:8001" } })
    assert.match(page.body, /Turn automatic posts on/)
    assert.match(page.body, /Off: no new event posts are published/)
    const on = await adminPost("/api/news/auto", { enabled: "1" })
    assert.match(on.headers.location as string, /message=auto-on/)
    assert.match((await admin.inject({ method: "GET", url: "/news", remoteAddress: "127.0.0.1", headers: { host: "localhost:8001" } })).body, /Turn automatic posts off/)
})

test("the community, help, rules and privacy links are settings with the environment variables as fallback", async () => {
    const settings = await import("../src/data/serverSettings")
    const keys = ["links.community", "links.support", "links.terms", "links.privacy"] as const
    const variables = ["SERVER_COMMUNITY_URL", "SERVER_SUPPORT_URL", "SERVER_TERMS_URL", "SERVER_PRIVACY_URL"]
    const original = variables.map(name => process.env[name])
    try {
        for (const name of variables) delete process.env[name]
        assert.deepEqual(keys.map(key => settings.getLinkSetting(key)), ["", "", "", ""])
        process.env.SERVER_COMMUNITY_URL = "https://env.example/community"
        assert.equal(settings.getLinkSetting("links.community"), "https://env.example/community", "the environment variable is the fallback")
        assert.match((await fastify.inject({ method: "GET", url: "/game/community" })).body, /href="https:\/\/env\.example\/community"/)

        const saveForm = (values: Record<string, string>) => admin.inject({ method: "POST", url: "/api/server/settings", remoteAddress: "127.0.0.1",
            headers: adminHeaders, payload: form({ tab: "identity", ...values }) })
        const saved = await saveForm({ "links.community": "https://chat.example/invite", "links.support": "https://help.example/", "links.terms": "https://rules.example/", "links.privacy": "https://privacy.example/" })
        assert.match(saved.headers.location as string, /message=identity_saved/)
        assert.equal(settings.getLinkSetting("links.community"), "https://chat.example/invite", "the saved address wins")
        const community = (await fastify.inject({ method: "GET", url: "/game/community" })).body
        assert.match(community, /href="https:\/\/chat\.example\/invite"/)
        assert.doesNotMatch(community, /env\.example/)
        assert.match((await fastify.inject({ method: "GET", url: "/game/support" })).body, /href="https:\/\/help\.example\/"/)
        assert.match((await fastify.inject({ method: "GET", url: "/game/terms" })).body, /href="https:\/\/rules\.example\/"/)
        assert.match((await fastify.inject({ method: "GET", url: "/game/privacy" })).body, /href="https:\/\/privacy\.example\/"/)

        // only https, no credentials: nothing is saved otherwise
        for (const bad of ["http://plain.example/", "javascript:alert(1)", "https://user:pass@x.example/", "ftp://x.example/"]) {
            const rejected = await saveForm({ "links.community": bad })
            assert.match(rejected.headers.location as string, /error=invalid_text_setting/, bad)
        }
        assert.equal(settings.getLinkSetting("links.community"), "https://chat.example/invite")
        // an empty field clears the saved address; the environment variable shows again
        await saveForm({ "links.community": "" })
        assert.equal(settings.getLinkSetting("links.community"), "https://env.example/community")
    } finally {
        variables.forEach((name, index) => { if (original[index] === undefined) delete process.env[name]; else process.env[name] = original[index] })
    }
})

test("the public pages and the admin site share the admin theme; the public switch is a link and a cookie, no script", async () => {
    const { readFileSync } = await import("node:fs")
    for (const url of ["/game/news", "/game/odds", "/game/support"]) {
        const page = await fastify.inject({ method: "GET", url })
        assert.match(page.body, /<nav aria-label="Game information" class="page-nav">\s*<a href="\/game\/news">News<\/a><a href="\/game\/odds">Summon odds<\/a><a href="\/game\/events">Events<\/a><a href="\/game\/support">Help<\/a><a href="\/game\/community">Community<\/a>/, `${url}: the same navigation on every page, News included`)
        assert.doesNotMatch(page.body, /<script/, `${url}: the app's page windows run no scripts`)
        assert.match(page.body, /<meta name="color-scheme" content="light dark">/, url)
        assert.match(page.body, new RegExp(`<a class="theme-switch theme-to-dark" href="/game/theme\\?to=dark&amp;back=${url.replace(/\//g, "/")}"`), url)
        assert.match(page.body, /theme-to-light/, url)
        assert.match(page.body, /<html lang="en">/, `${url}: no cookie, so the system's theme`)
    }
    // choosing a theme sets a cookie and returns to the page, which then shows that theme
    const chosen = await fastify.inject({ method: "GET", url: "/game/theme?to=dark&back=/game/odds" })
    assert.equal(chosen.statusCode, 302)
    assert.equal(chosen.headers.location, "/game/odds")
    const cookie = String(chosen.headers["set-cookie"])
    assert.match(cookie, /^reflipped_theme=dark; Path=\/; Max-Age=\d+; SameSite=Lax; HttpOnly/)
    const themed = await fastify.inject({ method: "GET", url: "/game/odds", headers: { cookie: "a=b; reflipped_theme=dark" } })
    assert.match(themed.body, /<html lang="en" data-theme="dark">/)
    assert.match((await fastify.inject({ method: "GET", url: "/game/news", headers: { cookie: "reflipped_theme=light" } })).body, /<html lang="en" data-theme="light">/)
    assert.match((await fastify.inject({ method: "GET", url: "/game/news", headers: { cookie: "reflipped_theme=purple" } })).body, /<html lang="en">/, "an unknown value is ignored")
    // it never returns to another site or a path of another kind
    for (const back of ["https://evil.example/", "//evil.example", "/admin", "/game/x?y=<z>", "javascript:alert(1)"])
        assert.equal((await fastify.inject({ method: "GET", url: `/game/theme?to=light&back=${encodeURIComponent(back)}` })).headers.location, "/game/news", back)
    assert.equal((await fastify.inject({ method: "GET", url: "/game/theme?to=blue" })).statusCode, 400)
    // the news page moved to /game/news: the game server has no /news any more
    assert.equal((await fastify.inject({ method: "GET", url: "/news" })).statusCode, 404)
    // the admin site's switch is a script and the admin pages load it
    const script = await fastify.inject({ method: "GET", url: "/public/js/theme.js" })
    assert.equal(script.statusCode, 200)
    assert.match(script.body, /data-theme/)
    const adminPage = await admin.inject({ method: "GET", url: "/news", remoteAddress: "127.0.0.1", headers: { host: "localhost:8001" } })
    assert.match(adminPage.body, /<script src="\/public\/js\/theme.js"><\/script>/)
    assert.match(adminPage.body, /data-theme-toggle/)
    // the stylesheet: the dark tokens apply for the system's dark theme unless the choice says light, and for the choice's dark
    const css = readFileSync("src/input.css", "utf8")
    assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/)
    assert.match(css, /:root\[data-theme="dark"\] \{/)
    assert.equal([...css.matchAll(/--md-sys-color-primary: var\(--md-sys-color-primary-dark\)/g)].length, 2, "both dark blocks set the same tokens")
    // lists keep their bullets inside the card (the page's own stylesheet), and no fixed colours
    const pageCss = readFileSync("web/public/css/shell-pages.css", "utf8")
    assert.match(pageCss, /\.shell-page \.card ul \{ list-style: disc; padding-left: 1\.5rem/)
    assert.doesNotMatch(pageCss, /#[0-9a-fA-F]{3,6}\b/, "no fixed colours: tokens only")
    // the switch's links must out-rank the navigation pill rule (.shell-page .page-nav a), or both show in the light theme
    assert.match(pageCss, /\.shell-page \.page-nav a\.theme-to-light \{ display: none; \}/)
    assert.doesNotMatch(pageCss, /\.shell-page \.theme-to-(light|dark) \{/)
})
