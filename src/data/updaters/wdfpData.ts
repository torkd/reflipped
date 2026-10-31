// Updates an outdated wdfp_data database

import { Database } from "better-sqlite3";
import { generatePublicIdpId, hashDeviceSecret, MIN_DEVICE_SECRET_LENGTH } from "../../lib/deviceSecret";

/**
 * Updates a database before its initialization function has been called.
 * 
 * @param database A better-sqlite3 database.
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
}

/**
 * Updates a database after its initialization function has been called.
 * 
 * @param database A better-sqlite3 database.
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
}
