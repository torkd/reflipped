import type { Database, Statement } from "./sqlite";

/**
 * Reuse compiled SQL on one connection. Dynamic update/import shapes share the same bounded LRU as fixed queries.
 * Only use for statements executed directly: changing a statement's binding/row modes would affect later callers.
 */
export function createStatementCache(db: Pick<Database, "prepare">, limit = 512): (sql: string) => Statement {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Statement cache limit must be a positive integer")
    const statements = new Map<string, Statement>()
    return sql => {
        let statement = statements.get(sql)
        if (statement !== undefined) {
            statements.delete(sql)
        } else {
            statement = db.prepare(sql)
            if (statements.size >= limit) statements.delete(statements.keys().next().value!)
        }
        statements.set(sql, statement)
        return statement
    }
}
