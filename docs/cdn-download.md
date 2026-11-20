# Game assets

The flipper game's app holds only a small part of the game. Everything else (units, music, stories, events) is downloaded on first start: about 10 GB for the English Android version. The official servers that sent these files closed with the game in 2024, so a Reflipped server sends them instead, and needs its own copy.

## Getting a copy
Reflipped doesn't include the game data, and the official servers can no longer send it. You need a copy someone saved before the game closed:
- one language (English, Korean or Thai) for Android: about 12 GB;
- every language and platform: about 30 GB.

A server can also run without a copy: its players then install a [game data pack](game-data-pack.md) instead of downloading.

## Adding it to your server
1. Put the files in a folder called `.cdn` inside the Reflipped folder, so that the language folders are `.cdn/en/`, `.cdn/ko/` and so on. (To keep them elsewhere, set `CDN_DIR` in `.env` to that folder.)
2. Check the copy: run `npm run cdn`, pick your platform and language, and it lists any missing or damaged files.
3. Restart Reflipped.

## English translation
Some units, stories, events and items were only ever released in Japanese. Reflipped can send English text for them, without changing your copy of the game data. It is on by default, but has to be built once:
1. Build it: `npm run i18n:build`. It reads `.cdn`, writes a separate `.cdn-overlay` folder, and ends with a short report.
2. Restart Reflipped. Phones set to English get the translation on their next start.
3. After a Reflipped update that brings new translations, run both steps again.

To switch it off, add the line `I18N=off` to `.env` and restart. (With Docker, see the [Docker guide](../docker/README.md), "English translation".)

Good to know:
- Names use the official English terms where they exist, fan translations for the Japanese-only characters, and machine translation for the rest. It hasn't had a full human review yet, so expect some odd wording.
- Only phones set to English get it; Korean and Thai stay as they are.
- A phone that has just done the big first download gets it one restart of the game later.
- Banners and pictures with Japanese text drawn in stay Japanese for now.

## Chinese game data (optional, for Score Scramble)
The English game data has an old version of one file: the party screen of Score Scramble's quests, which then show error U_bd3902. The Chinese version of the game has the newer file, and Reflipped can send it. Nothing else is taken from the Chinese data, and the file has no Chinese text in it. Use one of the two ways below, not both.

**If your server has the Chinese data:**
1. Put the Chinese copy (its `archive-…` folders) in `.cdn/cn/`, next to `.cdn/en/`. (Elsewhere: set `CN_CDN_DIR` in `.env`.)
2. Restart Reflipped. It picks the file out by itself and sends it to phones on their next start.

**If it doesn't:**
1. On a computer that has the Chinese copy, run `npm run cn:patch -- --cn path/to/chinese/copy --out .`. It writes `cn-patches.zip`, a few kilobytes.
2. Copy that file into the server's `.cdn/mods` folder and restart Reflipped: it is sent like any other [mod](modding.md).

To switch it off, add `CN_PATCHES=off` to `.env` and restart. Reflipped only uses the exact file it knows; with a different copy it leaves it out and says so when it starts. Score Scramble's own texts were only ever in Japanese and stay so.
