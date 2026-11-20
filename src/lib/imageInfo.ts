// The type and size of an uploaded image, read from its header. Used for the server card image (src/data/serverThumbnail.ts):
// only PNG, JPEG and WebP are accepted, the formats Android decodes. SVG is never accepted, since it can carry scripts.

export type ImageType = "image/png" | "image/jpeg" | "image/webp"

export interface ImageInfo {
    type: ImageType
    width: number
    height: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The image's type and pixel size, or null when the data isn't a PNG, JPEG or WebP image this can read. */
export function inspectImage(data: Buffer): ImageInfo | null {
    const info = png(data) ?? jpeg(data) ?? webp(data)
    return info !== null && info.width > 0 && info.height > 0 ? info : null
}

function png(data: Buffer): ImageInfo | null {
    // signature, then the IHDR chunk: length, "IHDR", width, height
    if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString("latin1", 12, 16) !== "IHDR") return null
    return { type: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}

/** Start-of-frame markers (baseline, progressive, lossless, arithmetic); C4, C8 and CC are other tables. */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpeg(data: Buffer): ImageInfo | null {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
    let at = 2
    while (at + 4 <= data.length) {
        if (data[at] !== 0xff) return null
        const marker = data[at + 1]
        if (marker === 0xff) { at++; continue } // fill byte
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue } // markers without a length
        if (marker === 0xd9 || marker === 0xda) return null // end of image or scan data before any frame header
        const length = data.readUInt16BE(at + 2)
        if (length < 2) return null
        if (JPEG_FRAMES.has(marker)) {
            if (at + 9 > data.length) return null
            return { type: "image/jpeg", height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) }
        }
        at += 2 + length
    }
    return null
}

function webp(data: Buffer): ImageInfo | null {
    if (data.length < 30 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WEBP") return null
    const chunk = data.toString("latin1", 12, 16)
    if (chunk === "VP8 ") {
        // lossy: a frame tag, the start code 9d 01 2a, then 14-bit width and height
        if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null
        return { type: "image/webp", width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === "VP8L") {
        // lossless: the signature 2f, then width - 1 and height - 1 in 14 bits each
        if (data[20] !== 0x2f) return null
        const bits = data.readUInt32LE(21)
        return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (chunk === "VP8X") {
        // extended (alpha, animation): canvas width - 1 and height - 1 in 24 bits each
        return { type: "image/webp", width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 }
    }
    return null
}
