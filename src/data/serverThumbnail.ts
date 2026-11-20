// The server card image an admin uploads on the Settings page (Server identity tab). The Reflipped app shows it in its
// server list: /shell/config names it by an absolute URL on the address the app asked, and GET /shell/thumbnail
// serves it. An uploaded image takes the place of the `server.thumbnail` URL setting; uploading clears that URL.
//
// Stored in the server_settings table (two keys, THUMBNAIL_IMAGE_KEYS), so it lives in the database with the rest of
// the server's state and survives restarts and container rebuilds.

import { createHash } from "crypto"
import { getStoredText, getTextSetting, setStoredTexts, THUMBNAIL_IMAGE_KEYS } from "./serverSettings"
import { ImageInfo, ImageType, inspectImage } from "../lib/imageInfo"

/** The largest image the app downloads (ThumbnailPolicy.MAX_BYTES in the app); a larger one is never shown. */
export const THUMBNAIL_MAX_BYTES = 512 * 1024
/** The app refuses images wider or taller than this (ServerArtwork in the app). */
export const THUMBNAIL_MAX_SIDE = 8192

const TYPES: readonly ImageType[] = ["image/png", "image/jpeg", "image/webp"]

export interface UploadedThumbnail extends ImageInfo {
    /** size in bytes */
    bytes: number
    /** a hash of the bytes, which names this version of the image in its URL */
    version: string
}

export type ThumbnailCheck = { ok: true, image: UploadedThumbnail } | { ok: false, reason: "too-large" | "not-an-image" | "too-many-pixels" }

/** Whether `data` can be the card image, and what it is. */
export function checkThumbnail(data: Buffer): ThumbnailCheck {
    if (data.length > THUMBNAIL_MAX_BYTES) return { ok: false, reason: "too-large" }
    const info = inspectImage(data)
    if (info === null) return { ok: false, reason: "not-an-image" }
    if (info.width > THUMBNAIL_MAX_SIDE || info.height > THUMBNAIL_MAX_SIDE) return { ok: false, reason: "too-many-pixels" }
    const version = createHash("sha256").update(data).digest("hex").slice(0, 16)
    return { ok: true, image: { ...info, bytes: data.length, version } }
}

/** The uploaded image's description, or null when none is uploaded. */
export function uploadedThumbnail(): UploadedThumbnail | null {
    const text = getStoredText(THUMBNAIL_IMAGE_KEYS.meta)
    if (text === null) return null
    try {
        const meta = JSON.parse(text) as Partial<UploadedThumbnail>
        if (!TYPES.includes(meta.type as ImageType) || typeof meta.version !== "string" || !/^[0-9a-f]{16}$/.test(meta.version)
            || !Number.isInteger(meta.width) || !Number.isInteger(meta.height) || !Number.isInteger(meta.bytes)) return null
        return meta as UploadedThumbnail
    } catch { return null }
}

/** The uploaded image and its bytes, or null. */
export function uploadedThumbnailData(): { image: UploadedThumbnail, data: Buffer } | null {
    const image = uploadedThumbnail()
    const encoded = getStoredText(THUMBNAIL_IMAGE_KEYS.data)
    if (image === null || encoded === null) return null
    const data = Buffer.from(encoded, "base64")
    return data.length === image.bytes ? { image, data } : null
}

/** Stores `data` as the card image after checking it, and clears the image URL setting. Nothing changes on a failed check. */
export function saveUploadedThumbnail(data: Buffer): ThumbnailCheck {
    const check = checkThumbnail(data)
    if (!check.ok) return check
    setStoredTexts([
        [THUMBNAIL_IMAGE_KEYS.meta, JSON.stringify(check.image)],
        [THUMBNAIL_IMAGE_KEYS.data, data.toString("base64")],
        ["server.thumbnail", null]
    ])
    return check
}

/** Removes the uploaded image; the image URL setting, if any, is used again. */
export function removeUploadedThumbnail(): void {
    setStoredTexts([[THUMBNAIL_IMAGE_KEYS.meta, null], [THUMBNAIL_IMAGE_KEYS.data, null]])
}

/**
 * The card image's URL for /shell/config: the uploaded image on `origin` (the address the app asked, so it works on a
 * LAN address as on a public one), else the image URL setting, else null.
 */
export function thumbnailUrl(origin: string | null): string | null {
    const image = uploadedThumbnail()
    if (image !== null && origin !== null) return `${origin}/shell/thumbnail?v=${image.version}`
    return getTextSetting("server.thumbnail") || null
}
