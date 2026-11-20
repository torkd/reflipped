// ADM-4: the news the game's /news page shows. A post is written by an admin (source "admin") or published
// automatically for an event (source "auto", with an `auto_key` naming the event run, so it is published once).
// Posts carry the real time they went live. The body is plain text: paragraphs are separated by blank lines.
import type { Statement } from "./sqlite";
import getDatabase, { Database } from ".";

export type NewsSource = "admin" | "auto"

export interface NewsPost {
    id: number
    title: string
    body: string
    source: NewsSource
    autoKey: string | null
    /** real time, ms */
    publishedAt: number
    hidden: boolean
}

interface Row { id: number, title: string, body: string, source: string, auto_key: string | null, published_at: number, hidden: number }

export const NEWS_TITLE_MAX = 120
export const NEWS_BODY_MAX = 20000
/** The page shows this many posts at a time. */
export const NEWS_PAGE_SIZE = 10

let statements: {
    insert: Statement<[string, string, string, string | null, number]>
    page: Statement<[number, number]>
    pageAll: Statement<[number, number]>
    count: Statement<[]>
    countAll: Statement<[]>
    byId: Statement<[number]>
    byAutoKey: Statement<[string]>
    update: Statement<[string, string, number]>
    setHidden: Statement<[number, number]>
    remove: Statement<[number]>
} | null = null

/** Prepared on first use, so importing this module doesn't open the database. */
function db() {
    if (statements) return statements
    const database = getDatabase(Database.WDFP_DATA)
    const columns = `id, title, body, source, auto_key, published_at, hidden`
    statements = {
        insert: database.prepare(`INSERT INTO news_posts (title, body, source, auto_key, published_at) VALUES (?, ?, ?, ?, ?)`),
        page: database.prepare(`SELECT ${columns} FROM news_posts WHERE hidden = 0 ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`),
        pageAll: database.prepare(`SELECT ${columns} FROM news_posts ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`),
        count: database.prepare(`SELECT COUNT(*) AS count FROM news_posts WHERE hidden = 0`),
        countAll: database.prepare(`SELECT COUNT(*) AS count FROM news_posts`),
        byId: database.prepare(`SELECT ${columns} FROM news_posts WHERE id = ?`),
        byAutoKey: database.prepare(`SELECT ${columns} FROM news_posts WHERE auto_key = ?`),
        update: database.prepare(`UPDATE news_posts SET title = ?, body = ? WHERE id = ?`),
        setHidden: database.prepare(`UPDATE news_posts SET hidden = ? WHERE id = ?`),
        remove: database.prepare(`DELETE FROM news_posts WHERE id = ?`)
    }
    return statements
}

const post = (row: Row): NewsPost => ({
    id: row.id, title: row.title, body: row.body, source: row.source === "auto" ? "auto" : "admin",
    autoKey: row.auto_key, publishedAt: row.published_at, hidden: row.hidden === 1
})

/** Adds a post; null when an automatic post with the same key exists already (deleted ones keep their key hidden: see removeNewsPost). */
export function addNewsPost(title: string, body: string, source: NewsSource, publishedAt: number, autoKey: string | null = null): number | null {
    if (autoKey !== null && db().byAutoKey.get(autoKey) !== undefined) return null
    return Number(db().insert.run(title, body, source, autoKey, publishedAt).lastInsertRowid)
}

/** A page of posts, newest first (1-based); `all` includes hidden ones, for the admin page. */
export function listNewsPosts(page: number, all: boolean, pageSize = NEWS_PAGE_SIZE): NewsPost[] {
    const offset = (Math.max(1, page) - 1) * pageSize
    return (all ? db().pageAll : db().page).all(pageSize, offset).map(row => post(row as Row))
}

export function countNewsPosts(all: boolean): number {
    return ((all ? db().countAll : db().count).get() as { count: number }).count
}

export function getNewsPost(id: number): NewsPost | null {
    const row = db().byId.get(id) as Row | undefined
    return row === undefined ? null : post(row)
}

export function hasNewsAutoKey(autoKey: string): boolean {
    return db().byAutoKey.get(autoKey) !== undefined
}

export function updateNewsPost(id: number, title: string, body: string): boolean {
    return db().update.run(title, body, id).changes > 0
}

export function setNewsPostHidden(id: number, hidden: boolean): boolean {
    return db().setHidden.run(hidden ? 1 : 0, id).changes > 0
}

/**
 * Deletes a post. An automatic post is hidden instead, so its event isn't announced again the next time the
 * generator runs (the hidden row keeps the key); an admin post is removed.
 */
export function removeNewsPost(id: number): boolean {
    const existing = getNewsPost(id)
    if (existing === null) return false
    if (existing.source === "auto") return setNewsPostHidden(id, true)
    return db().remove.run(id).changes > 0
}
