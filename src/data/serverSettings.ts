/**
 * Server-wide settings an admin changes at runtime on the admin site's Settings page. Every setting is declared in
 * SETTINGS (key, label, allowed range, default); the page and `POST /api/server/settings` are generated from that list,
 * so a new feature only adds an entry. Values are stored in the `server_settings` table and survive a restart; a
 * setting that was never saved uses its default.
 */
import { applySqliteBudgets, resolveSqliteBudgets, DATABASE_BUDGETS, databaseBudgetDefault, type DatabaseBudgetKey } from "../lib/sqliteTuning";
import type { Statement } from "./sqlite";
import getDatabase, { Database } from ".";
import { parseAppVersion } from "../lib/appVersion";

export interface SettingSection {
    id: "gameplay" | "performance" | "server"
    title: string
    description: string
}

/** The Settings page's top-level sections, in page order. Presets only touch "performance". */
export const SETTING_SECTIONS: readonly SettingSection[] = [
    {
        id: "gameplay", title: "Gameplay",
        description: "Quality-of-life choices for players. Presets don't change these."
    },
    {
        id: "performance", title: "Performance and networking",
        description: "How often the games and the server talk to each other. Faster means quicker invitations and more requests; a preset sets all of these at once."
    },
    {
        id: "server", title: "Server housekeeping",
        description: "App versions, database memory and automatic cleanup. Presets don't change these."
    }
]

export interface SettingGroup {
    id: string
    section: SettingSection["id"]
    title: string
    description: string
}

/** The cards inside the sections, in page order. */
export const SETTING_GROUPS: readonly SettingGroup[] = [
    { id: "identity", section: "server", title: "Server identity",
        description: "How the server appears in the Reflipped app's server list (its name, description, label and card image), and the links its Help, Community, terms and privacy pages give players. Presets and the reset button don't change them." },
    { id: "app", section: "server", title: "Reflipped app",
        description: "Which versions of the Reflipped app may join, and the newest one, announced to older apps. Apps from before app versions existed don't check this." },
    { id: "database", section: "server", title: "Database",
        description: "Memory used for database reads. Changes apply immediately; more memory does not always make requests faster." },
    {
        id: "companions", section: "gameplay", title: "AI companions",
        description: "After a host taps Recruit, AI companions fill the free slots if no player joins in time."
    },
    {
        id: "lobby", section: "gameplay", title: "Co-op lobby",
        description: "How a co-op lobby starts its battle, and how long it keeps a player whose game went to the background."
    },
    {
        id: "invitations", section: "performance", title: "Invitations",
        description: "How a recruitment reaches other players: the host's game re-sends it, the other games check for invitations, and each invitation waits under the bell."
    },
    {
        id: "connection", section: "performance", title: "Lobby connection",
        description: "Keeps players in a co-op lobby connected while they wait."
    },
    {
        id: "rooms", section: "server", title: "Abandoned co-op rooms",
        description: "Rooms whose host's game closed without disbanding them."
    },
    {
        id: "anticheat", section: "server", title: "Anti-cheat",
        description: "Tolerances of the battle checks. The checks themselves stay fixed; flags only record what they find unless anti-cheat enforces."
    }
]

export interface SettingDefinition {
    key: SettingKey
    /** SETTING_GROUPS id of the section it is shown in */
    group: string
    label: string
    description: string
    unit: "s" | "MiB"
    /** Whole units, from min to max. */
    min: number
    max: number
    defaultValue: () => number
}

export type SettingKey = DatabaseBudgetKey
    | "coop.companion_delay_seconds"
    | "coop.companion_delay_players_seconds"
    | "coop.recruit_interval_seconds"
    | "coop.invitation_lifetime_seconds"
    | "coop.lobby_keepalive_seconds"
    | "coop.abandoned_room_seconds"
    | "coop.start_countdown_seconds"
    | "coop.lobby_resume_grace_seconds"
    | "coop.battle_start_timeout_seconds"
    | "client.attention_polling_seconds"
    | "client.attention_polling_battle_seconds"
    | "anticheat.wall_clock_slack_seconds"

/** An environment variable in whole seconds, if it is one in range. */
function envSeconds(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]?.trim()
    const value = raw ? Number(raw) : NaN
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export const SETTINGS: readonly SettingDefinition[] = [
    ...DATABASE_BUDGETS.map(spec => ({
        key: spec.key, group: "database", unit: "MiB" as const,
        label: spec.key === "database.cache_mib" ? "Database cache" : "Database memory map",
        description: spec.key === "database.cache_mib"
            ? "Page cache allocated as needed. Temporary data and the rest of the server use additional memory."
            : "Database pages mapped for reads. 0 disables mapping; the operating system may lower this limit. Measure before increasing it.",
        min: spec.min, max: spec.max, defaultValue: () => {
            try { return databaseBudgetDefault(spec.key) } catch { return spec.fallback }
        },
    })),
    {
        key: "coop.companion_delay_seconds", group: "companions",
        label: "Wait when nobody else is online",
        description: "No other player could join, so this can be short. 0 fills the room at once.",
        unit: "s", min: 0, max: 600, defaultValue: () => envSeconds("COOP_COMPANION_DELAY", 15, 0, 600)
    },
    {
        key: "coop.companion_delay_players_seconds", group: "companions",
        label: "Wait while players are online",
        description: "Someone could still join: they checked for invitations or opened the room list in the last minute, aren't in a room, and haven't declined. Drops to the short wait once nobody is left.",
        unit: "s", min: 0, max: 600, defaultValue: () => envSeconds("COOP_COMPANION_DELAY_PLAYERS", 60, 0, 600)
    },
    {
        key: "coop.start_countdown_seconds", group: "lobby",
        label: "Count down before the battle starts",
        description: "After the host taps Start, every player sees the seconds left. A player leaving or no longer ready stops it, and the host can start again. 0 starts at once.",
        unit: "s", min: 0, max: 10, defaultValue: () => 0
    },
    {
        key: "coop.lobby_resume_grace_seconds", group: "lobby",
        label: "Keep the slot of a player who switched away for",
        description: "A player whose game went to the background or lost its connection keeps its place, and comes back to the same lobby within this time. A host away for longer closes the room. 0 removes them at once.",
        unit: "s", min: 0, max: 300, defaultValue: () => 60
    },
    {
        key: "coop.battle_start_timeout_seconds", group: "lobby",
        label: "Start a battle without missing players after",
        description: "Counted from the first player ready in the battle. A player whose game never got there is left out, and the others play its character. At most 100 s: the games themselves give up waiting after 120 s.",
        unit: "s", min: 10, max: 100, defaultValue: () => 20
    },
    {
        key: "coop.abandoned_room_seconds", group: "rooms",
        label: "Close a room without its host after",
        description: "Counted from the end of its battle, or from when the host left its lobby; the host coming back stops it. Keep it above 60 s: after a battle the host's game closes its room itself after 60 s, and players can Return to Room until then. 0 never closes them.",
        unit: "s", min: 0, max: 3600, defaultValue: () => 90
    },
    {
        key: "client.attention_polling_seconds", group: "invitations",
        label: "Games check for invitations every",
        description: "Outside co-op rooms. Shorter brings invitations sooner, at one request per player each time.",
        unit: "s", min: 3, max: 60, defaultValue: () => 10
    },
    {
        key: "client.attention_polling_battle_seconds", group: "invitations",
        label: "During a battle, every",
        description: "Only for players who allow invitations in battle in their options.",
        unit: "s", min: 5, max: 60, defaultValue: () => 15
    },
    {
        key: "coop.recruit_interval_seconds", group: "invitations",
        label: "Host re-sends the recruitment every",
        description: "While the room has a free slot, 20 times at most. A room that misses three re-sends is no longer offered.",
        unit: "s", min: 5, max: 60, defaultValue: () => 15
    },
    {
        key: "coop.invitation_lifetime_seconds", group: "invitations",
        label: "An invitation stays under the bell for",
        description: "Then it expires, and that player no longer counts as someone who could join.",
        unit: "s", min: 10, max: 300, defaultValue: () => 30
    },
    {
        key: "coop.lobby_keepalive_seconds", group: "connection",
        label: "Acknowledge lobby members every",
        description: "The game leaves a lobby after 30 s without an acknowledgement, so keep this well below 30.",
        unit: "s", min: 2, max: 25, defaultValue: () => 10
    },
    {
        key: "anticheat.wall_clock_slack_seconds", group: "anticheat",
        label: "Allow clear times beyond real time by",
        description: "A battle's clear time can't run ahead of the real time since its start by more than the fastest battle speed; this much more is still accepted, for slow networks. Larger flags fewer battles.",
        unit: "s", min: 0, max: 600, defaultValue: () => 10
    }
]

/** Text settings remain separate so numeric gameplay callers and presets keep their existing types. */
export type TextSettingKey = "server.name" | "server.description" | "server.type" | "server.thumbnail" | "links.community" | "links.support"
    | "links.terms" | "links.privacy" | "shell.min_app_version"
    | "shell.latest_app_version" | "shell.update_url" | "shell.update_notes" | "shell.update_apk_url" | "shell.update_apk_sha256"
export interface TextSettingDefinition {
    key: TextSettingKey
    group: string
    label: string
    description: string
    minLength: number
    maxLength: number
    defaultValue: () => string
    validate?: (value: string) => boolean
}

/** Server identity fields are single-line display text, never markup. */
export function parseTextSettingValue(setting: TextSettingDefinition, raw: unknown): string | null {
    if (typeof raw !== "string" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(raw)) return null
    const value = raw.trim()
    return value.length >= setting.minLength && value.length <= setting.maxLength
        && (!setting.validate || setting.validate(value)) ? value : null
}

/** Public HTTP(S) location only (the server card image, the app update page); no credentials, fragments or non-HTTP resource schemes. Public image queries are supported. */
function validHttpUrl(value: string): boolean {
    if (value === "") return true
    if (!/^https?:\/\/[^/?#]+/i.test(value) || /[\s\\<>"`#]/u.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) return false
    try {
        const url = new URL(value)
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== ""
            && !url.username && !url.password && !url.hash
    } catch { return false }
}

/** An https address only (the owner's community, help, terms and privacy pages the app links to); no credentials. */
function validHttpsUrl(value: string): boolean {
    return value === "" || (validHttpUrl(value) && /^https:/i.test(value))
}

/** The address an environment variable gives, for a link setting left empty (the links were environment variables first). */
function linkFromEnvironment(name: string): string {
    const value = process.env[name]?.trim() ?? ""
    return value.length <= 2048 && validHttpsUrl(value) ? value : ""
}

export const TEXT_SETTINGS: readonly TextSettingDefinition[] = [{
    key: "server.name", group: "identity", label: "Server name",
    description: "Shown to players before sign-in and as the server label in the game. Use 1–64 characters on one line.",
    minLength: 1, maxLength: 64, defaultValue: () => {
        const value = process.env.SERVER_NAME?.trim() ?? ""
        return value && value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ? value : "Reflipped"
    }
}, {
    key: "server.description", group: "identity", label: "Server description",
    description: "Optional description shown in the app's server picker, such as the community, rules or play style. Up to 500 characters on one line.",
    minLength: 0, maxLength: 500, defaultValue: () => ""
}, {
    key: "server.type", group: "identity", label: "Server type",
    description: "Optional label for your community or house rules, such as Casual community, Sandbox or Custom rules. Up to 40 characters; blank shows Community server. The active event mode is shown separately.",
    minLength: 0, maxLength: 40, defaultValue: () => ""
}, {
    key: "server.thumbnail", group: "identity", label: "Server image address",
    description: "An image hosted elsewhere, used while none is uploaded: an absolute HTTP or HTTPS address at its final location (the app doesn't follow redirects), without credentials. An image on a local-network address shows only when it is on this server's own address.",
    minLength: 0, maxLength: 2048, defaultValue: () => "", validate: validHttpUrl
}, {
    key: "links.community", group: "identity", label: "Community link",
    description: "Where the app's Community page sends players, such as your Discord invite or forum: an https address. Blank uses the SERVER_COMMUNITY_URL environment variable, if set, else the page just explains how to find others.",
    minLength: 0, maxLength: 2048, defaultValue: () => linkFromEnvironment("SERVER_COMMUNITY_URL"), validate: validHttpsUrl
}, {
    key: "links.support", group: "identity", label: "Help link",
    description: "Where the app's Help page sends players who need to contact you: an https address. Blank uses SERVER_SUPPORT_URL, if set.",
    minLength: 0, maxLength: 2048, defaultValue: () => linkFromEnvironment("SERVER_SUPPORT_URL"), validate: validHttpsUrl
}, {
    key: "links.terms", group: "identity", label: "Server rules link",
    description: "Your server's rules, linked from the app's terms page: an https address. Blank uses SERVER_TERMS_URL, if set.",
    minLength: 0, maxLength: 2048, defaultValue: () => linkFromEnvironment("SERVER_TERMS_URL"), validate: validHttpsUrl
}, {
    key: "links.privacy", group: "identity", label: "Privacy information link",
    description: "Your privacy information, linked from the app's privacy page: an https address. Blank uses SERVER_PRIVACY_URL, if set.",
    minLength: 0, maxLength: 2048, defaultValue: () => linkFromEnvironment("SERVER_PRIVACY_URL"), validate: validHttpsUrl
}, {
    key: "shell.min_app_version", group: "app", label: "Oldest supported app version",
    description: "Older apps say \"This server needs a newer Reflipped app\" and don't join. Use a version such as 0.2.0, or a pre-release such as 0.2.0-beta.1 (alpha, then beta, then pre, then the release), or leave blank to accept every version. The app checks this itself, so it guides players but doesn't stop a modified app.",
    minLength: 0, maxLength: 32, defaultValue: () => "", validate: value => value === "" || parseAppVersion(value) !== null
}, {
    key: "shell.latest_app_version", group: "app", label: "Newest app version",
    description: "Announce a newer Reflipped app: apps below this version show \"Update available\" with a link, and can still join. Same format as above; blank announces nothing. If it is lower than the oldest supported version, the oldest supported version is announced.",
    minLength: 0, maxLength: 32, defaultValue: () => "", validate: value => value === "" || parseAppVersion(value) !== null
}, {
    key: "shell.update_url", group: "app", label: "Update page address",
    description: "Where the update notice sends players: your download page or build guide, an absolute HTTP or HTTPS address. Blank uses the public build guide.",
    minLength: 0, maxLength: 2048, defaultValue: () => "", validate: validHttpUrl
}, {
    key: "shell.update_notes", group: "app", label: "Update notes",
    description: "Optional short text shown with the update notice, such as what changed. Up to 280 characters on one line.",
    minLength: 0, maxLength: 280, defaultValue: () => ""
}, {
    key: "shell.update_apk_url", group: "app", label: "Update APK address",
    description: "Optional: where the app downloads the new version's APK to install it itself (an absolute HTTP or HTTPS address). Only apps you built can install it: Android installs an update only when it is signed with the same key. Needs the SHA-256 below.",
    minLength: 0, maxLength: 2048, defaultValue: () => "", validate: validHttpUrl
}, {
    key: "shell.update_apk_sha256", group: "app", label: "Update APK SHA-256",
    description: "The APK's SHA-256 checksum (64 hexadecimal characters, as `sha256sum` prints it). The app refuses a download that doesn't match.",
    minLength: 0, maxLength: 64, defaultValue: () => "", validate: value => value === "" || /^[0-9a-fA-F]{64}$/.test(value)
}]
const textDefinitions = new Map(TEXT_SETTINGS.map(setting => [setting.key, setting]))

export function getTextSetting(key: TextSettingKey): string {
    const setting = textDefinitions.get(key)!
    return parseTextSettingValue(setting, getStoredText(key)) ?? setting.defaultValue()
}

/** An owner link the app shows (community, help, terms, privacy): the saved address, else the environment variable's, else "". */
export function getLinkSetting(key: "links.community" | "links.support" | "links.terms" | "links.privacy"): string {
    return getTextSetting(key) || textDefinitions.get(key)!.defaultValue()
}

const definitions = new Map(SETTINGS.map(setting => [setting.key, setting]))

export interface SettingPreset {
    id: string
    title: string
    description: string
    /** what it costs, shown next to the description */
    cost: string
    /** a value for every setting in the "performance" section, and nothing else */
    values: Partial<Record<SettingKey, number>>
}

/** The settings a preset sets: everything in the "performance" section. */
export function presetKeys(): SettingKey[] {
    const performanceGroups = new Set(SETTING_GROUPS.filter(group => group.section === "performance").map(group => group.id))
    return SETTINGS.filter(setting => performanceGroups.has(setting.group)).map(setting => setting.key)
}

/** One-click sets of performance and networking values on the Settings page; gameplay settings are left alone. */
export const SETTING_PRESETS: readonly SettingPreset[] = [
    {
        id: "balanced", title: "Balanced",
        description: "The original server's timings: invitations within about 10 s.",
        cost: "Least server load.",
        values: {
            "client.attention_polling_seconds": 10,
            "client.attention_polling_battle_seconds": 15,
            "coop.recruit_interval_seconds": 15,
            "coop.invitation_lifetime_seconds": 30,
            "coop.lobby_keepalive_seconds": 10
        }
    },
    {
        id: "responsive", title: "Responsive",
        description: "Invitations within about 3 s, quicker re-sends and keepalive.",
        cost: "About 3× the invitation and recruitment requests.",
        values: {
            "client.attention_polling_seconds": 3,
            "client.attention_polling_battle_seconds": 5,
            "coop.recruit_interval_seconds": 5,
            "coop.invitation_lifetime_seconds": 30,
            "coop.lobby_keepalive_seconds": 5
        }
    }
]

/** Saves a preset's values; false for an unknown preset. */
export function applyPreset(id: string): boolean {
    const preset = SETTING_PRESETS.find(candidate => candidate.id === id)
    if (!preset) return false
    return setSettings(preset.values).length === 0
}

/** The preset the current performance values match exactly, or null ("Custom"). */
export function activePreset(): SettingPreset | null {
    return SETTING_PRESETS.find(preset => presetKeys().every(key => getSetting(key) === preset.values[key])) ?? null
}

let statements: {
    select: Statement<[string]>
    upsert: Statement<[string, string]>
    clear: Statement<[string]>
    db: ReturnType<typeof getDatabase>
} | null = null

/** The table is created on first use, so importing this module doesn't open the database. */
function db() {
    if (statements) return statements
    const database = getDatabase(Database.WDFP_DATA)
    database.prepare(`CREATE TABLE IF NOT EXISTS server_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    )`).run()
    statements = {
        select: database.prepare<[string]>(`SELECT value FROM server_settings WHERE key = ?`),
        upsert: database.prepare<[string, string]>(`INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
        clear: database.prepare<[string]>(`DELETE FROM server_settings WHERE key = ?`),
        db: database
    }
    return statements
}

/** A whole number in the declared unit/range, or null. */
export function parseSettingValue(setting: SettingDefinition, raw: unknown): number | null {
    const text = String(raw ?? "").trim()
    if (!/^\d{1,6}$/.test(text)) return null
    const value = Number(text)
    return value >= setting.min && value <= setting.max ? value : null
}

/** The setting's saved value, or its default. */
export function getSetting(key: SettingKey): number {
    const setting = definitions.get(key)!
    const row = db().select.get(key) as { value: string } | undefined
    return (row === undefined ? null : parseSettingValue(setting, row.value)) ?? setting.defaultValue()
}

/** Saves the given values, all or none: returns the keys that were out of range (nothing saved then). */
export function setSettings(values: Partial<Record<SettingKey | TextSettingKey, unknown>>): (SettingKey | TextSettingKey)[] {
    const parsed: [SettingKey | TextSettingKey, number | string][] = []
    const invalid: (SettingKey | TextSettingKey)[] = []
    for (const [key, raw] of Object.entries(values) as [SettingKey | TextSettingKey, unknown][]) {
        const textSetting = textDefinitions.get(key as TextSettingKey)
        if (textSetting) {
            const value = parseTextSettingValue(textSetting, raw)
            if (value === null) invalid.push(key)
            else parsed.push([key, value])
            continue
        }
        const setting = definitions.get(key as SettingKey)
        if (!setting) continue
        const value = parseSettingValue(setting, raw)
        if (value === null) invalid.push(key)
        else parsed.push([key, value])
    }
    if (invalid.length > 0) return invalid
    const { db: database, upsert } = db()
    const memoryUpdates = parsed.filter(([key]) => DATABASE_BUDGETS.some(spec => spec.key === key))
    const memoryPolicy = memoryUpdates.length ? resolveSqliteBudgets(database,
        Object.fromEntries(memoryUpdates.map(([key, value]) => [key, String(value)]))) : null
    database.transaction(() => {
        for (const [key, value] of parsed) upsert.run(key, String(value))
    })()
    if (memoryPolicy) applySqliteBudgets(database, memoryPolicy)
    return []
}

/** Server state that isn't a setting on the page (e.g. the clock's anchor), stored as text under its own key. */
export function getStoredText(key: string): string | null {
    const row = db().select.get(key) as { value: string } | undefined
    return row?.value ?? null
}

export function setStoredText(key: string, value: string | null): void {
    if (value === null) db().clear.run(key)
    else db().upsert.run(key, value)
}

/** Stores several texts at once: all or none (inside an open transaction, a savepoint of it). */
export function setStoredTexts(entries: [key: string, value: string | null][]): void {
    const { db: database } = db()
    database.transaction(() => {
        for (const [key, value] of entries) setStoredText(key, value)
    })()
}

/**
 * The uploaded server card image (src/data/serverThumbnail.ts): what it is, and its bytes. They are stored under two
 * keys so the description can be read without loading the image. Part of the server identity.
 */
export const THUMBNAIL_IMAGE_KEYS = { meta: "server.thumbnail_image", data: "server.thumbnail_image_data" } as const

/**
 * Returns every setting to its default. With `keepIdentity`, the server identity (name, description, type and card
 * image) stays as it is: the Settings page's reset button only covers the timing and database settings.
 */
export function resetSettings(options: { keepIdentity?: boolean } = {}): void {
    const { db: database, clear } = db()
    const memoryPolicy = resolveSqliteBudgets(database, Object.fromEntries(DATABASE_BUDGETS.map(spec => [spec.key, null])))
    const texts = TEXT_SETTINGS.filter(setting => !(options.keepIdentity && setting.group === "identity"))
    database.transaction(() => {
        for (const setting of [...SETTINGS, ...texts]) clear.run(setting.key)
        if (!options.keepIdentity) for (const key of Object.values(THUMBNAIL_IMAGE_KEYS)) clear.run(key)
    })()
    applySqliteBudgets(database, memoryPolicy)
}
