# /latest/api/index.php/mail/index
                       
## Request
### Headers
```
Host: na.wdfp.kakaogames.com
Accept-Encoding: deflate, gzip
Accept: text/xml, application/xml, application/xhtml+xml, text/html;q=0.9, text/plain;q=0.8, text/css, image/png, image/jpeg, image/gif;q=0.8, application/x-shockwave-flash, video/mp4;q=0.9, flv-application/octet-stream;q=0.8, video/x-flv;q=0.7, audio/mp4, application/futuresplash, */*;q=0.5
User-Agent: Mozilla/5.0 (Android; U; en-US) AppleWebKit/533.19.4 (KHTML, like Gecko) AdobeAIR/51.0
x-flash-version: 51,0,1,1
Connection: Keep-Alive
Referer: app:/worldflipper_android_release.swf
Content-Type: application/x-www-form-urlencoded
PARAM: 2b57c5ad60215c8adab623348c346415149930a2
GAME-APP-ID: 635343250
SHORT_UDID: 376249241
UDID: 8959A034-38B2-49A9-9F0C-6663706E07DD0521
RES_VER: 2.1.121
COUNTRY_CODE: us
APP_ID: 561429
KAKAO_PID: 12
DEVICE_LANG: en
DEVICE_NAME: SM-T860 12
APP_VER: 0.0.81
DEVICE: 2
Content-Length: 176
```

### Body
```
{
  "api_count": 15,
  "viewer_id": "<redacted>",
  "app_secret": "8a4421148b884608bb96862f3988d832",
  "current_page": 1,
  "app_admin": "c14e19deb5c734b93a5e65c4d2099e0c"
}
```

## Response
### Headers
```
Date: Fri, 07 Jun 2024 21:07:14 GMT
Content-Type: application/x-msgpack
Transfer-Encoding: chunked
Connection: keep-alive
Server: nginx
x-php-processing-time: 0.3119
x-result-code: 1
param: a26951f9cd9b2fd36bf39e3ba262273c9e7fdc67
```

### Body
```
{
  "data_headers": {
    "force_update": false,
    "asset_update": false,
    "short_udid": 376249241,
    "viewer_id": "<redacted>",
    "servertime": 1717794434,
    "result_code": 1
  },
  "data": {
    "mail": [],
    "total_count": 0
  }
}
```


## Notes
No capture has a non-empty `mail` list, so the entry format below comes from the client's parser (`pinball.remote.mail.index.MailIndexRealRemote`) and the `Mail` model in the SWF.

Entry fields: `id` (int), `type` (int), `type_id` (int or null), `number` (int), `reason_id` (int), `subject` and `description` (string or null), `create_time` and `receive_time` (`YYYY-MM-DD HH:MM:SS`), `reward_limit_time` (same format, or null), `reward_period_limited` (bool).

- `receive_time` is `"0000-00-00 00:00:00"` for mail that hasn't been received.
- `type`: 1 item, 3 paid beads, 4 free beads, 5 unit, 6 armament, 7 star crumbs, 8 mana, 9 pooled exp, 10 bond tokens, 11 boss boost points, 12 boost points, 13 title (degree), 14 daily challenge point, 15 periodic reward point. Types 1, 5, 6, 13, 14 and 15 need `type_id`; the others must not send one, or the client throws. 2 is undefined.
- Types 14 and 15 (`DailyChallengePoint(type_id)`, `PeriodicRewardPoint(type_id)` in the client): `type_id` is a row of `quest/event/daily_challenge_point` or `reward/periodic_reward_point`, which the client looks up (a missing row throws). The mail shows the row's name and icon ("::name:: × ::number::").
  - Daily challenge points are the attempts left at a solo boss challenge (id 1), Nostalgia Trials (251), Chrono Trial (5001) or an event quest. Master columns: 0 `string_id`, 1 `max_challenge_point` (the cap), 2 `max_display_challenge_point` (unused by the client; a new player's list holds exactly these, so Reflipped takes it as what the day starts with), 3 `is_recovery` ("left today" or "left"), 4 `name`, 5 `thumbnail_path`, 6 `description`, 7 `start_time`, 8 `end_time` ("(None)" is open-ended). `campaign/daily_challenge_point_campaign` adds points during a campaign: 1 `daily_challenge_point_id`, 2 `additional_challenge_point`, 3 `start_time`, 4 `end_time`. The client counts `point` plus the `additional_point` of each campaign in the entry's `campaign_list` whose period is open, and receives a mail only if that total plus the mail is at most `max_challenge_point` (otherwise "This message cannot be opened due to storage limits." and no request).
  - Periodic reward points are the special rewards left at a hard multi (co-op) boss ("::point:: special reward(s) remaining"). Columns: 1 `max_reward_point`, 2 `recovery_point`, 3 `recovery_cycle` (0: "More added at 5 am daily", the only cycle the client names), 4–8 as above. The client never checks a cap for them; Reflipped keeps them within `max_reward_point`.
  - Balances: `user_daily_challenge_point_list` is part of every reply's common data, and the client upserts its entries by `id`; `user_periodic_reward_point_list` is read from `/load`, `mail/receive`, `mail/receive_all` and the battle finish replies, upserted the same way. Reflipped's mail replies send only the entries that changed. The client never refills either: Reflipped's daily reset (05:00 Japan time) sets each recovering daily challenge point open that game day to at least column 2 and adds `recovery_point` to each daily reward point open that day, up to the cap.
  - In 0.0.81's master data every campaign and every periodic reward point has ended by 2024-12-17, and the dated daily challenge points by 2025-04-28 (Japan time); ids 1, 251 and 5001 are open-ended.
- `reason_id` is looked up in the client's mail reason master table, which supplies subject and description. Only an id missing from that table uses the mail's own `subject`/`description` (both must be set, or the client shows the text for reason 999999). Reflipped mail uses reason 0 with its own text.
- The list holds only unreceived mail: `total_count` is their number, and receiving shrinks it (see the `mail/receive` capture). Pages hold 100 mails; `current_page` starts at 1.
- `create_time`, `receive_time` and `reward_limit_time` are Japan time, like the `history/receive` capture's dates. Checked on a device: sent in UTC, a mail sent a minute earlier showed as "9 hours ago" and its expiry 9 hours early. Save files keep UTC.
- Single receive errors are result codes in the original: 2001 deleted, 2002 already received, 2004 outdated. Reflipped doesn't send them yet (it answers 400), since it never lists such mail.
- After `mail/receive_all` the client shows only a text dialog (`receive_all_dialog_all`, or `receive_all_dialog_partly` plus the reasons from the skip counts), and the unit join movie if `character_list` is not empty. It has no item recap for claim all; only a single `mail/receive` opens a detail dialog for the mail. The server can't add one.
