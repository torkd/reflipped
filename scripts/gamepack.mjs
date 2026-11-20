// Builds a game data pack (SH-25): the game's own CDN archives in the order the game downloads them, in one
// uncompressed tar the Reflipped app installs from a file instead of downloading about 10 GB from a server. Every
// Reflipped server lists the same base files, so one pack serves every server; the app then asks the server only for
// its own layers (schedule, translation, mods). See docs/game-data-pack.md.
//
//   npm run gamepack                         en, from CDN_DIR (default .cdn), to reflipped-gamedata-en-<version>.tar
//   npm run gamepack -- --lang ko --cdn /srv/cdn --out /tmp/ko.tar
//   npm run gamepack -- --digests            prints each asset list's digest (pinned in the app: GamePack.java)
//   npm run gamepack -- --limit 3 --out t.tar   only the first 3 archives: a test pack, which the app refuses
//                                               (its list isn't an official one); client/air-shell/test/gamepack-test.sh
//
// The pack: first `reflipped-gamepack.json`, the manifest
//   {"format":1,"kind":"reflipped-game-data","lang","platform","version","list","totalSize","archives":[{path,size,sha256}]}
// then each archive at its CDN path (`en/archive-android-full/asset-2.1.0-1-….zip`), in the manifest's order: the
// full archives, then every diff version. `list` is the digest of the archive list (see listDigest); the app accepts
// only the official lists' digests, and checks each archive's size and SHA-256 (base64, as the asset lists give it).
// Each archive's SHA-256 is checked here too before it goes in, so a damaged CDN copy stops the build.
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const LANGS = ["en", "ko", "th"];
const PLATFORM = "android";
export const MANIFEST = "reflipped-gamepack.json";

/** The archives of a language's full asset list in download order, and the list's last version. */
export function archiveList(lang) {
    const list = JSON.parse(readFileSync(path.join(root, "assets", "asset_lists", `${lang}-${PLATFORM}-full.json`), "utf8"));
    const archives = [...list.full.archive]
    let version = list.full.version
    for (const step of list.diff) {
        if (step.original_version !== version) throw new Error(`${lang}: diff ${step.version} doesn't follow ${version}`)
        archives.push(...step.archive)
        version = step.version
    }
    return {
        version,
        archives: archives.map(a => {
            if (!a.location.startsWith("{$cdnAddress}/")) throw new Error(`unexpected location ${a.location}`)
            return { path: a.location.slice("{$cdnAddress}/".length), size: a.size, sha256: a.sha256 }
        })
    }
}

/** sha256 (hex) of one "path<TAB>size<TAB>sha256\n" line per archive: what the app pins for each official list. */
export function listDigest(archives) {
    const hash = createHash("sha256")
    for (const a of archives) hash.update(`${a.path}\t${a.size}\t${a.sha256}\n`)
    return hash.digest("hex")
}

function tarHeader(name, size) {
    if (Buffer.byteLength(name) > 100) throw new Error(`name too long for the tar header: ${name}`)
    const header = Buffer.alloc(512)
    header.write(name, 0, "utf8")
    header.write("0000644\0", 100)
    header.write("0000000\0", 108)
    header.write("0000000\0", 116)
    header.write(size.toString(8).padStart(11, "0") + "\0", 124)
    header.write("00000000000\0", 136) // mtime 0: the same archives always make the same pack
    header.write("        ", 148)
    header.write("0", 156)
    header.write("ustar\0", 257)
    header.write("00", 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
    return header
}

function main() {
    if (args.includes("--digests")) {
        for (const lang of LANGS) {
            const { version, archives } = archiveList(lang)
            console.log(`${lang}\t${version}\t${archives.length} archives\t${listDigest(archives)}`)
        }
        return
    }
    const lang = flag("--lang", "en")
    if (!LANGS.includes(lang)) throw new Error(`--lang must be one of ${LANGS.join(", ")}`)
    const cdn = path.resolve(flag("--cdn", process.env.CDN_DIR || path.join(root, ".cdn")))
    const listed = archiveList(lang)
    const version = listed.version
    const limit = Number(flag("--limit", "0"))
    const archives = limit > 0 ? listed.archives.slice(0, limit) : listed.archives
    const out = path.resolve(flag("--out", `reflipped-gamedata-${lang}-${version}.tar`))
    const missing = archives.filter(a => !existsSync(path.join(cdn, a.path)))
    if (missing.length) throw new Error(`${missing.length} of ${archives.length} archives aren't in ${cdn}, e.g. ${missing[0].path}`)
    const totalSize = archives.reduce((sum, a) => sum + a.size, 0)
    const manifest = Buffer.from(JSON.stringify({
        format: 1, kind: "reflipped-game-data", lang, platform: PLATFORM, version,
        list: listDigest(archives), totalSize, archives
    }))

    const temp = out + ".part"
    const fd = openSync(temp, "w")
    const pad = (size) => { if (size % 512) writeSync(fd, Buffer.alloc(512 - (size % 512))) }
    writeSync(fd, tarHeader(MANIFEST, manifest.length))
    writeSync(fd, manifest)
    pad(manifest.length)
    const buffer = Buffer.alloc(4 << 20)
    let done = 0
    let lastReport = 0
    for (const a of archives) {
        const file = path.join(cdn, a.path)
        if (statSync(file).size !== a.size) throw new Error(`${a.path}: ${statSync(file).size} bytes, the list says ${a.size}`)
        writeSync(fd, tarHeader(a.path, a.size))
        const hash = createHash("sha256")
        const input = openSync(file, "r")
        for (let n; (n = readSync(input, buffer, 0, buffer.length, null)) > 0;) {
            hash.update(buffer.subarray(0, n))
            writeSync(fd, buffer, 0, n)
        }
        closeSync(input)
        if (hash.digest("base64") !== a.sha256) throw new Error(`${a.path}: SHA-256 doesn't match the asset list (damaged copy?)`)
        pad(a.size)
        done += a.size
        if (done - lastReport > 500e6 || done === totalSize) {
            lastReport = done
            console.log(`gamepack: ${(done / 1e9).toFixed(2)} of ${(totalSize / 1e9).toFixed(2)} GB`)
        }
    }
    writeSync(fd, Buffer.alloc(1024))
    closeSync(fd)
    renameSync(temp, out)
    console.log(`gamepack: wrote ${out} (${lang}, ${version}, ${archives.length} archives, ${(statSync(out).size / 1e9).toFixed(2)} GB)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        main()
    } catch (error) {
        console.error(`gamepack: ${error.message}`)
        process.exit(1)
    }
}
