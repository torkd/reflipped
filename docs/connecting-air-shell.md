# Playing on a Reflipped server (Android)

This guide is for players. It turns your own copy of the flipper game's app (the APK file) into the **Reflipped app**, a version of the game that connects to a Reflipped server: one a friend or a community runs, or your own.

You build the app on a computer, then copy it to your phone. It takes about half an hour the first time, most of it waiting for downloads. You can't download a ready-made app instead: the game files have to come from your own APK, and the Adobe AIR tools that package them may only be downloaded by people who accept their licence themselves (see [the AIR SDK licence](air-licence.md)).

Want to run a server instead? See [running Reflipped at home](air-shell-install.md) or [running a public server](deployment.md).

## What you need
- **An Android phone**, or an Android emulator on your computer, with about 12 GB of free space. The game downloads about 10 GB of data the first time it starts. Nearly every phone from recent years works; very old 32-bit phones need a special build (see "Options").
- **A computer** with about 3 GB free:
  - **Linux**: builds directly;
  - **Windows 10 or 11**: builds inside **WSL2**, Windows' built-in Linux;
  - **macOS**, or anything else that runs Docker: builds inside a ready-made **build container**.
- **The server's address**, from whoever runs it, for example `https://wf.example.org` or `http://192.168.1.10:8000`. You type it into the app the first time it starts.
- **The flipper game's original APK, version 0.0.81.** Below, `<game.apk>` stands for its file name. To check you have exactly the right file, run this in a terminal and compare the result with the long code below:
  ```sh
  sha256sum "<game.apk>"      # Linux / WSL2
  shasum -a 256 "<game.apk>"  # macOS
  # eeeab302b4b3bdbe180d59561b38d92ffb85ed395155e778278ed60b3f2ba77f
  ```

## Step 1: get the AIR SDK
The flipper game is built on Adobe AIR, so building the app needs the **AIR SDK**, a free toolkit now published by Wipro at <https://airsdk.wxlift.com>. You download it yourself and accept its licence yourself.

Good to know:
- The free version shows a short AIR logo when the app starts. That's expected; leave it in.
- The free version is meant for individuals and small companies; check the current limit on the website.
- Pick a normal (stable) version, not a beta.

Which file to download:
- **Linux and Windows (WSL2):** the **Linux AIR SDK Manager** (`AIRSDKManager_linux_amd64_<version>.zip`) from <https://airsdk.wxlift.com/download>. Step 2A installs the SDK with it. On Windows 11 the manager's window should open from WSL2, but this hasn't been tried yet; if it doesn't start, get `AIRSDK_Linux.zip` another way and use the `--air-zip` shortcut in step 2A.
- **macOS (Docker):** the Linux SDK itself, `AIRSDK_Linux.zip`, from the download page or the AIR SDK Manager. If your manager only offers the macOS SDK, do this step on a Linux machine or virtual machine. (Not tested on a Mac yet.)

## Step 2A: build on Linux or Windows (WSL2)
**Windows only, once:** open PowerShell as administrator and run `wsl --install -d Ubuntu`. Restart, open **Ubuntu** from the Start menu and create a user. Your Windows files are under `/mnt/c/Users/<you>/` there. Work in your Linux home folder (`cd ~`): it is much faster.

1. **Install the basic tools** (Ubuntu, Debian and WSL2; for Arch Linux see [running Reflipped at home](air-shell-install.md)):
   ```sh
   sudo apt update && sudo apt install -y git curl tar unzip python3 python3-pil
   ```
2. **Download Reflipped** and copy your APK into its folder:
   ```sh
   git clone https://github.com/torkd/reflipped.git reflipped && cd reflipped
   cp "/mnt/c/Users/<you>/Downloads/<game.apk>" .     # WSL2; change the path to where your APK is
   ```
3. **Install the build tools** (Java and the Android tools). They go into one folder, `~/sdk-wf`, and nothing else on your system changes. The script shows a link to Google's Android SDK terms; installing means you accept them (older versions ask you to type `y`).
   ```sh
   client/air-shell/setup-sdk.sh
   ```
4. **Install the AIR SDK.** Unpack the manager, start it, accept the licence, set its install folder to `~/sdk-wf/air-sdks` and install the newest SDK. Then tell Reflipped where it is:
   ```sh
   client/air-shell/setup-sdk.sh --manager-zip ~/Downloads/AIRSDKManager_linux_amd64_<version>.zip
   ~/sdk-wf/bin/airsdkmanager
   client/air-shell/setup-sdk.sh --air-dir ~/sdk-wf/air-sdks/AIRSDK_<version>   # for example AIRSDK_51.5.1
   ```
   Already have `AIRSDK_Linux.zip`? Then `client/air-shell/setup-sdk.sh --air-zip AIRSDK_Linux.zip` does all three lines at once.
5. **Build the app:**
   ```sh
   . ~/sdk-wf/env.sh
   python3 -I client/air-shell/build.py --apk "<game.apk>"
   ```
   Your app is `client/air-shell/build/reflipped-shell.apk` (about 47 MB). On WSL2, copy it to your Windows Downloads folder with `cp client/air-shell/build/reflipped-shell.apk /mnt/c/Users/<you>/Downloads/`.

The build also created your **signing key**, `~/.config/starpoint/air-shell.p12`. Keep it safe: see "Keep your signing key" below.

## Step 2B: build in the container (macOS, or any computer with Docker)
Install Docker Desktop (or Docker Engine on Linux). On a Mac with an Apple chip the build is slower, because the Android tools only exist for Intel/AMD Linux and have to be emulated.

1. **Download Reflipped:** `git clone https://github.com/torkd/reflipped.git reflipped`, or download it as a ZIP from <https://github.com/torkd/reflipped> (the green "Code" button, then "Download ZIP").
2. **Make a work folder**, for example `~/reflipped-build`, and put exactly two files in it: your APK and `AIRSDK_Linux.zip`. The finished app and your signing key will appear in this folder too.
3. **Prepare the builder** (once, and again after you update Reflipped). From the Reflipped folder:
   ```sh
   docker build --platform linux/amd64 -t reflipped-shell-builder -f client/air-shell/container/Dockerfile client/air-shell
   ```
   The builder only holds Reflipped's own scripts: no game files and no AIR SDK.
4. **Build the app:**
   ```sh
   docker run --rm -it --platform linux/amd64 -v reflipped-shell-sdk:/sdk -v ~/reflipped-build:/work reflipped-shell-builder
   ```
   The first time, it downloads Java and the Android tools (about 1 GB, kept for next time) and shows a link to Google's Android SDK terms, which you accept by going ahead (older tools ask you to type `y`). Then it writes `reflipped-shell.apk` and your signing key `air-shell.p12` into your work folder. Options (see "Options") go after the name `reflipped-shell-builder`, for example `… reflipped-shell-builder --arch armv7`.

To free the space again: `docker volume rm reflipped-shell-sdk` removes the downloaded tools, `docker image rm reflipped-shell-builder` the builder.

## Step 3: install the app on your phone or emulator
1. Copy `reflipped-shell.apk` to your phone, any way you like: a USB cable, a cloud drive, or a message to yourself.
2. Open it in the phone's Files app and tap **Install**.
3. Android asks once whether that app may install apps ("Install unknown apps"): allow it.
4. Google Play Protect may want to scan the app, because it doesn't come from the Play Store: allow it.

Look for the Reflipped icon: the app installs next to the official one, without replacing it.

**On an emulator:** most emulators install an APK when you drag it onto their window; otherwise use `adb install -r reflipped-shell.apk`. The emulator must be able to run ARM apps, as most current ones can. If the server runs on the same computer, the emulator usually reaches it at `http://10.0.2.2:8000` (Android's own emulator) or at the computer's network IP.

(Developers can also install it over a cable or Wi-Fi with `adb install -r reflipped-shell.apk`; see [running Reflipped at home](air-shell-install.md).)

## Step 4: first launch
1. You see the AIR logo, then the game's own start screens.
2. **Type the server's address** and tap **Connect**. If you leave out `http://` or `https://`, the app uses `https://`. If it says "No Reflipped server at that address", check the address, and that your phone can reach the server (for a server at home: same Wi-Fi).
3. The game signs in and creates your player on that server.
4. **The game data downloads**: about 10 GB. Use Wi-Fi and keep the app open on screen. If the download gets interrupted, it carries on from where it stopped the next time you open the app.
5. The tutorial starts. Have fun!

If the server can't be reached on a later start, the app offers **Retry** and **Change server**. Changing the server starts a new player on the new server.

## Keep your signing key
The first build creates a signing key: `~/.config/starpoint/air-shell.p12` (step 2A) or `air-shell.p12` in your work folder (step 2B). **Keep a backup of that file.**

Android only lets you update the app if the new version is signed with the same key. With a different key you have to uninstall the old app first, which deletes the downloaded game data and your player's link to the server: your progress stays on the server, but the new install starts as a new player.

**Updating to a new Reflipped version:** get the latest Reflipped (`git pull` in its folder), build again the same way, and install the new app over the old one.

## Options
Add these to the `build.py` command (step 2A) or after `reflipped-shell-builder` (step 2B):

| Option | What it does |
|---|---|
| `--server https://wf.example.org` | Builds the server's address into the app. It never asks for an address and has no "Change server". Handy if you only ever play on one server. |
| `--arch armv7` | Builds a separate app for old 32-bit phones. |
| `--out <file>` | Saves the app under another name (step 2A only). |

To sign with a key of your own instead of the generated one, set `SHELL_KEYSTORE=<path to .p12>` and `SHELL_KEYSTORE_PASS=<password>` before building (step 2B: `docker run -e SHELL_KEYSTORE=/work/<file> -e SHELL_KEYSTORE_PASS=… …`, with the key in your work folder).

## Problems
| What you see | What to do |
|---|---|
| "No Reflipped server at that address" | Check the address and port with whoever runs the server. Open `<address>/shell/config` in your phone's browser: it should show a short line starting with `{"reflipped":1`. |
| "App not installed" or "package conflicts" | An older copy signed with a different key is installed. Uninstall it first (this deletes its downloaded data). |
| The download stops when the screen turns off | Keep the app open on screen. It carries on the next time you start it. |
| Container: "put the AIR SDK zip … in your folder" | `AIRSDK_Linux.zip` must be in your work folder. |
| Container: "more than one APK in your folder" | Leave only one APK in the folder, or name it with `-e APK=<file name>`. |
| A black screen after the logo, or an "Error No." message | Tell whoever runs the server, with the time it happened. |

More help with the build: [running Reflipped at home](air-shell-install.md), "Troubleshooting".
