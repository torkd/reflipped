// Request body schemas (SEC-6, docs/hardening.md "Input and abuse").
//
// Every route that reads a body or query declares a JSON schema, and Fastify (ajv) rejects a request that doesn't
// match with a 400 (`code: "FST_ERR_VALIDATION"`) before any hook or handler runs. The schemas check the types of
// the fields a handler reads and require only fields the client always sends (the captures in docs/routes/*.md),
// and they allow extra properties, so a field the client adds doesn't break the game. test/validation.test.ts
// runs every captured request through its route.
//
// Fastify's ajv coerces scalars (`"5"` → 5), so a field typed `integer` here is a number in the handler.

/** JSON-schema fragment; kept loose because the schemas are plain data. */
export type Schema = Record<string, unknown>

export const integer = { type: "integer" } as const
export const number = { type: "number" } as const
export const string = { type: "string" } as const
/** A name a player types (shown to others: rankings, co-op): the game allows far shorter ones (SEC-12). */
export const playerText = { type: "string", maxLength: 32 } as const
export const boolean = { type: "boolean" } as const
/** Any JSON value; for fields a handler stores or passes on without reading. */
export const any = {} as const

/** A string the client may send as a number (or the other way round), such as co-op room numbers. */
export const stringOrInteger = { type: ["string", "integer"] } as const

/**
 * Also accepts null. A plain `type` gets `"null"` added to its list, so ajv keeps a null as null; inside an `anyOf`
 * it would coerce it to 0 or "" for the first branch.
 */
export function nullable(schema: Schema): Schema {
    const type = schema.type
    if (typeof type === "string") return { ...schema, type: [type, "null"] }
    if (Array.isArray(type)) return { ...schema, type: [...type, "null"] }
    return { anyOf: [schema, { type: "null" }] }
}

export function arrayOf(items: Schema, maxItems = 1000): Schema {
    return { type: "array", items, maxItems }
}

/** An object with these typed properties, of which `required` must be present; other properties are allowed. */
export function object(properties: Record<string, Schema>, required: string[] = []): Schema {
    return { type: "object", properties, required }
}

/** An object whose keys are free (ids) and whose values match `values`. */
export function recordOf(values: Schema, limits: { maxKeys?: number, maxKeyLength?: number } = {}): Schema {
    return {
        type: "object", additionalProperties: values,
        ...(limits.maxKeys === undefined ? {} : { maxProperties: limits.maxKeys }),
        ...(limits.maxKeyLength === undefined ? {} : { propertyNames: { maxLength: limits.maxKeyLength } })
    }
}

/**
 * The `schema` option of a game API route: a body with `viewer_id` (which `src/lib/gameAuth.ts` reads) plus these
 * properties.
 */
export function gameBody(properties: Record<string, Schema> = {}, required: string[] = []): { body: Schema } {
    return { body: object({ viewer_id: integer, ...properties }, ["viewer_id", ...required]) }
}

/** The `schema` option of a route with a JSON body (openapi, admin API). */
export function jsonBody(properties: Record<string, Schema> = {}, required: string[] = []): { body: Schema } {
    return { body: object(properties, required) }
}

/**
 * The `schema` option of a POST route whose handler never reads the body (openapi stubs). Accepts anything, but
 * marks the route as checked: test/validation.test.ts fails on a POST route with no body schema.
 */
export const ignoredBody: { body: Schema } = { body: {} }

/** The `schema` option of a route that reads only its query string. */
export function query(properties: Record<string, Schema> = {}, required: string[] = []): { querystring: Schema } {
    return { querystring: object(properties, required) }
}
