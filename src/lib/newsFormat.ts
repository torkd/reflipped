// ADM-4: a news post's text as HTML. The text is plain; the whole thing is escaped first, then only these shapes are
// recognised: a blank line starts a new paragraph, a line starting "## " is a heading, lines starting "- " are a list,
// an https:// address and a /game/... page of this server become links. Nothing else is ever markup.
import { escapeHtml } from "../routes/web/layout";

/** Links in already-escaped text: an https address, or a /game/ page of this server. */
function linkify(escaped: string): string {
    return escaped.replace(/(https:\/\/[^\s<]+|\/game\/[A-Za-z0-9/_-]+)/g, (match: string) => {
        // a trailing full stop or comma belongs to the sentence; &amp; and friends stay inside the address
        const trailing = /[.,;:!?)]+$/.exec(match)?.[0] ?? ""
        const address = trailing ? match.slice(0, -trailing.length) : match
        const rel = address.startsWith("https://") ? ` rel="noreferrer"` : ""
        return `<a class="underline" href="${address}"${rel}>${address}</a>${trailing}`
    })
}

export function renderNewsBody(text: string): string {
    const html: string[] = []
    let list: string[] = []
    let paragraph: string[] = []
    const flushList = () => { if (list.length) { html.push(`<ul>${list.map(item => `<li>${item}</li>`).join("")}</ul>`); list = [] } }
    const flushParagraph = () => { if (paragraph.length) { html.push(`<p>${paragraph.join("<br>")}</p>`); paragraph = [] } }
    for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
        const line = raw.trimEnd()
        if (line.trim() === "") { flushList(); flushParagraph(); continue }
        if (line.startsWith("## ")) { flushList(); flushParagraph(); html.push(`<h3 class="card-title">${linkify(escapeHtml(line.slice(3)))}</h3>`); continue }
        if (line.startsWith("- ")) { flushParagraph(); list.push(linkify(escapeHtml(line.slice(2)))); continue }
        flushList()
        paragraph.push(linkify(escapeHtml(line)))
    }
    flushList(); flushParagraph()
    return html.join("")
}
