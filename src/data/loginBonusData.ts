import loginBonus from "../../assets/login_bonus.json";

export type LoginBonusGroupType = "Normal" | "Limited" | "Comeback" | "ComebackAlways" | "ActiveUser"

export interface LoginBonusReward {
    kind: number
    amount: number
    itemId?: number
    characterId?: number
}

export interface LoginBonusDay {
    index: number
    rewards: LoginBonusReward[]
}

export interface LoginBonusGroup {
    id: string
    groupType: LoginBonusGroupType
    startDate: string | null
    endDate: string | null
    annualStart: string | null
    annualEnd: string | null
    conditionStart: string | null
    conditionEnd: string | null
    comebackGroupId: string | null
    includeBeginner: boolean | null
    reasonId: number
    days: LoginBonusDay[]
}

/** Only server-relevant columns of master/bonus/login_bonus; generated with scripts/converter.py. */
export const loginBonusGroups = loginBonus as LoginBonusGroup[]
