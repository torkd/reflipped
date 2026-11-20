/**
 * `npm run gamefiles` (SH-29): the list of every base game file a fresh install leaves on the phone
 * (`src/gamepack/baseFiles.ts`), which the Reflipped app checks an exported game data pack against.
 *
 *   npm run gamefiles -- --digest [--lang en] [--cdn DIR]     prints the list's digest (pinned in GamePack.java)
 *   npm run gamefiles -- --list FILE [--lang en] [--cdn DIR]  writes the list (`path<TAB>size<TAB>sha256\n` lines)
 *   npm run gamefiles -- --list FILE --archives a.zip,b.zip   the list of these archives instead (the desktop test)
 *
 * `CDN_DIR` gives the default of `--cdn`. Reads and hashes the language's whole base set (about 9 GB, a minute).
 */
import { writeFileSync } from "fs";
import { BaseFile, baseFiles, fileListDigest, fileListText, filesOfArchives } from "./baseFiles";

function usage(message?: string): never {
    if (message) console.error(message)
    console.error("usage: npm run gamefiles -- (--digest | --list FILE) [--lang en|ko|th] [--cdn DIR] [--archives a.zip,b.zip]")
    process.exit(2)
}

const opts = { cdn: process.env.CDN_DIR || ".cdn", lang: "en", digest: false, list: undefined as string | undefined, archives: undefined as string[] | undefined }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i] ?? usage(`${arg} needs a value`)
    switch (arg) {
        case "--cdn": opts.cdn = value(); break
        case "--lang": opts.lang = value(); break
        case "--digest": opts.digest = true; break
        case "--list": opts.list = value(); break
        case "--archives": opts.archives = value().split(","); break
        default: usage(`unknown option ${arg}`)
    }
}
if (!opts.digest && opts.list === undefined) usage()
if (!["en", "ko", "th"].includes(opts.lang)) usage(`unknown language ${opts.lang}`)

const progress = (done: number, of: number) => { if (done % 100 === 0 || done === of) process.stderr.write(`\r${done}/${of} archives`) }
const files: BaseFile[] = opts.archives ? filesOfArchives(opts.archives) : baseFiles(opts.lang, opts.cdn, progress)
process.stderr.write("\n")
if (opts.list !== undefined) writeFileSync(opts.list, fileListText(files))
const bytes = files.reduce((sum, f) => sum + f.size, 0)
console.log(`${opts.archives ? "archives" : opts.lang}: ${files.length} files, ${bytes} bytes, list digest ${fileListDigest(files)}`)
