# Reflipped
> [!NOTE]
> This project is developed with the help of AI, with best-effort human review. Most features are tested, but some issues might slip through. If you find one, please [report it](https://github.com/torkd/reflipped/issues).

Reflipped brings back the global version of a mobile pinball RPG, called "the flipper game" in these docs, whose official servers closed in 2024. It is a replacement game server, together with an Android app you build yourself from your own copy of the game, so the game can be played again on a server you or a friend run.

Reflipped is still a work in progress: most of the game is playable, but some modes and events aren't there yet. See [what works](#what-works) below and the [roadmap](/docs/roadmap.md) for what is coming.

Reflipped is a fork of [Starpoint](https://github.com/Duosion/starpoint) by Duosion and its contributors. It adds the rebuilt Android app, co-op, developer mode, missions and a reworked admin panel on top of their work.

## Quick start
**To play** (the full walk-through, also for Windows and macOS, is the [player guide](/docs/connecting-air-shell.md)):
1. Get the flipper game's original Android APK, version 0.0.81, and the Linux AIR SDK from <https://airsdk.wxlift.com> (`AIRSDK_Linux.zip`; you accept its licence yourself).
2. On Linux (or Windows' WSL2), with both files in your Downloads folder:
   ```sh
   git clone https://github.com/torkd/reflipped.git && cd reflipped
   client/air-shell/setup-sdk.sh && client/air-shell/setup-sdk.sh --air-zip ~/Downloads/AIRSDK_Linux.zip
   . ~/sdk-wf/env.sh && python3 -I client/air-shell/build.py --apk ~/Downloads/<game.apk>
   ```
3. Copy `client/air-shell/build/reflipped-shell.apk` to your Android phone or emulator, and install it.
4. Open the app, type the server's address, and let the game data download (about 10 GB).

**To run a server** on your own computer (details in [running Reflipped at home](/docs/air-shell-install.md)):
1. Install [Node.js](https://nodejs.org/) 22 or newer, and get Reflipped with `git clone` as above.
2. Put your copy of the game data in a folder called `.cdn` inside it (see [game assets](/docs/cdn-download.md)).
3. Run `npm ci && npm run dev`. Players on your network connect to `http://<your computer's IP>:8000`, and the admin website is at http://localhost:8001.
4. Optional: run `npm run i18n:build` and restart, for English text in the content that was only released in Japanese.

## What works
**Getting started**
- The full first-time download of the game's data, straight from the server.
- The tutorial.

**Units and armaments**
- Unit levels, uncaps (over-limit), evolution, mana boards, EX boosts, Amity Scrolls and character stories.
- Armaments: upgrading, awakening, selling, melting and locking.
- Parties and party groups, including Seconds and Ability Cores.
- The encyclopedia.

**Quests and battles**
- Every main story quest.
- Character quests, EX quests and the Kaleidoscope dailies.
- Solo boss battles.
- Many event quests: rush events, ranking events and story events.

**Co-op**
- Hosting a room, with AI companions filling empty slots.
- Joining other players' rooms from the room list or with a room number.
- Recruiting: inviting everyone online through the in-game bell.
- Room links and "Return to Room" after a battle.

**Portals and shops**
- Unit and armament portals, with the exchanges that come with them.
- Box gacha.
- People's Choice (pick a unit with an exchange ticket; solo choice).
- Most shops, with their purchase and stock limits.

**Progress and rewards**
- Missions: regular, daily, event and Step Up missions, with their rewards.
- Titles, earned from title missions and title mail, and set on your profile.
- The gift box (mail).
- Daily resets: Kaleido and Boss Boosts, daily portal pulls and shop stock refresh every game day.

**For server owners**
- An admin website to look after players: import or download a save, send mail and gifts, and switch on developer mode (every unit and armament maxed, for testing).
- Time travel: set the server's date to replay past events and portals.
- Mods: replace game files for every player (see the [modding guide](/docs/modding.md)).
- English translation for the units, stories, events and items that were only released in Japanese (see [game assets](/docs/cdn-download.md#english-translation)).
- Docker setups with automatic HTTPS, backups and a hardened server for running in public.

If you reach something that isn't supported yet, the game shows an **H404** error. The full technical list is in the [API routes document](/docs/routes.md).

## Playing
You need an Android phone or an Android emulator on your computer, a computer to build the app on (Linux, Windows or macOS) and your own copy of the flipper game's original APK. Follow [playing on a Reflipped server](/docs/connecting-air-shell.md): it takes you from the APK to the game running on your phone.

**Emulators work too:** the app runs on Android emulators, including x86_64 ones that run ARM apps (as most current emulators can). There is no iPhone version yet.

## Running your own server
- **On your own computer, for you and your home network:** [running Reflipped at home](/docs/air-shell-install.md).
- **On the internet, for other players:** [running a public server](/docs/deployment.md), which uses the [Docker setups](/docker/README.md).

Either way you need a copy of the game's data files (see [game assets](/docs/cdn-download.md)).

## FAQ
- **Is there a public server I can join?**
  - Not from us: this project doesn't run one. You can host your own, or join one a friend runs.
- **Can I bring my old save?**
  - Yes. Open the admin website of your server (http://localhost:8001 on the computer running it), go to the players page, pick your player, choose the save file and click "Upload Save".
- **The game shows an "H404" error.**
  - That part of the game isn't supported yet. Check the [roadmap](/docs/roadmap.md).
- **Can I download a ready-made app?**
  - No. Each player builds it from their own copy of the game, because neither the game files nor the Adobe AIR SDK used to package them can be handed out. The [player guide](/docs/connecting-air-shell.md) walks you through it.

## Mods
The [modding guide](/docs/modding.md) explains how to install mods.

## Credits
- Reflipped is maintained by [Dav](https://github.com/torkd) and [Taenebron](https://github.com/Taenebron).
- Reflipped is built on [Starpoint](https://github.com/Duosion/starpoint), the original server emulator by Duosion, with contributions from Jolt and others. Thank you for the groundwork this fork stands on.
