// Pure catalog lookup: the database layer must not import the mission engine back through its own dependencies.
import missions from "../../assets/mission.json";
import type { PlayerMission } from "./types";

interface DegreeMission { stages: { rewards: { kind: number, id?: number }[] }[] }
const degreeMissions = missions["5"] as Record<string, DegreeMission>

/** Only titles actually owned and awarded by retained, cleared title-mission stages survive explicit replacement. */
export function retainedMissionDegreeIds(owned: number[], claims: Pick<PlayerMission, "missionId" | "clearedStage">[]): number[] {
    const earned = new Set<number>()
    for (const claim of claims) {
        for (const stage of degreeMissions[String(claim.missionId)]?.stages.slice(0, claim.clearedStage) ?? []) {
            for (const reward of stage.rewards) if (reward.kind === 6 && reward.id !== undefined) earned.add(reward.id)
        }
    }
    return owned.filter(id => earned.has(id))
}
