# The Reflipped app (the AIR shell)

This folder builds the **Reflipped app**, the Android app players use to play on a Reflipped server. It is a new app around the original game: the game itself comes from your own copy of the flipper game's APK, while the parts that talked to the old official services (login, anti-cheat, store, notifications) are replaced by small pieces of our own that talk to Reflipped instead.

It runs on real phones through login, the full game data download, the tutorial and normal play.

- **Players:** install the ready-made app with the [player guide](../../docs/connecting-air-shell.md).
- **Building the app yourself** (Linux, Windows and macOS): [building the Reflipped app](../../docs/building-the-app.md).

The app's code is licensed under the GNU GPL version 3, with an extra permission that allows sharing an app that combines it with the AIR runtime and the game's own files: see [LICENSE.md](LICENSE.md).

The rest of this page is for developers.

## What the build does
`build.py` takes the game from the APK you give it, at build time, and writes only to `build/` (never committed):
1. It extracts the game (its SWF, `bundle.zip` and its `.sha1`, the only files it takes from the APK) and applies a few small changes for Reflipped (`tools/patch_game.py`: it hides the paid-shop buttons and fixes tall screens and some tutorial locks), adds "REFLIPPED" to the title-screen logo, and draws the app icons from the Reflipped logo (see "Tools").
2. It writes the app description (`descriptor/application.xml`). The app ID is `com.kakaogames.wdfp.starpoint` by default, so it installs beside the official app; a server address is filled in only if you pass `--server`.
3. It replaces all 15 native extensions (ANEs) of the original app with our own: each gets our own `extension.xml`, a `library.swf` and `.swc` compiled from our own ActionScript in `as3/` with the AIR SDK's compiler, and a jar of the Java stubs from `java/src/`. The Kakao stub points the game at Reflipped and logs in through it; the anti-cheat (GxShield) and root checks always report "clean". The result contains no Xshield, Kakao SDK or other third-party extension code.
4. It adds the Reflipped server, for playing on the phone: `tools/node_runtime.py` downloads Node for Android (the nodejs-mobile project's build, checked against a fixed SHA-256), takes the matching C++ runtime out of Google's Android NDK (a few MB read from its zip, also checked) and compiles our small launcher, `native/launcher.c`, with the computer's clang and lld. They go into our own extension `reflipped.localserver` for the app's one CPU architecture; the server itself (`npm run bundle` in the repository, without the converted game data) goes in as `reflipped-server.zip`. The app runs it in a separate background service only when the player plays on the phone. `--no-node` leaves all of it out.
5. It packages each extension with `adt -package -target ane`, then the app with `adt -target apk-captive-runtime`, signed with a local key in `~/.config/starpoint/air-shell.p12`, created on the first run.

### The import build (`--content import`)
With `--content import` the app holds no game content at all (about 10 MB instead of 47 MB); the player's own game is imported on the phone, on the app's first launch:
- **At build time**, `build.py` still reads the APK you pass, but only to make two small files for the app: `manifest.properties` (the size and SHA-256 of each file the app takes from the game, and of the patched result) and `swf.ops`, the list of changes that turns the game's SWF into the patched one (`tools/swf_ops.py`: offsets into the game's SWF and the bytes our patches add, about 1.5 KB). Besides `tools/patch_game.py` it applies `tools/patch_import.py`, which makes the game read `bundle.zip` from the app's storage. `make_logo.py` doesn't run: the app adds "REFLIPPED" to the title logo itself, on the phone (below). The build checks that no game file ended up in the APK.
- **The app's main SWF** is our loader (`loader/ReflippedLoader.as`), with one extension of our own, `reflipped.content` (`as3/reflipped.content/`, `java/src/reflipped/shell/content/`).
- **On first launch** the extension shows its own screens: it reads the installed original app (the manifest lists it under `<queries>`, so Android lets the app see it) or a file the player picks (an APK, or an `.xapk`/`.apks` bundle), checks each file's SHA-256, applies `swf.ops` and keeps the files in the app's storage (`reflipped-game/`, plus `bundle.zip` and its `.sha1`). It keeps the original SWF too: when an app update brings a different `swf.ops`, the app patches it again without asking for the game. Then it adds "REFLIPPED" under the title-screen logo in the stored `bundle.zip`, the same way `tools/make_logo.py` does at build time (a Java port, from the player's own file), and records that it did, so it happens once; a bundle that doesn't hold the expected logo is left as it is.
- **On every launch** the loader reads the patched SWF, has the extension check its SHA-256 against the one in the APK, and only then runs it with `Loader.loadBytes` (code loaded that way has the app's full rights, so nothing else may run).

`sh client/air-shell/test/sh20-import-test.sh` tests the op list and the importer on a computer with a made-up game; `sh client/air-shell/test/sh20-import-test.sh client/air-shell/build/app/reflipped-import <game.apk>` imports the real game with the files of your last import build. `sh client/air-shell/test/sh24-title-logo-test.sh` tests the title logo step on a made-up logo; given your `bundle.zip` and a copy stamped by `make_logo.py`, it also checks that both logos are the same, pixel for pixel. The import build runs on Android only.

## Tools you need
The quickest way is `setup-sdk.sh`, which installs everything below into one folder (default `~/sdk-wf`), with no system packages, and checks every download's checksum:
```sh
client/air-shell/setup-sdk.sh                                  # Java, Android tools, adb, android-34
client/air-shell/setup-sdk.sh --manager-zip <AIRSDKManager_linux_amd64_*.zip>  # from airsdk.wxlift.com/download
~/sdk-wf/bin/airsdkmanager                                     # install an SDK into ~/sdk-wf/air-sdks
client/air-shell/setup-sdk.sh --air-dir ~/sdk-wf/air-sdks/<version>   # links it as ~/sdk-wf/air
client/air-shell/setup-sdk.sh --node                           # optional: Node 24, if the system Node is older
. ~/sdk-wf/env.sh                                              # in every terminal, before building
client/air-shell/setup-sdk.sh --uninstall                      # removes the folder again
```
`--dry-run` shows what would be downloaded. On anything other than x86_64 Linux (macOS, or Windows without WSL2), `container/` builds the same way in Docker: the player mounts a folder with their APK and `AIRSDK_Linux.zip`, and the container runs `setup-sdk.sh --air-zip` and `build.py` with its tools cached in a volume (steps in the player guide, 2B).

The server for playing on the phone also needs, unless you build with `--no-node`: clang, lld and llvm from your system's packages (`clang`, `ld.lld`, `llvm-strip`; or set `CLANG` and `LLVM_STRIP`), Node 24 with `npm ci` run in the repository, and internet access on the first build (the Node download, about 80 MB, is kept in `build/cache/node/`). A local NDK r27d (`ANDROID_NDK_HOME`, or `$ANDROID_HOME/ndk/27.3.13750724`) is used instead of reading its zip.

To set things up by hand instead:
- Java 17 or newer (`javac`, `java`).
- The **AIR SDK**, from airsdk.wxlift.com/download (the free version shows an AIR logo at startup; see [the AIR SDK licence](../../docs/air-licence.md)). Set `AIR_HOME` to the folder that holds `lib/adt.jar`.
- The Android SDK with one platform (`sdkmanager "platforms;android-34"`). Set `ANDROID_HOME`.
- `adb`, for installing and reading logs.

## Build and run
```sh
# 1. dry run: extract, draw the icons and write the descriptors, no Java or AIR needed
#    (it leaves out the steps that need them: the extensions' ActionScript libraries and Java stubs)
python3 -I client/air-shell/build.py --apk <game.apk> --stage-only

# 2. full build: one app for any server; players add the address in its server list
python3 -I client/air-shell/build.py --apk <game.apk>
#    or build a server in (the app never asks; for a private build)
python3 -I client/air-shell/build.py --apk <game.apk> --server http://192.168.1.10:8000

# 3. install, and watch every extension call the game makes
adb install -r client/air-shell/build/reflipped-shell.apk
adb logcat -s ReflippedShell AndroidRuntime
```
Reflipped must listen on an address the phone can reach (`LISTEN_HOST=0.0.0.0`). My servers combines read-only included community servers with custom entries that support Add/Edit/Remove. The default list includes `https://reflipped.torkd.space`, the project's main community server. A valid offline address can be saved; joining checks `GET /shell/config` afresh. Cards show connection status, the reported name and description, cached thumbnails, and the active event mode. `--servers servers.json` replaces the included list with a JSON array of `{ "name", "address", "description" }` entries with optional `type`, `thumbnail` and `progression`; an empty array excludes all provided entries. A bare address uses HTTPS for a public name and tries plain HTTP first for a home-network or local address; a full `http://` or `https://` address is used as typed. From the selected address the app works out the game API (`<server>`) and the login service (`<server>/openapi/service`). The game data address is, in order: `--cdn` if built in, the `cdn` the server reports (`SHELL_CDN` on the server), or `<server>/patch/Live/2.0.0`.

Options:
- `--content`: `embedded` (default) packs the patched game into the app; `import` builds an app without it, which imports the player's game on first launch (see "The import build").
- `--server`, `--cdn`: build in the server or game data address.
- `--app-id`, `--name`: another app ID or name.
- `--arch`: `armv8` (default) or `armv7`, a separate app for 32-bit-only phones.
- `--air-namespace`: match your SDK (default `51.0`). `--target-sdk`: the Android target.
- `--debug`: a debug build that prints the game's script errors (see the home setup guide).

Builds are release builds, signed with `~/.config/starpoint/air-shell.p12`, created on the first build. Keep that file: an update only installs over an app signed with the same key. `SHELL_KEYSTORE` and `SHELL_KEYSTORE_PASS` select your own key (default password `starpoint`); every build prints the key it used. Debug-only environment variables (`REFLIPPED_TRACE_ASSETS`, `REFLIPPED_READY_SECONDS`) print a warning in a normal build.

## Debugging on a device
- **Nothing starts at all:** a crash under `AndroidRuntime`, or a black screen, usually points to the AIR runtime or the app description, not to the stubs.
- **`ReflippedShell` lines** list every extension call with its arguments and result: use them to see what the game expects from a stub.
- **An ActionScript error about an unknown function** (`Error #3500`) means a stub is missing a call name. Add it with `ctx.noop("NAME")`.
- **`Error #2113`** when an extension is first used means its context was created outside its own `library.swf`: the class the game calls is missing from `as3/<extension id>/`.

## Tools
- `tools/make_icons.py <dir>`: draws the launcher icons, plain and adaptive, from the Reflipped logo in `icon/reflipped.svg` (the same drawing as the admin site's logo). `build.py` runs it.
- `tools/make_logo.py <bundle.zip>`: adds "REFLIPPED" under the title-screen logo, built from the logo's own letter shapes, and updates `bundle.zip.sha1` so the game unpacks the new bundle on its next launch. `build.py` runs it for the usual build; an import build does the same on the phone (`java/src/reflipped/shell/content/LogoStamp.java`, `BundleLogo.java`), so keep the two in step.
- `tools/swf_ops.py make|apply|stats`: makes, applies or describes the import build's op list.
- `tools/patch_import.py <swf>`: the import build's extra change, `bundle.zip` read from the app's storage. `build.py` runs it.
- `tools/node_runtime.py --abi <arm64-v8a|armeabi-v7a|x86_64> --out <dir>`: writes `libnode.so`, `libc++_shared.so` and our launcher `libreflippednode.so` for one CPU architecture (see "What the build does"). `build.py` runs it.
- `tools/ane_calls.py <apk|swf> [--json out.json]`: lists every extension, call name (with its number of arguments) and handler the game uses. It reads the game's bytecode directly (`tools/abc.py`), with no Java or decompiler.

## Android Studio
`java/src/` is a plain source tree. For code completion, create an Android library module and add `$AIR_HOME/lib/android/FlashRuntimeExtensions.jar` as a `compileOnly` dependency. `build.py` stays the real build.
