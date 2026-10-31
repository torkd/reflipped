import { randomInt } from "crypto"
import { FastifyRequest } from "fastify"
import { getStoredText, setStoredText } from "./data/serverSettings"

/**
 * The clock the server runs on when no time has been set through the web UI.
 * `SERVER_TIME` is a UTC date ("2025-01-03T12:00:00" or "2025-01-03T12:00"), or "real" for the machine's clock.
 * The default is a moment when the gacha, shops and events in `assets/` are open, since with the real date
 * (past the end of the last event) no summoning portal opens and the client fails with C8601.
 *
 * The clock starts there (or at a time set in the web UI) and then runs in real time. It must run: the client
 * rebuilds its own clock from every reply's `servertime`, so a frozen one pulls the client's clock back on each
 * request and stretches all its timers (co-op invitation polling, recruiting, AI summon; docs/coop-research.md).
 * `SERVER_CLOCK=frozen` keeps the old frozen clock (the tests use it). Stamina and pooled exp still don't regenerate:
 * their timestamps are reported as "now". The running clock is stored in the database and carries on after a restart;
 * changing `SERVER_TIME`, or Reset on the admin site, starts it again from the configured time.
 */
export const DEFAULT_SERVER_TIME = "2025-01-03T12:00:00"

export function parseServerTime(value: string): Date | null {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)(:\d\d)?(\.\d+)?Z?$/.exec(value.trim())
    const date = match ? new Date(`${match[1]}${match[2] ?? ":00"}${match[3] ?? ""}Z`) : null
    return date && !isNaN(date.getTime()) ? date : null
}

function defaultServerTime(): Date | null {
    const configured = process.env.SERVER_TIME?.trim() || DEFAULT_SERVER_TIME
    if (configured.toLowerCase() === "real") return null
    const date = parseServerTime(configured)
    if (!date) throw new Error(`Invalid SERVER_TIME "${configured}": use YYYY-MM-DDTHH:MM[:SS] (UTC) or "real".`)
    return date
}

/** `SERVER_CLOCK=frozen` stops the server clock at the time it was set; anything else lets it run. */
function isClockFrozen(): boolean {
    return process.env.SERVER_CLOCK?.trim().toLowerCase() === "frozen"
}

interface ClockAnchor {
    /** the server date the clock was set to */
    date: Date
    /** the machine time (ms) when that happened */
    setAt: number
}

/** server_settings key of the running clock's anchor, so a restart carries on instead of jumping back */
const CLOCK_ANCHOR_KEY = "clock.anchor"

// The server clock (null: the machine's clock). Loaded on first use, since the database may not be open yet.
let serverClock: ClockAnchor | null | undefined = undefined

/**
 * The running clock survives a restart: its anchor is stored with the configured start (`SERVER_TIME`), and reused
 * while that start is unchanged. Rewinding the clock on every restart would pull the game's clocks back again.
 */
function loadClock(): ClockAnchor | null {
    const start = defaultServerTime()
    if (start === null) return null
    if (isClockFrozen()) return { date: start, setAt: Date.now() }
    try {
        const stored = JSON.parse(getStoredText(CLOCK_ANCHOR_KEY) ?? "null")
        const date = new Date(stored?.date)
        if (stored?.start === start.toISOString() && !isNaN(date.getTime()) && Number.isFinite(stored?.setAt)) {
            return { date, setAt: stored.setAt }
        }
    } catch {
        // unreadable: start over
    }
    return saveClock({ date: start, setAt: Date.now() })
}

function saveClock(anchor: ClockAnchor): ClockAnchor {
    if (!isClockFrozen()) {
        const start = defaultServerTime()
        setStoredText(CLOCK_ANCHOR_KEY, JSON.stringify({ date: anchor.date.toISOString(), setAt: anchor.setAt, start: start?.toISOString() }))
    }
    return anchor
}

/** The server clock's current date, or null when it follows the machine's clock. */
function currentServerClock(): Date | null {
    if (serverClock === undefined) serverClock = loadClock()
    if (serverClock === null) return null
    if (isClockFrozen()) return serverClock.date
    return new Date(serverClock.date.getTime() + (Date.now() - serverClock.setAt))
}

/**
 * Returns the current server time as a unix epoch.
 *
 * @param date An optional date; The date to get the time of. Ignored while the server clock is set (see
 *   `DEFAULT_SERVER_TIME`): then the server's "now" is returned.
 * @returns The unix epoch.
 */
export function getServerTime(
    date: Date = new Date()
): number {
    return Math.floor((currentServerClock() ?? date).getTime() / 1000)
}

/**
 * Gets the current server time as a Date.
 *
 * @returns The current server time as a date.
 */
export function getServerDate(): Date {
    return currentServerClock() ?? new Date()
}

/**
 * Sets the server time; the clock runs on from there. `null` goes back to the default clock (see `SERVER_TIME`).
 */
export function setServerTime(date: Date | null) {
    const target = date ?? defaultServerTime()
    serverClock = target === null ? null : saveClock({ date: target, setAt: Date.now() })
}

/**
 * Formats a date as "YYYY-MM-DD HH:MM:SS" in UTC, how the client writes dates in requests and save data. Master
 * table dates have the same format but are Japan time: read them with `masterDate()`.
 */
export function formatUtcDateTime(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, "0")
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/**
 * Reads a master table date ("YYYY-MM-DD HH:MM:SS": gacha, shop and campaign periods) as the client does, in Japan
 * time (UTC+9). The client's master loader turns every such field into `Date.UTC(...)` minus a fixed 32400000 ms set
 * at boot, so `2024-06-25 14:00:00` is 05:00 UTC.
 */
export function masterDate(text: string): Date {
    return new Date(`${text.replace(" ", "T")}+09:00`)
}

/**
 * Converts a server time value (unix epoch in seconds) into a Date.
 * 
 * @param serverTime The unix epoch value.
 * @returns The date.
 */
export function getDateFromServerTime(serverTime: number): Date {
    return new Date(serverTime * 1000)
}

/**
 * Generates an IdpAlias to identify a particular device.
 * 
 * @param appId 
 * @param idpId 
 * @param serialNo 
 * @returns The generated IdpAlias
 */
export function generateIdpAlias(
    appId: string,
    deviceId: string,
    serialNo: string
): string {
    return `${appId}:${deviceId}:${serialNo}`
}

/**
 * Generates a random viewer ID using the crypto library.
 * 
 * @returns A number between 100,000,000 and 999,999,999
 */
export function generateViewerId(): number {
    return randomInt(100000000, 999999999)
}

/** Whether a viewer id is in the range the server hands out; /load only adopts ids like that. */
export function isGeneratedViewerId(viewerId: number): boolean {
    return Number.isInteger(viewerId) && viewerId >= 100000000 && viewerId < 999999999
}

export interface DataHeaders {
    force_update?: boolean
    asset_update?: boolean
    short_udid?: number
    viewer_id?: number
    servertime?: number
    result_code?: number
    udid?: string
}

/**
 * Generates a default data headers object, which is used in communication with the client.
 * 
 * @param customValues A partial DataHeaders object with custom fields to replace the default ones.
 * @returns A DataHeaders object.
 */
export function generateDataHeaders(
    customValues: Partial<DataHeaders> = {},
    fields: (keyof DataHeaders)[] = ['force_update', 'asset_update', 'short_udid', 'viewer_id', 'servertime', 'result_code'],
): Record<string, any> {
    const defaultHeaders: DataHeaders = {
        force_update: false,
        asset_update: false,
        short_udid: 0,
        viewer_id: 0,
        servertime: getServerTime(), //1651514014,//getServerTime(),
        result_code: 1
    }
    const headers: Record<string, any> = {}

    for (const field of fields) {
        const customValue = customValues[field]
        const defaultValue = defaultHeaders[field]
        headers[field] = customValue === undefined ? defaultValue : customValue
    }

    return headers
}

export enum Platform {
    ANDROID,
    IOS
}

export function getRequestPlatformSync(
    request: FastifyRequest
): Platform {
    // check user agent
    if ((request.headers["user-agent"] || '').includes('iOS;'))
        return Platform.IOS;

    // check requestedby header
    if ((request.headers["requestedby"] || '') === 'ios')
        return Platform.IOS;

    return Platform.ANDROID
}