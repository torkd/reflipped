// The light/dark choice of the game's public pages (news, odds, events, help, ...). The app opens them in windows
// that run no scripts, so the switch is a plain link: GET /game/theme?to=light|dark&back=<page> sets a cookie and
// returns to the page, which renders data-theme from it. With no cookie the page follows the system's theme
// (src/input.css). The admin site's switch is a script (web/public/js/theme.js) and stores its choice in the browser.

export type PublicTheme = "light" | "dark"

const COOKIE = "reflipped_theme"
const YEAR_SECONDS = 365 * 24 * 60 * 60

/** The theme a request's cookies chose, or null for the system's. */
export function publicThemeOf(cookieHeader: string | undefined): PublicTheme | null {
    const match = new RegExp(`(?:^|;\\s*)${COOKIE}=(light|dark)(?:;|$)`).exec(cookieHeader ?? "")
    return match === null ? null : match[1] as PublicTheme
}

/** The Set-Cookie value for a chosen theme. */
export function publicThemeCookie(theme: PublicTheme): string {
    return `${COOKIE}=${theme}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax; HttpOnly`
}

/** The attribute for <html>: empty when the system's theme applies. */
export function themeAttribute(theme: PublicTheme | null): string {
    return theme === null ? "" : ` data-theme="${theme}"`
}

/** A page this server's theme link may return to: its own game pages (news included), with a plain query. Anything else is "/game/news". */
export function safeBackPath(back: string | undefined): string {
    return back !== undefined && /^\/game\/[a-z0-9/_-]*(\?[A-Za-z0-9=&_-]*)?$/.test(back) ? back : "/game/news"
}

/**
 * The two switch links for a page: "Dark theme" while the page is light and "Light theme" while it is dark. Both are
 * rendered and the stylesheet shows the one that applies, since only the browser knows the system's theme.
 */
export function themeSwitchHtml(back: string): string {
    const href = (to: PublicTheme) => `/game/theme?to=${to}&amp;back=${encodeURIComponent(back).replace(/%2F/g, "/").replace(/&/g, "%26")}`
    return `<a class="theme-switch theme-to-dark" href="${href("dark")}" rel="nofollow">Dark theme</a><a class="theme-switch theme-to-light" href="${href("light")}" rel="nofollow">Light theme</a>`
}
