# Modding guide

Mods replace some of the game's files (pictures, sounds, text) for every player on a Reflipped server. The server sends them to the app together with the normal game data.

## Installing a mod
1. Stop Reflipped if it is running.
2. Open the `.cdn` folder inside the Reflipped folder (the folder with the game data).
3. Create a folder called `mods` inside it, if there isn't one yet.
4. Put the mod's `.zip` file in the `mods` folder. **Don't unzip it.**
5. Start Reflipped.
6. Players get the mod the next time they start the game.

## Removing a mod
1. Stop Reflipped, take the `.zip` out of the `mods` folder, and start Reflipped again.
2. New players won't get it. Phones that already have it keep it: for now, the only way to undo a mod on a phone is to clear the app's data, which also deletes the downloaded game data.

## Good to know
- **Restart after every change**: Reflipped reads the `mods` folder when it starts.
- **Several mods** apply in file name order: when two change the same file, the one whose name sorts last wins.
- **The English translation wins over mods** that change the same files (see [game assets](cdn-download.md#english-translation)).
- **New players get mods one restart later**: the big first download doesn't include them, so they arrive the next time the game starts.
- Reflipped never writes into the game data folder, so it can stay read-only. If an older version left a `metadata.json` file in `.cdn`, you can delete it.
- The Score Scramble fix from the Chinese game data can also be installed as a mod (see [game assets](cdn-download.md#chinese-game-data-optional-for-score-scramble)).

## Making mods
A guide is coming. The [wfax tool](https://github.com/blead/wfax) is what makes modding possible.
