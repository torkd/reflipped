# Reflipped
> [!NOTE]
> This project is developed with the help of AI, with best-effort human review. Most features are tested, but some issues might slip through. If you find one, please [report it](https://github.com/torkd/reflipped/issues).

Reflipped aims to bring back the global version of the acclamated flipper game, whose official servers closed in 2024. It is a replacement game server plus an Android app, the **Reflipped app**, so the game can be played again: alone on your phone, or on a server that you, a friend or a community runs.

Reflipped is a fork of [Starpoint](https://github.com/Duosion/starpoint) by Duosion and its contributors.

## Quick start
You need an Android phone (Android 7 or newer, about 12 GB free) and your own copy of the flipper game's original APK, version 0.0.81 (or the original app still installed on the phone).

1. On your phone, download the latest `reflipped-app-….apk` from the [Releases page](https://github.com/torkd/reflipped/releases).
2. Open it and tap **Install**. Allow your browser or Files app to install apps if Android asks.
3. Open the Reflipped app. On **Set up the game**, choose **Use the installed game**, or **Choose the APK file** and pick your copy of the game.
4. Choose how to play:
   - **Server**: pick a server from **My servers**, or **Add** the address its owner gave you, then **Join server**.
   - **Local play**: play alone, with the server running on your phone.
       - Local play requires a copy of the global CDN, which the project does not distribute.
5. Sign in with a Reflipped account (recommended: it keeps your save if you change phone), or play as a guest.
    - Local play will only ever keep your account on the phone. Reflipped accounts are **not** shared between servers.
6. Let the game data download (about 10 GB, use Wi-Fi) or install from a local archive, then tap to start.

The [player guide](/docs/connecting-air-shell.md) has every step in detail, and what to do when something goes wrong.

## How it differs from the original game
- **You choose where to play**: on any Reflipped server, or with **Local play**, alone on your phone with no one else's server needed once the game data is downloaded.
- **Nothing is sold for real money.** Bundles and costs that took paid beads take any beads, and a server's owner can hand out the old monthly packs for free.
- **Events come back** on a schedule the server's owner picks: at the original pace, faster, chosen by hand, or chosen by each player.
- **Late, Japanese-only content is in English**, machine-translated for now.

## Reflipped spotlighted features
- **Local play**: the whole server runs inside the app, with its own admin panel.
- **The player portal**, on every server's website: an account with two-step login, your save to download or import, and lost phones to unlink.
- **The admin website** for server owners: players and their saves, mail and gifts, the event calendar and the server's date, news posts, settings and cheat review.
- **Server choice in the app**: a list of servers, switching between them without downloading the game again, and game data packs to install the data from a file.
- **Mods and translations** that a server sends to every player.

## Guides
- **Players:** [playing with the Reflipped app](/docs/connecting-air-shell.md), [game data packs](/docs/game-data-pack.md).
- **Running a server at home:** [running Reflipped at home](/docs/air-shell-install.md), then [game assets](/docs/cdn-download.md) for the game data.
- **Running a public server:** [running a public server](/docs/deployment.md), with the [Docker setups](/docker/README.md).
- **Server owners:** [events and rewards](/docs/events.md), [login rewards](/docs/login-rewards.md), [mods](/docs/modding.md).
- **Building the app yourself** (optional): [building the Reflipped app](/docs/building-the-app.md).

## FAQ
- **Is there a public server I can join?**
  - The app lists the project's community server; you can also join one a friend runs, host your own, or use Local play.
- **Can I bring my old save?**
  - Yes, as a save file: the server's owner imports it on the admin website, or you do on the player portal if the owner allows it.
- **Why do I need my own copy of the game?**
  - The game's files can't be handed out, so the Reflipped app takes them from your copy the first time it starts.
- **Is there an iPhone version?**
  - Not yet. Android emulators on a computer work.

## Credits
- Reflipped is maintained by [Dav](https://github.com/torkd) and [Taenebron](https://github.com/Taenebron).
- Reflipped is built on [Starpoint](https://github.com/Duosion/starpoint), the original server emulator by Duosion, with contributions from Jolt and others. Thank you for the groundwork this fork stands on.

## Licence
Reflipped is licensed under the [GNU General Public License version 3](/LICENSE). The Reflipped app's code (`client/air-shell/`) also allows combining it with the Adobe AIR runtime and the game's own files: see [its licence](/client/air-shell/LICENSE.md). The AIR SDK has its own licence: see [the AIR SDK licence](/docs/air-licence.md).
