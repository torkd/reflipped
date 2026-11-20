// ADM-4: the automatic event posts. `publishDueNews` is cheap and safe to call often (the news page calls it, and the
// server calls it every few minutes): it publishes every post whose time has come and that doesn't exist yet. An
// admin switches it off on the News page; the posts already published stay.
import { addNewsPost } from "../data/news";
import { getStoredText, setStoredText } from "../data/serverSettings";
import { buildNewsPost, newsSubjects } from "./newsContent";
import { eventsToAnnounce, newsAutoKey } from "./newsSchedule";

const SETTING_KEY = "news.auto_events"

/** Whether automatic event posts are on: they are, until an admin turns them off. */
export function newsAutoEnabled(): boolean {
    return getStoredText(SETTING_KEY) !== "off"
}

export function setNewsAutoEnabled(enabled: boolean): void {
    setStoredText(SETTING_KEY, enabled ? "on" : "off")
}

/** Publishes the posts due at `now` (real ms). Returns how many went live. */
export function publishDueNews(now = Date.now()): number {
    if (!newsAutoEnabled()) return 0
    let published = 0
    for (const upcoming of eventsToAnnounce(now, newsSubjects())) {
        const { title, body } = buildNewsPost(upcoming)
        if (addNewsPost(title, body, "auto", now, newsAutoKey(upcoming.event, upcoming.cycle)) !== null) published++
    }
    return published
}
