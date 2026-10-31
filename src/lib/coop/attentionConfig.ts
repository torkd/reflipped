/**
 * The attention (`config`) block the client applies from any reply that has one (load, attention/check, share_room):
 * the values the original server returned (captured 2024-06), with the timings an admin can change on the Settings
 * page. A block that is present must hold all 22 fields, or the client throws 8700 (docs/coop-research.md).
 */
import { getSetting } from "../../data/serverSettings"

export const CAPTURED_ATTENTION_CONFIG = {
    "attention_recruitment_interval_seconds": 15,
    "attention_recruitment_redeliver_limit": 20,
    "attention_polling_interval_seconds_normal": 10,
    "attention_polling_interval_seconds_battle": 15,
    "multi_attention_lifetime_seconds": 30,
    "contribution_score_rate_to_parasite": 0.25,
    "attention_log_interval_seconds": 600,
    "disable_finish_duration_seconds": 5,
    "disable_decline_count_seconds": 60,
    "disable_decline_count_limit": 14,
    "disable_decline_duration_seconds": 30,
    "disable_intent_disconnect_duration_seconds": 300,
    "disable_unintent_disconnect_duration_seconds": 5,
    "disable_remote_error_duration_seconds": 300,
    "attention_animation_time_seconds": 6,
    "disable_expire_count_limit": 4,
    "disable_expire_duration_seconds": 180,
    "polling_delay_normal_seconds_range_min": 1,
    "polling_delay_normal_seconds_range_max": 10,
    "polling_delay_battle_seconds_range_min": 1,
    "polling_delay_battle_seconds_range_max": 15,
    "return_attention_max_num": 3
}

/** The config block with the admin's timings. */
export function attentionConfig(): typeof CAPTURED_ATTENTION_CONFIG {
    return {
        ...CAPTURED_ATTENTION_CONFIG,
        "attention_recruitment_interval_seconds": getSetting("coop.recruit_interval_seconds"),
        "attention_polling_interval_seconds_normal": getSetting("client.attention_polling_seconds"),
        "attention_polling_interval_seconds_battle": getSetting("client.attention_polling_battle_seconds"),
        "multi_attention_lifetime_seconds": getSetting("coop.invitation_lifetime_seconds")
    }
}
