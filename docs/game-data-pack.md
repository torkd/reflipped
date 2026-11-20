# Game data packs

The flipper game needs about 10 GB of game data besides the app. Usually the Reflipped app downloads it from the server the first time it starts. A **game data pack** is the same data in one file, which you install on your phone instead:
- **Players** save a long download or mobile data, on any server.
- **Server owners** can skip hosting the 10 GB: a server without the game data asks its players for a pack, and sends only its own extras (event schedule, translation, mods: a few MB).

One pack works on every Reflipped server.

## Installing a pack on your phone
1. Copy the pack to your phone, for example into **Downloads** (a memory card or USB stick works too). You need about 22 GB free: 10 GB for the file and 11 GB for the installed data.
2. Open the Reflipped app and join your server as usual.
3. When the app asks how to get the game data, choose **Install from a file** and pick the pack.
4. Wait a few minutes while the app checks and installs it. It keeps going in the background.
5. Tap to start. The game downloads only the server's extras.

You can delete the file afterwards. The same question comes up whenever the phone has no game data: on first start, after **Clear Cache** on the title screen, or after switching to a server whose extras don't fit.

**Local play** needs no server at all with a pack. When the app asks for the game's data tables, choose **From a file** and pick the pack. The app installs the game data and makes the tables from it. If the phone already has the game data, the app makes them without asking.

If the app refuses the file, its message says why (not a pack, incomplete, damaged, compressed, or not the official game data).

## Exporting the game data from a phone
A phone that already has the game data can save it as a pack, for another phone, without a computer.
1. In the Reflipped app, open **Menu → Account Info → Sign out**.
2. On the welcome screen, choose **Export game data**.
3. Pick where to save the file (Downloads, a memory card or a USB stick). It takes a minute or two; the pack is about 9 GB.
4. Install it on the other phone as above.

Two limits: only English game data can be exported for now, and only data downloaded or installed with a recent version of the app. If the app says so, choose **Clear Cache** on the title screen, get the data again, and export after that.

## Making a pack on a computer
You need a [copy of the game data](cdn-download.md) and the Reflipped folder.
1. In the Reflipped folder, run `npm run gamepack`.
2. It checks every file and writes `reflipped-gamedata-en-2.1.125.tar` (about 10 GB).

Options: `--lang ko` or `--lang th` for Korean or Thai, `--cdn <folder>` to read the copy from elsewhere, `--out <file>` to write the pack elsewhere. The app accepts only the official game data: mods belong in the server's `mods/` folder, not in a pack.

**Or use your server's whole game data folder:** `tar -cf cdn.tar .cdn` (or a `.zip` of the folder) installs the same way. The app picks out what it needs. It must not be compressed (no `.tar.gz`), and the phone needs room for the whole file.

## Running a server without the game data
- A server whose `.cdn` folder has no game data offers no download: its players see "doesn't offer the game data for download" and install a pack.
- To stop offering the download although you have the data (to save traffic), set `GAME_DATA_DOWNLOAD=off` in `.env` and restart. With Docker, also point `CDN_DIR` at a folder that holds only `mods/` (see the [Docker guide](../docker/README.md#server-settings)).
- Tell your players where to get a pack. Check the game's terms before sharing one publicly: it holds the game's own files.
