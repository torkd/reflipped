// Mission entitlement snapshots freeze reward amounts when earned, including a full gift box or a later profile
// change. Category 0 is reserved here for Step Up missions; the game's ordinary categories start at 1.
import getDatabase, { Database } from ".";
const db = getDatabase(Database.WDFP_DATA)
export function rewardSnapshotSync<T>(playerId: number, category: number, missionId: number, stage: number, create: () => T): T {
    const row = db.prepare(`SELECT rewards_json FROM players_mission_reward_snapshots
        WHERE player_id = ? AND category = ? AND mission_id = ? AND stage = ?`).get(playerId, category, missionId, stage) as { rewards_json: string } | undefined
    if (row) return JSON.parse(row.rewards_json) as T
    const rewards = create()
    db.prepare(`INSERT INTO players_mission_reward_snapshots (player_id, category, mission_id, stage, rewards_json)
        VALUES (?, ?, ?, ?, ?)`).run(playerId, category, missionId, stage, JSON.stringify(rewards))
    return rewards
}
export function deleteRewardSnapshotSync(playerId: number, category: number, missionId: number, stage: number): void {
    db.prepare(`DELETE FROM players_mission_reward_snapshots WHERE player_id = ? AND category = ? AND mission_id = ? AND stage = ?`).run(playerId, category, missionId, stage)
}
export function deleteRewardSnapshotCategorySync(playerId: number, category: number): void {
    db.prepare(`DELETE FROM players_mission_reward_snapshots WHERE player_id = ? AND category = ?`).run(playerId, category)
}

export interface MissionRunProgress { category: number, missionId: number, progress: number, clearedStage: number }
export function currentMissionRunSync(playerId: number): string | null {
    return (db.prepare(`SELECT run_key FROM players_mission_event_current_run WHERE player_id = ?`).get(playerId) as { run_key: string } | undefined)?.run_key ?? null
}
export function setCurrentMissionRunSync(playerId: number, key: string): void {
    db.prepare(`INSERT INTO players_mission_event_current_run (player_id, run_key) VALUES (?, ?)
        ON CONFLICT (player_id) DO UPDATE SET run_key = excluded.run_key`).run(playerId, key)
}
export function missionRunProgressSync(playerId: number, key: string): MissionRunProgress[] {
    const row = db.prepare(`SELECT progress_json FROM players_mission_event_runs WHERE player_id = ? AND run_key = ?`).get(playerId, key) as { progress_json: string } | undefined
    return row ? JSON.parse(row.progress_json) as MissionRunProgress[] : []
}
export function setMissionRunProgressSync(playerId: number, key: string, progress: MissionRunProgress[]): void {
    db.prepare(`INSERT INTO players_mission_event_runs (player_id, run_key, progress_json) VALUES (?, ?, ?)
        ON CONFLICT (player_id, run_key) DO UPDATE SET progress_json = excluded.progress_json`).run(playerId, key, JSON.stringify(progress))
}
