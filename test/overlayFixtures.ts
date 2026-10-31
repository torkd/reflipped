// Synthetic fixtures for the translation overlay tests (I18N-3): a mini CDN with two tables, a scenario and an
// image, translation files, and a zip reader. Made-up data only, never game data.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { inflateRawSync } from "zlib";
import { digestPath, masterAssetPath, readCentralDirectory } from "../src/lib/cdnIndex";
import { buildOrderedMap } from "../src/lib/orderedmap";
import { srcHash } from "../src/i18n/cells";
import { memberIn } from "../src/i18n/overlay";
import { writeZip } from "../src/lib/zipWriter";

export const UI_STRING = "string/ui_string"
export const CHARACTER_TEXT = "character/character_text"
export const SCENARIO = "story/test_quest/test_001/scenario"
export const IMAGE = "dynamic/home_banner/test_banner.png"
export const IMAGE_FOLDER = "medium_upload"

/** A tiny fake PNG: the game's lower-case magic, an IHDR with the size, and some bytes. */
export function fakePng(width: number, height: number, fill: number): Buffer {
    const header = Buffer.from([0x89, 0x70, 0x6e, 0x67, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdr = Buffer.alloc(25)
    ihdr.writeUInt32BE(13, 0)
    ihdr.write("IHDR", 4, "latin1")
    ihdr.writeUInt32BE(width, 8)
    ihdr.writeUInt32BE(height, 12)
    return Buffer.concat([header, ihdr, Buffer.alloc(64, fill)])
}

export function uiString(): Buffer {
    return buildOrderedMap([
        ["score_attack_title", [["score_attack_title", "スコアアタック", "スコアアタック", "", ""]]],
        ["score_attack_border", [["score_attack_border", "ボーダー::count::", "ボーダー::count::", "", ""]]],
        ["ok_button", [["ok_button", "OK", "OK", "", ""]]],
        ["unrelated", [["unrelated", "別", "Other", "", ""]]]
    ]).encode()
}

export function characterText(): Buffer {
    return buildOrderedMap([
        ["111001", [["Hibiki", "ヒビキ", "An old unit."]]],
        ["141171", [["夕陽野タイチ", "ユウヒノタイチ", "新しい説明"]]]
    ]).encode()
}

export function scenario(): Buffer {
    return buildOrderedMap([[SCENARIO, buildOrderedMap([
        ["1", [["22", "", "", "", "", ""]]],
        ["2", [["0", "", "", "", "speaker_a", "こんにちは\\nさようなら"]]]
    ])]]).encode()
}

export const ORIGINAL_IMAGE = fakePng(600, 420, 1)

export interface MiniCdn {
    cdnDir: string
    region: string
}

/** Writes `<dir>/en/archive-common-full/asset-2.1.0-1-…zip` (and a medium archive for the image). */
export function writeMiniCdn(cdnDir: string): MiniCdn {
    const region = path.join(cdnDir, "en")
    const common = path.join(region, "archive-common-full")
    const medium = path.join(region, "archive-medium-full")
    mkdirSync(common, { recursive: true })
    mkdirSync(medium, { recursive: true })
    writeFileSync(path.join(common, "asset-2.1.0-1-00000001.zip"), writeZip([
        { name: digestPath(masterAssetPath(UI_STRING)), data: uiString() },
        { name: digestPath(masterAssetPath(CHARACTER_TEXT)), data: characterText() },
        { name: digestPath(masterAssetPath(SCENARIO)), data: scenario() },
        { name: digestPath("master/other/untouched.orderedmap"), data: buildOrderedMap([["1", [["x"]]]]).encode() }
    ]))
    writeFileSync(path.join(medium, "asset-2.1.0-1-00000002.zip"), writeZip([
        { name: memberIn(IMAGE, IMAGE_FOLDER), data: ORIGINAL_IMAGE }
    ]))
    return { cdnDir, region }
}

export const COLUMNS = {
    version: 1,
    tables: {
        [UI_STRING]: { translate: [2], reading: [] },
        [CHARACTER_TEXT]: { translate: [0, 2], reading: [1] }
    }
}

export function entry(source: string, text: string, status = "reviewed") {
    return { srcHash: srcHash(source), text, status, note: "" }
}

/** The standard translation set: two ui_string rows, a late unit's name and description, a scenario line. */
export function translationSet(): Record<string, unknown> {
    return {
        "master/string__ui_string.json": {
            score_attack_title: { "2": entry("スコアアタック", "Score Attack") },
            score_attack_border: { "2": entry("ボーダー::count::", "Border ::count::", "machine") }
        },
        "master/character__character_text.json": {
            "141171": { "0": entry("夕陽野タイチ", "Taichi Yuhino"), "2": entry("新しい説明", "A new description.", "official") }
        },
        "story/test_quest/test_001/scenario.json": {
            "2": { "5": entry("こんにちは\\nさようなら", "Hello.\nGoodbye.") }
        }
    }
}

/** Writes translation files under `<i18nDir>/<lang>/` and the column map at `<i18nDir>/columns.json`. */
export function writeTranslations(i18nDir: string, files: Record<string, unknown>, lang = "en") {
    mkdirSync(i18nDir, { recursive: true })
    writeFileSync(path.join(i18nDir, "columns.json"), JSON.stringify(COLUMNS))
    for (const [file, content] of Object.entries(files)) {
        const full = path.join(i18nDir, lang, file)
        mkdirSync(path.dirname(full), { recursive: true })
        writeFileSync(full, JSON.stringify(content, null, 1))
    }
}

/** Every member of a zip, by name. */
export function readZip(file: string): Map<string, Buffer> {
    const data = readFileSync(file)
    const out = new Map<string, Buffer>()
    for (const m of readCentralDirectory(file)) {
        const start = m.localHeaderOffset + 30 + data.readUInt16LE(m.localHeaderOffset + 26) + data.readUInt16LE(m.localHeaderOffset + 28)
        const body = data.subarray(start, start + m.compressedSize)
        out.set(m.name, m.method === 8 ? inflateRawSync(body) : Buffer.from(body))
    }
    return out
}
