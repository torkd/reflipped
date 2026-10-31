// Translation checker (docs/i18n.md, "Checker rules"). The core is string-based: source text, translation text and
// the column context in, a list of issues out. File walking is in `cli.ts`.

import { hasKana, hasKanji } from "./text"

export type Severity = "error" | "warning"

export interface Issue {
    severity: Severity
    rule: string
    message: string
}

export interface CheckOptions {
    /** "scenario" applies the line rules (about 30-35 characters, at most 3 lines); "text" does not. */
    kind?: "text" | "scenario"
    /** Warn above this many characters (the 95th percentile of the English text of the column). */
    maxLength?: number
    maxLineLength?: number // scenario: warn above this (default 35)
    maxLines?: number // scenario: error above this (default 3)
    /** Allow kana in the translation (a later language that uses it); kanji are never allowed. */
    allowKana?: boolean
    /** Glossary entries ({ja, en}) to check for consistency; matching is a plain substring test. */
    glossary?: ReadonlyArray<{ ja: string; en: string }>
}

const DIRECTIVE = /::(?:if\b[^:]*|else|end)::/g
const PLACEHOLDER = /::[A-Za-z_][A-Za-z0-9_]*::/g
const TAG = /<\/?([A-Za-z]+)\b[^>]*?\/?>/g
const SELF_CLOSING = new Set(["br", "icon", "img"])

const normalizeDirective = (d: string): string => d.replace(/\s+/g, "")

function counts(items: string[]): Map<string, number> {
    const map = new Map<string, number>()
    for (const item of items) map.set(item, (map.get(item) ?? 0) + 1)
    return map
}

/** Items in `a` that `b` has fewer of (as a multiset difference). */
function missing(a: string[], b: string[]): string[] {
    const have = counts(b)
    const out: string[] = []
    for (const item of a) {
        const n = have.get(item) ?? 0
        if (n > 0) have.set(item, n - 1)
        else out.push(item)
    }
    return out
}

/** The placeholders (`::name::`) of a text; the conditional directives (`::if …::`, `::else::`, `::end::`) are separate. */
export function placeholdersOf(text: string): string[] {
    return (text.replace(DIRECTIVE, "").match(PLACEHOLDER) ?? []).slice()
}

export function directivesOf(text: string): string[] {
    return (text.match(DIRECTIVE) ?? []).map(normalizeDirective)
}

/** Names of the open/close sequence problems of `<font>`-style tags: returns unbalanced tag names. */
export function unbalancedTags(text: string): string[] {
    const stack: string[] = []
    const bad: string[] = []
    for (const m of text.matchAll(TAG)) {
        const name = m[1].toLowerCase()
        if (SELF_CLOSING.has(name) || m[0].endsWith("/>")) continue
        if (m[0].startsWith("</")) {
            if (stack[stack.length - 1] === name) stack.pop()
            else bad.push(`</${name}>`)
        } else stack.push(name)
    }
    return [...bad, ...stack.map((n) => `<${n}>`)]
}

const tagsOf = (text: string, names: string[]): string[] =>
    [...text.matchAll(TAG)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ")).filter((t) => names.includes(t.replace(/[</>]/g, "").split(" ")[0]))

/** Visible text of a line: tags removed. */
const visible = (line: string): string => line.replace(TAG, "")

export function checkTranslation(source: string, translation: string, options: CheckOptions = {}): Issue[] {
    const issues: Issue[] = []
    const add = (severity: Severity, rule: string, message: string) => issues.push({ severity, rule, message })

    if (translation.trim() === "" && source.trim() !== "") {
        add("error", "empty", "translation is empty")
        return issues
    }

    // placeholders and conditional blocks
    const srcPh = placeholdersOf(source)
    const trPh = placeholdersOf(translation)
    for (const p of missing(srcPh, trPh)) add("error", "placeholder", `placeholder ${p} is missing`)
    for (const p of missing(trPh, srcPh)) add("error", "placeholder", `placeholder ${p} is not in the source`)

    const srcDir = directivesOf(source)
    const trDir = directivesOf(translation)
    for (const d of missing(srcDir, trDir)) add("error", "conditional", `${d} is missing`)
    for (const d of missing(trDir, srcDir)) add("error", "conditional", `${d} is not in the source`)
    let depth = 0
    for (const d of trDir) {
        if (d.startsWith("::if")) depth++
        else if (d === "::end::" && --depth < 0) break
    }
    if (depth !== 0) add("error", "conditional", "::if…::end:: blocks are not balanced")

    // markup
    for (const t of unbalancedTags(translation)) add("error", "tags", `unbalanced tag ${t}`)
    const markup = ["font", "b", "p", "icon"]
    for (const t of missing(tagsOf(source, markup), tagsOf(translation, markup))) add("error", "tags", `tag ${t} is missing`)
    for (const t of missing(tagsOf(translation, markup), tagsOf(source, markup)))
        add("error", "tags", `tag ${t} is not in the source`)
    const brs = (s: string) => (s.match(/<br\s*\/?>/gi) ?? []).length
    if (brs(source) !== brs(translation)) add("warning", "br", `<br/> count differs (${brs(source)} in source, ${brs(translation)} here)`)
    const nbsp = (s: string) => (s.match(/&nbsp;/g) ?? []).length
    if (nbsp(source) !== nbsp(translation)) add("warning", "nbsp", `&nbsp; count differs (${nbsp(source)} in source, ${nbsp(translation)} here)`)

    // the client font has no kanji: they are dropped silently, as are ー and ・
    if (hasKanji(translation)) add("error", "kanji", `kanji left in text: ${(translation.match(/[㐀-䶿一-鿿豈-﫿々]+/gu) ?? []).join(" ")}`)
    if (!options.allowKana && hasKana(translation)) add("warning", "kana", `kana left in text: ${(translation.match(/[぀-ヿｦ-ﾟ]+/gu) ?? []).join(" ")}`)

    // lengths
    if (options.kind === "scenario") {
        const maxLine = options.maxLineLength ?? 35
        const maxLines = options.maxLines ?? 3
        const lines = translation.split("\n")
        if (lines.length > maxLines) add("error", "lines", `${lines.length} lines (at most ${maxLines})`)
        lines.forEach((line, i) => {
            const n = [...visible(line)].length
            if (n > maxLine) add("warning", "line-length", `line ${i + 1} has ${n} characters (about 30-${maxLine})`)
        })
    }
    if (options.maxLength !== undefined) {
        const n = [...visible(translation)].length
        if (n > options.maxLength) add("warning", "length", `${n} characters, above the 95th percentile of English text in this column (${options.maxLength})`)
    }

    // glossary consistency
    for (const entry of options.glossary ?? []) {
        if (source.includes(entry.ja) && !translation.toLowerCase().includes(entry.en.toLowerCase()))
            add("warning", "glossary", `source has "${entry.ja}" but the translation lacks "${entry.en}"`)
    }
    return issues
}
