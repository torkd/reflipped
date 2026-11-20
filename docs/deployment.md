# Running a public server

This guide puts Reflipped on the internet, so players anywhere can join with the address you give them. It uses the ready-made Docker setup, which brings a web server for the big game data downloads and free, automatic HTTPS certificates from Let's Encrypt. Other layouts (game data on a separate machine, or behind a web server you already run) are in the [Docker guide](../docker/README.md).

Please read the [disclaimer](../deployment/README.md) first.

## What you need
- A Linux machine with a public IP address, and about 15 GB of disk for the English game data plus room for your players.
- A domain name you can point at it, say `reflipped.example.com`.
- A copy of the game's data files (see [game assets](cdn-download.md)), or none if your players install a [game data pack](game-data-pack.md).
- Bandwidth: every new player downloads about 10 GB once; 100 new players is about 1 TB.

## Step by step
1. **Point your domains at the machine.**
   - An A record (and AAAA, if the machine has IPv6) for `reflipped.example.com`.
   - A second name for co-op, such as `coop.reflipped.example.com`, with **only** an A record (no AAAA): co-op needs IPv4.
2. **Open the firewall** for TCP ports 80, 443 and 18888 (co-op). Keep 8000 and 8001 closed: the admin website is for you alone.
3. **Install Docker** Engine with the compose plugin (`docker compose version` should answer).
4. **Get Reflipped and the game data:** `git clone https://github.com/torkd/reflipped.git`, and put the game data (the `en/`, `ko/`, … folders) in `.cdn/` inside it.
5. **Configure:** `cd reflipped/docker/stack && cp .env.example .env`, then set in `.env`:
   ```sh
   HTTP_PORT=80
   HTTPS_PORT=443
   TLS=letsencrypt
   PUBLIC_HOST=reflipped.example.com
   COOP_PUBLIC_HOST=coop.reflipped.example.com
   LE_EMAIL=you@example.com
   LE_STAGING=1          # first run only: a test certificate, see step 7
   ```
6. **First start:** `docker compose up -d --build`. Then `curl -k https://reflipped.example.com/healthz` should answer `ok`.
7. **Real certificate:** `docker compose down`, `docker volume rm reflipped-certs reflipped-certs-acme`, set `LE_STAGING=` (empty) in `.env`, and `docker compose up -d`. Now `curl https://reflipped.example.com/healthz` works without `-k`.
8. **Create your admin account**, still in `docker/stack`:
   ```sh
   export ADMIN_API_TOKEN=$(openssl rand -hex 32)
   echo "ADMIN_API_TOKEN=$ADMIN_API_TOKEN" >> .env
   docker compose up -d
   curl -s -o /dev/null -w '%{redirect_url}\n' -H "Authorization: Bearer $ADMIN_API_TOKEN" \
        --data-urlencode username=admin --data-urlencode 'password=<a long password>' -d role=admin \
        http://127.0.0.1:8001/api/user/create
   ```
   It answers with an address ending in `?message=created`.
9. **Open the admin website** from your own computer: `ssh -L 8001:127.0.0.1:8001 <server>`, then http://localhost:8001. Log in and turn on two-step login on your account page.
10. **Name your server:** on the admin website, **Settings → Server identity**: name, description, picture and your community, help, rules and privacy links.
11. **Play:** in the Reflipped app, tap **Add** in My servers and type `https://reflipped.example.com`. Send your players the [player guide](connecting-air-shell.md) and your address.

Steps 6 and 7 haven't been tried yet against Let's Encrypt from a real public server; the rest has been tested with other certificates. If you run into a problem there, please report it.

## Looking after the server
- **Logs:** `docker compose logs -f reflipped`.
- **Updating:** `git pull && docker compose up -d --build`. The database updates itself on start.
- **Backups:** set them up on day one (below).

## Backups
A backup is a checked copy of the player database, made while the server runs, in a folder named after its time (UTC). The newest 14 are kept (`BACKUP_KEEP`; `0` keeps all).

To set up nightly backups with Docker:
1. Create the folder once: `mkdir -p docker/backups && sudo chown 1000:1000 docker/backups`.
2. Try it: `docker compose run --rm backup`.
3. Add a cron line on the host: `30 4 * * * cd /srv/reflipped/docker/stack && docker compose run --rm backup >/dev/null`.
4. Copy the backups to another machine or cloud storage too: a backup on the same disk is lost with that disk.

Without Docker, the systemd timer makes one every day around 04:30, into `/var/lib/reflipped/backups`; from a plain checkout, `npm run backup` writes one into `.backups/`. Don't back up by copying `wdfp_data.db` alone while the server runs: it can miss recent changes.

**To restore a backup:**
1. Stop Reflipped: `docker compose stop reflipped` (systemd: `systemctl stop reflipped`).
2. Replace the database with the backup's contents, deleting the old `wdfp_data.db-wal` and `wdfp_data.db-shm` files:
   - Docker:
     ```sh
     docker run --rm -v reflipped-data:/data -v "$PWD/../backups/<name>":/restore:ro alpine sh -c 'rm -f /data/database/wdfp_data.db-wal /data/database/wdfp_data.db-shm && cp -a /restore/. /data/database/ && chown -R 1000:1000 /data/database'
     ```
   - systemd, as root: `rm -f /var/lib/private/reflipped/database/wdfp_data.db-{wal,shm}` and `cp -r /var/lib/private/reflipped/backups/<name>/. /var/lib/private/reflipped/database/`.
3. Start Reflipped again: `docker compose start reflipped` (systemd: `systemctl start reflipped`).

## Server settings for the app
Most settings are on the admin website's **Settings** page and apply at once. Settings marked as variables go in the Docker setup's `.env` (see the [Docker guide](../docker/README.md#server-settings)), or under `Environment=` with systemd, and need a restart.

- **Server identity** (Settings): the name, description, type label and picture players see on your server's card, and the links behind the app's Help and Community pages and its rules and privacy pages (https only).
- **App versions** (Settings, Reflipped app): *Oldest supported app version* turns older apps away with "This server needs a newer Reflipped app". *Newest app version* only announces an update, once, with a button to your *Update page address* (blank: the public player guide).
- **Offering the update in the app** (same card): fill in *Update APK address* and *Update APK SHA-256*, and players can tap **Install update**. Android only accepts an update signed like the installed app, so use the ready-made app's release file (and its `.sha256`) for players with the ready-made app, or your own build for an app you built and handed out.
- **Players importing their own save** (Settings, Rewards): off by default, since a save file can be edited. It needs Managed reward rules (see [events and rewards](events.md)). Signed-in players can then import once a day on the player portal.
- **Game data download:** offered when your server has the game data in `.cdn`. Without it, or with `GAME_DATA_DOWNLOAD=off`, players install a [game data pack](game-data-pack.md); your mods, event schedule and translation are still sent.
- **Offering Local play's data:** players who choose **Local play** need the game's data tables once. To offer them:
  1. Build the file in the Reflipped folder, with `.cdn` in place: `npm run datapack -- --out /path/to/datapack` (about 7 MB).
  2. Set `DATA_PACK_SERVE_DIR=/path/to/datapack` and restart.
  3. Build it again after each Reflipped update.
  Build it from the game's unmodified files; mods belong in `mods/`.
- **Admin panel in the app:** administrator accounts see an **Admin panel** entry in the app, which opens your admin website's normal login. For an admin website behind your own HTTPS proxy, set `SHELL_ADMIN_URL=https://admin.example.org/`.

## News
The admin website's **News** page runs the in-game news page.
- **Your own posts:** write a title and text and press **Publish**. A blank line starts a paragraph, `## ` starts a heading, `- ` a list item; web addresses become links. You can edit, hide or delete any post.
- **Automatic event posts:** the server announces every event, summoning portal and boosted-drops week a week before it opens, with what it offers (in Classic, Accelerated and Manual mode). A button on the News page turns them off and on.

## Security (anti-cheat)
The admin website's **Security** page helps on servers with shared rankings, raids and co-op. The server flags battle results no honest game could send, for you to review.
- **Mode:** *Log only* (the default) records flags and changes nothing for players; *Enforce* also keeps impossible results off the shared boards; *Off* records nothing. Players are never told.
- **Cheat review:** the flags, newest first. *Dismiss* a flag that is nothing.
- **Restrict** a player: they keep playing, but stay off rankings and raid boards, and out of strangers' co-op rooms. **Block** also signs them out and unbinds their phone.

## Many players: where the downloads come from
The game data downloads are most of your traffic.
- **Small server:** Reflipped serves them itself (the default).
- **Public server:** the Docker setup's web server serves them straight from disk.
- **Many players:** put the same files on cloud storage behind a CDN and set `SHELL_CDN` to the address of the folder that holds `en/`, `ko/`, … (no trailing slash). Copy your `mods/` folder there too, and, with the English translation, the archives from `.cdn-overlay/<lang>/` into an `overlay/<lang>/` folder. Players don't need a new app when you move the downloads. Check the provider's terms about hosting game files.

## Without Docker: systemd
`deployment/linux/reflipped.service` runs Reflipped from a checkout as a locked-down system service. HTTPS and the game data downloads are left to a web server in front of it, such as the nginx or Caddy configs in `docker/proxy/`.
1. Install Node.js 24.7 or newer system-wide (in `/usr/bin` or `/usr/local/bin`).
2. Get and build Reflipped outside `/home`:
   ```sh
   sudo git clone https://github.com/torkd/reflipped.git /opt/reflipped && cd /opt/reflipped && sudo npm ci && sudo npm run build
   ```
3. Install the service files:
   ```sh
   for f in reflipped.service reflipped-backup.service reflipped-backup.timer; do
     sudo sed "s~WorkingDirectory=/reflipped~WorkingDirectory=/opt/reflipped~" deployment/linux/$f | sudo tee /etc/systemd/system/$f >/dev/null
   done
   ```
4. Start it: `sudo systemctl daemon-reload && sudo systemctl enable --now reflipped reflipped-backup.timer`, then check with `curl http://127.0.0.1:8000/healthz`.
5. Put your web server in front, pointed at `127.0.0.1:8000`, and open only ports 80, 443 and 18888 in the firewall.

- **Settings:** `sudo systemctl edit reflipped`, then add `Environment=` lines under `[Service]`, for example `Environment=I18N=off`.
- **Updating:** `cd /opt/reflipped && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl restart reflipped`.
- **Logs:** `journalctl -u reflipped -f`.
- **Coming from the older service file**, which kept the database in the checkout's `.database/` folder: copy that folder's contents to `/var/lib/private/reflipped/database/` before the first start.

## Behind a web server you already run
- Let `/patch/Live/2.0.0/schedule/` reach Reflipped even if the web server serves the rest of `/patch/Live/2.0.0/` from disk: Reflipped makes those files itself.
- **nginx:** add `underscores_in_headers on;` in the `http` block (or the players' default `server`), or the game shows H400 right after connecting.
- Send `X-Forwarded-Proto`, and set `TRUST_PROXY` to the web server's address (for example `127.0.0.1`) so each player gets their own rate limit. With the Docker setups, leave `TRUST_PROXY` unset.
- Ready-made configs for nginx, Caddy and Traefik: [Docker guide](../docker/README.md), "Behind an existing reverse proxy".

## Other settings
| Variable | What it does |
|---|---|
| `NEW_ACCOUNTS_PER_HOUR` | New guest accounts per hour across the server (600 by default, `0` for no limit). |
| `QUEST_PERIOD_CHECK=off` | Lets event quests start outside their event. |
| `STAMINA=off` | Makes every battle free. |
| `RATE_LIMIT=0` | Turns rate limiting off. |
| `PORTAL_REGISTRATION=closed` | Closes sign-up on the player portal, so only you create accounts. |
| `SQLITE_CACHE_MB`, `SQLITE_MMAP_MB` | Default database memory (16 MiB cache, no memory map), until changed in **Settings → Server housekeeping → Database**. Keep the defaults unless you have measured a reason. |

Process and route metrics are at `/api/server/metrics` on the admin website (or with `ADMIN_API_TOKEN` as a Bearer token); `/api/server/health` shows the running version.
