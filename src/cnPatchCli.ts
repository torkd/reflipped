/**
 * `npm run cn:patch` (FT-79): writes the client files the global CDN lacks, taken from the Chinese version's CDN
 * (src/lib/cnPatches.ts), as a mod, for a server that doesn't have the Chinese CDN itself.
 *
 *   npm run cn:patch -- [--cn DIR] [--out DIR]
 *
 * `--cn` defaults to `CN_CDN_DIR`, else `<CDN_DIR>/cn`; `--out` to `<CDN_DIR>/mods`. The mod is `cn-patches.zip`.
 * A server that has the Chinese CDN needs neither: it builds the same archive at startup (`CN_PATCHES=auto`), so
 * don't install both. In the Docker image (no tsc there): node out/cnPatchCli.js [options].
 */
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { buildCnPatchArchive, cnCdnDir } from "./lib/cnPatches";
import { cdnDir } from "./lib/paths";

function usage(message?: string): never {
    if (message) console.error(message)
    console.error("usage: npm run cn:patch -- [--cn DIR] [--out DIR]")
    process.exit(2)
}

const opts = { cn: cnCdnDir(), out: path.join(cdnDir(), "mods") }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i] ?? usage(`${arg} needs a value`)
    switch (arg) {
        case "--cn": opts.cn = path.resolve(value()); break
        case "--out": opts.out = path.resolve(value()); break
        case "-h": case "--help": usage(); break
        default: usage(`unknown option ${arg}`)
    }
}

let built
try {
    built = buildCnPatchArchive(opts.cn)
} catch (error) {
    console.error(`can't read the Chinese game data in ${opts.cn}: ${(error as Error).message}`)
    process.exit(1)
}
for (const skip of built?.skipped ?? []) console.warn(`left out ${skip.assetPath}: ${skip.reason}`)
if (!built) {
    console.error(`no file to take from ${opts.cn}`)
    process.exit(1)
}
mkdirSync(opts.out, { recursive: true })
const file = path.join(opts.out, "cn-patches.zip")
writeFileSync(file, built.data)
console.log(`wrote ${file} (${built.included.length} file${built.included.length === 1 ? "" : "s"}: ${built.included.join(", ")})`)
console.log("Restart Reflipped to send it to the players.")
