# Running Reflipped at home

This guide sets up everything on one computer: the Reflipped server, and the Reflipped app for your Android phone, which then plays on that server over your home Wi-Fi. It is written for **Arch Linux** (tested on EndeavourOS with a Galaxy S22 Ultra), but the steps are the same on other Linux systems apart from the package names in step 0.

- Only want to play on someone else's server (also on Windows and macOS)? Follow [playing on a Reflipped server](connecting-air-shell.md) instead.
- Want other people to join over the internet? See [running a public server](deployment.md).

## Overview
| Step | What | Time |
|---|---|---|
| 0 | Install the basic tools | 1 min |
| 1 | Download Reflipped, get the APK | 2 min |
| 2 | Install the build tools (Java, Android tools) | 5 min, ~1 GB |
| 3 | Install the AIR SDK | 5 min, ~1 GB |
| 4 | Add the game data and start the server | 3 min |
| 5 | Let your phone through the firewall | 1 min |
| 6 | Build the app | 1 min |
| 7 | Install it on your phone | 5 min |

The build tools in steps 2 and 3 all go into one folder, `~/sdk-wf`, and nothing is installed system-wide. One command removes them again (see "Removing everything").

## 0. Basic tools
```sh
sudo pacman -S --needed git curl tar unzip zstd xz python python-pillow coreutils nodejs npm
```
Reflipped needs Node.js 22 or newer; Arch's current version works. You don't need Java or Android packages from pacman: step 2 brings its own.

## 1. Reflipped and the APK
```sh
git clone https://github.com/torkd/reflipped.git
cd reflipped
```

You need the flipper game's original Android APK, **version 0.0.81** (below, `<game.apk>` stands for its file name). Put it in the `reflipped` folder, and check that it is exactly the right file:
```sh
sha256sum "<game.apk>"
# eeeab302b4b3bdbe180d59561b38d92ffb85ed395155e778278ed60b3f2ba77f
```
Git ignores APK files, so it can't end up in the project by accident.

## 2. Build tools: Java and the Android tools
```sh
client/air-shell/setup-sdk.sh
```
This installs Java 17, the Android command-line tools and `adb` (the tool that talks to your phone) into `~/sdk-wf`, and writes `~/sdk-wf/env.sh`, which makes them available in the terminal you run it in.

While it runs, it shows Google's Android SDK terms: installing means accepting them (older tools ask you to type `y`). Every download is checked against the checksum its publisher lists. Running the script again is safe: it skips what is already there. `--dry-run` shows what it would download, `--dir` picks another folder.

## 3. The AIR SDK
The flipper game is built on Adobe AIR, so the app is packaged with the **AIR SDK**, now published by Wipro. Reflipped never downloads or ships it for you: you get it yourself and **accept its licence yourself**. The free version shows a short AIR logo when the app starts (leave it in), and is meant for individuals and small companies; check the current terms at <https://airsdk.wxlift.com>. Use a stable version, not a beta. More in [the AIR SDK licence](air-licence.md).

1. Open <https://airsdk.wxlift.com/download>, accept the licence and download the **Linux AIR SDK Manager** (`AIRSDKManager_linux_amd64_<version>.zip`).
2. Unpack it into `~/sdk-wf`:
   ```sh
   client/air-shell/setup-sdk.sh --manager-zip ~/Downloads/AIRSDKManager_linux_amd64_1.5.1.zip
   ```
   On Arch this also fetches one older system library the manager needs (`libxml2.so.2`, from Arch's official `libxml2-legacy` package). Without it, the manager shows a misleading "32-bit AIR on 64-bit systems" message and doesn't start.
3. Start the manager with this command (not the original program file):
   ```sh
   ~/sdk-wf/bin/airsdkmanager
   ```
   In the manager, accept the licence, set the install folder to `/home/<you>/sdk-wf/air-sdks`, and install the newest AIR SDK (we used **51.5.1**).
4. Tell Reflipped where the SDK is:
   ```sh
   ls ~/sdk-wf/air-sdks                                     # for example AIRSDK_51.5.1
   client/air-shell/setup-sdk.sh --air-dir ~/sdk-wf/air-sdks/AIRSDK_51.5.1
   ```
   This also fixes two packaging problems in the SDK's Linux tools. Don't run the SDK's own `bin/configure_linux.sh`: it leaves stray files behind.

To check that it worked:
```sh
. ~/sdk-wf/env.sh
java -jar "$AIR_HOME/lib/adt.jar" -version      # 51.5.1.1
```

## 4. Game data and the server
The server hands the game's data files (about 10 GB for English) to your phone on first start. They aren't part of Reflipped: put your copy in a folder called `.cdn` inside the `reflipped` folder (see [game assets](cdn-download.md)).

Then install and start the server:
```sh
node --version          # v22 or newer
npm ci
npm run dev             # "Reflipped is listening on http://0.0.0.0:8000"
                        # "Reflipped admin UI is listening on http://127.0.0.1:8001"
```
Leave it running in its own terminal.

- **The game server** listens on port 8000, open to your home network, so your phone can reach it.
- **The admin website** (players, save import, mail, the server's date) is at http://localhost:8001. It has no password, so by default it only opens on this computer. `npm run dev` also opens it to your home network, so you can reach it at `http://<this computer's IP>:8001` from another device; delete the file `.env.dev` to keep it on this computer only. Never open port 8001 on a network you don't trust.

## 5. Firewall
Your phone connects to this computer on port 8000, and on port 18888 for co-op, so both must be let in. Check which firewall you use:
```sh
systemctl is-active firewalld ufw
```
- **firewalld:** find the zone of your Wi-Fi connection, then open the ports in it. These rules last until the next reboot; add `--permanent` to keep them.
  ```sh
  firewall-cmd --get-active-zones                   # for example "block" on wlan0
  sudo firewall-cmd --zone=block --add-port=8000/tcp
  sudo firewall-cmd --zone=block --add-port=18888/tcp
  ```
  To close them again, run the same commands with `--remove-port`.
- **ufw:** `sudo ufw allow 8000/tcp` and `sudo ufw allow 18888/tcp` (to close: `sudo ufw delete allow 8000/tcp`, and the same for 18888).

To test, open `http://<this computer's IP>:8000/news` in your phone's browser: it should show the Reflipped news page.

## 6. Build the app
```sh
. ~/sdk-wf/env.sh
ip -4 route get 1.1.1.1 | grep -oP 'src \K\S+'          # this computer's IP, for example 192.168.1.169
python3 -I client/air-shell/build.py --apk "<game.apk>"
```
- **The app** is `client/air-shell/build/reflipped-shell.apk` (about 47 MB).
- **The server address:** the app asks for it on first launch. Type `http://<this computer's IP>:8000`, with the `http://`: without it the app assumes `https://`. Because the address isn't built in, the same app works with any server, and a new IP doesn't need a new build.
- **Building the address in:** `--server http://192.168.1.169:8000` builds it into the app, which then never asks (and has no "Change server"). Useful for a build you only use with one server.
- **Signing key:** the first build creates `~/.config/starpoint/air-shell.p12`. **Keep it.** Android only installs an update over your app if it is signed with the same key, and every build prints which key it used. To use your own key, set `SHELL_KEYSTORE=<path to a .p12>` and `SHELL_KEYSTORE_PASS=<password>`. (The path still carries the project's old name, so existing installs can keep updating.)
- **Old 32-bit phones:** add `--arch armv7` for a separate app.

The app installs next to the official one, without replacing it.

## 7. Install it on your phone
**The simple way:** copy the APK to your phone and open it there, as in [the player guide](connecting-air-shell.md), step 3.

**With adb** (handy if you build often, and needed for reading the app's log). `adb` is already in `~/sdk-wf` after `. ~/sdk-wf/env.sh`.

Over Wi-Fi (Android 11 or newer, phone and computer on the same network):
1. **Developer options:** Settings → About phone → tap **Build number** 7 times.
2. **Wireless debugging:** Settings → System → Developer options → switch on **Wireless debugging**.
3. **Pair:** tap **Wireless debugging → Pair device with pairing code**, then on the computer:
   ```sh
   adb pair <ip>:<pairing-port>          # enter the 6-digit code
   ```
4. **Connect** with the address shown under **"IP address & Port"** on the main Wireless debugging screen. Its port is different from the pairing port, and changes each time wireless debugging is switched on:
   ```sh
   adb connect <ip>:<port>
   adb devices                           # should list the phone as "device"
   ```
   "Connection refused" almost always means the pairing port, or an old port, was used.

Over USB: switch on **USB debugging** in Developer options, plug the phone in, accept the prompt on the phone, and check with `adb devices`.

Then install and start the app:
```sh
adb install -r client/air-shell/build/reflipped-shell.apk
```
If `adb devices` lists your phone twice, add `-s <ip>:<port>` to every adb command, for example `adb -s 192.168.1.91:37029 install …`. Switch wireless debugging off when you're done: anyone you paired with can control the phone while it is on.

## What happens on first launch
1. The AIR logo, then the game's own start screens.
2. The app asks for the server address (step 6), signs in, and creates your player on the server.
3. The game data downloads from your server: about 10 GB. Keep the app open on screen until it finishes.
4. The tutorial starts.

What the server supports so far is listed in the [README](../README.md#what-works).

## For developers: reading the app's log
```sh
adb logcat -s ReflippedShell AndroidRuntime
```
The app logs every call the game makes into Reflipped's replacement plugins, with its arguments and result, for example:
```
I/ReflippedShell: com.sesisoft.KakaoGameSdk.KGSESSION_START("561429") -> null
I/ReflippedShell: pinball.checkapp.isRootUser() -> false
```
During the first download, `assetDownload:` lines show the progress.

A normal build hides the game's own script errors, so a bug may just show as a black screen. A **debug build** prints them:
```sh
python3 -I client/air-shell/build.py --apk "<game.apk>" \
    --debug --out client/air-shell/build/reflipped-shell-debug.apk
adb install -r client/air-shell/build/reflipped-shell-debug.apk
adb logcat | grep -aE 'ReflippedShell|Error #|TypeError|ArgumentError|SyntaxError'
```
A debug build pauses for about 15 seconds at startup (it waits for a debugger, then carries on by itself). `--stage-only` runs the build without packaging, as a quick check.

## Removing everything
```sh
client/air-shell/setup-sdk.sh --uninstall       # deletes ~/sdk-wf (asks first)
rm -rf ~/.android                               # adb's keys and cache (only if you don't use adb otherwise)
rm -f ~/.config/starpoint/air-shell.p12         # the app's signing key
rm -rf client/air-shell/build                   # the built app
adb uninstall air.com.kakaogames.wdfp.starpoint # the app on the phone
```
`--uninstall` only deletes a folder the script created itself.

## Troubleshooting
| What you see | Why | What to do |
|---|---|---|
| `setup-sdk.sh: missing 'zstd'` (or curl, unzip, …) | A basic tool is missing | Install it (step 0) |
| The AIR SDK Manager says "Running 32-bit AIR 51.3 on 64-bit systems…" and doesn't start | A system library is missing | Run `setup-sdk.sh --manager-zip …` again and start the manager with `~/sdk-wf/bin/airsdkmanager` |
| `bash: syntax error near unexpected token 'newline'` | `<version>` was typed as it is | Use the real folder name from `ls ~/sdk-wf/air-sdks` |
| `aapt tool failed: … cannot execute binary file`, or `aapt … undefined symbol` | The SDK's Linux tools weren't fixed up | `setup-sdk.sh --air-dir <SDK folder>` |
| The server fails with `better_sqlite3.node` … `NODE_MODULE_VERSION`, or `Could not locate the bindings file` | The server's packages were installed with another Node.js version | Run `npm ci` again with the Node.js you start the server with |
| `adb connect` says "connection refused" | The pairing port, or an old port | Use the port under "IP address & Port" on the Wireless debugging screen |
| `adb: more than one device/emulator` | The phone is listed twice | `adb -s <ip>:<port> …` |
| The app shows its logo, then a black screen | A game error that a normal build hides | Make a debug build (see "For developers") and look for `Error #` in the log |
| "Error No.F1132" in the game | The app couldn't get the server list from Reflipped | Check that the server is running and reachable (steps 4–5) |
| "No Reflipped server at that address", or later "Can't reach …" | Firewall, wrong IP or port, `https://` instead of `http://`, or the server isn't running | Steps 4–6; open `http://<ip>:8000/shell/config` in the phone's browser: it should show a line starting with `{"reflipped":1` |
