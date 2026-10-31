# Running Reflipped with Docker

Ready-made Docker setups for running a Reflipped server. For a first public server, the step-by-step [public server guide](../docs/deployment.md) is the easiest place to start; this page explains every setup and option. The [disclaimer about public servers](../deployment/README.md) applies here too.

Each setup has its own folder with a `compose.yaml` and an `.env.example`. Copy the example to `.env` and change it there: `.env` holds your own paths, ports and host names and is never committed.

The Docker commands need root unless your user is in the `docker` group. Either put `sudo` in front, or add yourself with `sudo usermod -aG docker $USER` and log in again (being in that group is as powerful as root).

## Which setup do I need?
| Folder | What it runs | Pick it when |
|---|---|---|
| `stack/` | Reflipped plus a web server (nginx) that serves the game data | One machine does everything. **The usual choice.** |
| `api/` | Reflipped plus the web server, without the game data | The game data comes from somewhere else (an `assets/` machine, or cloud storage). |
| `assets/` | Only the web server with the game data | A separate machine just for the big downloads, next to an `api/` one. |
| `proxy/` | Only Reflipped | You already run nginx, Caddy or Traefik and want to keep using it. |

`stack/`, `api/` and `assets/` all support HTTPS in the same way (see "HTTPS"), and can all sit behind a web server you already run.

## `stack/`: everything on one machine
```sh
cd docker/stack
cp .env.example .env          # CDN_DIR (where the game data is), ports; TLS and PUBLIC_HOST for HTTPS
docker compose up -d --build
curl http://127.0.0.1:8080/healthz      # "ok"
```
Players type `http://<host>:8080`, or `https://<PUBLIC_HOST>` with HTTPS on, when the app asks for the server. The web server hands out the game data files straight from disk and passes everything else to Reflipped, so Reflipped itself only handles the game.

## `api/`: the game server without the game data
The same as `stack/`, but the game data isn't served. Players need both addresses built into the app: `--server https://<game server> --cdn https://<data server>/patch/Live/2.0.0`. Or set `SHELL_CDN` on the game server (see the [public server guide](../docs/deployment.md), "Server settings for the app"), so a normal app finds the data by itself.

Reflipped still reads two small things from a game data folder: the short file lists (`<lang>/entities/files/`) and your `mods/`. Point `CDN_DIR` at the real data if this machine has it; otherwise an almost empty folder is enough:
```sh
mkdir -p skel/en/entities/files      # one per language the data server has
cp -r /path/to/.cdn/mods skel/       # only if you use mods
```
If you use the English translation, this machine needs a copy of it too (see "English translation").

## `assets/`: only the game data
Just the web server, serving `CDN_DIR` under `/patch/Live/2.0.0/`. No Reflipped, no database.
```sh
cd docker/assets && cp .env.example .env && docker compose up -d
curl -I http://<host>:8080/patch/Live/2.0.0/en/entities/2.1.125-android_medium.csv
```
Use `http://<host>:8080/patch/Live/2.0.0` (or `https://<PUBLIC_HOST>/patch/Live/2.0.0` with HTTPS) as the data address for an `api/` server.

## `proxy/`: only Reflipped, for your own web server
Reflipped alone, with its game port open only on the machine itself (`API_BIND`/`API_PORT`, default `127.0.0.1:8000`). HTTPS and the game data downloads are your web server's job. See "Behind an existing reverse proxy".

## HTTPS
Set `TLS` in `.env`. Every option except `off` also needs `PUBLIC_HOST` (your domain); `CERT_NAMES` adds more names or IP addresses, separated by commas. Leave the line `COMPOSE_PROFILES=${TLS}` below it as it is.

| `TLS=` | Certificate | Notes |
|---|---|---|
| empty or `off` | none | Plain HTTP on `HTTP_PORT`. For a home network, or behind a web server that handles HTTPS. |
| `letsencrypt` | free from Let's Encrypt, renewed automatically | Needs a public domain name and port 80 reachable from the internet. |
| `selfsigned` | made up on the spot | **The app doesn't accept it** (see below). |
| `custom` | your own: `fullchain.pem` and `privkey.pem` in `CUSTOM_CERT_DIR` (default `docker/certs/`) | After replacing the files: `docker compose up -d && docker compose exec edge nginx -s reload`. |

For a server that faces the internet directly, set `HTTP_PORT=80` and `HTTPS_PORT=443`. With HTTPS on, plain HTTP only redirects to HTTPS, and a renewed or replaced certificate is picked up within 6 hours. The web server won't start without a certificate, and says so in its log (`docker compose logs edge`).

### Let's Encrypt
```sh
# .env
HTTP_PORT=80
HTTPS_PORT=443
TLS=letsencrypt
PUBLIC_HOST=reflipped.example.com
LE_EMAIL=you@example.com
LE_STAGING=1          # first run: Let's Encrypt's test service, which has no rate limits (its certificate isn't trusted)
```
```sh
docker compose up -d --build
curl -k https://reflipped.example.com/healthz
```
On the first start the certificate is fetched, then the web server starts, and it is renewed automatically from then on (checked twice a day).

When the test run works, switch to a real certificate: `docker compose down`, `docker volume rm reflipped-certs reflipped-certs-acme`, set `LE_STAGING=` (empty), and `docker compose up -d`. Without removing the volumes, the test certificate stays.

### Self-signed
**The app does not accept a self-signed certificate**: it checks certificates like a browser does. Use this only behind something that accepts any certificate (Cloudflare's "Full" mode, or another web server forwarding to this one over HTTPS), or for testing with `curl -k`. The certificate's fingerprint is in `docker compose logs selfsigned-init`. Delete the certificate volumes to make a new one.

## Behind an existing reverse proxy
If you already run nginx, Caddy or Traefik, there are two ways. In both, keep the Docker ports on the machine itself (loopback) so players only come in through your web server, and set `TRUST_PROXY` so Reflipped sees each player's own address.

**A. Your web server forwards everything to one of the setups above** (`stack/`, `api/` or `assets/`, with `TLS=` off and `EDGE_BIND=127.0.0.1`). Works with any web server, including Traefik.
- nginx: `location / { proxy_pass http://127.0.0.1:8080; proxy_set_header Host $http_host; proxy_set_header X-Forwarded-For $remote_addr; }`, plus `underscores_in_headers on;` in the `server` block (the game sends headers such as `device_lang`). A full example with HTTPS is in `proxy/nginx/reflipped.conf`.
- Caddy: `reflipped.example.com { reverse_proxy 127.0.0.1:8080 }`.
- Traefik on the host: `proxy/traefik/dynamic.yml`.
- Traefik in Docker: run `docker compose -f compose.yaml -f ../proxy/traefik/edge.yaml up -d` from the setup's folder, and set `PROXY_NETWORK`, `PUBLIC_HOST`, `TRAEFIK_ENTRYPOINT` and `TRAEFIK_CERTRESOLVER`. For `stack/` and `api/`, also set `TRUST_PROXY=<STACK_SUBNET>,<the Traefik network's subnet>`.

A web server on the same machine is already trusted by default.

**B. Your web server serves the game data itself and passes the rest to Reflipped** (the `proxy/` setup). One step fewer; nginx and Caddy only.
- nginx: `proxy/nginx/reflipped.conf`.
- Caddy: `proxy/caddy/Caddyfile` (Caddy gets the certificate itself).
- A web server in a container: `docker compose -f compose.yaml -f compose.network.yaml up -d` puts Reflipped on `PROXY_NETWORK`. Point your web server at `reflipped:8000` and set `TRUST_PROXY` to that network's subnet.
- Traefik can't serve files, so `proxy/traefik/reflipped.yaml` sends everything to Reflipped, which then serves the game data too. Fine for a few players; for more, use way A.

Traefik needs version 3.6 or newer, and a freshly started container answers 404 for its first few seconds, until its health check passes.

Tested with nginx 1.28, Caddy 2.10 and Traefik 3.6. The translation's download paths were added later and haven't been tried through nginx or Caddy yet.

## English translation
Reflipped can send English text for the units, stories and events that were only ever released in Japanese (see [game assets](../docs/cdn-download.md), "English translation"). It is on by default (`I18N=on` in `.env`), but has to be built once. In `stack/` or `proxy/`:
```sh
mkdir -p ../../.cdn-overlay                        # once, before the first `up`, or Docker creates it owned by root
docker compose --profile i18n run --rm i18n-build  # builds the translation from your game data
docker compose up -d                               # restart: Reflipped reads the translation when it starts
```
The translation is built into `CDN_OVERLAY_DIR` (default `.cdn-overlay`, next to `.cdn`). Build it again, and restart, after a `git pull` that brings new translations; no image rebuild is needed. `I18N_MIN_STATUS=reviewed` ships only text a person has checked. To switch it off, set `I18N=off` and restart: phones get the original text back on their next start.

With `api/` and `assets/` on separate machines, build the translation where the full game data is and copy the `.cdn-overlay` folder to both machines. Behind your own web server, `proxy/nginx/reflipped.conf` and `proxy/caddy/Caddyfile` already serve it; with Traefik, Reflipped serves it itself.

## Day-to-day
- **Updating:** `git pull && docker compose up -d --build`. The database updates itself on start.
- **Players' data:** the database and the log live in the Docker volume `reflipped-data` (`DATA_VOLUME`). It has the same name in every setup, so switching between `stack/`, `api/` and `proxy/` keeps your players. Run only one setup with Reflipped on it at a time.
- **Backups:** `docker compose run --rm backup` copies the database into `BACKUP_DIR` (default `docker/backups/`, which must be writable by user id 1000) and keeps the newest `BACKUP_KEEP`. Scheduling and restoring are in the [public server guide](../docs/deployment.md), "Backups".
- **Admin website:** it has no password, so it only listens on the machine itself (`ADMIN_BIND`/`ADMIN_PORT`, default `127.0.0.1:8001`). Reach it from elsewhere through SSH (`ssh -L 8001:127.0.0.1:8001 <host>`) or a VPN.
- **Co-op:** co-op uses its own port (`COOP_PORT`, 18888), opened directly. Players reach it at `COOP_PUBLIC_HOST`, or at the same address as the game if that is unset.
- **Game data and translation folders** are mounted read-only: Reflipped never writes to them, mods included. An older version of Reflipped wrote a `metadata.json` file into the game data folder; you can delete it.

## Technical details
- **Reflipped's container** is built from the repository (Node.js 22), runs as a normal user with a read-only file system, no extra privileges and all Linux capabilities dropped.
- **The web server's container** (`nginx-unprivileged`) runs the same way, with the game data and translation folders mounted read-only.
- **Caching:** the game data and translation archives have a content hash in their name, so they are sent with a one-year `immutable` cache header, which a CDN in front can use. The few files that can change (file lists, mods) are revalidated on every request. Compression is off for the game data, which is already compressed.
- **Blocked:** directory listings, hidden files, Reflipped's old `metadata.json` and the translation's manifest (403), and any method other than GET and HEAD on the game data (405).
- **Other:** `underscores_in_headers on` (the game's headers), uploads up to 50 MB (for save imports), and `/healthz` answers `ok` for health checks.
- **Trusted addresses:** `TRUST_PROXY` defaults to the setup's own network (`STACK_SUBNET`), so Reflipped only believes a forwarded player address when it comes from the setup's web server or one on the same machine.
- The shared service definitions are in `common/services.yaml`, the nginx config in `common/nginx/` and the helper scripts in `common/scripts/`.

## Coming from `docker/cdn/`
`docker/cdn/` is now `docker/stack/`. Copy your `.env` over and update it:
- `CDN_BIND`/`CDN_PORT` are now `EDGE_BIND`/`HTTP_PORT`;
- `NGINX_SITE=reflipped-cdn-tls` and `--profile tls` are replaced by `TLS=letsencrypt` (add `COMPOSE_PROFILES=${TLS}` from the example);
- `REFLIPPED_UPSTREAM` still works, for a web server container in front of a Reflipped that runs on the host (`http://host.docker.internal:8000`, with `extra_hosts: ["host.docker.internal:host-gateway"]` on the edge service, and Reflipped started with `LISTEN_HOST=0.0.0.0` and `TRUST_PROXY=172.16.0.0/12`).

Volume names changed. Keep your players with `DATA_VOLUME=reflipped-cdn_reflipped-data` (or copy them into the new volume), and your certificate with `CERT_VOLUME=reflipped-cdn_letsencrypt` (or let Let's Encrypt issue a new one). Then stop the old setup with `docker compose -p reflipped-cdn down` (or `-p starpoint-cdn`, for one from before the rename) and start the new one.
