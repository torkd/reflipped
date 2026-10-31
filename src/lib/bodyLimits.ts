// Size limits for request bodies (SEC-6, docs/hardening.md "Input and abuse").
//
// Fastify's `bodyLimit` caps the raw body (for the game API that is the base64 text), and the msgpack parser in
// src/app.ts checks the decoded value with `checkDecodedBody` before any schema or handler sees it. The largest
// captured game request (docs/routes/*.md) is a few KB with a depth of 5, so the defaults leave a wide margin.

/** Raw body limit of the game server, in bytes. */
export const GAME_BODY_LIMIT = 1024 * 1024
/** Raw body limit of the admin server, in bytes. The save import is multipart, which has its own limits (src/routes/web_api/index.ts). */
export const ADMIN_BODY_LIMIT = 1024 * 1024

/** Deepest nesting of arrays and objects a decoded body may have. */
export const MAX_BODY_DEPTH = 32
/** Most values (scalars, arrays, objects) a decoded body may hold. */
export const MAX_BODY_NODES = 100_000

/**
 * Walks a decoded body without recursion and returns why it is too deep or too large, or null if it is fine.
 */
export function checkDecodedBody(value: unknown, maxDepth = MAX_BODY_DEPTH, maxNodes = MAX_BODY_NODES): string | null {
    const stack: [unknown, number][] = [[value, 0]]
    let nodes = 0
    while (stack.length > 0) {
        const [current, depth] = stack.pop()!
        if (++nodes > maxNodes) return `body has more than ${maxNodes} values`
        if (current === null || typeof current !== "object" || ArrayBuffer.isView(current)) continue
        if (depth >= maxDepth) return `body is nested deeper than ${maxDepth} levels`
        const children = Array.isArray(current) ? current
            : current instanceof Map ? [...current.keys(), ...current.values()]
            : current instanceof Set ? [...current]
            : Object.values(current)
        for (const child of children) stack.push([child, depth + 1])
    }
    return null
}
