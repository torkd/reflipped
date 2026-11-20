import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createTestServer } from "./helpers";

// SH-16: pages the Reflipped app shows in its web views. The app's "Link an account" sign-in is for a player who
// already plays as a guest, so its web view (user agent "ReflippedLinking") gets the shell's login and register pages
// without "Play without an account"; the server pages it opens over the game use the app's light look.

let fastify: FastifyInstance
let cleanup: () => Promise<void>

before(async () => {
    ({ fastify, cleanup } = await createTestServer())
})

after(async () => {
    await cleanup()
})

const APP = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 ReflippedApp"

test("the shell's sign-in offers guest play, except when it links an account", async () => {
    for (const url of ["/portal/login?next=shell", "/portal/register?next=shell"]) {
        const signIn = await fastify.inject({ method: "GET", url, headers: { "user-agent": APP } })
        assert.equal(signIn.statusCode, 200, url)
        assert.match(signIn.body, /href="\/portal\/shell\/done\?guest=1"/, url)
        const linking = await fastify.inject({ method: "GET", url, headers: { "user-agent": `${APP} ReflippedLinking` } })
        assert.equal(linking.statusCode, 200, url)
        assert.doesNotMatch(linking.body, /guest=1/, url)
        assert.doesNotMatch(linking.body, /Play without an account/, url)
    }
})

test("the server pages the app opens use the admin site's theme", async () => {
    for (const url of ["/game/news", "/game/odds", "/game/support", "/game/credits"]) {
        const page = await fastify.inject({ method: "GET", url })
        assert.equal(page.statusCode, 200, url)
        assert.match(page.body, /<link rel="stylesheet" href="\/public\/css\/shell-pages.css">/, url)
        assert.match(page.body, /<body class="shell-page /, url)
    }
    const odds = await fastify.inject({ method: "GET", url: "/game/odds" })
    assert.match(odds.body, /<h1 class="page-title">Summon odds<\/h1>/)
    assert.doesNotMatch(odds.body, /Portal odds/)
    const css = await fastify.inject({ method: "GET", url: "/public/css/shell-pages.css" })
    assert.equal(css.statusCode, 200)
    assert.match(css.body, /var\(--md-sys-color-background\)/, "colours come from the admin theme's tokens")
    assert.doesNotMatch(css.body, /color-scheme: light/, "light and dark both work")
})
