/**
 * Server-wide settings an admin changes at runtime on the admin site's Settings page. Every setting is declared in
 * SETTINGS (key, label, allowed range, default); the page and `POST /api/server/settings` are generated from that list,
 * so a new feature only adds an entry. Values are stored in the `server_settings` table and survive a restart; a
 * setting that was never saved uses its default.
 */
import type { Statement } from "better-sqlite3";
import getDatabase, { Database } from ".";

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
        description: "What the server cleans up by itself. Presets don't change these."
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
    {
        id: "companions", section: "gameplay", title: "AI companions",
        description: "After a host taps Recruit, AI companions fill the free slots if no player joins in time."
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
    }
]

export interface SettingDefinition {
    key: SettingKey
    /** SETTING_GROUPS id of the section it is shown in */
    group: string
    label: string
    description: string
    /** whole seconds, from min to max */
    min: number
    max: number
    defaultValue: () => number
}

export type SettingKey =
    | "coop.companion_delay_seconds"
    | "coop.companion_delay_players_seconds"
    | "coop.recruit_interval_seconds"
    | "coop.invitation_lifetime_seconds"
    | "coop.lobby_keepalive_seconds"
    | "coop.abandoned_room_seconds"
    | "client.attention_polling_seconds"
    | "client.attention_polling_battle_seconds"

/** An environment variable in whole seconds, if it is one in range. */
function envSeconds(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name]?.trim()
    const value = raw ? Number(raw) : NaN
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export const SETTINGS: readonly SettingDefinition[] = [
    {
        key: "coop.companion_delay_seconds", group: "companions",
        label: "Wait when nobody else is online",
        description: "No other player could join, so this can be short. 0 fills the room at once.",
        min: 0, max: 600, defaultValue: () => envSeconds("COOP_COMPANION_DELAY", 15, 0, 600)
    },
    {
        key: "coop.companion_delay_players_seconds", group: "companions",
        label: "Wait while players are online",
        description: "Someone could still join: they checked for invitations or opened the room list in the last minute, aren't in a room, and haven't declined. Drops to the short wait once nobody is left.",
        min: 0, max: 600, defaultValue: () => envSeconds("COOP_COMPANION_DELAY_PLAYERS", 60, 0, 600)
    },
    {
        key: "coop.abandoned_room_seconds", group: "rooms",
        label: "Close a room without its host after",
        description: "Counted from the end of its battle, or from when the host left its lobby; the host coming back stops it. Keep it above 60 s: after a battle the host's game closes its room itself after 60 s, and players can Return to Room until then. 0 never closes them.",
        min: 0, max: 3600, defaultValue: () => 90
    },
    {
        key: "client.attention_polling_seconds", group: "invitations",
        label: "Games check for invitations every",
        description: "Outside co-op rooms. Shorter brings invitations sooner, at one request per player each time.",
        min: 3, max: 60, defaultValue: () => 10
    },
    {
        key: "client.attention_polling_battle_seconds", group: "invitations",
        label: "During a battle, every",
        description: "Only for players who allow invitations in battle in their options.",
        min: 5, max: 60, defaultValue: () => 15
    },
    {
        key: "coop.recruit_interval_seconds", group: "invitations",
        label: "Host re-sends the recruitment every",
        description: "While the room has a free slot, 20 times at most. A room that misses three re-sends is no longer offered.",
        min: 5, max: 60, defaultValue: () => 15
    },
    {
        key: "coop.invitation_lifetime_seconds", group: "invitations",
        label: "An invitation stays under the bell for",
        description: "Then it expires, and that player no longer counts as someone who could join.",
        min: 10, max: 300, defaultValue: () => 30
    },
    {
        key: "coop.lobby_keepalive_seconds", group: "connection",
        label: "Acknowledge lobby members every",
        description: "The game leaves a lobby after 30 s without an acknowledgement, so keep this well below 30.",
        min: 2, max: 25, defaultValue: () => 10
    }
]

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

/** A whole number of seconds within the setting's range, or null. */
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
export function setSettings(values: Partial<Record<SettingKey, unknown>>): SettingKey[] {
    const parsed: [SettingKey, number][] = []
    const invalid: SettingKey[] = []
    for (const [key, raw] of Object.entries(values) as [SettingKey, unknown][]) {
        const setting = definitions.get(key)
        if (!setting) continue
        const value = parseSettingValue(setting, raw)
        if (value === null) invalid.push(key)
        else parsed.push([key, value])
    }
    if (invalid.length > 0) return invalid
    const { db: database, upsert } = db()
    database.transaction(() => {
        for (const [key, value] of parsed) upsert.run(key, String(value))
    })()
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

/** Returns every setting to its default. */
export function resetSettings(): void {
    const { db: database, clear } = db()
    database.transaction(() => {
        for (const setting of SETTINGS) clear.run(setting.key)
    })()
}
