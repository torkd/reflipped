import type { Database } from "../sqlite";
import { randomUUID } from "crypto";
import { storedRewardMailFingerprint, StoredRewardIdentity } from "../rewardMailIdentity";


export default function init(
    database: Database,
    exists: Boolean
) {
    // initialize the database

    // create players table
    database.prepare(`CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        first_login_time DATE NOT NULL,
        idp_alias TEXT NOT NULL,
        idp_code TEXT NOT NULL,
        idp_id TEXT NOT NULL,
        reg_time DATE NOT NULL,
        last_login_time DATE NOT NULL,
        status TEXT NOT NULL,
        device_secret_hash TEXT,
        user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
        app_version TEXT,
        app_build TEXT,
        app_seen_at DATE
    )`).run()
    // SEC-5: loginDevice finds a device's account by the hash of its secret (src/lib/deviceSecret.ts)
    database.prepare(`CREATE INDEX IF NOT EXISTS accounts_device_secret_hash ON accounts (device_secret_hash)`).run()

    // ACC-1: portal users (src/data/users.ts, docs/accounts.md "Data model"). A device account belongs to at most one
    // user (accounts.user_id, null for a guest); deleting the user turns its accounts back into guests.
    database.prepare(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        email TEXT UNIQUE COLLATE NOCASE,
        role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
        created_time DATE NOT NULL,
        last_login_time DATE,
        totp_secret TEXT,
        totp_last_step INTEGER,
        time_travel INTEGER NOT NULL DEFAULT 0
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS accounts_user_id ON accounts (user_id)`).run()

    // ACC-1: one-time device link codes (ACC-4). Only a SHA-256 of the code is stored, as for device secrets.
    database.prepare(`CREATE TABLE IF NOT EXISTS link_codes (
        code_hash TEXT PRIMARY KEY NOT NULL,
        user_id INTEGER NOT NULL,
        expires DATE NOT NULL,
        used_time DATE,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS link_codes_user_id ON link_codes (user_id)`).run()

    // ACC-2: portal login sessions (src/data/portalSessions.ts). The cookie holds the token; only its SHA-256 is stored.
    // A session that passed the password but not yet the TOTP code has mfa_pending set and opens nothing else.
    database.prepare(`CREATE TABLE IF NOT EXISTS portal_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id INTEGER NOT NULL,
        csrf_token TEXT NOT NULL,
        created_time DATE NOT NULL,
        expires DATE NOT NULL,
        mfa_pending INTEGER NOT NULL DEFAULT 0,
        mfa_failures INTEGER NOT NULL DEFAULT 0,
        pending_totp_secret TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS portal_sessions_user_id ON portal_sessions (user_id)`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS portal_sessions_expires ON portal_sessions (expires)`).run()

    // FT-59: saves a player deleted (src/data/deletedSaves.ts, src/lib/saveDeletion.ts), kept for an admin to restore
    // until expires_at (real time, ms); `data` is the gzipped save. The account stays, so it goes with the account.
    database.prepare(`CREATE TABLE IF NOT EXISTS deleted_saves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        rank INTEGER NOT NULL,
        source TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        data BLOB NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS deleted_saves_account_id ON deleted_saves (account_id)`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS deleted_saves_player_id ON deleted_saves (player_id)`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS deleted_saves_expires_at ON deleted_saves (expires_at)`).run()

    // ACC-5: admin site login sessions (src/data/adminSessions.ts), the same columns as portal_sessions but their own
    // table, so a portal cookie never opens the admin site
    database.prepare(`CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id INTEGER NOT NULL,
        csrf_token TEXT NOT NULL,
        created_time DATE NOT NULL,
        expires DATE NOT NULL,
        mfa_pending INTEGER NOT NULL DEFAULT 0,
        mfa_failures INTEGER NOT NULL DEFAULT 0,
        pending_totp_secret TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS admin_sessions_user_id ON admin_sessions (user_id)`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS admin_sessions_expires ON admin_sessions (expires)`).run()

    // ACC-3: one-time codes that carry a portal login from the shell's WebView to the shell (src/data/shellSignIns.ts),
    // which trades one for a device token. Only a SHA-256 of the code is stored.
    database.prepare(`CREATE TABLE IF NOT EXISTS shell_sign_ins (
        code_hash TEXT PRIMARY KEY NOT NULL,
        user_id INTEGER NOT NULL,
        expires DATE NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS shell_sign_ins_user_id ON shell_sign_ins (user_id)`).run()

    // create zat session table
    database.prepare(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY NOT NULL,
        account_id INTEGER NOT NULL,
        expires DATE NOT NULL,
        type INTEGER NOT NULL,
        udid TEXT,
        authenticated_at DATE,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
    )`).run()

    // create players table
    database.prepare(`CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stamina INTEGER NOT NULL,
        stamina_heal_time INTEGER NOT NULL,
        boost_point INTEGER NOT NULL,
        boss_boost_point INTEGER NOT NULL,
        transition_state INTEGER NOT NULL,
        role INTEGER NOT NULL,
        name TEXT NOT NULL,
        last_login_time DATE NOT NULL,
        comment TEXT NOT NULL,
        vmoney INTEGER NOT NULL,
        free_vmoney INTEGER NOT NULL,
        rank_point INTEGER NOT NULL,
        star_crumb INTEGER NOT NULL,
        bond_token INTEGER NOT NULL,
        exp_pool INTEGER NOT NULL,
        exp_pooled_time INTEGER NOT NULL,
        leader_character_id INTEGER NOT NULL,
        party_slot INTEGER NOT NULL,
        degree_id INTEGER NOT NULL,
        birth INTEGER NOT NULL,
        free_mana INTEGER NOT NULL,
        paid_mana INTEGER NOT NULL,
        enable_auto_3x INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        tutorial_step INTEGER,
        tutorial_skip_flag INTEGER,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
    )`).run();

    database.exec(`CREATE TABLE IF NOT EXISTS players_point_reset_days (
        player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, point_id INTEGER NOT NULL, day TEXT NOT NULL,
        PRIMARY KEY(player_id, kind, point_id)
    )`)

    database.prepare(`CREATE TABLE IF NOT EXISTS players_options (
        key TEXT NOT NULL,
        value INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (key, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_triggered_tutorials (
        id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_cleared_regular_missions (
        id INTEGER NOT NULL,
        value INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_items (
        id INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS daily_challenge_point_list_entries (
        id INTEGER NOT NULL,
        point INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS daily_challenge_point_list_campaigns (
        campaign_id INTEGER NOT NULL,
        additional_point INTEGER NOT NULL,
        list_entry_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, campaign_id, list_entry_id),
        FOREIGN KEY (list_entry_id, player_id) REFERENCES daily_challenge_point_list_entries (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_characters (
        id INTEGER NOT NULL,
        entry_count INTEGER NOT NULL,
        evolution_level INTEGER NOT NULL,
        over_limit_step INTEGER NOT NULL,
        protection INTEGER NOT NULL,
        join_time DATE NOT NULL,
        update_time DATE NOT NULL,
        exp INTEGER NOT NULL,
        stack INTEGER NOT NULL,
        mana_board_index INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        ex_boost_status_id INTEGER,
        ex_boost_ability_id_list TEXT,
        illustration_settings TEXT,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_characters_bond_tokens (
        mana_board_index INTEGER NOT NULL,
        status INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        PRIMARY KEY (mana_board_index, player_id, character_id),
        FOREIGN KEY (character_id, player_id) REFERENCES players_characters (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_characters_mana_nodes (
        value INTEGER NOT NULL,
        character_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (value, character_id, player_id),
        FOREIGN KEY (character_id, player_id) REFERENCES players_characters (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_party_groups (
        id INTEGER NOT NULL,
        color_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        PRIMARY KEY (id, player_id, category),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_parties (
        slot INTEGER NOT NULL,
        name TEXT NOT NULL,
        character_id_1 INTEGER,
        character_id_2 INTEGER,
        character_id_3 INTEGER,
        unison_character_1 INTEGER,
        unison_character_2 INTEGER,
        unison_character_3 INTEGER,
        equipment_1 INTEGER,
        equipment_2 INTEGER,
        equipment_3 INTEGER,
        ability_soul_1 INTEGER,
        ability_soul_2 INTEGER,
        ability_soul_3 INTEGER,
        edited INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        PRIMARY KEY (slot, player_id, group_id, category),
        FOREIGN KEY (group_id, player_id, category) REFERENCES players_party_groups (id, player_id, category) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // database.prepare(`CREATE TABLE IF NOT EXISTS players_party_options (
    //     allow_other_players_to_heal_me INTEGER NOT NULL,
    //     slot INTEGER NOT NULL,
    //     player_id INTEGER NOT NULL,
    //     group_id INTEGER NOT NULL,
    //     category INTEGER NOT NULL,
    //     PRIMARY KEY (slot, player_id, group_id, category),
    //     FOREIGN KEY (slot, player_id, group_id, category) REFERENCES players_parties (slot, player_id, group_id, category) ON DELETE CASCADE,
    //     FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    // )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_equipment (
        id INTEGER NOT NULL,
        level INTEGER NOT NULL,
        enhancement_level INTEGER NOT NULL,
        protection INTEGER NOT NULL,
        stack INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_quest_progress (
        section INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        finished INTEGER NOT NULL,
        high_score INTEGER,
        clear_rank INTEGER,
        best_elapsed_time_ms INTEGER,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (section, quest_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_gacha_info (
        gacha_id INTEGER NOT NULL,
        is_daily_first INTEGER NOT NULL,
        is_account_first INTEGER NOT NULL,
        gacha_exchange_point INTEGER,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (gacha_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_gacha_campaigns (
        gacha_id INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        count INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (gacha_id, campaign_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_drawn_quests (
        category_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        odds_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (category_id, quest_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_periodic_reward_points (
        id INTEGER NOT NULL,
        point INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_mail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type INTEGER NOT NULL,
        type_id INTEGER,
        number INTEGER NOT NULL,
        reason_id INTEGER NOT NULL,
        subject TEXT,
        description TEXT,
        create_time DATE NOT NULL,
        receive_time DATE,
        reward_limit_time DATE,
        player_id INTEGER NOT NULL,
        receive_seq INTEGER,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE INDEX IF NOT EXISTS players_mail_player_id ON players_mail (player_id, receive_time)`).run();
    // the order in which a player received their mail (the history's order and retention); receive_time can't give it,
    // since the clock goes back (event calendar, player clocks, Reset)
    database.prepare(`CREATE INDEX IF NOT EXISTS players_mail_player_id_receive_seq ON players_mail (player_id, receive_seq)`).run();

    // Earned gifts survive save replacement. Keep a tombstone after received history is trimmed, so an older save
    // cannot turn a received gift back into pending mail. Only the actual send path creates these opaque sources.
    database.transaction(() => {
        const rewardSourcesExisted = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'players_reward_mail_sources'`).get() !== undefined
        database.prepare(`CREATE TABLE IF NOT EXISTS players_reward_mail_sources (
            player_id INTEGER NOT NULL,
            source_key TEXT NOT NULL,
            mail_id INTEGER UNIQUE,
            content_fingerprint TEXT NOT NULL,
            PRIMARY KEY (player_id, source_key),
            FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
            FOREIGN KEY (mail_id) REFERENCES players_mail (id) ON DELETE SET NULL
        )`).run()
        // Before durable sources existed, these reserved reasons identified this server's earned mission/login gifts.
        // Adopt them once only: later imports with foreign source keys remain ordinary mail after future restarts too.
        if (!rewardSourcesExisted) {
            const legacy = database.prepare(`SELECT * FROM players_mail WHERE reason_id IN (55, 60) ORDER BY id`).all() as StoredRewardIdentity[]
            const insert = database.prepare(`INSERT INTO players_reward_mail_sources (player_id, source_key, mail_id, content_fingerprint) VALUES (?, ?, ?, ?)`)
            for (const mail of legacy) insert.run(mail.player_id, randomUUID(), mail.id, storedRewardMailFingerprint(mail))
        }
    })()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_active_missions (
        id INTEGER NOT NULL,
        progress INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_active_missions_stages (
        id INTEGER NOT NULL,
        status INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        mission_id INTEGER NOT NULL,
        PRIMARY KEY (id, mission_id, player_id),
        FOREIGN KEY (mission_id, player_id) REFERENCES players_active_missions (id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_box_gacha (
        id INTEGER NOT NULL,
        box_id INTEGER NOT NULL,
        reset_times INTEGER NOT NULL,
        remaining_number INTEGER NOT NULL,
        is_closed INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, box_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_box_gacha_drawn_rewards (
        id INTEGER NOT NULL,
        box_id INTEGER NOT NULL,
        gacha_id INTEGER NOT NULL,
        number INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (id, box_id, gacha_id, player_id),
        FOREIGN KEY (gacha_id, box_id, player_id) REFERENCES players_box_gacha (id, box_id, player_id) ON DELETE CASCADE,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_start_dash_exchange_campaigns (
        campaign_id INTEGER NOT NULL,
        gacha_id INTEGER NOT NULL,
        term_index INTEGER NOT NULL,
        status INTEGER NOT NULL,
        period_start_time DATE NOT NULL,
        period_end_time DATE NOT NULL,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_multi_special_exchange_campaigns (
        campaign_id INTEGER NOT NULL,
        status INTEGER NOT NULL,
        ticket_item_id INTEGER,
        player_id INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // CO-3: who shared a multi special exchange lounge, so each one's pick is mailed to the others
    database.prepare(`CREATE TABLE IF NOT EXISTS players_multi_special_exchange_lounge_mates (
        campaign_id INTEGER NOT NULL,
        player_id INTEGER NOT NULL,
        mate_player_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, campaign_id, mate_player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
        FOREIGN KEY (mate_player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // shop purchases per product, for its limits (SEC-15): ever, on `day` and in `month` (game days, see src/lib/shopLimits.ts)
    database.prepare(`CREATE TABLE IF NOT EXISTS players_shop_purchases (
        player_id INTEGER NOT NULL,
        shop_type INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        total INTEGER NOT NULL,
        day TEXT NOT NULL,
        day_count INTEGER NOT NULL,
        month TEXT NOT NULL,
        month_count INTEGER NOT NULL,
        PRIMARY KEY (player_id, shop_type, item_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // the game day and month of a player's last daily and monthly reset (FT-1, src/lib/resets.ts); UNIQUE rather than
    // an INTEGER PRIMARY KEY, which would be the rowid and leave player_id without an index (test/dbIndexes.test.ts)
    database.prepare(`CREATE TABLE IF NOT EXISTS players_resets (
        player_id INTEGER NOT NULL UNIQUE,
        day TEXT NOT NULL,
        month TEXT NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // raid events (FT-12): each player's clears (kills) and best score per raid quest (difficulty) with the party group
    // that set the best score, and per event the kill tally rewards received, the ranking rewards and the day's
    // auto-battle starts
    database.prepare(`CREATE TABLE IF NOT EXISTS players_raid_records (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        kill_count INTEGER NOT NULL,
        high_score INTEGER NOT NULL,
        party TEXT NOT NULL,
        run TEXT NOT NULL DEFAULT '',
        excluded_kill_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (player_id, event_id, quest_id, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS players_raid_records_event ON players_raid_records (event_id, run, quest_id)`).run();
    database.prepare(`CREATE TABLE IF NOT EXISTS players_raid_state (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        kills_received INTEGER NOT NULL,
        ranking_rewarded INTEGER NOT NULL,
        auto_day TEXT,
        auto_used INTEGER NOT NULL,
        run TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, event_id, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // ranking events (FT-33): each player's best record in an event (a full clear beats any partial run, then the time;
    // a partial run by score), its leader, and whether the rank rewards were received
    database.prepare(`CREATE TABLE IF NOT EXISTS players_ranking_records (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        accomplished INTEGER NOT NULL,
        elapsed_time_ms INTEGER NOT NULL,
        score INTEGER NOT NULL,
        leader_character_id INTEGER NOT NULL,
        rewarded INTEGER NOT NULL DEFAULT 0,
        run TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, event_id, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS players_ranking_records_event ON players_ranking_records (event_id, run)`).run();

    // the unit poll (character election, FT-2): the unit (keyword) each player voted for, one vote per election
    database.prepare(`CREATE TABLE IF NOT EXISTS players_character_election_votes (
        player_id INTEGER NOT NULL,
        election_id INTEGER NOT NULL,
        keyword_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, election_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // Hanifolk Carnival (FT-11): each boss's (folder's) record: the best score, the last score and the party that set
    // them (units, unison units); a battle with another party starts the record over
    database.prepare(`CREATE TABLE IF NOT EXISTS players_carnival_records (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        folder_id INTEGER NOT NULL,
        best_score INTEGER NOT NULL,
        previous_score INTEGER NOT NULL,
        character_ids TEXT NOT NULL,
        unison_character_ids TEXT NOT NULL,
        run TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, event_id, folder_id, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    // the highest total score whose rewards were paid, so a total that drops (a party change) and climbs back doesn't
    // pay them again
    database.prepare(`CREATE TABLE IF NOT EXISTS players_carnival_paid (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        total_score INTEGER NOT NULL,
        run TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, event_id, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // Score Scramble (FT-11): the best score per quest, which decides the border rewards a battle newly reaches (a lost
    // battle scores too, so quest progress, written only by a clear, can't hold it), and the recent battles
    // `history/score_attack_event_battle` lists
    database.prepare(`CREATE TABLE IF NOT EXISTS players_score_attack_best (
        player_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        score INTEGER NOT NULL,
        run TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, quest_id, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE TABLE IF NOT EXISTS players_score_attack_battles (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        score INTEGER,
        elapsed_time_ms INTEGER NOT NULL,
        clear_rank INTEGER,
        finish_kind INTEGER NOT NULL,
        total_damage INTEGER NOT NULL,
        party TEXT NOT NULL,
        create_time INTEGER NOT NULL,
        run TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS players_score_attack_battles_player ON players_score_attack_battles (player_id, event_id, run)`).run();

    // special exchange campaigns (FT-39): a player who entered a campaign (status 1) or exchanged its ticket (3)
    database.prepare(`CREATE TABLE IF NOT EXISTS players_special_exchange (
        player_id INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        status INTEGER NOT NULL,
        PRIMARY KEY (player_id, campaign_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // campaign gifts (FT-39): the scheduled gifts a player has received, by gift key ("special_exchange:<campaign id>")
    database.prepare(`CREATE TABLE IF NOT EXISTS players_campaign_gifts (
        player_id INTEGER NOT NULL,
        gift_key TEXT NOT NULL,
        sent_time INTEGER NOT NULL,
        PRIMARY KEY (player_id, gift_key),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // periodic packs (FT-89, src/lib/periodicPacks.ts): a player's running term of a monthly pack (times in ms), and every
    // delivery made once (a term's start, a game day, a rank threshold)
    database.prepare(`CREATE TABLE IF NOT EXISTS players_periodic_packs (
        player_id INTEGER NOT NULL,
        pack_id TEXT NOT NULL,
        term_start INTEGER NOT NULL,
        term_end INTEGER NOT NULL,
        PRIMARY KEY (player_id, pack_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE TABLE IF NOT EXISTS players_periodic_pack_receipts (
        player_id INTEGER NOT NULL,
        pack_id TEXT NOT NULL,
        receipt_key TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (player_id, pack_id, receipt_key),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // lineup choices (FT-38): the lineup a player picked in a select item campaign of a shop (shop_type 7 Boss Coin, 4 event)
    database.prepare(`CREATE TABLE IF NOT EXISTS players_lineup_choices (
        player_id INTEGER NOT NULL,
        shop_type INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        lineup_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, shop_type, campaign_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // news posts (ADM-4): written by admins or published automatically for an event; auto_key is set only for the
    // automatic ones and is unique, so one event run never gets a second post. published_at is real time (ms).
    database.prepare(`CREATE TABLE IF NOT EXISTS news_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL,
        auto_key TEXT UNIQUE,
        published_at INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0
    )`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS news_posts_published ON news_posts (published_at DESC, id DESC)`).run();

    // follows (FT-15): player_id follows followee_id since follow_time (ms); a pair that follows both ways is mutual
    database.prepare(`CREATE TABLE IF NOT EXISTS players_follows (
        player_id INTEGER NOT NULL,
        followee_id INTEGER NOT NULL,
        follow_time INTEGER NOT NULL,
        PRIMARY KEY (player_id, followee_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
        FOREIGN KEY (followee_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS players_follows_followee ON players_follows (followee_id)`).run();

    // the follow bonus (FT-43): how many co-op battles two players played to the end together while mutual follows;
    // one row per pair, the lower player ID first
    database.prepare(`CREATE TABLE IF NOT EXISTS players_coop_partners (
        player_id INTEGER NOT NULL,
        partner_id INTEGER NOT NULL,
        battles INTEGER NOT NULL,
        PRIMARY KEY (player_id, partner_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
        FOREIGN KEY (partner_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS players_coop_partners_partner ON players_coop_partners (partner_id)`).run();

    // the profile's show/hide settings (FT-36, profile/update_profile_settings); a player without a row shows all three
    database.prepare(`CREATE TABLE IF NOT EXISTS players_profile_settings (
        player_id INTEGER NOT NULL UNIQUE,
        show_owned_character_count INTEGER NOT NULL,
        show_opened_mana_board_second_count INTEGER NOT NULL,
        show_owned_degree_count INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // Practice Combat (FT-17): the player's recent practice battles, cleared or given up, for history/practice_battle.
    // party holds the slots' units, unison units, armaments (with their level and enhancement level at the time) and
    // ability souls, and each slot's damage, as JSON
    database.prepare(`CREATE TABLE IF NOT EXISTS players_practice_battles (
        player_id INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        score INTEGER,
        elapsed_time_ms INTEGER NOT NULL,
        clear_rank INTEGER,
        finish_kind INTEGER NOT NULL,
        total_damage INTEGER NOT NULL,
        party TEXT NOT NULL,
        create_time INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS players_practice_battles_player ON players_practice_battles (player_id)`).run();

    // suggested parties (FT-50): each player's party from their latest clear of each quest, which
    // quest/get_recent_other_player_party shows other players (src/lib/recentParties.ts)
    database.prepare(`CREATE TABLE IF NOT EXISTS players_recent_quest_parties (
        player_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        party TEXT NOT NULL,
        clear_time INTEGER NOT NULL,
        PRIMARY KEY (player_id, category, quest_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS players_recent_quest_parties_quest ON players_recent_quest_parties (category, quest_id, clear_time)`).run();

    // the Haunt (FT-6): the cycle a player was last in ("<first quest id>~<clock era>", null outside every cycle) and
    // the reset dialog the next /load sends (tower_dungeon_list), if any
    database.prepare(`CREATE TABLE IF NOT EXISTS players_tower_dungeon (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        cycle TEXT,
        notice_month INTEGER,
        notice_status INTEGER,
        PRIMARY KEY (player_id, event_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // missions (FT-2): category is the client's mission_category (1 regular, 2 daily, 3 event)
    database.prepare(`CREATE TABLE IF NOT EXISTS players_missions (
        player_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        mission_id INTEGER NOT NULL,
        progress INTEGER NOT NULL,
        cleared_stage INTEGER NOT NULL,
        PRIMARY KEY (player_id, category, mission_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    // titles (degrees) a player owns, besides the default title 1 everyone has (FT-2 degree missions, FT-4 mail)
    database.prepare(`CREATE TABLE IF NOT EXISTS players_degrees (
        player_id INTEGER NOT NULL,
        degree_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, degree_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run();

    database.prepare(`CREATE TABLE IF NOT EXISTS players_rush_events (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        active_rush_battle_folder_id INTEGER,
        endless_battle_max_round INTEGER,
        endless_battle_max_round_time INTEGER,
        endless_battle_max_round_character_id_1 INTEGER,
        endless_battle_max_round_character_id_2 INTEGER,
        endless_battle_max_round_character_id_3 INTEGER,
        endless_battle_max_round_character_evolution_img_lvl_1 INTEGER,
        endless_battle_max_round_character_evolution_img_lvl_2 INTEGER,
        endless_battle_max_round_character_evolution_img_lvl_3 INTEGER,
        run TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, event_id, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_rush_events_cleared_folders (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        folder_id INTEGER NOT NULL,
        run TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, event_id, folder_id, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    database.prepare(`CREATE TABLE IF NOT EXISTS players_rush_events_played_parties (
        character_id_1 INTEGER,
        character_id_2 INTEGER,
        character_id_3 INTEGER,
        unison_character_id_1 INTEGER,
        unison_character_id_2 INTEGER,
        unison_character_id_3 INTEGER,
        equipment_id_1 INTEGER,
        equipment_id_2 INTEGER,
        equipment_id_3 INTEGER,
        ability_soul_id_1 INTEGER,
        ability_soul_id_2 INTEGER,
        ability_soul_id_3 INTEGER,
        evolution_img_level_1 INTEGER,
        evolution_img_level_2 INTEGER,
        evolution_img_level_3 INTEGER,
        unison_evolution_img_level_1 INTEGER,
        unison_evolution_img_level_2 INTEGER,
        unison_evolution_img_level_3 INTEGER,
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        round INTEGER NOT NULL,
        battle_type INTEGER NOT NULL,
        run TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (player_id, event_id, round, battle_type, run),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    // FT-3: earned login rewards remain durable through a full gift box or an interrupted presentation.
    database.prepare(`CREATE TABLE IF NOT EXISTS players_login_bonus_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        period_key TEXT NOT NULL,
        game_day TEXT NOT NULL,
        bonus_index INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        reward_json TEXT NOT NULL,
        mailed_rewards INTEGER NOT NULL DEFAULT 0,
        shown INTEGER NOT NULL DEFAULT 0,
        presented INTEGER NOT NULL DEFAULT 0,
        UNIQUE (player_id, group_id, period_key, game_day),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS players_login_bonus_receipts_player_period
        ON players_login_bonus_receipts (player_id, group_id, period_key, id)`).run()
    // FT-24: the absence checks (loginHistory() in src/lib/loginBonus.ts) read a player's latest receipt and whether one
    // falls in a window; without this they scan all of the player's receipts, which grow by a few each login day
    database.prepare(`CREATE INDEX IF NOT EXISTS players_login_bonus_receipts_player_received
        ON players_login_bonus_receipts (player_id, received_at)`).run()

    // PERF-1: most primary keys put player_id last, and SQLite only searches a composite index from its leftmost
    // column, so every "WHERE player_id = ?" scanned the whole table (docs/capacity.md). Each index leads with the
    // column the queries filter on and also holds the table's composite foreign key, so cascading deletes don't scan.
    // Tables whose primary key already starts with player_id (players_rush_events*) need none.
    // Created here rather than in an updater: init runs on every start, so existing databases get them too.
    const indexes: [table: string, columns: string][] = [
        ["players", "account_id"],
        ["sessions", "account_id, type"],
        ["sessions", "type, expires"],
        ["players_options", "player_id"],
        ["players_triggered_tutorials", "player_id"],
        ["players_cleared_regular_missions", "player_id"],
        ["players_items", "player_id"],
        ["daily_challenge_point_list_entries", "player_id"],
        ["daily_challenge_point_list_campaigns", "player_id, list_entry_id"],
        ["players_characters", "player_id"],
        ["players_characters_bond_tokens", "player_id, character_id"],
        ["players_characters_mana_nodes", "player_id, character_id"],
        ["players_party_groups", "player_id, category"],
        ["players_parties", "player_id, category, group_id"],
        ["players_equipment", "player_id"],
        ["players_quest_progress", "player_id"],
        ["players_gacha_info", "player_id"],
        ["players_gacha_campaigns", "player_id, gacha_id"],
        ["players_drawn_quests", "player_id"],
        ["players_periodic_reward_points", "player_id"],
        ["players_active_missions", "player_id"],
        ["players_active_missions_stages", "player_id, mission_id"],
        ["players_box_gacha", "player_id"],
        ["players_box_gacha_drawn_rewards", "player_id, gacha_id, box_id"],
        ["players_start_dash_exchange_campaigns", "player_id"],
        ["players_multi_special_exchange_campaigns", "player_id"],
        // a deleted player leaves its lounge mates' lists (CO-3)
        ["players_multi_special_exchange_lounge_mates", "mate_player_id"],
        // the endless battle ranking reads one event across all players
        ["players_rush_events", "event_id, run"],
    ]
    for (const [table, columns] of indexes) {
        const name = `${table}_${columns.split(", ").join("_")}`
        database.prepare(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns})`).run()
    }

    // FT-2: earned daily rewards wait here when a reset removes their old progress rows.
    database.prepare(`CREATE TABLE IF NOT EXISTS players_mission_reward_backlog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        mission_id INTEGER NOT NULL,
        stage INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS players_mission_reward_backlog_player
        ON players_mission_reward_backlog (player_id)`).run()

    // Reward amounts are frozen at mission completion rather than gift-box delivery or Step Up claiming.
    database.prepare(`CREATE TABLE IF NOT EXISTS players_mission_reward_snapshots (
        player_id INTEGER NOT NULL,
        category INTEGER NOT NULL,
        mission_id INTEGER NOT NULL,
        stage INTEGER NOT NULL,
        rewards_json TEXT NOT NULL,
        PRIMARY KEY (player_id, category, mission_id, stage),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE TABLE IF NOT EXISTS players_mission_event_current_run (
        player_id INTEGER NOT NULL UNIQUE,
        run_key TEXT NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE TABLE IF NOT EXISTS players_mission_event_runs (
        player_id INTEGER NOT NULL,
        run_key TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        PRIMARY KEY (player_id, run_key),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    const backlogColumns = database.prepare(`PRAGMA table_info(players_mission_reward_backlog)`).all() as { name: string }[]
    if (!backlogColumns.some(column => column.name === "rewards_json"))
        database.prepare(`ALTER TABLE players_mission_reward_backlog ADD COLUMN rewards_json TEXT`).run()

    // FT-5: an account's own clock, the server clock moved by whole days (src/lib/playerClock.ts), and its own era (how
    // often it was moved back). Server config, not save data, so it is keyed by account: it stays through a save
    // import, developer mode and a progress reset, and goes with the account.
    database.prepare(`CREATE TABLE IF NOT EXISTS account_clocks (
        account_id INTEGER NOT NULL UNIQUE,
        offset_days INTEGER NOT NULL,
        era INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
    )`).run();
    // The era came after the table: a database made by an early build of it lacks the column, and may be at version 6
    // already, so the version can't tell. Checked on every start; it costs one PRAGMA.
    const clockColumns = database.prepare(`PRAGMA table_info(account_clocks)`).all() as { name: string }[]
    if (!clockColumns.some(column => column.name === "era"))
        database.prepare(`ALTER TABLE account_clocks ADD COLUMN era INTEGER NOT NULL DEFAULT 0`).run()
    // FT-31: whether the clock came from the player or from an admin, checked on every start like the era.
    if (!clockColumns.some(column => column.name === "source"))
        database.prepare(`ALTER TABLE account_clocks ADD COLUMN source TEXT NOT NULL DEFAULT 'player'`).run()
    // FT-31: when an account last changed its content view, for the personal travel cooldown (src/data/accountClocks.ts).
    database.prepare(`CREATE TABLE IF NOT EXISTS account_content_travel (
        account_id INTEGER NOT NULL UNIQUE,
        changed_at INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
    )`).run()

    // FT-41: party codes (src/data/partyCodes.ts): a party a player shared from the party screen (party/publish), which
    // another player looks up by its code (party/refer). Not save data: the codes are for others to read.
    database.prepare(`CREATE TABLE IF NOT EXISTS party_codes (
        code TEXT PRIMARY KEY NOT NULL,
        player_id INTEGER NOT NULL,
        party_name TEXT NOT NULL,
        battle_party TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS party_codes_player_id ON party_codes (player_id)`).run()

    // Encyclopedia read history is separate from the broad availability policy (src/data/encyclopedia.ts).
    database.prepare(`CREATE TABLE IF NOT EXISTS players_encyclopedia (
        player_id INTEGER NOT NULL,
        encyclopedia_id INTEGER NOT NULL,
        is_read INTEGER NOT NULL CHECK (is_read IN (0, 1)),
        PRIMARY KEY (player_id, encyclopedia_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()

    // SEC-18: anti-cheat findings (src/lib/anticheat.ts). `details` is JSON of our own values, never a request body or
    // token (OPS-2); `status` is open, dismissed or actioned
    database.prepare(`CREATE TABLE IF NOT EXISTS anticheat_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER NOT NULL,
        rule TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('hard', 'soft', 'info')),
        route TEXT,
        quest_id INTEGER,
        details TEXT NOT NULL DEFAULT '{}',
        req_id TEXT,
        created DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
        resolved_by INTEGER,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS anticheat_flags_player ON anticheat_flags (player_id, status)`).run()
    // SEC-18: a restricted player keeps playing, but stays off shared boards and public co-op (an admin action)
    database.prepare(`CREATE TABLE IF NOT EXISTS anticheat_players (
        player_id INTEGER PRIMARY KEY,
        restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
        restricted_at DATE,
        restricted_by INTEGER,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    ) WITHOUT ROWID`).run() // the primary key is then a real index (test/dbIndexes.test.ts), not the rowid

    // SEC-18 phase 4 (src/lib/anticheatStats.ts, src/data/anticheatStatsData.ts). R9 and R10: per quest, mode (solo or
    // co-op), metric and party power band, a log-scale histogram of the server's own honest-looking finishes (`bins`:
    // JSON {bin: count}, at most 192 bins, halved past 1000 samples). No player data.
    database.prepare(`CREATE TABLE IF NOT EXISTS anticheat_finish_stats (
        category INTEGER NOT NULL,
        quest_id INTEGER NOT NULL,
        coop INTEGER NOT NULL,
        metric TEXT NOT NULL,
        band INTEGER NOT NULL,
        samples INTEGER NOT NULL,
        bins TEXT NOT NULL,
        PRIMARY KEY (category, quest_id, coop, band, metric)
    ) WITHOUT ROWID`).run()
    // R11: one row per player, the finishes of the current real-time hour and the current run of play (times in ms)
    database.prepare(`CREATE TABLE IF NOT EXISTS anticheat_play_rate (
        player_id INTEGER PRIMARY KEY,
        hour INTEGER NOT NULL,
        hour_count INTEGER NOT NULL,
        session_start INTEGER NOT NULL,
        last_finish INTEGER NOT NULL,
        flagged_hour INTEGER NOT NULL DEFAULT -1,
        flagged_session INTEGER NOT NULL DEFAULT -1,
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    ) WITHOUT ROWID`).run()
    // R12: which device keys (a hash of the account's device secret hash, never the secret) a player finished battles
    // with, kept 90 days after the last one; and the linked pairs already flagged (lower player id first)
    database.prepare(`CREATE TABLE IF NOT EXISTS anticheat_device_keys (
        device_key TEXT NOT NULL,
        player_id INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (device_key, player_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    ) WITHOUT ROWID`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS anticheat_device_keys_player ON anticheat_device_keys (player_id)`).run()
    database.prepare(`CREATE TABLE IF NOT EXISTS anticheat_linked_pairs (
        player_id INTEGER NOT NULL,
        other_id INTEGER NOT NULL,
        created DATE NOT NULL,
        PRIMARY KEY (player_id, other_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
        FOREIGN KEY (other_id) REFERENCES players (id) ON DELETE CASCADE
    ) WITHOUT ROWID`).run()
    database.prepare(`CREATE INDEX IF NOT EXISTS anticheat_linked_pairs_other ON anticheat_linked_pairs (other_id)`).run()

}
