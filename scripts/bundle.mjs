// Builds the server as one JavaScript file for the server on the phone (SH-13, docs/on-device-server.md), with the
// files it reads beside it:
//   out/bundle/server.js        the server and its npm dependencies (esbuild, CommonJS, Node 24)
//   out/bundle/build-info.json  the commit it was built from (scripts/build-info.mjs)
//   out/bundle/assets/          the converted game data, kept as JSON files: inlined, it costs Node 360-420 MB of RAM
//   out/bundle/web/             page templates and the stylesheet, scripts and images of the web pages
// Run it with `npm run bundle` (which builds the stylesheet first). Start it with `node out/bundle/server.js` from the
// folder that holds, or should hold, the data (`.database/`, `.cdn/`, `.logs/`): src/lib/paths.ts takes data paths from
// the working directory and the shipped files from the bundle's folder.
//
// `--out <dir>` writes it elsewhere; `--minify` shrinks the code (stack traces keep the function names).
// `--no-assets` leaves `assets/` out too (SH-13 step 3, "Server data pack" in docs/on-device-server.md): the bundle then
// reads the converted game data from the data pack, `$DATA_PACK_DIR/assets/` (`npm run datapack` builds it), and refuses
// a pack whose assets differ from the ones it was built with. Its code holds no game content then; the app still
// carries a copy of the converted data in `datapack-source/` (SH-29), from which it builds the pack itself with the
// master tables of the game files on the phone. The server never reads that folder.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outDir = outFlag >= 0 && args[outFlag + 1] ? path.resolve(args[outFlag + 1]) : path.join(root, "out", "bundle");
const minify = args.includes("--minify");
const packAssets = args.includes("--no-assets");

const assetsDir = path.join(root, "assets");
// SEC-19: the master tables of the official data pack (`npm run datapack -- --write-pin src/datapack/pin.json`), which
// a --no-assets bundle requires, so a pack with altered masters is refused by the server and by the app
const pinFile = path.join(root, "src", "datapack", "pin.json");
const mastersPin = existsSync(pinFile) ? JSON.parse(readFileSync(pinFile, "utf8")).mastersDigest : null;
const stylesheet = path.join(root, "web", "public", "tailwind.css");
if (!existsSync(stylesheet)) {
    console.error("web/public/tailwind.css is missing: run `npm run css` first (`npm run bundle` does)");
    process.exit(1);
}

/** Leaves `assets/**.json` out of the bundle: each import becomes a require of the copy beside server.js. */
const assetsAsFiles = {
    name: "assets-as-files",
    setup(b) {
        b.onResolve({ filter: /\.json$/ }, (resolveArgs) => {
            const file = path.resolve(resolveArgs.resolveDir, resolveArgs.path);
            const relative = path.relative(assetsDir, file);
            if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
            return { path: "./assets/" + relative.split(path.sep).join("/"), external: true };
        });
    }
};

/** `--no-assets`: each import becomes a require of the file in the data pack, found by DATA_PACK_DIR when it runs. */
const assetsFromPack = {
    name: "assets-from-pack",
    setup(b) {
        b.onResolve({ filter: /\.json$/ }, (resolveArgs) => {
            const file = path.resolve(resolveArgs.resolveDir, resolveArgs.path);
            const relative = path.relative(assetsDir, file);
            if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
            return { path: relative.split(path.sep).join("/"), namespace: "pack-asset" };
        });
        b.onLoad({ filter: /.*/, namespace: "pack-asset" }, (loadArgs) => ({
            contents: `module.exports = require(require("node:path").resolve((process.env.DATA_PACK_DIR || "").trim(), "assets", ${JSON.stringify(loadArgs.path)}))`,
            loader: "js"
        }));
    }
};

/** The digest of assets/ the data pack's manifest must carry: the same as `assetsDigest()` in src/lib/dataPack.ts. */
function assetsDigest() {
    const lines = [];
    const walk = (dir, base) => {
        for (const name of readdirSync(dir).sort()) {
            const rel = base ? `${base}/${name}` : name;
            if (statSync(path.join(dir, name)).isDirectory()) walk(path.join(dir, name), rel);
            else lines.push(`assets/${rel} ${createHash("sha256").update(readFileSync(path.join(dir, name))).digest("hex")}\n`);
        }
    };
    walk(assetsDir, "");
    const hash = createHash("sha256");
    for (const line of lines.sort()) hash.update(line);
    return hash.digest("hex");
}

rmSync(outDir, { recursive: true, force: true });
const result = await build({
    entryPoints: [path.join(root, "src", "server.ts")],
    outfile: path.join(outDir, "server.js"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    // src/lib/paths.ts: server.js sits in the app root
    define: { REFLIPPED_BUNDLE: "true", ...(packAssets ? { REFLIPPED_PACK_ASSETS: JSON.stringify(assetsDigest()) } : {}),
        ...(packAssets && mastersPin !== null ? { REFLIPPED_PACK_MASTERS: JSON.stringify(mastersPin) } : {}) },
    // msgpackr's optional native accelerator: msgpackr falls back to plain JS without it
    external: ["msgpackr-extract"],
    plugins: [packAssets ? assetsFromPack : assetsAsFiles],
    // SH-13: on the phone, Node's report of an uncaught error starts with the source line, which in a minified bundle
    // is the whole file and fills Android's log entry, so the message never reaches the app's error dialog. Write the
    // stack first, on its own (the phone's server runs with the local profile). The banner comes before esbuild's own
    // "use strict", so it repeats it: the bundle must stay strict.
    banner: {
        js: '"use strict";if(process.env.REFLIPPED_PROFILE==="local")process.on("uncaughtExceptionMonitor",function(e){' +
            'try{process.stderr.write("Uncaught error: "+String(e&&e.stack||e)+"\\n")}catch(_){}});'
    },
    minify,
    keepNames: true,
    legalComments: "linked",
    metafile: true,
    logLevel: "warning"
});

if (!packAssets) cpSync(assetsDir, path.join(outDir, "assets"), { recursive: true });
for (const dir of ["pages", "public"])
    cpSync(path.join(root, "web", dir), path.join(outDir, "web", dir), { recursive: true });
execFileSync(process.execPath, [path.join(root, "scripts", "build-info.mjs"), "--out", outDir], { stdio: "inherit" });
// SH-13: the data pack this bundle accepts, for the app to check a pack before it starts the server (DATA_PACK_DIGEST
// in client/air-shell/java/.../service/ServerBundle.java)
if (packAssets) writeFileSync(path.join(outDir, "datapack-assets-digest.txt"), assetsDigest() + "\n");
if (packAssets && mastersPin !== null) writeFileSync(path.join(outDir, "datapack-masters-digest.txt"), mastersPin + "\n");
// SH-29: what the app needs to build that pack itself from the game files on the phone: the list of files it takes
// from them (src/datapack/source.ts) and the converted game data, which the server reads only from the pack
if (packAssets) {
    const source = path.join(outDir, "datapack-source");
    cpSync(assetsDir, path.join(source, "assets"), { recursive: true });
    execFileSync(process.execPath, ["--import", "tsx", path.join(root, "src", "datapack", "source.ts"),
        path.join(source, "source.json")], { cwd: root, stdio: "inherit" });
}

const externalAssets = new Set();
for (const input of Object.values(result.metafile.inputs))
    for (const imported of input.imports)
        if (imported.external && imported.path.startsWith("./assets/")) externalAssets.add(imported.path);
const size = statSync(path.join(outDir, "server.js")).size;
console.log(`bundle: ${path.relative(process.cwd(), outDir) || "."}/server.js, ${(size / 1024 / 1024).toFixed(1)} MB; ` +
    (packAssets ? "asset files are read from the data pack (DATA_PACK_DIR)" : `${externalAssets.size} asset files read beside it`));
