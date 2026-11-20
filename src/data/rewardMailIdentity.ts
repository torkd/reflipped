import { createHash } from "crypto";
import type { PlayerMail } from "./types";

type RewardIdentity = Pick<PlayerMail, "type" | "typeId" | "number" | "reasonId" | "subject" | "description" | "createTime" | "rewardLimitTime">

/** Legacy saves have no opaque source key. Compare their immutable mail contents at the save format's precision. */
export function rewardMailFingerprint(mail: RewardIdentity): string {
    return createHash("sha256").update(JSON.stringify([
        mail.type, mail.typeId, mail.number, mail.reasonId, mail.subject, mail.description,
        Math.floor(mail.createTime.getTime() / 1000),
        mail.rewardLimitTime === null ? null : Math.floor(mail.rewardLimitTime.getTime() / 1000)
    ])).digest("hex")
}

export interface StoredRewardIdentity {
    id: number, player_id: number, type: number, type_id: number | null, number: number, reason_id: number,
    subject: string | null, description: string | null, create_time: string, reward_limit_time: string | null
}

export function storedRewardMailFingerprint(mail: StoredRewardIdentity): string {
    return rewardMailFingerprint({
        type: mail.type, typeId: mail.type_id, number: mail.number, reasonId: mail.reason_id,
        subject: mail.subject, description: mail.description, createTime: new Date(mail.create_time),
        rewardLimitTime: mail.reward_limit_time === null ? null : new Date(mail.reward_limit_time)
    })
}
