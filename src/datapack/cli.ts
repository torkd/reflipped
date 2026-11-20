/**
 * `npm run datapack` (SH-13 step 3): builds the server data pack from the CDN (`src/datapack/build.ts`).
 *
 *   npm run datapack -- [--cdn DIR] [--region en] [--out out/datapack-build] [--max-version 2.1.125] [--no-assets]
 *
 * `CDN_DIR` gives the default of `--cdn`. In the Docker image (no tsc there): node out/datapack/cli.js [options].
 * `--write-pin FILE` writes the SEC-19 pin (src/datapack/pin.json: the master tables' digest the bundle names).
 * `--no-assets` leaves the converted game data (`assets/`) out, for a server that runs with them beside its code.
 * The server uses the result with `DATA_PACK_DIR=<out>/datapack` (docs/on-device-server.md, "Server data pack").
 */
import path from "path";
import { CdnIndex, regionCdnDir } from "../lib/cdnIndex";
import { appPath } from "../lib/paths";
import { buildDataPack } from "./build";
import { writeFileSync } from "fs";
import { mastersDigest } from "../lib/dataPack";

function usage(message?: string): never {
    if (message) console.error(message)
    console.error("usage: npm run datapack -- [--cdn DIR] [--region en] [--out out/datapack-build] [--max-version X] [--no-assets] [--write-pin src/datapack/pin.json]")
    process.exit(2)
}

const opts = { cdn: process.env.CDN_DIR || ".cdn", region: "en", out: path.join("out", "datapack-build"), maxVersion: undefined as string | undefined, assets: true, pin: undefined as string | undefined }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i] ?? usage(`${arg} needs a value`)
    switch (arg) {
        case "--cdn": opts.cdn = value(); break
        case "--region": opts.region = value(); break
        case "--out": opts.out = value(); break
        case "--max-version": opts.maxVersion = value(); break
        case "--no-assets": opts.assets = false; break
        case "--write-pin": opts.pin = value(); break
        case "-h": case "--help": usage(); break
        default: usage(`unknown option ${arg}`)
    }
}

const started = Date.now()
const root = regionCdnDir(opts.region, opts.cdn)
const index = CdnIndex.build(root, { maxVersion: opts.maxVersion })
console.log(`indexed ${index.stats.archives} archives of ${root} (latest ${index.latestVersion.join(".")}) in ${((Date.now() - started) / 1000).toFixed(1)} s`)
const built = buildDataPack({ index, region: opts.region, assetsDir: opts.assets ? appPath("assets") : null, outDir: path.resolve(opts.out) })
const mb = (n: number) => (n / 1024 / 1024).toFixed(2) + " MB"
console.log(`data pack for CDN ${built.manifest.cdnVersion}: ${built.masters} master files${opts.assets ? ` and ${built.manifest.files.length - built.masters} asset files` : ""}`)
if (built.missingOptional.length > 0) console.log(`not in the CDN (optional): ${built.missingOptional.join(", ")}`)
console.log(`folder   ${built.folder}`)
console.log(`archive  ${built.archive} (${mb(built.descriptor.size)})`)
console.log(`sha256   ${built.descriptor.sha256}`)
console.log(`descriptor ${built.descriptorFile}`)
// SEC-19: the pin the bundle (scripts/bundle.mjs) names, so servers and apps refuse a pack with other master tables
if (opts.pin !== undefined) {
    const masters = built.manifest.files.filter(f => f.path.startsWith("master/")).map(f => f.path).sort()
    const pin = { format: built.manifest.format, cdnVersion: built.manifest.cdnVersion, region: built.manifest.region,
        mastersDigest: mastersDigest(built.manifest.files), tables: masters }
    writeFileSync(opts.pin, JSON.stringify(pin, null, 1) + "\n")
    console.log(`pin      ${opts.pin} (masters ${pin.mastersDigest})`)
}
