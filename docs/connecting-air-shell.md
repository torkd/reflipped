# Playing with the Reflipped app (Android)

This guide is for players. It takes you from nothing to the game running on your phone, with the ready-made **Reflipped app**. No computer is needed.

Want to run a server instead? See [running Reflipped at home](air-shell-install.md) or [running a public server](deployment.md).

## What you need
- **An Android phone** with Android 7 or newer and about 12 GB of free space, or an Android emulator that runs ARM apps (most current ones do).
- **Your own copy of the flipper game**, version 0.0.81: either the original app still installed on the phone, or its APK file (`.apk` or `.xapk`). The Reflipped app holds none of the game's files and takes them from your copy, once.
- **Wi-Fi**: the game data is about 10 GB.
- **A server's address**, if you want to play on a server that isn't in the app's list. For playing alone, you don't need one.

## 1. Install the app
1. On your phone, open the [Releases page](https://github.com/torkd/reflipped/releases) and download `reflipped-app-<version>-….apk` from the newest release.
2. Open the downloaded file and tap **Install**.
3. If Android asks whether your browser or Files app may install apps ("Install unknown apps"), allow it.
4. If Google Play Protect wants to scan the app, let it: the app doesn't come from the Play Store.

The app installs next to the official one, without replacing it.

**Already have a Reflipped app you built yourself?** Android won't install the ready-made one over it ("App not installed"). See [Moving from an app you built](#moving-from-an-app-you-built) first.

**To check the download** (optional): each release lists the file's SHA-256 next to it, in a `.sha256` file. On a computer, `sha256sum <file>` must print the same code.

## 2. Set up the game (first launch only)
1. Open the Reflipped app. After the AIR logo, it shows **Set up the game**.
2. Choose **Use the installed game** if the original app is on the phone, or **Choose the APK file** and pick your copy.
3. Wait a few seconds while the app checks and copies the game. If it says the version is wrong, your copy isn't version 0.0.81.

From then on the app no longer needs the original app or the file.

## 3. Choose where to play
The app asks how you want to play:
- **Server**: play online, with other players. Go on with step 4.
- **Local play**: play alone, with the server running on your phone. Go to [Local play](#local-play).

## 4. Join a server
1. Pick a server in **My servers**. The project's community server is already listed.
2. To add another one, tap **Add**, paste the address its owner gave you (for example `https://wf.example.org`, or `192.168.1.10:8000` for a server at home), and save it.
3. Select the server and tap **Join server**.
4. Choose **Reflipped account** and sign in or create one, then tap **Play as** your name. Or choose **Play as guest**.
5. When the app asks how to get the game data, choose **Download** (about 10 GB, on Wi-Fi), or **Install from a file** if you have a [game data pack](game-data-pack.md).
6. Tap to start playing.

**Account or guest?** An account keeps your save on the server, so a new phone or a reinstall picks it up again by signing in. A guest save is tied to this app on this phone. You can turn a guest into an account later: **Menu → Account Info → Link an account**.

The download keeps going in the background and continues where it stopped if it's interrupted. On Android 13 and newer, allow notifications to see its progress.

## Local play
Local play runs the Reflipped server inside the app, so you play alone, without anyone else's server.
1. On the first screen, choose **Local play**.
2. The phone's server needs the game's data tables once (about 7 MB). Choose **From a server** and pick an online Reflipped server that offers them, or **From a file** if you saved one.
3. The game data (about 9 GB) downloads from that server too, unless the phone already has it.
4. Tap to start playing.

Good to know:
- **Menu → Account Info → Admin panel** opens your own admin site, already signed in: change the event mode, the date and other settings, or download your save (**Players**, your name, **Download save**).
- Your save lives in the app. **Uninstalling the app or clearing its data deletes it**, so download a copy from time to time.
- To continue a Local play save on a server, import the downloaded file on that server's player portal (if its owner allows it), or ask its owner to import it.
- Local play is in English: on a phone set to Korean or Thai, some event and quest names show in English.

## Your account on the server's website
Every Reflipped server has a player portal at `<server address>/portal`. Sign in with your Reflipped account to:
- change your password and turn on two-step login with an authenticator app;
- download your save, or import one if the server's owner allows it;
- unlink a lost or sold phone (its game stops; your save stays);
- delete your save and start over;
- choose a historical event period, on servers in Time Travel mode.

To bring a phone that plays as a guest (or the original app) into your account, get a short code on the portal and type it in the game as your profile comment.

## Switching servers or accounts
1. Open **Menu → Account Info → Sign out**.
2. Choose another server, or sign in with another account.

Your save stays on each server. The downloaded game data is usually kept: the app only replaces the few files the last server changed (a few MB). If that isn't possible, it warns you first that the data will be downloaded again.

## Updating the app
When a newer app is out, a server may show **Update available** once, or say **This server needs a newer Reflipped app**.
1. Tap **Install update** if the notice offers it, and confirm the install. Otherwise download the newest `reflipped-app-….apk` from the [Releases page](https://github.com/torkd/reflipped/releases).
2. Install it over the old app. Your game data and progress stay.

The title screen shows the app's version and the server's, for example "Reflipped · app 0.1.0 · server 1.0.1".

## Moving from an app you built
An app you built yourself is signed with your own key, so Android won't install the ready-made app over it.
1. **Keep your progress:** if you play as a guest, link an account first (**Menu → Account Info → Link an account**). Saves in Local play: download a copy from the Admin panel.
2. Uninstall your old Reflipped app. This deletes its downloaded game data.
3. Install the ready-made app (step 1) and sign in to your account.

## Event modes on server cards
Each server card shows how that server schedules events:

| Mode | What it means |
|---|---|
| Classic | Past events come back at their original pace. |
| Accelerated | The event timeline runs faster; the card shows the speed, such as 2×. |
| Time travel | Each player can choose a historical event period. |
| Manual | The server's owner chooses which events run. |
| Legacy schedule | The server uses an older scheduling system. |
| Event mode: not listed | The server doesn't say. |

## Problems
| What you see | What to do |
|---|---|
| "App not installed" or "package conflicts" | Another Reflipped app is installed, signed with a different key (for example one you built). See [Moving from an app you built](#moving-from-an-app-you-built). |
| "Set up the game" says the version is wrong | Your copy isn't version 0.0.81. Use another copy. |
| "No Reflipped server at that address" | Check the address and port with the server's owner. Open `<address>/shell/config` in the phone's browser: it should show a line starting with `{"reflipped":1`. |
| "This server needs a newer Reflipped app" | Update the app (see "Updating the app"). |
| The download stops when the screen turns off | Keep the app open; it continues next time you start it. |
| An "H404" error in the game | That part of the game isn't supported yet (see the [feature list](features.md)). |
| A black screen after the logo, or an "Error No." message | Tell the server's owner, with the time it happened. |
