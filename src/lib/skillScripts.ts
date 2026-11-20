/**
 * Skill battle scripts as they were before a balance change (FT-74). A skill's behaviour is its battle script
 * (`skill/action_skill` column 7 names it; the file is `<path>.action.dsl.amf3.deflate`), which the CDN has only in
 * its final version. A change that altered a skill carries a patch: the script it starts from (pinned by the SHA-256
 * of its inflated bytes), the path of the script it makes, and edits to the decoded tree. While the change is pending,
 * the schedule overlay ships the made script and the change's cells point the skill's row at it; the CDN's script is
 * never shadowed, so a device that leaves the period reads the final one again.
 *
 * The tree is the client's ActionDsl (Haxe enums as arrays: `["Command", ["CreateHitArea", …]]`). An edit's `at` is a
 * path of array indices and object keys from the root; `set` replaces the node, `wrap` puts it inside a new one (the
 * string `"$node"` stands for it), `delete` removes an array item. Values are JSON: a whole number is written as an
 * AMF3 integer, any other number as a double, `{"$double": n}` as a double holding a whole number, and any other
 * object as the scripts' anonymous dynamic object (`{"min": 600, "max": 600}`).
 */
import { createHash } from "crypto";
import { deflateRawSync, inflateRawSync } from "zlib";
import { Amf3Double, Amf3Object, Amf3Value, decodeAmf3, encodeAmf3 } from "./amf3";

export const SCRIPT_SUFFIX = ".action.dsl.amf3.deflate"

export type ScriptEdit =
    | { at: (number | string)[], set: unknown }
    | { at: (number | string)[], wrap: unknown }
    | { at: (number | string)[], delete: true }

export interface ScriptPatch {
    /** the script it starts from (an `action_skill` column-7 path) and the SHA-256 of its inflated file */
    source: string
    sha256: string
    /** the path of the script it makes; a cell of the same change points the skill's row at it */
    target: string
    edits: ScriptEdit[]
    /** what the edits restore and on what evidence (not read by the server) */
    why?: string
}

/** The asset path of a script named in `skill/action_skill` column 7. */
export function scriptAssetPath(path: string): string {
    return path + SCRIPT_SUFFIX
}

function fromJson(value: unknown, node?: Amf3Value): Amf3Value {
    if (value === "$node" && node !== undefined) return node
    if (value === null || typeof value === "boolean" || typeof value === "string") return value
    if (typeof value === "number") return Number.isInteger(value) ? value : new Amf3Double(value)
    if (Array.isArray(value)) return value.map(item => fromJson(item, node))
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
        if (entries.length === 1 && entries[0][0] === "$double" && typeof entries[0][1] === "number") return new Amf3Double(entries[0][1])
        return new Amf3Object({ className: "", dynamic: true, sealed: [] }, new Map(entries.map(([k, v]) => [k, fromJson(v, node)])))
    }
    throw new Error(`Skill script patch: unsupported value ${JSON.stringify(value)}`)
}

function step(parent: Amf3Value, key: number | string): { get: () => Amf3Value, put: (v: Amf3Value) => void, remove: () => void } {
    const noRemove = () => { throw new Error("Skill script patch: only an array item can be deleted") }
    if (Array.isArray(parent) && typeof key === "number" && key >= 0 && key < parent.length)
        return { get: () => parent[key], put: v => { parent[key] = v }, remove: () => { parent.splice(key, 1) } }
    if (parent instanceof Amf3Object && typeof key === "string" && parent.values.has(key))
        return { get: () => parent.values.get(key), put: v => { parent.values.set(key, v) }, remove: noRemove }
    throw new Error(`Skill script patch: no ${JSON.stringify(key)} in the tree`)
}

function locate(root: Amf3Value, at: (number | string)[]) {
    if (at.length === 0) throw new Error("Skill script patch: an edit needs a path")
    let node = root
    for (const key of at.slice(0, -1)) node = step(node, key).get()
    return step(node, at[at.length - 1])
}

/**
 * The script a patch makes, deflated like the CDN's, from the deflated source file. Throws if the source isn't the
 * pinned one or an edit's path doesn't exist, so a build never ships a half-patched skill.
 */
export function buildPatchedScript(sourceFile: Buffer, patch: ScriptPatch): Buffer {
    const raw = inflateRawSync(sourceFile)
    const digest = createHash("sha256").update(raw).digest("hex")
    if (digest !== patch.sha256) throw new Error(`Skill script ${patch.source}: the CDN's copy is not the one the patch was made for`)
    const tree = decodeAmf3(raw)
    for (const edit of patch.edits) {
        const slot = locate(tree, edit.at)
        if ("set" in edit) slot.put(fromJson(edit.set))
        else if ("wrap" in edit) slot.put(fromJson(edit.wrap, slot.get()))
        else slot.remove()
    }
    return deflateRawSync(encodeAmf3(tree))
}
