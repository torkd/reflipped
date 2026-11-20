# Building the Reflipped app

Most players don't need this: the [ready-made app](connecting-air-shell.md) works on every server. Build the app yourself if you want to change it, give your players an app with your server built in, or play an app with the game already inside.

The build takes about half an hour the first time, mostly downloads. It runs on **Linux**, on **Windows 10 or 11** inside WSL2, and on **macOS** (or anything with Docker) inside a build container.

## What you need
- **About 3 GB free** on the computer.
- **The flipper game's original APK, version 0.0.81.** Below, `<game.apk>` stands for its file name. Check that it's exactly the right file; the result must be the long code in the comment:
  ```sh
  sha256sum "<game.apk>"      # Linux / WSL2
  shasum -a 256 "<game.apk>"  # macOS
  # eeeab302b4b3bdbe180d59561b38d92ffb85ed395155e778278ed60b3f2ba77f
  ```
- **The AIR SDK**, which you download yourself (step 1).

## 1. Get the AIR SDK
The flipper game is built on Adobe AIR, so the app is packaged with the free **AIR SDK**, published by Wipro. Reflipped never downloads or ships it: you download it and accept its licence yourself (see [the AIR SDK licence](air-licence.md)).

1. Open <https://airsdk.wxlift.com/download> and accept the licence.
2. Download a stable version (not a beta):
   - **Linux and Windows:** the **Linux AIR SDK Manager** (`AIRSDKManager_linux_amd64_<version>.zip`), or the SDK itself, `AIRSDK_Linux.zip`, if it's offered.
   - **macOS:** the Linux SDK, `AIRSDK_Linux.zip`.

The free version shows a short AIR logo when the app starts. That's expected; leave it in.

## 2A. Build on Linux or Windows (WSL2)
**Windows only, once:** open PowerShell as administrator and run `wsl --install -d Ubuntu`. Restart, open **Ubuntu** from the Start menu and create a user. Work in your Linux home folder (`cd ~`); your Windows files are under `/mnt/c/Users/<you>/`.

1. **Install the basic tools:**
   ```sh
   sudo apt update && sudo apt install -y git curl tar unzip python3 python3-pil clang lld llvm   # Ubuntu, Debian, WSL2
   sudo pacman -S --needed git curl tar unzip zstd xz python python-pillow clang lld llvm         # Arch Linux
   ```
2. **Download Reflipped** and copy your APK into its folder:
   ```sh
   git clone https://github.com/torkd/reflipped.git && cd reflipped
   cp "/mnt/c/Users/<you>/Downloads/<game.apk>" .     # change the path to where your APK is
   ```
3. **Install the build tools** (Java, the Android tools and Node.js 24) into one folder, `~/sdk-wf`. The script shows a link to Google's Android SDK terms; going ahead means you accept them.
   ```sh
   client/air-shell/setup-sdk.sh --node
   ```
4. **Install the AIR SDK.** With `AIRSDK_Linux.zip`, one line does it:
   ```sh
   client/air-shell/setup-sdk.sh --air-zip ~/Downloads/AIRSDK_Linux.zip
   ```
   With the SDK Manager instead: unpack and start it, set its install folder to `~/sdk-wf/air-sdks`, install the newest SDK, then point Reflipped at it:
   ```sh
   client/air-shell/setup-sdk.sh --manager-zip ~/Downloads/AIRSDKManager_linux_amd64_<version>.zip
   ~/sdk-wf/bin/airsdkmanager
   client/air-shell/setup-sdk.sh --air-dir ~/sdk-wf/air-sdks/AIRSDK_<version>   # for example AIRSDK_51.5.1
   ```
5. **Build the app:**
   ```sh
   . ~/sdk-wf/env.sh
   npm ci
   python3 -I client/air-shell/build.py --apk "<game.apk>"
   ```
   Your app is `client/air-shell/build/reflipped-shell.apk`. On WSL2, copy it to Windows with `cp client/air-shell/build/reflipped-shell.apk /mnt/c/Users/<you>/Downloads/`.

## 2B. Build in the container (macOS, or any computer with Docker)
1. Install Docker Desktop (or Docker Engine on Linux).
2. **Download Reflipped:** `git clone https://github.com/torkd/reflipped.git`, or download the ZIP from <https://github.com/torkd/reflipped> ("Code", then "Download ZIP").
3. **Make a work folder**, for example `~/reflipped-build`, with exactly two files in it: your APK and `AIRSDK_Linux.zip`.
4. **Prepare the builder** (once, and again after updating Reflipped), from the Reflipped folder:
   ```sh
   docker build --platform linux/amd64 -t reflipped-shell-builder -f client/air-shell/container/Dockerfile .
   ```
5. **Build the app:**
   ```sh
   docker run --rm -it --platform linux/amd64 -v reflipped-shell-sdk:/sdk -v ~/reflipped-build:/work reflipped-shell-builder
   ```
   The first run downloads about 1.1 GB of tools, kept for next time. The app, `reflipped-shell.apk`, and your signing key, `air-shell.p12`, appear in your work folder.

On a Mac with an Apple chip the build is slower, because the Android tools have to be emulated. To free the space afterwards: `docker volume rm reflipped-shell-sdk` and `docker image rm reflipped-shell-builder`.

## 3. Install it
1. Copy `reflipped-shell.apk` to your phone (a cable, a cloud drive, a message to yourself).
2. Open it there and tap **Install**, allowing installs from that app if Android asks.

On an emulator, drag the APK onto its window, or run `adb install -r reflipped-shell.apk`. Then follow the [player guide](connecting-air-shell.md) from step 3. An app you build has the game inside, so it doesn't show **Set up the game**.

## Keep your signing key
The first build creates a signing key: `~/.config/starpoint/air-shell.p12` (2A) or `air-shell.p12` in your work folder (2B). **Back it up.** Android only installs an update over your app when it's signed with the same key. With another key you must uninstall first, which deletes the downloaded game data (your progress stays on the server if you use an account).

To use a key of your own, set `SHELL_KEYSTORE=<path to .p12>` and `SHELL_KEYSTORE_PASS=<password>` before building (2B: `docker run -e SHELL_KEYSTORE=/work/<file> -e SHELL_KEYSTORE_PASS=… …`).

## Updating
1. In the Reflipped folder, run `git pull`.
2. Build again the same way (2B: prepare the builder again first).
3. Install the new app over the old one.

## Options
Add these to the `build.py` command (2A) or after `reflipped-shell-builder` (2B):

| Option | What it does |
|---|---|
| `--server https://wf.example.org` | Suggests that server when the app starts. Players can still choose another. |
| `--servers servers.json` | Replaces the app's list of community servers with your own (see below). |
| `--content import` | Builds an app without the game inside, like the ready-made one: it asks for the game on first launch. |
| `--arch armv7` | A separate app for old 32-bit phones. |
| `--no-node` | Leaves Local play out (a smaller app). |
| `--out <file>` | Saves the app under another name (2A only). |
| `--version 0.2.0` | Sets the app version. Android only installs it over an older one when the version is higher. |

A server list for `--servers` looks like this (up to 50 servers; an empty list `[]` leaves only the servers players add):
```json
[
  {
    "name": "Example community",
    "address": "https://reflipped.example.org",
    "description": "Describe this community's rules and progression here.",
    "type": "Classic progression",
    "thumbnail": "https://reflipped.example.org/images/server.png"
  }
]
```

## Installing with adb, and reading the app's log
For developers who build often. `adb` is in `~/sdk-wf` after `. ~/sdk-wf/env.sh`.
1. On the phone: **Settings → About phone**, tap **Build number** 7 times.
2. **Settings → System → Developer options**: switch on **Wireless debugging** (or **USB debugging** and plug the phone in).
3. Wireless only: tap **Pair device with pairing code**, then run `adb pair <ip>:<pairing-port>` and type the code. Connect with the address under **IP address & Port**: `adb connect <ip>:<port>`.
4. Check with `adb devices`, then install: `adb install -r client/air-shell/build/reflipped-shell.apk`.
5. Read the log: `adb logcat -s ReflippedShell AndroidRuntime`.

A normal build hides the game's own script errors, so a bug may show only as a black screen. A debug build (`--debug --out client/air-shell/build/reflipped-shell-debug.apk`) prints them; look for `Error #` in the log. It pauses about 15 seconds at startup.

Switch wireless debugging off when you're done.

## Removing everything
```sh
client/air-shell/setup-sdk.sh --uninstall       # deletes ~/sdk-wf (asks first)
rm -f ~/.config/starpoint/air-shell.p12         # the signing key: only if you won't update this app again
rm -rf client/air-shell/build                   # the built app
```

## Problems
| What you see | What to do |
|---|---|
| `setup-sdk.sh: missing 'zstd'` (or curl, unzip, …) | Install the basic tools (step 1 of 2A). |
| The AIR SDK Manager says "Running 32-bit AIR … on 64-bit systems" | Run `setup-sdk.sh --manager-zip …` again and start it with `~/sdk-wf/bin/airsdkmanager`. |
| `syntax error near unexpected token 'newline'` | `<version>` was typed literally: use the real folder name from `ls ~/sdk-wf/air-sdks`. |
| `aapt tool failed` or `aapt … undefined symbol` | Run `setup-sdk.sh --air-dir <SDK folder>` again. Don't run the SDK's own `configure_linux.sh`. |
| Container: "put the AIR SDK zip … in your folder" | Put `AIRSDK_Linux.zip` in your work folder. |
| Container: "more than one APK in your folder" | Leave only one APK there, or name it with `-e APK=<file name>`. |
| "App not installed" on the phone | An app signed with another key is installed: uninstall it first (see "Keep your signing key"). |
| A black screen after the logo | Make a debug build and read the log (see above). |
