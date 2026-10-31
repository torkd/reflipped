import { readFileSync } from "fs";
import path from "path";

/** Admin page templates live here (relative to the compiled out/routes/web). */
export const staticPagesDir = "../../../web/pages"

export type NavItem = "dashboard" | "players" | "settings" | "credits"

const NAV: { id: NavItem, href: string, label: string, icon: string }[] = [
    { id: "dashboard", href: "/", label: "Dashboard", icon: "M520-600v-240h320v240H520ZM120-440v-400h320v400H120Zm400 320v-400h320v400H520Zm-400 0v-240h320v240H120Zm80-400h160v-240H200v240Zm400 320h160v-240H600v240Zm0-480h160v-80H600v80ZM200-200h160v-80H200v80Zm160-320Zm240-160Zm0 240ZM360-280Z" },
    { id: "players", href: "/player", label: "Players", icon: "M40-160v-112q0-34 17.5-62.5T104-378q62-31 126-46.5T360-440q66 0 130 15.5T616-378q29 15 46.5 43.5T680-272v112H40Zm720 0v-120q0-44-24.5-84.5T666-434q51 6 96 20.5t84 35.5q36 20 55 44.5t19 53.5v120H760ZM360-480q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 66-47 113t-113 47Zm400-160q0 66-47 113t-113 47q-11 0-28-2.5t-28-5.5q27-32 41.5-71t14.5-81q0-42-14.5-81T544-792q14-5 28-6.5t28-1.5q66 0 113 47t47 113ZM120-240h480v-32q0-11-5.5-20T580-306q-54-27-109-40.5T360-360q-56 0-111 13.5T140-306q-9 5-14.5 14t-5.5 20v32Zm240-320q33 0 56.5-23.5T440-640q0-33-23.5-56.5T360-720q-33 0-56.5 23.5T280-640q0 33 23.5 56.5T360-560Zm0 320Zm0-400Z" },
    { id: "settings", href: "/settings", label: "Settings", icon: "m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z" },
    { id: "credits", href: "/credits", label: "Credits", icon: "m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Z" }
]

export function readPage(name: string): string {
    return readFileSync(path.join(__dirname, staticPagesDir, `${name}.html`)).toString("utf-8")
}

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

/**
 * Renders an admin page: the content fragment `web/pages/<page>.html` with its {{key}}
 * placeholders filled from `values` (inserted as given, so escape user text first), inside the
 * shared layout with `active` highlighted in the navigation.
 */
export function renderPage(page: string, title: string, active: NavItem | null, values: Record<string, string> = {}): string {
    let content = readPage(page)
    for (const [key, value] of Object.entries(values)) content = content.split(`{{${key}}}`).join(value)
    const nav = NAV.map(item => {
        const current = item.id === active
        return `                <a href="${item.href}" class="nav-link${current ? " nav-link-active" : ""}"${current ? ' aria-current="page"' : ""}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="${item.icon}"/></svg>
                    ${item.label}
                </a>`
    }).join("\n")
    return readPage("layout")
        // function replacers: a string replacement expands $` $' $& in player names (SEC-12)
        .replace("{{title}}", () => escapeHtml(title))
        .replace("{{nav}}", () => nav)
        .replace("{{content}}", () => content)
}
