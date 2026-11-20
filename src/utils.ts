import { randomInt } from "crypto"
import { FastifyRequest } from "fastify"

import { getServerTime } from "./lib/serverClock"

// The server clock lives in src/lib/serverClock.ts; most code imports it from here.
export { DEFAULT_SERVER_TIME, getServerDate, getServerTime, parseServerTime, setServerTime } from "./lib/serverClock"

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