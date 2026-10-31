# The Reflipped app (the AIR shell)

This folder builds the **Reflipped app**, the Android app players use to play on a Reflipped server. It is a new app around the original game: the game itself comes from your own copy of the flipper game's APK, while the parts that talked to the old official services (login, anti-cheat, store, notifications) are replaced by small pieces of our own that talk to Reflipped instead.

It runs on real phones through login, the full game data download, the tutorial and normal play.

- **Players:** follow [playing on a Reflipped server](../../docs/connecting-air-shell.md) (Linux, Windows and macOS).
- **Running a server at home, with every build detail:** [running Reflipped at home](../../docs/air-shell-install.md).

The rest of this page is for developers.

## What the build does
`build.py` takes everything game-related from the APK you give it, at build time, and writes only to `build/` (never committed):
1. It extracts the game (its SWF, `bundle.zip` and its `.sha1`) and applies a few small changes for Reflipped (`tools/patch_game.py`: it hides the paid-shop buttons and fixes tall screens and some tutorial locks), then adds "REFLIPPED" to the title-screen logo and draws the icons (see "Tools").
2. It writes the app description (`descriptor/application.xml`). The app ID is `com.kakaogames.wdfp.starpoint` by default, so it installs beside the official app; a server address is filled in only if you pass `--server`.
3. It replaces all 15 native extensions (ANEs) of the original app with Java stubs from `java/src/`: each gets our own `extension.xml`, the original `library.swf` from your APK, a generated `.swc` and a jar of the stub classes. The game's ActionScript side of each extension is already inside the game, so no ActionScript compiler is needed. The Kakao stub points the game at Reflipped and logs in through it; the anti-cheat (GxShield) and root checks always report "clean". The result contains no Xshield, Kakao SDK or other third-party extension code.
4. It packages each extension with `adt -package -target ane`, then the app with `adt -target apk-captive-runtime`, signed with a local key in `~/.config/starpoint/air-shell.p12`, created on the first run.

## Tools you need
The quickest way is `setup-sdk.sh`, which installs everything below into one folder (default `~/sdk-wf`), with no system packages, and checks every download's checksum:
```sh
client/air-shell/setup-sdk.sh                                  # Java, Android tools, adb, android-34
client/air-shell/setup-sdk.sh --manager-zip <AIRSDKManager_linux_amd64_*.zip>  # from airsdk.wxlift.com/download
~/sdk-wf/bin/airsdkmanager                                     # install an SDK into ~/sdk-wf/air-sdks
client/air-shell/setup-sdk.sh --air-dir ~/sdk-wf/air-sdks/<version>   # links it as ~/sdk-wf/air
client/air-shell/setup-sdk.sh --node                           # optional: Node 22, if the system Node is older
. ~/sdk-wf/env.sh                                              # in every terminal, before building
client/air-shell/setup-sdk.sh --uninstall                      # removes the folder again
```
`--dry-run` shows what would be downloaded. On anything other than x86_64 Linux (macOS, or Windows without WSL2), `container/` builds the same way in Docker: the player mounts a folder with their APK and `AIRSDK_Linux.zip`, and the container runs `setup-sdk.sh --air-zip` and `build.py` with its tools cached in a volume (steps in the player guide, 2B).

To set things up by hand instead:
- Java 17 or newer (`javac`, `java`).
- The **AIR SDK**, from airsdk.wxlift.com/download (the free version shows an AIR logo at startup; see [the AIR SDK licence](../../docs/air-licence.md)). Set `AIR_HOME` to the folder that holds `lib/adt.jar`.
- The Android SDK with one platform (`sdkmanager "platforms;android-34"`). Set `ANDROID_HOME`.
- `adb`, for installing and reading logs.

## Build and run
```sh
# 1. dry run: extract and write the descriptors, no Java or AIR needed
python3 -I client/air-shell/build.py --apk <game.apk> --stage-only

# 2. full build: one app for any server; it asks for the address on first launch
python3 -I client/air-shell/build.py --apk <game.apk>
#    or build a server in (the app never asks; for a private build)
python3 -I client/air-shell/build.py --apk <game.apk> --server http://192.168.1.10:8000

# 3. install, and watch every extension call the game makes
adb install -r client/air-shell/build/reflipped-shell.apk
adb logcat -s ReflippedShell AndroidRuntime
```
Reflipped must listen on an address the phone can reach (`LISTEN_HOST=0.0.0.0`). Without `--server`, the app asks for the address on first launch (`http://192.168.1.10:8000`, `https://wf.example.org`; `https://` is assumed without a scheme) and accepts it only if the server answers `GET /shell/config` as a Reflipped server. From that address it works out the game API (`<server>`) and the login service (`<server>/openapi/service`). The game data address is, in order: `--cdn` if built in, the `cdn` the server reports (`SHELL_CDN` on the server), or `<server>/patch/Live/2.0.0`.

Options:
- `--server`, `--cdn`: build in the server or game data address.
- `--app-id`, `--name`: another app ID or name.
- `--arch`: `armv8` (default) or `armv7`, a separate app for 32-bit-only phones.
- `--air-namespace`: match your SDK (default `51.0`). `--target-sdk`: the Android target.
- `--debug`: a debug build that prints the game's script errors (see the home setup guide).
- `--stub-library-swf`: packs an empty `library.swf` instead of each extension's original one. It fails at runtime (Error #2113) and is only for diagnosis.

Builds are release builds, signed with `~/.config/starpoint/air-shell.p12`, created on the first build. Keep that file: an update only installs over an app signed with the same key. `SHELL_KEYSTORE` and `SHELL_KEYSTORE_PASS` select your own key (default password `starpoint`); every build prints the key it used. Debug-only environment variables (`REFLIPPED_TRACE_ASSETS`, `REFLIPPED_READY_SECONDS`) print a warning in a normal build.

## Debugging on a device
- **Nothing starts at all:** a crash under `AndroidRuntime`, or a black screen, usually points to the AIR runtime or the app description, not to the stubs.
- **`ReflippedShell` lines** list every extension call with its arguments and result: use them to see what the game expects from a stub.
- **An ActionScript error about an unknown function** means a stub is missing a call name. Add it with `ctx.noop("NAME")`.

## Tools
- `tools/make_icons.py <apk> <dir>`: draws the launcher icons (the original art with a shifted backdrop colour and a REFLIPPED ribbon in the title logo's own letters). `build.py` runs it.
- `tools/make_logo.py <bundle.zip>`: adds "REFLIPPED" under the title-screen logo, built from the logo's own letter shapes, and updates `bundle.zip.sha1` so the game unpacks the new bundle on its next launch. `build.py` runs it.
- `tools/ane_calls.py <apk|swf> [--json out.json]`: lists every extension, call name (with its number of arguments) and handler the game uses. It reads the game's bytecode directly (`tools/abc.py`), with no Java or decompiler.

## Android Studio
`java/src/` is a plain source tree. For code completion, create an Android library module and add `$AIR_HOME/lib/android/FlashRuntimeExtensions.jar` as a `compileOnly` dependency. `build.py` stays the real build.
