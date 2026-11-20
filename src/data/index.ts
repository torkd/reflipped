import SqliteDatabase from './sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from "path";
import { databaseDir } from "../lib/paths";
import { configureSqlite } from "../lib/sqliteTuning";
import { updateBeforeInit as updateWdfpDataBefore, updateAfterInit as updateWdfpDataAfter} from "./updaters/wdfpData";
import initWdfpData from "./initializers/wdfpData";

const dataDir = databaseDir()
const versionFileExtension = ".version"
if (!existsSync(dataDir)) {
    // make the data directory since it doesn't exist
    try {
        mkdirSync(dataDir)
    } catch (error) {
        throw new Error(`Failed to create the data directory. Reason: ${(error as Error).message}`)
    }
}

export const enum Database {
    WDFP_DATA
}

interface DatabaseMetadata {
    path: string
    latestVersion: number
    init?: (database: SqliteDatabase, exists: boolean) => void
    updateBefore?: (database: SqliteDatabase, currentVersion: number) => void
    updateAfter?: (database: SqliteDatabase, currentVersion: number) => void
}

const databasesMetadata: {[key in Database]: DatabaseMetadata} = {
    [Database.WDFP_DATA]: {
        path: "/wdfp_data.db",
        init: initWdfpData,
        updateBefore: updateWdfpDataBefore,
        updateAfter: updateWdfpDataAfter,
        latestVersion: 17
    }
}

const loadedDatabases: {
    [key in Database]?: SqliteDatabase
} = {}

export default function getDatabase(
    database: Database
): SqliteDatabase {
    // don't try to load an already-loaded database
    const isLoaded = loadedDatabases[database]
    if (isLoaded) return isLoaded

    // get metadata
    const metadata = databasesMetadata[database]

    const relativeDatabasePath = metadata.path
    const absoluteDatabasePath = path.join(dataDir, relativeDatabasePath)
    // check if the db already exists
    const dbExists = existsSync(absoluteDatabasePath)

    // get the database's version
    let currentVersion: number = 0
    const versionFilePath = path.join(dataDir, `${relativeDatabasePath}${versionFileExtension}`)
    if (dbExists && existsSync(versionFilePath)) {
        const fileContents = readFileSync(versionFilePath).toString('utf-8')
        const versionNumber = Number(fileContents)
        currentVersion = isNaN(versionNumber) ? currentVersion : versionNumber
    }

    // create new db
    const db = new SqliteDatabase(absoluteDatabasePath)

    // Connection tuning (docs/capacity.md); keep schema/version/migrations independent of this policy.
    configureSqlite(db)

    // call init & update function
    const init = metadata.init
    const updateBefore = metadata.updateBefore
    const updateAfter = metadata.updateAfter
    if (init !== undefined) {
        try {
            // try to update before initialization
            const latestVersion = metadata.latestVersion
            const updateRequired = dbExists && metadata.latestVersion > currentVersion
            if (updateRequired && updateBefore !== undefined) {
                console.log("Updating wdfp_data.db...")
                updateBefore(db, currentVersion)
            }

            // initialize
            init(db, dbExists)

            // try to update after initialization
            if (updateRequired && updateAfter !== undefined) {
                updateAfter(db, currentVersion)
                console.log("Successfully updated wdfp_data.db")
            }

            // write version file
            writeFileSync(versionFilePath, latestVersion.toString(), { encoding: 'utf-8' })
        } catch (error) {
            console.log(error)
            console.log(`Initalization failed for module ${metadata.path}. Error: ${error}`)
        }
    }

    // add to loaded databases
    loadedDatabases[database] = db

    return db
}

/**
 * Closes every open database, so SQLite checkpoints its WAL into the file (SH-13: the server on the phone on SIGTERM).
 * A later getDatabase() opens it again.
 */
export function closeDatabases() {
    for (const key of Object.keys(loadedDatabases)) {
        const database = Number(key) as Database
        try {
            loadedDatabases[database]?.close()
        } catch (error) {
            console.error("closing the database failed:", error)
        }
        delete loadedDatabases[database]
    }
}