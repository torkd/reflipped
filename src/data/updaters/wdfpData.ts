// Updates an outdated wdfp_data database

import type { Database } from "../sqlite";
import { generatePublicIdpId, hashDeviceSecret, MIN_DEVICE_SECRET_LENGTH } from "../../lib/deviceSecret";

/** The tables that keep event records per run (src/data/wdfpData.ts, EVENT_RUN_TABLES; not imported: that module opens the database). */
const EVENT_RUN_TABLES = ["players_raid_records", "players_raid_state", "players_ranking_records", "players_carnival_records",
    "players_carnival_paid", "players_score_attack_best", "players_score_attack_battles", "players_rush_events",
    "players_rush_events_cleared_folders", "players_rush_events_played_parties"] as const

/**
 * Updates a database before its initialization function has been called.
 * 
 * @param database The player database (src/data/sqlite.ts).
 */
export function updateBeforeInit(
    database: Database,
    currentVersion: number
) {
    if (0 >= currentVersion) {
        // update to version 1

        // rush event; players_parties table
        database.prepare(`ALTER TABLE players_parties RENAME TO players_parties_old`).run()
        // rush event; players_party_groups table
        database.prepare(`ALTER TABLE players_party_groups RENAME TO players_party_groups_old`).run()
    }

    if (1 >= currentVersion) {

        // update to version 2

        // delete players_party_options table
        database.prepare(`
        DROP TABLE players_party_options
        `).run()

    }

    if (3 >= currentVersion) {
        // update to version 4 (before init, so init can index the new column)

        // SEC-5: accounts store a hash of the device secret (whiteKey) instead of the secret itself in idp_id
        const accountColumns = database.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[]
        if (accountColumns.length > 0 && !accountColumns.some(column => column.name === "device_secret_hash")) {
            database.prepare(`ALTER TABLE accounts ADD COLUMN device_secret_hash TEXT`).run()
            const accounts = database.prepare(`SELECT id, idp_id, idp_alias FROM accounts`).all() as { id: number, idp_id: string, idp_alias: string }[]
            const update = database.prepare(`UPDATE accounts SET device_secret_hash = ?, idp_id = ? WHERE id = ?`)
            database.transaction(() => {
                // until now idp_id was the whiteKey the device sent, so it becomes the hash and a public id replaces it.
                // An empty or short key (the SDK with ad tracking off) falls back to the deviceId, as loginDevice does
                // (deviceSecretFromBody); it is the middle part of idp_alias ("appId:deviceId:serialNo").
                // With neither, the account matches nothing.
                for (const account of accounts) {
                    const aliasParts = account.idp_alias.split(":")
                    const secret = [account.idp_id, aliasParts.length === 3 ? aliasParts[1] : ""]
                        .find(value => value.length >= MIN_DEVICE_SECRET_LENGTH)
                    const hash = secret === undefined ? null : hashDeviceSecret(secret)
                    update.run(hash, generatePublicIdpId(), account.id)
                }
            })()
        }
    }

    if (5 >= currentVersion) {
        // update to version 6 (before init, so init can index the new column)

        // FT-4: received mail remembers the order it was received in (receive_seq, per player), since receive_time goes
        // back with the clock. Mail received until now is numbered by its receive time, the best order there is.
        const mailColumns = database.prepare(`PRAGMA table_info(players_mail)`).all() as { name: string }[]
        if (mailColumns.length > 0 && !mailColumns.some(column => column.name === "receive_seq")) {
            database.transaction(() => {
                database.prepare(`ALTER TABLE players_mail ADD COLUMN receive_seq INTEGER`).run()
                database.prepare(`
                UPDATE players_mail SET receive_seq = ranked.seq
                FROM (
                    SELECT id, ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY receive_time, id) AS seq
                    FROM players_mail WHERE receive_time IS NOT NULL
                ) AS ranked
                WHERE players_mail.id = ranked.id
                `).run()
            })()
        }
    }

    if (6 >= currentVersion) {
        // update to version 7 (before init, so init can index the new column)

        // ACC-1: a device account can belong to a portal user; existing accounts stay guests
        const accountColumns = database.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[]
        if (accountColumns.length > 0 && !accountColumns.some(column => column.name === "user_id"))
            database.prepare(`ALTER TABLE accounts ADD COLUMN user_id INTEGER REFERENCES users (id) ON DELETE SET NULL`).run()
    }

    if (7 >= currentVersion) {
        // update to version 8

        // ACC-2: TOTP second factor on portal users (the table exists from version 7 on; older databases get it from init)
        const userColumns = database.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]
        if (userColumns.length > 0 && !userColumns.some(column => column.name === "totp_secret")) {
            database.prepare(`ALTER TABLE users ADD COLUMN totp_secret TEXT`).run()
            database.prepare(`ALTER TABLE users ADD COLUMN totp_last_step INTEGER`).run()
        }
    }

    if (10 >= currentVersion) {
        // update to version 11

        // ACC-8: an admin lets a portal user move their own player's clock (the table exists from version 7 on)
        const userColumns = database.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]
        if (userColumns.length > 0 && !userColumns.some(column => column.name === "time_travel"))
            database.prepare(`ALTER TABLE users ADD COLUMN time_travel INTEGER NOT NULL DEFAULT 0`).run()
    }

    if (11 >= currentVersion) {
        // update to version 12

        // SEC-16: when a viewer session last proved its account's zat (/load, tool/signup); game requests renew the
        // session only up to a fixed time after it
        const sessionColumns = database.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
        if (sessionColumns.length > 0 && !sessionColumns.some(column => column.name === "authenticated_at"))
            database.prepare(`ALTER TABLE sessions ADD COLUMN authenticated_at DATE`).run()
    }

    if (12 >= currentVersion) {
        // update to version 13

        // event records per run: the tables get a `run` column in their keys, which SQLite can't add to a key in place.
        // The old tables step aside (without their indexes, whose names init reuses), init creates the new ones, and
        // updateAfterInit copies the rows over with no run ("", adopted by the current run on first use).
        for (const table of EVENT_RUN_TABLES) {
            const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
            if (columns.length === 0 || columns.some(column => column.name === "run")) continue
            const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as { name: string, origin: string }[]
            for (const index of indexes) if (index.origin === "c") database.prepare(`DROP INDEX ${index.name}`).run()
            database.prepare(`ALTER TABLE ${table} RENAME TO ${table}_pre_run`).run()
        }
    }

    if (16 >= currentVersion) {
        // update to version 17

        // FT-33: a retired Score Scramble battle (a wipe ends with single_battle_quest/abort) is in the history with no
        // score, so the column takes null. SQLite can't drop NOT NULL in place: the table steps aside like for version
        // 13 and updateAfterInit copies its rows into the one init creates.
        const columns = database.prepare(`PRAGMA table_info(players_score_attack_battles)`).all() as { name: string, notnull: number }[]
        if (columns.some(column => column.name === "score" && column.notnull === 1)) {
            const indexes = database.prepare(`PRAGMA index_list(players_score_attack_battles)`).all() as { name: string, origin: string }[]
            for (const index of indexes) if (index.origin === "c") database.prepare(`DROP INDEX ${index.name}`).run()
            database.prepare(`ALTER TABLE players_score_attack_battles RENAME TO players_score_attack_battles_pre_null`).run()
        }
    }
}

/**
 * Updates a database after its initialization function has been called.
 * 
 * @param database The player database (src/data/sqlite.ts).
 */
export function updateAfterInit(
    database: Database,
    currentVersion: number
) {
    if (0 >= currentVersion) {
        // update to version 1

        // rush event; players_party_groups table
        database.prepare(`
        INSERT INTO players_party_groups
        SELECT *, 1 FROM players_party_groups_old
        `).run()

        // rush event; players_parties table
        database.prepare(`
        INSERT INTO players_parties
        SELECT *, 1 FROM players_parties_old
        `).run()
        database.prepare(`DELETE FROM players_parties_old`).run()
        database.prepare(`DELETE FROM players_party_groups_old`).run()
    }

    if (2 >= currentVersion) {
        // update to version 3

        // SEC-3: viewer sessions remember the device UDID that signs game requests
        const sessionColumns = database.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
        if (!sessionColumns.some(column => column.name === "udid"))
            database.prepare(`ALTER TABLE sessions ADD COLUMN udid TEXT`).run()
    }

    if (4 >= currentVersion) {
        // update to version 5

        // FT-13: a multi special exchange campaign remembers the ticket the player drew
        const campaignColumns = database.prepare(`PRAGMA table_info(players_multi_special_exchange_campaigns)`).all() as { name: string }[]
        if (!campaignColumns.some(column => column.name === "ticket_item_id"))
            database.prepare(`ALTER TABLE players_multi_special_exchange_campaigns ADD COLUMN ticket_item_id INTEGER`).run()
    }

    if (12 >= currentVersion) {
        // update to version 13: the event records' rows into the tables with a run (see updateBeforeInit)
        for (const table of EVENT_RUN_TABLES) {
            const old = `${table}_pre_run`
            const columns = (database.prepare(`PRAGMA table_info(${old})`).all() as { name: string }[]).map(column => column.name)
            if (columns.length === 0) continue
            // rows of a player that no longer exists (left by a database without foreign keys) would fail the copy
            database.prepare(`INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${old} WHERE player_id IN (SELECT id FROM players)`).run()
            database.prepare(`DROP TABLE ${old}`).run()
        }
    }

    if (13 >= currentVersion) {
        // update to version 14

        // FIX-7: units with 3 skills or fewer were given only board 1's bond token; the original gave every unit both
        addMissingSecondBondTokens(database)
    }

    if (14 >= currentVersion) {
        // update to version 15

        // SH-15: the Reflipped app version and build an account last signed in with (src/data/appVersions.ts)
        const accountColumns = database.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[]
        for (const column of ["app_version TEXT", "app_build TEXT", "app_seen_at DATE"])
            if (!accountColumns.some(existing => existing.name === column.split(" ")[0]))
                database.prepare(`ALTER TABLE accounts ADD COLUMN ${column}`).run()
    }

    if (15 >= currentVersion) {
        // update to version 16

        // SEC-18: a raid record's clears that anti-cheat (enforce) kept off the shared tally and the raid ranking
        const raidColumns = database.prepare(`PRAGMA table_info(players_raid_records)`).all() as { name: string }[]
        if (raidColumns.length > 0 && !raidColumns.some(column => column.name === "excluded_kill_count"))
            database.prepare(`ALTER TABLE players_raid_records ADD COLUMN excluded_kill_count INTEGER NOT NULL DEFAULT 0`).run()
    }

    if (16 >= currentVersion) {
        // update to version 17: the Score Scramble battles into the table whose score takes null (see updateBeforeInit)
        const old = "players_score_attack_battles_pre_null"
        const columns = (database.prepare(`PRAGMA table_info(${old})`).all() as { name: string }[]).map(column => column.name)
        if (columns.length > 0) {
            database.prepare(`INSERT INTO players_score_attack_battles (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${old} WHERE player_id IN (SELECT id FROM players)`).run()
            database.prepare(`DROP TABLE ${old}`).run()
        }
    }
}

/** Adds the board 2 bond token entry (status 0) to every unit that lacks one. Safe to run again. */
export function addMissingSecondBondTokens(database: Database): number {
    return database.prepare(`
    INSERT OR IGNORE INTO players_characters_bond_tokens (mana_board_index, status, player_id, character_id)
    SELECT 2, 0, player_id, id FROM players_characters
    `).run().changes
}
