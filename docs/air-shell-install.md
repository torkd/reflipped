# Running Reflipped at home

This guide runs a Reflipped server on one computer, for you and the people on your home network. Players connect with the [Reflipped app](connecting-air-shell.md) over Wi-Fi.

- Only want to play? Follow the [player guide](connecting-air-shell.md): you don't need a server of your own, and **Local play** runs one on your phone.
- Want players to join over the internet? See [running a public server](deployment.md).

The steps are written for Linux. On Windows and macOS the server runs the same way with Node.js; only the firewall step differs.

## What you need
- A computer that stays on while you play, with about 15 GB free.
- **Node.js 24.7 or newer** and **git**.
- A copy of the game's data files (see [game assets](cdn-download.md)): the app downloads them from your server.

## Step by step
1. **Install the tools**, for example:
   ```sh
   sudo pacman -S --needed git nodejs npm        # Arch Linux
   sudo apt install -y git nodejs npm            # Debian, Ubuntu (check that the Node.js version is 24.7 or newer)
   node --version                                # v24.7.0 or newer
   ```
   If your system's Node.js is older, install a current one from <https://nodejs.org/>.
2. **Download Reflipped:**
   ```sh
   git clone https://github.com/torkd/reflipped.git && cd reflipped
   npm ci
   ```
3. **Add the game data:** put your copy in a folder called `.cdn` inside the `reflipped` folder, so that you have `.cdn/en/`. Check it with `npm run cdn`.
4. **Start the server:**
   ```sh
   npm run dev
   ```
   It says "Reflipped is listening on http://0.0.0.0:8000". Leave it running in its terminal.
5. **Create your admin account:** open http://localhost:8001 on this computer. The first visit asks you to create the admin login.
6. **Let your phone in:** open ports 8000 (the game) and 18888 (co-op) in the firewall (see [Firewall](#firewall)).
7. **Find this computer's address:** `ip -4 route get 1.1.1.1 | grep -oP 'src \K\S+'` prints something like `192.168.1.169`.
8. **Test it:** open `http://<that address>:8000/game/news` in your phone's browser. It should show the Reflipped news page.
9. **Play:** in the Reflipped app, tap **Add** in My servers, type `<that address>:8000`, and join.

## Firewall
Check which firewall you use: `systemctl is-active firewalld ufw`.
- **ufw:** `sudo ufw allow 8000/tcp` and `sudo ufw allow 18888/tcp`.
- **firewalld:** find your Wi-Fi's zone with `firewall-cmd --get-active-zones`, then (with that zone):
  ```sh
  sudo firewall-cmd --permanent --zone=<zone> --add-port=8000/tcp --add-port=18888/tcp
  sudo firewall-cmd --reload
  ```
- **Windows / macOS:** allow Node.js through the firewall when the system asks, for private networks.

## The admin website
At http://localhost:8001, behind your admin login, you can:
- see your players, download or import their saves, and send them mail and gifts;
- set the server's name, description and picture shown in the app;
- pick the event mode under **Settings**, and jump to any event on the **Calendar** page (see [events and rewards](events.md));
- write news posts for the in-game news page;
- change rewards, login calendars and other settings.

`npm run dev` also opens the admin website to your home network at `http://<this computer's address>:8001`. To keep it on this computer only, delete the file `.env.dev`. Never open port 8001 on a network you don't trust.

An administrator account also gets an **Admin panel** entry in the app (**Menu → Account Info**), which asks for the same login.

## Optional extras
- **English text for the Japanese-only content:** run `npm run i18n:build` once and restart (see [game assets](cdn-download.md#english-translation)).
- **Score Scramble** needs one file from the Chinese game data (see [game assets](cdn-download.md#chinese-game-data-optional-for-score-scramble)).
- **Mods:** see the [modding guide](modding.md).
- **Local play data for your players:** see [running a public server](deployment.md#server-settings-for-the-app), "Offering Local play's data".

## Updating
1. Stop the server (Ctrl+C in its terminal).
2. Run `git pull && npm ci`.
3. Start it again with `npm run dev`. The database updates itself; your players and accounts stay.

## Problems
| What you see | What to do |
|---|---|
| `Reflipped needs Node.js 24.7 or newer` | Install a newer Node.js, then run `npm ci` again. |
| "No Reflipped server at that address", or "Can't reach …" in the app | Check that the server is running, the address and port, and the firewall (steps 6–8). Type `http://` in front of the address if the app tried `https://`. |
| The news page doesn't open on the phone | The phone and computer aren't on the same network, or the firewall blocks port 8000. |
| Co-op rooms don't connect | Port 18888 is blocked. |
| "Error No.F1132" in the game | The app can't reach the server: check steps 4–8. |
