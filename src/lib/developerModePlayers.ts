// The players in developer mode (src/lib/developerMode.ts), for the shared boards to leave out: SEC-18, in every mode,
// even with anti-cheat off, since their records were made with everything unlocked. Its own small module, so the
// boards (ranking, raid, rush, suggested parties) can import it without pulling in developer mode's dependencies.

import { readdirSync } from "fs";
import path from "path";
import { databaseDir } from "./paths";

/** Where developer mode keeps each player's save from before the unlock (`<player id>.json`). */
export function developerModeBackupDir(): string {
    return path.join(databaseDir(), "developer-mode-backups")
}

let unlocked: { dir: string, players: Set<number> } | null = null

/**
 * The players in developer mode. Read once from the backup folder, then kept in step by unlock, revert and forget
 * (setDeveloperMode), so a board read doesn't touch the disk per player.
 */
export function developerModePlayers(): ReadonlySet<number> {
    const dir = developerModeBackupDir()
    if (unlocked === null || unlocked.dir !== dir) {
        const players = new Set<number>()
        try {
            for (const name of readdirSync(dir)) {
                const match = /^(\d+)\.json$/.exec(name)
                if (match) players.add(Number(match[1]))
            }
        } catch { /* no backups yet */ }
        unlocked = { dir, players }
    }
    return unlocked.players
}

export function setDeveloperMode(playerId: number, on: boolean): void {
    const players = developerModePlayers() as Set<number>
    if (on) players.add(playerId)
    else players.delete(playerId)
}
