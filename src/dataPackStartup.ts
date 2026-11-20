// Opens and verifies the server data pack (src/lib/dataPack.ts) when DATA_PACK_DIR is set. Its own module so
// src/server.ts can import it right after the run profile, before the modules that read game data: a bad pack stops
// the server here with a clear message instead of failing later, in a request.
import { activeDataPack, DataPackError, expectedAssetsDigest } from "./lib/dataPack";

try {
    const pack = activeDataPack()
    if (pack) console.log(`Reflipped uses the data pack in ${pack.dir}: CDN ${pack.manifest.cdnVersion} (${pack.manifest.region}), ${pack.masterCount} master files, checked`)
    else if (expectedAssetsDigest() !== undefined)
        throw new DataPackError("this server build ships without the game data (assets/); set DATA_PACK_DIR to the data pack")
} catch (error) {
    if (!(error instanceof DataPackError)) throw error
    console.error(`Reflipped cannot start: ${error.message}`)
    process.exit(1)
}
