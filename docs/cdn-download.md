# Game assets
The flipper game's app holds only a small part of the game. Everything else (units, music, stories, events) is downloaded on first start: about 10 GB for the English Android version. The official servers that used to send these files closed with the game in July 2024, so a Reflipped server sends them instead, and needs its own copy.

## Getting a copy
Reflipped doesn't include the game data, and it can no longer be downloaded from the official servers: the download script that used to do it stopped working when they closed. You need a copy someone saved before the game closed.

How big it is:
- one language (English, Korean or Thai) for Android: about 12 GB;
- every language and platform: about 30 GB.

## Where to put it
Put the files in a folder called `.cdn` inside the Reflipped folder, so that the language folders end up as `.cdn/en/`, `.cdn/ko/` and so on. To keep them somewhere else, set `CDN_DIR` in `.env` (or in the Docker setup's `.env`) to that folder.

## Checking your copy
Reflipped can check that your copy is complete and undamaged:
```sh
npm run cdn
```
It asks which platform and language you have, checks every file, and lists any that are missing or damaged.

## English translation
Some units, stories, events and items were added near the end of the game's life and only ever released in Japanese. Reflipped can send English text for them, without touching your copy of the game data. It has been tested in the game and is **on by default**: it only needs building once.

Where the English comes from: wherever the official English data already had a name or term, that is used. Names of the Japanese-only characters come from fan translations or, where none exists, a best-effort machine translation, and the rest of the text is machine-translated too. It hasn't had a full human review yet, so expect some odd wording.

To use it:
1. Build the translation from your game data (it reads `.cdn` and writes a separate `.cdn-overlay` folder next to it):
   ```sh
   npm run i18n:build
   ```
   It ends with a short report of what it translated.
2. Restart Reflipped. Phones with the game in English get the translation on their next start.

After an update of Reflipped that brings new translations, run `npm run i18n:build` again and restart.

To switch it off, add the line `I18N=off` to `.env` and restart: phones get the original text back on their next start. `I18N=on` switches it back on.

Good to know:
- Only phones set to English get the translation; Korean and Thai are left as they are.
- Like mods, a phone that has just done the big first download gets the translation one restart later.
- `I18N_MIN_STATUS=reviewed` sends only text a person has checked (none yet).
- Running with Docker? See the [Docker guide](../docker/README.md), "English translation".
- Some banners and pictures have Japanese text drawn into the image; those stay Japanese for now.
