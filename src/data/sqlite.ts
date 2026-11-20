// SQLite access for every Reflipped server: Node's built-in `node:sqlite` behind the part of the
// better-sqlite3 API this code base uses (SH-13, docs/on-device-server.md "Server changes").
//
// The server ran on better-sqlite3 until Node 24 became the minimum. A native npm module can't be loaded
// where the server runs inside the Android app, so every server now uses the built-in module and keeps one
// code path. This adapter keeps better-sqlite3's behaviour where `node:sqlite` differs, because the callers
// (about 400 statements) were written against it:
// - rows are plain objects with fast properties (`node:sqlite` gives null-prototype dictionary objects), and
//   BLOBs are Buffers;
// - integers beyond 2^53 are read as the nearest number, not thrown as a RangeError;
// - parameters: arrays are spread, the named-parameter object may come last, `undefined` binds NULL, a
//   boolean or other object is refused, and too few, too many or missing values throw instead of binding
//   NULL;
// - `run()` reports `changes: 0` for a statement that isn't a write, not the previous write's count;
// - errors carry better-sqlite3's `code` (`SQLITE_CONSTRAINT_UNIQUE`, …);
// - `get()`/`all()` refuse a statement without result columns, and `prepare()` a second statement in the text;
// - `transaction(fn)` with `.deferred`/`.immediate`/`.exclusive`, nested calls as savepoints, and `pragma()`.
// Don't use `node:sqlite` directly elsewhere: go through this module.

import { existsSync } from "fs"

// Older releases lack the `node:sqlite` options used below and `crypto.argon2` (src/lib/password.ts): say so at
// start-up, rather than fail at the first query or login.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number)
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 7))
    throw new Error(`Reflipped needs Node.js 24.7 or newer; this is ${process.version}`)

type NodeSqlite = typeof import("node:sqlite")
type NodeDatabase = import("node:sqlite").DatabaseSync
type NodeStatement = import("node:sqlite").StatementSync

/**
 * Loads `node:sqlite` without its one "SQLite is an experimental feature" warning, which Node 24 prints
 * before 24.15. Only that warning is dropped, and only while the module loads.
 */
function loadNodeSqlite(): NodeSqlite {
    const emitWarning = process.emitWarning
    process.emitWarning = function (warning: unknown, ...rest: unknown[]) {
        const first = rest[0] as string | { type?: string } | undefined
        const type = typeof first === "string" ? first : first?.type ?? (warning as Error)?.name
        const text = typeof warning === "string" ? warning : (warning as Error)?.message
        if (type === "ExperimentalWarning" && typeof text === "string" && text.includes("SQLite")) return
        return Reflect.apply(emitWarning, process, [warning, ...rest])
    } as typeof process.emitWarning
    try {
        return require("node:sqlite")
    } finally {
        process.emitWarning = emitWarning
    }
}

const { DatabaseSync } = loadNodeSqlite()

// ---------------------------------------------------------------------------------------------- errors

/** SQLite result codes by number, as better-sqlite3 names them in `error.code`. */
const PRIMARY_CODES = ["SQLITE_OK", "SQLITE_ERROR", "SQLITE_INTERNAL", "SQLITE_PERM", "SQLITE_ABORT", "SQLITE_BUSY",
    "SQLITE_LOCKED", "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_INTERRUPT", "SQLITE_IOERR", "SQLITE_CORRUPT",
    "SQLITE_NOTFOUND", "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "SQLITE_EMPTY", "SQLITE_SCHEMA",
    "SQLITE_TOOBIG", "SQLITE_CONSTRAINT", "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_NOLFS", "SQLITE_AUTH",
    "SQLITE_FORMAT", "SQLITE_RANGE", "SQLITE_NOTADB", "SQLITE_NOTICE", "SQLITE_WARNING"]
/** Extended codes: the primary code in the low byte, the names in order of the high byte, starting at 1. */
const EXTENDED_CODES: Record<number, string[]> = {
    1: ["MISSING_COLLSEQ", "RETRY", "SNAPSHOT"],
    5: ["RECOVERY", "SNAPSHOT", "TIMEOUT"],
    6: ["SHAREDCACHE", "VTAB"],
    8: ["RECOVERY", "CANTLOCK", "ROLLBACK", "DBMOVED", "CANTINIT", "DIRECTORY"],
    4: ["", "ROLLBACK"],
    10: ["READ", "SHORT_READ", "WRITE", "FSYNC", "DIR_FSYNC", "TRUNCATE", "FSTAT", "UNLOCK", "RDLOCK", "DELETE",
        "BLOCKED", "NOMEM", "ACCESS", "CHECKRESERVEDLOCK", "LOCK", "CLOSE", "DIR_CLOSE", "SHMOPEN", "SHMSIZE",
        "SHMLOCK", "SHMMAP", "SEEK", "DELETE_NOENT", "MMAP", "GETTEMPPATH", "CONVPATH", "VNODE", "AUTH",
        "BEGIN_ATOMIC", "COMMIT_ATOMIC", "ROLLBACK_ATOMIC", "DATA", "CORRUPTFS"],
    11: ["VTAB", "SEQUENCE", "INDEX"],
    14: ["NOTEMPDIR", "ISDIR", "FULLPATH", "CONVPATH", "DIRTYWAL", "SYMLINK"],
    19: ["CHECK", "COMMITHOOK", "FOREIGNKEY", "FUNCTION", "NOTNULL", "PRIMARYKEY", "TRIGGER", "UNIQUE", "VTAB",
        "ROWID", "PINNED", "DATATYPE"],
    23: ["USER"],
}

function codeName(errcode: number): string {
    const primary = PRIMARY_CODES[errcode & 0xff]
    if (primary === undefined) return "SQLITE_ERROR"
    const extended = EXTENDED_CODES[errcode & 0xff]?.[(errcode >> 8) - 1]
    return extended ? `${primary}_${extended}` : primary
}

/** Rethrows a `node:sqlite` error with better-sqlite3's `code`; any other error unchanged. */
function rethrow(error: unknown): never {
    const sqliteError = error as { code?: string; errcode?: number } | null
    if (sqliteError && sqliteError.code === "ERR_SQLITE_ERROR" && typeof sqliteError.errcode === "number")
        sqliteError.code = codeName(sqliteError.errcode)
    throw error
}

// ------------------------------------------------------------------------------------------ SQL shape

interface SqlShape {
    /** how many `?` the statement has */
    anonymous: number
    /** its named parameters without prefix, each once */
    named: string[]
    /** false when it uses `?NNN` or a `$name::suffix`, which the counts above don't describe */
    checked: boolean
    /** INSERT, UPDATE, DELETE, REPLACE or WITH: `run()` reports its change count */
    write: boolean
    /** CREATE, ALTER or DROP: result columns of prepared statements may change */
    schema: boolean
}

const WRITE_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE", "WITH"])
const SCHEMA_KEYWORDS = new Set(["CREATE", "ALTER", "DROP"])

function isWordStart(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128
}

function isWordChar(c: number): boolean {
    return isWordStart(c) || (c >= 48 && c <= 57)
}

/**
 * Reads what the adapter must know about one statement from its text, following SQLite's tokenizer for
 * strings, quoted names and comments. `node:sqlite` exposes neither the parameter count nor whether a
 * statement writes; better-sqlite3 got both from SQLite.
 */
export function sqlShape(sql: string): SqlShape {
    const length = sql.length
    const named: string[] = []
    let anonymous = 0
    let checked = true
    let first: string | null = null
    let ended = false
    let i = 0
    while (i < length) {
        const c = sql.charCodeAt(i)
        if (c === 32 || (c >= 9 && c <= 13)) { i++; continue }
        if (c === 45 && sql.charCodeAt(i + 1) === 45) { // -- comment
            const end = sql.indexOf("\n", i)
            i = end < 0 ? length : end + 1
            continue
        }
        if (c === 47 && sql.charCodeAt(i + 1) === 42) { // /* comment */
            const end = sql.indexOf("*/", i + 2)
            i = end < 0 ? length : end + 2
            continue
        }
        // A trigger body holds statements of its own, so only other statements are checked for a second one.
        if (ended && first !== "CREATE") throw new RangeError("The supplied SQL string contains more than one statement")
        if (first === null) first = ""
        if (c === 59) { ended = true; i++; continue } // ;
        if (c === 39 || c === 34 || c === 96) { // 'string', "name", `name`: the quote is doubled to escape it
            i++
            while (i < length) {
                if (sql.charCodeAt(i) !== c) { i++; continue }
                if (sql.charCodeAt(i + 1) !== c) break
                i += 2
            }
            i++
            continue
        }
        if (c === 91) { // [name]
            const end = sql.indexOf("]", i)
            i = end < 0 ? length : end + 1
            continue
        }
        if (c === 63) { // ? or ?NNN
            i++
            const digit = sql.charCodeAt(i)
            if (digit >= 48 && digit <= 57) checked = false
            else anonymous++
            continue
        }
        if (c === 58 || c === 64 || c === 36) { // :name, @name, $name
            let end = i + 1
            while (end < length && isWordChar(sql.charCodeAt(end))) end++
            if (end > i + 1) {
                const name = sql.slice(i + 1, end)
                if (!named.includes(name)) named.push(name)
                const next = sql.charCodeAt(end)
                if (c === 36 && (next === 58 || next === 40)) checked = false
            }
            i = end
            continue
        }
        if (isWordChar(c)) { // keyword, name or number; `$` may continue a name
            let end = i + 1
            while (end < length && (isWordChar(sql.charCodeAt(end)) || sql.charCodeAt(end) === 36)) end++
            if (first === "") first = isWordStart(c) ? sql.slice(i, end).toUpperCase() : "?"
            i = end
            continue
        }
        if (first === "") first = "?"
        i++
    }
    if (first === null) throw new RangeError("The supplied SQL string contains no statements")
    return { anonymous, named, checked, write: WRITE_KEYWORDS.has(first), schema: SCHEMA_KEYWORDS.has(first) }
}

// ------------------------------------------------------------------------------------------ statements

export interface RunResult {
    /** rows the statement inserted, updated or deleted; 0 for a statement that doesn't write */
    changes: number
    lastInsertRowid: number
}

const BIND_TYPE_ERROR = "SQLite3 can only bind numbers, strings, bigints, buffers, and null"

function isNamedParameters(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function bindValue(value: unknown): unknown {
    switch (typeof value) {
        case "number":
        case "string":
        case "bigint":
            return value
        case "undefined":
            return null
        case "object":
            if (value === null || ArrayBuffer.isView(value)) return value
    }
    throw new TypeError(BIND_TYPE_ERROR)
}

/** What a result value is in better-sqlite3: integers as numbers, BLOBs as Buffers. */
function rowValue(value: unknown): unknown {
    if (typeof value === "bigint") return Number(value)
    if (typeof value === "object" && value !== null) {
        const bytes = value as Uint8Array
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
    return value
}

type BindArguments<BindParameters> = BindParameters extends unknown[] ? BindParameters : [BindParameters]

/** A prepared statement. Keep it and run it again: `createStatementCache` (statementCache.ts) does that by SQL text. */
export class Statement<BindParameters extends unknown[] | {} = unknown[], Result = unknown> {
    /** the statement's SQL text */
    readonly source: string
    private readonly db: Database
    private readonly statement: NodeStatement
    private readonly shape: SqlShape
    private columns: string[] | null = null
    private reader: boolean | undefined
    private columnsEpoch = -1

    /** @internal Use `Database.prepare()`. */
    constructor(db: Database, statement: NodeStatement, source: string, shape: SqlShape) {
        this.db = db
        this.statement = statement
        this.source = source
        this.shape = shape
    }

    /** Runs the statement and returns how many rows it changed and the last inserted rowid. */
    run(...params: BindArguments<BindParameters>): RunResult {
        this.db.requireOpen()
        const args = this.bind(params)
        let result: { changes: number | bigint; lastInsertRowid: number | bigint }
        try {
            result = this.statement.run(...args)
        } catch (error) {
            rethrow(error)
        }
        if (this.shape.schema) this.db.schemaChanged()
        return {
            changes: this.shape.write ? Number(result.changes) : 0,
            lastInsertRowid: Number(result.lastInsertRowid),
        }
    }

    /** The first row, or `undefined` when there is none. */
    get(...params: BindArguments<BindParameters>): Result | undefined {
        this.db.requireOpen()
        this.requireReader()
        const args = this.bind(params)
        let row: unknown[] | undefined
        try {
            row = this.statement.get(...args) as unknown as unknown[] | undefined
        } catch (error) {
            rethrow(error)
        }
        return row === undefined ? undefined : this.row(row)
    }

    /** Every row. */
    all(...params: BindArguments<BindParameters>): Result[] {
        this.db.requireOpen()
        this.requireReader()
        const args = this.bind(params)
        let rows: unknown[]
        try {
            rows = this.statement.all(...args)
        } catch (error) {
            rethrow(error)
        }
        for (let i = 0; i < rows.length; i++) rows[i] = this.row(rows[i] as unknown[])
        return rows as Result[]
    }

    /** The rows one at a time. The statement stays busy until the iterator is finished or closed. */
    *iterate(...params: BindArguments<BindParameters>): IterableIterator<Result> {
        this.db.requireOpen()
        this.requireReader()
        const args = this.bind(params)
        try {
            for (const row of this.statement.iterate(...args)) yield this.row(row as unknown as unknown[])
        } catch (error) {
            rethrow(error)
        }
    }

    /** @internal For `Database.pragma()`: a pragma that sets a value has no result columns and returns no rows. */
    withoutReaderCheck(): this {
        this.reader = true
        return this
    }

    /** Refuses `get()`/`all()` on a statement without result columns before it runs, as better-sqlite3 does. */
    private requireReader(): void {
        if (this.reader === undefined) this.reader = this.statement.columns().length > 0
        if (!this.reader) throw new TypeError("This statement does not return data. Use run() instead")
    }

    /** `node:sqlite`'s argument list (the named-parameter object first) from better-sqlite3's. */
    private bind(params: unknown[]): any[] {
        const shape = this.shape
        const values: unknown[] = []
        let named: Record<string, unknown> | undefined
        for (let i = 0; i < params.length; i++) {
            const param = params[i]
            if (Array.isArray(param)) {
                for (let j = 0; j < param.length; j++) values.push(bindValue(param[j]))
            } else if (isNamedParameters(param)) {
                if (named !== undefined) throw new TypeError("You cannot specify named parameters in two different objects")
                named = param
            } else {
                values.push(bindValue(param))
            }
        }
        if (!shape.checked) {
            if (named === undefined) return values
            const copy: Record<string, unknown> = {}
            for (const key of Object.keys(named)) copy[key] = bindValue(named[key])
            values.unshift(copy)
            return values
        }
        if (values.length < shape.anonymous) throw new RangeError("Too few parameter values were provided")
        if (values.length > shape.anonymous) throw new RangeError("Too many parameter values were provided")
        if (shape.named.length === 0) return values
        if (named === undefined) throw new TypeError("Missing named parameters")
        const bound: Record<string, unknown> = {}
        for (const name of shape.named) {
            if (!(name in named)) throw new RangeError(`Missing named parameter "${name}"`)
            bound[name] = bindValue(named[name])
        }
        values.unshift(bound)
        return values
    }

    /** A plain object from the array `node:sqlite` returned, with the statement's column names. */
    private row(values: unknown[]): Result {
        let columns = this.columns
        // A prepared `SELECT *` follows the table: read the names again after a schema change on this
        // connection, or when the row's width shows one made elsewhere.
        if (columns === null || columns.length !== values.length || this.columnsEpoch !== this.db.schemaEpoch) {
            columns = this.columns = this.statement.columns().map(column => column.name)
            // assigning this name would set the row's prototype instead of a property
            if (columns.includes("__proto__")) throw new TypeError("A result column can't be named __proto__")
            this.columnsEpoch = this.db.schemaEpoch
        }
        const row: Record<string, unknown> = {}
        for (let i = 0; i < columns.length; i++) {
            const value = values[i]
            // integers arrive as bigint and BLOBs as Uint8Array (see rowValue); everything else is kept
            row[columns[i]] = typeof value === "bigint" ? Number(value)
                : typeof value === "object" && value !== null ? rowValue(value) : value
        }
        return row as Result
    }
}

// -------------------------------------------------------------------------------------------- database

export interface DatabaseOptions {
    /** open read-only; the file must exist */
    readonly?: boolean
    /** fail instead of creating the file */
    fileMustExist?: boolean
    /** how long a statement waits for another connection's lock, in ms (default 5000) */
    timeout?: number
}

export interface PragmaOptions {
    /** return the first column of the first row instead of every row */
    simple?: boolean
}

export interface Transaction<F extends (...args: any[]) => unknown> {
    (...args: Parameters<F>): ReturnType<F>
    /** BEGIN: the lock is taken at the first read or write */
    default(...args: Parameters<F>): ReturnType<F>
    deferred(...args: Parameters<F>): ReturnType<F>
    /** BEGIN IMMEDIATE: the write lock is taken at once */
    immediate(...args: Parameters<F>): ReturnType<F>
    exclusive(...args: Parameters<F>): ReturnType<F>
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i
// better-sqlite3's savepoint name, kept so a trace reads the same
const SAVEPOINT = "`\t_bs3.\t`"

export class Database {
    /** the path the database was opened with */
    readonly name: string
    /** Counts schema changes made through this connection; statements re-read their column names after one. */
    schemaEpoch = 0
    private readonly db: NodeDatabase
    private readonly control = new Map<string, NodeStatement>()

    constructor(filename: string, options: DatabaseOptions = {}) {
        if (options.fileMustExist && filename !== ":memory:" && !existsSync(filename))
            throw new TypeError(`Cannot open database because the file does not exist: ${filename}`)
        this.name = filename
        try {
            this.db = new DatabaseSync(filename, {
                readOnly: options.readonly === true,
                // better-sqlite3's defaults, stated because `node:sqlite`'s differ or changed between releases
                timeout: options.timeout ?? 5000,
                enableForeignKeyConstraints: true,
                enableDoubleQuotedStringLiterals: false,
                defensive: false,
                // read as arrays of exact integers; `Statement` turns them into better-sqlite3's rows
                readBigInts: true,
                returnArrays: true,
            } as ConstructorParameters<typeof DatabaseSync>[1])
        } catch (error) {
            rethrow(error)
        }
    }

    /** Whether the connection is open. */
    get open(): boolean {
        return this.db.isOpen
    }

    /** Whether a transaction is open on this connection. */
    get inTransaction(): boolean {
        return this.db.isOpen && this.db.isTransaction
    }

    /** Compiles one statement. Throws on a second statement in the text. */
    prepare<BindParameters extends unknown[] | {} = unknown[], Result = unknown>(
        source: string
    ): BindParameters extends unknown[] ? Statement<BindParameters, Result> : Statement<[BindParameters], Result> {
        if (typeof source !== "string") throw new TypeError("Expected first argument to be a string")
        this.requireOpen()
        const shape = sqlShape(source)
        let statement: NodeStatement
        try {
            statement = this.db.prepare(source)
        } catch (error) {
            rethrow(error)
        }
        return new Statement(this, statement, source, shape) as any
    }

    /** Runs every statement in the text, without parameters or results. */
    exec(source: string): this {
        this.requireOpen()
        try {
            this.db.exec(source)
        } catch (error) {
            rethrow(error)
        } finally {
            if (!TRANSACTION_CONTROL.test(source)) this.schemaEpoch++
        }
        return this
    }

    /** Runs `PRAGMA <source>` and returns its rows, or with `simple` the first column of the first row. */
    pragma(source: string, options: PragmaOptions = {}): unknown {
        if (typeof source !== "string") throw new TypeError("Expected first argument to be a string")
        const statement = this.prepare<[], Record<string, unknown>>(`PRAGMA ${source}`).withoutReaderCheck()
        if (!options.simple) return statement.all()
        const row = statement.get()
        if (row === undefined) return undefined
        for (const key in row) return row[key]
        return undefined
    }

    /**
     * Wraps `fn` so that a call runs in one transaction: committed when it returns, rolled back when it throws
     * (the error is rethrown). Called while a transaction is open, it is a savepoint instead, so its rollback
     * undoes only its own writes. `fn` must be synchronous. As in better-sqlite3.
     */
    transaction<F extends (...args: any[]) => unknown>(fn: F): Transaction<F> {
        if (typeof fn !== "function") throw new TypeError("Expected first argument to be a function")
        const database = this
        const wrap = (begin: string) => function (this: unknown, ...args: unknown[]): unknown {
            database.requireOpen()
            const nested = database.inTransaction
            database.runControl(nested ? `SAVEPOINT ${SAVEPOINT}` : begin)
            try {
                const result = fn.apply(this, args)
                if (result && typeof (result as { then?: unknown }).then === "function")
                    throw new TypeError("Transaction function cannot return a promise")
                database.runControl(nested ? `RELEASE ${SAVEPOINT}` : "COMMIT")
                return result
            } catch (error) {
                // SQLite may already have ended the transaction itself (a failed COMMIT doesn't, a full disk can)
                if (database.inTransaction) {
                    if (nested) {
                        database.runControl(`ROLLBACK TO ${SAVEPOINT}`)
                        database.runControl(`RELEASE ${SAVEPOINT}`)
                    } else {
                        database.runControl("ROLLBACK")
                    }
                }
                throw error
            }
        }
        const transaction = wrap("BEGIN") as unknown as Transaction<F>
        transaction.default = transaction
        transaction.deferred = wrap("BEGIN DEFERRED") as unknown as Transaction<F>
        transaction.immediate = wrap("BEGIN IMMEDIATE") as unknown as Transaction<F>
        transaction.exclusive = wrap("BEGIN EXCLUSIVE") as unknown as Transaction<F>
        return transaction
    }

    /** Closes the connection. Closing twice is fine. */
    close(): this {
        this.control.clear()
        if (this.db.isOpen) this.db.close()
        return this
    }

    /** @internal Using a closed connection is a TypeError with better-sqlite3's text, whatever was called. */
    requireOpen(): void {
        if (!this.db.isOpen) throw new TypeError("The database connection is not open")
    }

    /** @internal Called by a statement that changed the schema. */
    schemaChanged(): void {
        this.schemaEpoch++
    }

    private runControl(sql: string): void {
        let statement = this.control.get(sql)
        try {
            if (statement === undefined) this.control.set(sql, statement = this.db.prepare(sql))
            statement.run()
        } catch (error) {
            rethrow(error)
        }
    }
}

export default Database
