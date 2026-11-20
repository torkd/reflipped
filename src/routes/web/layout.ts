import { readFileSync } from "fs";
import { appPath } from "../../lib/paths";

export type NavItem = "dashboard" | "players" | "security" | "users" | "calendar" | "news" | "settings" | "credits"

const NAV: { id: NavItem, href: string, label: string, icon: string }[] = [
    { id: "dashboard", href: "/", label: "Dashboard", icon: "M520-600v-240h320v240H520ZM120-440v-400h320v400H120Zm400 320v-400h320v400H520Zm-400 0v-240h320v240H120Zm80-400h160v-240H200v240Zm400 320h160v-240H600v240Zm0-480h160v-80H600v80ZM200-200h160v-80H200v80Zm160-320Zm240-160Zm0 240ZM360-280Z" },
    { id: "players", href: "/player", label: "Players", icon: "M40-160v-112q0-34 17.5-62.5T104-378q62-31 126-46.5T360-440q66 0 130 15.5T616-378q29 15 46.5 43.5T680-272v112H40Zm720 0v-120q0-44-24.5-84.5T666-434q51 6 96 20.5t84 35.5q36 20 55 44.5t19 53.5v120H760ZM360-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47Zm400-160q0 66-47 113t-113 47q-11 0-28-2.5t-28-5.5q27-32 41.5-71t14.5-81q0-42-14.5-81T544-792q14-5 28-6.5t28-1.5q66 0 113 47t47 113ZM120-240h480v-32q0-11-5.5-20T580-306q-54-27-109-40.5T360-360q-56 0-111 13.5T140-306q-9 5-14.5 14t-5.5 20v32Zm240-320q33 0 56.5-23.5T440-640q0-33-23.5-56.5T360-720q-33 0-56.5 23.5T280-640q0 33 23.5 56.5T360-560Zm0 320Zm0-400Z" },
    { id: "security", href: "/security", label: "Security", icon: "M480-80q-139-35-229.5-159.5T160-516v-244l320-120 320 120v244q0 152-90.5 276.5T480-80Zm0-84q104-33 172-132t68-220v-189l-240-90-240 90v189q0 121 68 220t172 132Zm0-316Z" },
    { id: "users", href: "/user", label: "Users", icon: "M480-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47ZM160-160v-112q0-34 17.5-62.5T224-378q62-31 126-46.5T480-440q66 0 130 15.5T736-378q29 15 46.5 43.5T800-272v112H160Zm80-80h480v-32q0-11-5.5-20T700-306q-54-27-109-40.5T480-360q-56 0-111 13.5T260-306q-9 5-14.5 14t-5.5 20v32Zm240-320q33 0 56.5-23.5T560-640q0-33-23.5-56.5T480-720q-33 0-56.5 23.5T400-640q0 33 23.5 56.5T480-560Zm0-80Zm0 400Z" },
    { id: "calendar", href: "/calendar", label: "Calendar", icon: "M200-80q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-80h80v80h320v-80h80v80h40q33 0 56.5 23.5T840-720v560q0 33-23.5 56.5T760-80H200Zm0-80h560v-400H200v400Zm0-480h560v-80H200v80Zm0 0v-80 80Zm280 240q-17 0-28.5-11.5T440-440q0-17 11.5-28.5T480-480q17 0 28.5 11.5T520-440q0 17-11.5 28.5T480-400Zm-160 0q-17 0-28.5-11.5T280-440q0-17 11.5-28.5T320-480q17 0 28.5 11.5T360-440q0 17-11.5 28.5T320-400Zm320 0q-17 0-28.5-11.5T600-440q0-17 11.5-28.5T640-480q17 0 28.5 11.5T680-440q0 17-11.5 28.5T640-400ZM480-240q-17 0-28.5-11.5T440-280q0-17 11.5-28.5T480-320q17 0 28.5 11.5T520-280q0 17-11.5 28.5T480-240Zm-160 0q-17 0-28.5-11.5T280-280q0-17 11.5-28.5T320-320q17 0 28.5 11.5T360-280q0 17-11.5 28.5T320-240Zm320 0q-17 0-28.5-11.5T600-280q0-17 11.5-28.5T640-320q17 0 28.5 11.5T680-280q0 17-11.5 28.5T640-240Z" },
    { id: "news", href: "/news", label: "News", icon: "M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-480H160v480Zm80-80h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80Z" },
    { id: "settings", href: "/settings", label: "Settings", icon: "m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z" },
    { id: "credits", href: "/credits", label: "Credits", icon: "m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Z" }
]

export function readPage(name: string): string {
    return readFileSync(appPath("web", "pages", `${name}.html`)).toString("utf-8")
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/**
 * The fixed texts an admin page shows for the `?error=` and `?message=` codes the admin API redirects with (SEC-10).
 * The page shows only these, so a crafted link can't put its own words on it, and exception messages never reach it.
 */
export interface PageNotices {
    errors: ReadonlyMap<string, string>
    messages: ReadonlyMap<string, string>
}

/** The notice for a page's `?error=` or `?message=` code (an error first); nothing for an unknown code. */
export function noticeHtml(notices: PageNotices, error: unknown, message: unknown): string {
    const errorText = typeof error === "string" ? notices.errors.get(error) : undefined
    if (errorText !== undefined) return `<div class="notice-error">${escapeHtml(errorText)}</div>`
    const messageText = typeof message === "string" ? notices.messages.get(message) : undefined
    return messageText !== undefined ? `<div class="notice-info">${escapeHtml(messageText)}</div>` : ""
}

/**
 * Fills a template's {{key}} placeholders from `values` (inserted as given, so escape user text first), in one pass:
 * a value is never searched for placeholders itself, so a player named "{{clockState}}" stays that name. A function
 * replacer also keeps `$&` and the like in a value as they are (SEC-12). Unknown placeholders are left in place.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : placeholder)
}

/**
 * Renders an admin page: the content fragment `web/pages/<page>.html` with its {{key}}
 * placeholders filled from `values` (see `fillTemplate`), inside the
 * shared layout with `active` highlighted in the navigation.
 */
export function renderPage(page: string, title: string, active: NavItem | null, values: Record<string, string> = {}): string {
    const content = fillTemplate(readPage(page), values)
    const nav = NAV.map(item => {
        const current = item.id === active
        return `                <a href="${item.href}" class="nav-link${current ? " nav-link-active" : ""}"${current ? ' aria-current="page"' : ""}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="${item.icon}"/></svg>
                    ${item.label}
                </a>`
    }).join("\n")
    return fillTemplate(readPage("layout"), { title: escapeHtml(title), nav, content })
}
