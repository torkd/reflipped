# Modding guide
Mods replace some of the game's files (pictures, sounds, text) for every player on a Reflipped server. The server sends them to the app together with the normal game data.

## Installing a mod
1. Stop Reflipped if it is running.
2. Open the `.cdn` folder inside the Reflipped folder (the folder with the game data).
3. Create a folder called `mods` inside it, if there isn't one yet.
4. Put the mod's `.zip` file in the `mods` folder. **Don't unzip it.**
5. Start Reflipped.
6. The next time a player starts the game, the mod is downloaded.

## Good to know
- **Restart after a change.** Reflipped reads the `mods` folder when it starts, so restart it after adding, removing or changing a mod.
- **Several mods** are applied in file name order: when two mods change the same file, the one whose name sorts last wins.
- **The English translation wins over mods.** If the server has the translation switched on (see [game assets](cdn-download.md), "English translation") and a mod changes one of the same files, the translation's version is used.
- **New players get mods one restart later.** The big first download doesn't include mods; restart the game once it has finished, and the mods download then.
- **Removing a mod from the `mods` folder doesn't remove it from phones** that already have it. For now, the only way to undo a mod on a phone is to clear the app's data, which also deletes the downloaded game data.

Reflipped never writes into the game data folder, so it can stay read-only (in Docker too). If an older version of Reflipped left a `metadata.json` file in `.cdn`, you can delete it.

## Making mods
A guide is coming. The [wfax tool](https://github.com/blead/wfax) is what makes modding possible.
