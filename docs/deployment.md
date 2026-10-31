# Running a public server

This guide puts Reflipped on the internet, so players anywhere can join with the address you give them. It uses the ready-made Docker setup, which brings a web server for the big game data downloads and free, automatic HTTPS certificates from Let's Encrypt. Other layouts (game data on a separate machine, or behind a web server you already run) are in the [Docker guide](../docker/README.md).

Please read the [disclaimer](../deployment/README.md) first.

## What you need
- A Linux machine with a public IP address, and about 15 GB of disk for the English game data plus room for your players.
- A domain name you can point at it, say `reflipped.example.com`.
- A copy of the game's data files (see [game assets](cdn-download.md)).
- Bandwidth: every new player downloads about 10 GB once. 100 new players is about 1 TB.

## Step by step
1. **Point your domain at the machine.** Create an A record (and an AAAA record, if the machine has IPv6) for `reflipped.example.com`. Check with `dig +short reflipped.example.com`.
2. **Open the firewall** for TCP ports 80 (certificate checks and redirects), 443 (the game and its downloads) and 18888 (co-op). Keep 8000 and 8001 closed: the admin website has no password.
3. **Install Docker** Engine with the compose plugin (`docker compose version` should answer).
4. **Get Reflipped and the game data.** `git clone` Reflipped, and put the game data (the `en/`, `ko/`, … folders) in `.cdn/` inside it, or anywhere else and point `CDN_DIR` at it in the next step.
5. **Configure.** `cd docker/stack && cp .env.example .env`, then set in `.env`:
   ```sh
   HTTP_PORT=80
   HTTPS_PORT=443
   TLS=letsencrypt
   PUBLIC_HOST=reflipped.example.com
   LE_EMAIL=you@example.com
   LE_STAGING=1          # first run only: a test certificate, see step 7
   ```
6. **First start.** `docker compose up -d --build`. Then `docker compose logs letsencrypt-init` should end with a saved certificate, and `curl -k https://reflipped.example.com/healthz` should answer `ok`.
7. **Real certificate.** The first run used Let's Encrypt's test service, so a mistake doesn't run into its rate limits. Now switch to the real one: `docker compose down`, `docker volume rm reflipped-certs reflipped-certs-acme`, set `LE_STAGING=` (empty) in `.env`, and `docker compose up -d`. Now `curl https://reflipped.example.com/healthz` works without `-k`.
8. **Check the game side.** Both should answer `200`:
   ```sh
   curl -sI https://reflipped.example.com/patch/Live/2.0.0/en/entities/2.1.125-android_medium.csv
   curl -s -o /dev/null -w '%{http_code}\n' 'https://reflipped.example.com/infodesk/v2/app?appVer=0.0.81'
   ```
9. **Play.** Build the app as in [the player guide](connecting-air-shell.md) and type `https://reflipped.example.com` on first launch. Send your players that guide and your address.
10. **Admin website.** It only listens on the server itself. From your own computer, run `ssh -L 8001:127.0.0.1:8001 <server>` and open http://localhost:8001.

Steps 6 and 7 haven't been tried yet against Let's Encrypt from a real public server; the rest has been tested with other certificates. If you run into a problem there, please report it.

## Looking after the server
- **Logs:** `docker compose logs -f reflipped`.
- **Updating:** `git pull && docker compose up -d --build`. The database updates itself on start.
- **Backups:** see below. Set them up on day one.

## Backups
A backup is a copy of the player database, made while the server keeps running, and checked after it is written. Each backup is a folder named after the time it was made (in UTC, for example `20261029T181715Z/`). Only the newest 14 are kept (`BACKUP_KEEP`; `0` keeps all).

- **Docker:** `docker compose run --rm backup` writes into `docker/backups/` (`BACKUP_DIR`). Create that folder once and hand it to the container's user: `mkdir -p docker/backups && sudo chown 1000:1000 docker/backups`. To back up every night, add a cron line on the host: `30 4 * * * cd /srv/reflipped/docker/stack && docker compose run --rm backup >/dev/null`.
- **Without Docker (systemd):** the `reflipped-backup.timer` makes one every day around 04:30, into `/var/lib/reflipped/backups`.
- **By hand, from a checkout:** `npm run backup` (into `.backups/`).

Copy the backups somewhere else too (another machine, cloud storage): a backup on the same disk is lost with that disk.

**Restoring.** Stop Reflipped, delete `wdfp_data.db-wal` and `wdfp_data.db-shm` from the database folder (they belong to the old database), copy the backup folder's contents in, and start Reflipped again. Keep the `.version` file from the backup.
- Docker: `docker compose stop reflipped`, then
  ```sh
  docker run --rm -v reflipped-data:/data -v "$PWD/../backups/<name>":/restore:ro alpine sh -c 'rm -f /data/database/wdfp_data.db-wal /data/database/wdfp_data.db-shm && cp -a /restore/. /data/database/ && chown -R 1000:1000 /data/database'
  ```
  then `docker compose start reflipped`.
- systemd: `systemctl stop reflipped`, then as root `rm -f /var/lib/private/reflipped/database/wdfp_data.db-{wal,shm}` and `cp -r /var/lib/private/reflipped/backups/<name>/. /var/lib/private/reflipped/database/`, then `systemctl start reflipped`.

## Without Docker: systemd
`deployment/linux/reflipped.service` runs Reflipped straight from a checkout as a locked-down system service: it runs as a throwaway user, can only write to its own data folder (`/var/lib/reflipped`), and logs to the system journal. HTTPS and the game data downloads are left to a web server in front of it, such as the nginx or Caddy configs in `docker/proxy/`, pointed at `127.0.0.1:8000`.

1. Install Node.js 22 or newer system-wide (in `/usr/bin` or `/usr/local/bin`; a Node.js installed in your home folder isn't visible to the service).
2. Put Reflipped outside `/home`, which the service can't see, and build it:
   ```sh
   sudo git clone https://github.com/torkd/reflipped.git /opt/reflipped && cd /opt/reflipped && sudo npm ci && sudo npm run build
   ```
   The service reads ports and `CDN_DIR` from the checkout's `.env`.
3. Install the service files with the right folder:
   ```sh
   for f in reflipped.service reflipped-backup.service reflipped-backup.timer; do
     sudo sed "s~WorkingDirectory=/reflipped~WorkingDirectory=/opt/reflipped~" deployment/linux/$f | sudo tee /etc/systemd/system/$f >/dev/null
   done
   ```
4. Start it: `sudo systemctl daemon-reload && sudo systemctl enable --now reflipped reflipped-backup.timer`. Check with `curl http://127.0.0.1:8000/news` and follow the log with `journalctl -u reflipped -f`.
5. Put the web server in front, and open only ports 80, 443 and 18888 (co-op) in the firewall.

- **Changing settings:** `sudo systemctl edit reflipped`, and add `Environment=` lines under `[Service]`, for example `Environment=I18N=off` to switch the English translation off. The translation is on by default once built: run `npm run i18n:build` as the user that owns `/opt/reflipped`, then restart (see [game assets](cdn-download.md), "English translation"). Reflipped only reads the game data and translation folders, so they stay read-only, mods included.
- **Updating:** `cd /opt/reflipped && sudo git pull && sudo npm ci && sudo npm run build && sudo systemctl restart reflipped`.
- **Coming from the older service file**, which kept the database in the checkout's `.database/` folder: copy that folder's contents to `/var/lib/private/reflipped/database/` before the first start.

## Many players: where the downloads come from
The game data is a set of about 480 files that never change, so they can be served by anything that serves static files:
- **Small server:** Reflipped serves them itself. That's the default, and fine for a handful of players.
- **Public server (recommended):** the web server in front serves them straight from disk, as the Docker setup does. Reflipped then only handles the game itself.
- **Many players:** the downloads are most of your traffic. Put the same files on cloud storage behind a CDN, preferably one that doesn't charge for downloads, and point the app at it with `SHELL_CDN` (below). Copy your `mods/` folder too, and, if you use the English translation, the archives from `.cdn-overlay/<lang>/` into an `overlay/<lang>/` folder there (Reflipped still needs its own copy of `.cdn-overlay`). Check the provider's terms about hosting game files.

## Server settings for the app
When a player types your address, the app asks the server for its settings:
- `SERVER_NAME`: the name your server shows (default `Reflipped`).
- `SHELL_CDN`: where the app downloads the game data from, if not from this server; the full address of the folder that holds the `en/`, `ko/`, … folders, without a trailing slash. Because the app asks on every start, you can move the downloads later without players rebuilding their app.

## Behind a web server you already run
- Set `TRUST_PROXY` to the address of your web server (for example `127.0.0.1`), so Reflipped sees each player's own address. Without it, every player shares one rate limit. (`RATE_LIMIT=0` turns rate limiting off.)
- The game sends headers with underscores in their names (`device_lang`, `short_udid`). nginx drops those unless you add `underscores_in_headers on;`. Caddy and Traefik pass them through.
- Ready-made configs for nginx, Caddy and Traefik are in the [Docker guide](../docker/README.md), "Behind an existing reverse proxy".
