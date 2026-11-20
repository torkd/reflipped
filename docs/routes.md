# API Endpoints
Every server endpoint the game is known to call, and how far Reflipped has got with each. This page is for contributors; for a plain list of what works, see the [feature list](features.md). Each linked page shows the data the game and the server exchange.

> [!WARNING]
> This list may be incomplete and/or outdated. Check for any open pull requests or branches to make any final calls.

> [!WARNING]
> This is not a definitive list of every API endpoint that the game client interacts with.

Symbol | Meaning
:------- | :-------
:white_check_mark: | Complete
:warning: | Partial
:construction: | In Progress
:no_entry: | Incomplete & Not Being Worked On

### Server operations

Endpoint | Listener | Purpose
:------- | :------- | :-------
`GET /healthz` | Game | Minimal HTTP liveness check.
`GET /shell/datapack`, `GET /shell/datapack/<archive>` | Game | The server data pack the Reflipped app's Local play needs, offered when the owner sets `DATA_PACK_SERVE_DIR` to a folder built by `npm run datapack`: the first answers its version, size and SHA-256 and the download address, the second is the zip. Both answer 404 when no pack is offered.
`GET /api/server/metrics` | Admin | Process and route metrics; requires an admin login or API token when authentication is enabled.
`POST /api/server/thumbnail` | Admin | Uploads the server card image (multipart, one PNG, JPEG or WebP file of at most 512 KB and 8192 × 8192 pixels); it replaces the image URL setting. `POST /api/server/thumbnail/remove` removes it.
`GET /api/server/health` | Admin | The running server's version, commit and build time, the app protocol and the oldest supported app version, and uptime; same login as metrics.

### ``na.wdfp.kakaogames.com/latest/api/index.php``
Endpoint | Status
:------- | :-------
[/active_mission/receive](./routes/active_mission_receive.md) | :white_check_mark:
``/active_mission/real_incentive_transitioned_url`` _(no capture; acknowledged only)_ | :white_check_mark:
``/active_mission/receive_incentive`` _(the real-prize campaign, which isn't run: always answered "campaign over"; no capture)_ | :white_check_mark:
``/agreement/agree_all``, ``/agreement/agree_privacy``, ``/agreement/agree_terms`` _(the game's own terms dialog, which this version doesn't show; acknowledged only)_ | :white_check_mark:
[/asset/get_path](./routes/asset_get_path.md) | :warning:
[/asset/version_info](./routes/asset_version_info.md) | :warning:
``/attention/action`` _(no capture; shape from the client)_ | :white_check_mark:
[/attention/check](./routes/attention_check.md) | :white_check_mark:
``/attention/logger`` _(no capture; shape from the client)_ | :white_check_mark:
[/bonus/shown](./routes/bonus_shown.md) | :white_check_mark:
``/bonus/shown_expired_premium`` _(no capture; acknowledged only)_ | :white_check_mark:
``/box_gacha/close`` | :white_check_mark:
[/box_gacha/exec](./routes/box_gacha_exec.md) | :warning:
[/box_gacha/get_box_list](./routes/box_gacha_get_box_list.md) | :white_check_mark:
``/box_gacha/reset`` _(refilling the last box once empty; no capture, shape from the client)_ | :white_check_mark:
``/carnival_event/get_party`` _(no capture; shape from the client)_ | :white_check_mark:
``/carnival_event/index`` _(no capture; shape from the client)_ | :white_check_mark:
[/character/add_character_from_town](./routes/character_add_character_from_town.md) | :white_check_mark:
``/character/bulk_over_limit`` _(no capture; shape from the client)_ | :white_check_mark:
[/character/learn_mana_node](./routes/character_learn_mana_node.md) | :white_check_mark:
[/character/open_mana_board](./routes/character_open_mana_board.md) | :white_check_mark:
[/character/over_limit](./routes/character_over_limit.md) | :white_check_mark:
[/character/receive_bond_token](./routes/character_receive_bond_token.md) | :white_check_mark:
[/character/set_illustration_settings](./routes/character_set_illustration_settings.md) | :white_check_mark:
``/character/set_protection`` _(no capture; shape from the client)_ | :white_check_mark:
``/character_election/get_vote_status`` (no capture, shape from the client) | :white_check_mark:
``/character_election/vote`` (no capture, shape from the client) | :white_check_mark:
``/comic/get_list`` _(the Menu's comics; not answered yet: the comics and their pictures haven't been found, and an empty list would crash the game; no capture)_ | :no_entry:
[/encyclopedia/index](./routes/encyclopedia_index.md) | :white_check_mark: Per-player read history; known entries remain available.
[/encyclopedia/read_keyword](./routes/encyclopedia_read_keyword.md) | :white_check_mark: Reading is remembered across reconnects.
``/encyclopedia/unlock_keyword`` _(no capture; shape from the client)_ | :white_check_mark: Repeated unlocking preserves read history.
``/equipment/bulk_sell_stack`` _(no capture; shape from the client)_ | :white_check_mark:
``/equipment/bulk_upgrade`` _(no capture; shape from the client)_ | :white_check_mark:
[/equipment/set_protection](./routes/equipment_set_protection.md) | :white_check_mark:
[/equipment/sell_equipment](./routes/equipment_sell_equipment.md) | :white_check_mark:
[/equipment/sell_stack](./routes/equipment_sell_stack.md) | :white_check_mark:
[/equipment/upgrade](./routes/equipment_upgrade.md) | :white_check_mark:
``/exchange/star_crumb`` _(the Star Sliver Exchange; no capture, shape from the client)_ | :white_check_mark:
``/event/raid/battle/start`` _(no capture; shape from the client)_ | :white_check_mark:
``/event/raid/get_boss`` _(no capture; shape from the client)_ | :white_check_mark:
``/event/raid/party`` _(no capture; shape from the client)_ | :white_check_mark:
``/event/raid/ranking`` _(no capture; shape from the client)_ | :white_check_mark:
``/event/raid/ranking/party`` _(no capture; shape from the client)_ | :white_check_mark:
``/event/raid/ranking_reward`` _(no capture; shape from the client)_ | :white_check_mark:
``/event/raid/summary`` _(no capture; shape from the client)_ | :white_check_mark:
``/event/rush/summary`` | :white_check_mark:
``/event/rush/select_folder`` | :white_check_mark:
``/event/rush/ranking`` | :white_check_mark:
``/event/rush/ranking/played_party`` | :white_check_mark:
``/event/rush/aggregated_time`` | :white_check_mark:
``/event/rush/party`` | :white_check_mark:
``/event/rush/battle/start`` | :white_check_mark:
``/event/rush/reset`` | :white_check_mark:
[/ex_boost/draw](./routes/ex_boost_draw.md) | :white_check_mark:
[/ex_boost/first_draw](./routes/ex_boost_first_draw.md) | :white_check_mark:
[/ex_boost/select](./routes/ex_boost_select.md) | :white_check_mark:
``/expod/bulk_stack_to_exp`` _(no capture; shape from the client)_ | :white_check_mark:
[/expod/inject_exp](./routes/expod_inject_exp.md) | :white_check_mark:
[/expod/stack_to_exp](./routes/expod_stack_to_exp.md) | :white_check_mark:
``/follow/add`` _(no capture; shape from the client)_ | :white_check_mark:
``/follow/bulk_edit`` _(no capture; shape from the client)_ | :white_check_mark:
``/follow/delete`` _(no capture; shape from the client)_ | :white_check_mark:
[/follow/lists](./routes/follow_lists.md) | :white_check_mark:
``/follow/search_id`` _(no capture; shape from the client)_ | :white_check_mark:
``/follow/search_kakao_pid`` _(the search by ID; no capture, shape from the client)_ | :white_check_mark:
``/follow/search_twitter`` _(no Twitter link: always empty)_ | :white_check_mark:
/friend/follow _(GET web page a shared profile link opens; no capture)_ | :warning:
[/gacha/exchange_character](./routes/gacha_exchange_character.md) | :white_check_mark:
``/gacha/exchange_equipment`` | :white_check_mark:
[/gacha/exec](./routes/gacha_exec.md) | :warning:
``/gacha/shown_converted`` _(no capture; acknowledged only)_ | :white_check_mark:
``/gxshield/scanrisk`` (Xshield detection report) | :no_entry:
``/history/practice_battle`` _(Practice Combat battle history; no capture, shape from the client)_ | :white_check_mark:
[/history/receive](./routes/history_receive.md) | :white_check_mark:
``/history/score_attack_event_battle`` (Score Scramble battle history; no capture, shape from the client) | :white_check_mark:
[/how_to_get/get_list](./routes/how_to_get_get_list.md) | :white_check_mark:
``/item/sell`` _(no capture; shape from the client)_ | :white_check_mark:
``/item/use_item`` (stamina items; no capture, shape from the client) | :white_check_mark:
[/load](./routes/load.md) | :white_check_mark:
``/lounge/create`` _(People's Choice lounge; no capture, shape from the client)_ | :white_check_mark:
``/lounge/create_lounge_failure`` _(no capture; logged only)_ | :white_check_mark:
[/lounge/get_list](./routes/lounge_get_list.md) | :white_check_mark:
``/lounge/prepare`` _(no capture, shape from the client)_ | :white_check_mark:
``/lounge/restore`` _(no capture, shape from the client)_ | :white_check_mark:
``/lounge/search`` _(no capture, shape from the client)_ | :white_check_mark:
``/lounge/select`` _(no capture, shape from the client)_ | :white_check_mark:
``/lounge/share`` _(no capture; acknowledged only, no invitations for lounges)_ | :warning:
[/mail/index](./routes/mail_index.md) | :white_check_mark:
[/mail/receive](./routes/mail_receive.md) | :white_check_mark:
[/mail/receive_all](./routes/mail_receive_all.md) | :white_check_mark:
[/mission/get_mission_progress](./routes/mission_get_mission_progress.md) | :white_check_mark:
[/mission/update_mission_progress](./routes/mission_update_mission_progress.md) | :warning:
[/multi_battle_quest/abort](./routes/multi_battle_quest_abort.md) | :white_check_mark:
[/multi_battle_quest/create_room](./routes/multi_battle_quest_create_room.md) | :warning:
[/multi_battle_quest/disband_room](./routes/multi_battle_quest_disband_room.md) | :white_check_mark:
[/multi_battle_quest/finish](./routes/multi_battle_quest_finish.md) | :warning:
[/multi_battle_quest/get_rooms](./routes/multi_battle_quest_get_rooms.md) | :warning:
/multi_battle_quest/play_continue _(no capture; shape from single_battle_quest/play_continue)_ | :warning:
[/multi_battle_quest/prepare](./routes/multi_battle_quest_prepare.md) | :warning:
[/multi_battle_quest/select_room](./routes/multi_battle_quest_select_room.md) | :warning:
/multi_battle_quest/restore_room _(no capture; shape from the client)_ | :warning:
/multi_battle_quest/search_room _(no capture; shape from the client)_ | :warning:
[/multi_battle_quest/share_room](./routes/multi_battle_quest_share_room.md) | :white_check_mark:
[/multi_battle_quest/start](./routes/multi_battle_quest_start.md) | :warning:
[/multi_battle_quest/summon](./routes/multi_battle_quest_summon.md) | :warning:
/multi_battle_quest/verify_access_token _(no capture; shape from the client: room links)_ | :warning:
/multi_invitation/join _(GET web page a shared room link opens; no capture)_ | :warning:
[/multi_special_exchange/exchange_character](./routes/multi_special_exchange_exchange_character.md) | :white_check_mark:
``/multi_special_exchange/multi_draw_ticket`` _(no capture; shape from the client)_ | :white_check_mark:
[/multi_special_exchange/single_draw_ticket](./routes/multi_special_exchange_single_draw_ticket.md) | :white_check_mark:
[/option/update](./routes/option_update.md) | :white_check_mark:
[/option/update_in_battle](./routes/option_update_in_battle.md) | :white_check_mark:
``/party/check_word`` _(the party name check; no capture, shape from the client)_ | :white_check_mark:
[/party/edit](./routes/party_edit.md) | :white_check_mark:
``/party/publish`` _(shows a party's code; no capture, shape from the client)_ | :white_check_mark:
``/party/refer`` _(the party behind a code another player shared; no capture, shape from the client)_ | :white_check_mark:
[/party_group/edit](./routes/party_group_edit.md) | :white_check_mark:
[/payment/item_list](./routes/payment_item_list.md) | :white_check_mark:
``/profile/get_degree_list`` | :white_check_mark:
[/profile/get_my_profile](./routes/profile_get_my_profile.md) | :white_check_mark:
``/profile/get_profile`` _(another player's profile; no capture, shape from the client)_ | :white_check_mark:
``/profile/rename`` _(no capture; shape from the client)_ | :white_check_mark:
``/profile/update_degree`` | :white_check_mark:
``/profile/update_comment`` (a code from the server's website typed as the comment links the device to an account) | :white_check_mark:
``/profile/update_profile_settings`` _(no capture; shape from the client)_ | :white_check_mark:
``/quest/get_recent_other_player_party`` _(the suggested parties under a battle; no capture, shape from the client)_ | :white_check_mark:
``/ranking_event/get_summary`` | :white_check_mark:
``/ranking_event/receive_reward`` | :white_check_mark:
[/reproduce/post](./routes/reproduce_post.md) | :white_check_mark:
[/shop/buy](./routes/shop_buy.md) | :white_check_mark:
``/shop/get_campaign_lineup_id`` _(the lineup chosen in a shop's select item campaign; no capture, shape from the client)_ | :white_check_mark:
``/shop/recover_stamina`` (50 beads for 100 stamina; no capture, shape from the client) | :white_check_mark:
[/shop/get_sales_list](./routes/shop_get_sales_list.md) | :warning:
``/shop/set_campaign_lineup_id`` _(no capture; shape from the client)_ | :white_check_mark:
[/single_battle_quest/abort](./routes/single_battle_quest_abort.md) | :white_check_mark:
[/single_battle_quest/finish](./routes/single_battle_quest_finish.md) | :white_check_mark:
[/single_battle_quest/play_continue](./routes/single_battle_quest_play_continue.md) | :white_check_mark:
[/single_battle_quest/start](./routes/single_battle_quest_start.md) | :white_check_mark:
[/sns/get](./routes/sns_get.md) | :white_check_mark:
``/special_exchange/buy_ticket`` _(no capture; never sells: the ticket was paid-only)_ | :white_check_mark:
``/special_exchange/enter_campaign`` _(no capture; shape from the client)_ | :white_check_mark:
``/special_exchange/exchange_character`` _(no capture; shape from the client)_ | :white_check_mark:
``/special_exchange/exchange_equipment`` _(no capture; shape from the client)_ | :white_check_mark:
``/start_dash_exchange/buy_ticket`` _(the Start Dash bundle; no capture, shape from the client)_ | :white_check_mark:
``/start_dash_exchange/exchange_character`` _(the Start Dash bundle; no capture, shape from the client)_ | :white_check_mark:
[/story_quest/finish](./routes/story_quest_finish.md) | :white_check_mark:
``/tool/agreement`` _(the game's own terms flow, which this version doesn't run; no capture)_ | :no_entry:
[/tool/get_header_response](./routes/tool_get_header_response.md) | :white_check_mark:
[/tool/signup](./routes/tool_signup.md) | :white_check_mark:
``/tool/unregister`` _(deleting the save from the game's account menu: kept 30 days for the admin to restore; no capture, shape from the client)_ | :white_check_mark:
``/tool/user_reset`` _(a developer tool the game never calls; no capture)_ | :no_entry:
[/tutorial/finish_trigger](./routes/tutorial_finish_trigger.md) | :white_check_mark:
[/tutorial/update_step](./routes/tutorial_update_step.md) | :white_check_mark:

### ``gc-infodesk-zinny3.kakaogames.com``
Endpoint | Status
:------- | :-------
[/v2/appGroup](./routes/v2_appGroup.md) | :white_check_mark:
[/v2/app](./routes/v2_app.md) | :warning:

### ``gc-openapi-zinny3.kakaogames.com``
The Reflipped app only signs in here (`/service/v4/auth/loginDevice`), naming its app version and build in the `Reflipped-App-Version` and `Reflipped-App-Build` headers, which the admin Players page shows. The other requests come from the original app's login library, when it is pointed at the server instead. The agreement, log and promotion requests store nothing: they answer as the original did for a player with no promotions.

Endpoint | Status
:------- | :-------
[/service/v3/agreement/getForLogin](./routes/service_v3_agreement_getForLogin.md) | :white_check_mark:
[/service/v3/agreement/set](./routes/service_v3_agreement_set.md) | :white_check_mark:
[/service/v3/auth/loginGoogle](./routes/service_v3_auth_loginGoogle.md) | :no_entry:
[/service/v3/log/writeRoundLog](./routes/service_v3_log_writeRoundLog.md) | :white_check_mark:
[/service/v3/log/writeSdkBasicLog](./routes/service_v3_log_writeSdkBasicLog.md) | :white_check_mark:
[/service/v3/player/heartbeat](./routes/service_v3_player_heartbeat.md) | :white_check_mark:
[/service/v3/promotion/checkUrlPromotion](./routes/service_v3_promotion_checkUrlPromotion.md) | :white_check_mark:
[/service/v3/promotion/getStartingPopups](./routes/service_v3_promotion_getStartingPopups.md) | :white_check_mark:
[/service/v3/promotion/popup/getList](./routes/service_v3_promotion_popup_getList.md) | :white_check_mark:
[/service/v3/push/token/register](./routes/service_v3_push_token_register.md) | :white_check_mark:
[/service/v3/util/country/get](./routes/service_v3_util_country_get.md) | :white_check_mark:
[/service/v3/zat/login](./routes/service_v3_zat_login.md) | :white_check_mark:
[/service/v4/auth/loginDevice](./routes/service_v4_auth_loginDevice.md) | :white_check_mark:
[/service/v4/device/accessToken/create](./routes/service_v4_device_accessToken_create.md) | :warning:
### Reflipped only (game server, no counterpart in the original game)
Endpoint | Status
:------- | :-------
`GET /shell/config` (public app connection check: name, description, type, optional thumbnail, online mode, active event mode and acceleration, server version and commit, app protocol, oldest supported app version, newest announced app version with its update page and notes, CDN, the game files' base and layers and the languages it can restore (so the app can keep downloaded files when switching servers), whether the server offers the base game files for download (otherwise the app asks for a game data pack), whether a data pack for Local play is offered, and available sign-in choices) | :white_check_mark:
`GET /shell/thumbnail` (the server card image uploaded on the admin Settings page; `/shell/config` names it by an absolute URL on the address the app asked, with `?v=` naming the version) | :white_check_mark:
`POST /shell/restore` (the base copies of the game files another server's overlays or mods changed: the app sends the files' language, their base and the paths those layers wrote or deleted, and gets a zip of the base copies plus a `.removed.csv` for paths the base doesn't have, so it can keep its downloaded files when switching servers; 404 when this server's CDN folder lacks that language's base archives or `GAME_DATA_DOWNLOAD=off`, 409 for another base; `/shell/config` lists the languages it can restore) | :white_check_mark:
`POST /shell/session` (current device proof returns its account/admin hint; the admin browser still requires its separate login) | :white_check_mark:
`POST /portal/shell/logout` (device proof releases game sessions without deleting the save or its binding) | :white_check_mark:
`POST /portal/save` (a signed-in player replaces their own save with a file, when the server's owner allows it and the reward rules are Managed; once a day) | :white_check_mark:

With modern event schedules, `POST /api/server/events` saves mode, pace, admin travel and reward settings atomically. `GET /api/server/clock` includes the separate content view. Global clock changes and the old per-user travel switch return 409; use Settings instead. Historical clock compatibility remains available with `EVENT_SCHEDULING=off`. Automatic reward management returns 403 for admin gifts, save imports, developer unlock/restore and progress resets.

### Admin mail catalog

These GET routes are available on the admin listener and require an admin login or API token when authentication is enabled. Images are available when the corresponding CDN assets are present.

Endpoint | Purpose
:------- | :-------
`/api/catalog` | Mail picker names, filters and available thumbnail positions.
`/api/catalog/sheet` | Shared item and armament thumbnail sheet.
`/api/catalog/thumbnail/units/:id` | Portrait for a unit in the mail catalog.

## In-game browser pages

These read-only pages are on the public game listener. They do not need an account or expose a player's save.

| Page | What it shows |
|---|---|
| `/game/odds` | Portals open on the shared server calendar and a selector for other portal odds. |
| `/game/odds/<id>` | Actual per-draw unit or armament probabilities, including guaranteed draws. |
| `/game/events` | Events open on the shared server calendar; a player's personal calendar may differ. |
| `/game/support` | Connection/account help and the server owner's contact page, if configured. |
| `/game/community` | The server owner's community link, if configured. |
| `/game/terms` | Server information and the owner's terms link, if configured. |
| `/game/privacy` | Information the server stores and the owner's privacy link, if configured. |
| `/game/credits` | Reflipped and Starpoint credits; original game notices remain accessible separately in the app. |

The pages work in a browser. The Reflipped app's new menu integration still awaits a phone check.
