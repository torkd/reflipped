// Writes out/build-info.json during `npm run build`: the commit the server was built from and when, so the running
// server reports its build (src/lib/serverVersion.ts) without needing git, or a .git folder, at run time.
// REFLIPPED_COMMIT overrides the commit, for builds without a .git folder (the Docker image: --build-arg).
// `--out <dir>` writes it there instead (the bundle: scripts/bundle.mjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
    try {
        return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

function commit() {
    const given = process.env.REFLIPPED_COMMIT?.trim();
    if (given) return /^[0-9a-f]{7,40}(-dirty)?$/i.test(given) ? given.toLowerCase() : null;
    const head = git("rev-parse", "--short=12", "HEAD");
    if (!head) return null;
    // tracked changes only: a build tree always has untracked files (out/, .database/)
    const dirty = git("status", "--porcelain", "--untracked-files=no");
    return dirty ? `${head}-dirty` : head;
}

const info = { commit: commit(), builtAt: new Date().toISOString() };
const outFlag = process.argv.indexOf("--out");
const outDir = outFlag >= 0 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1]) : path.join(root, "out");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "build-info.json"), JSON.stringify(info) + "\n");
console.log(`build-info: commit ${info.commit ?? "unknown"}`);
