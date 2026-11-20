import { getRewardPolicy } from "../../lib/rewardPolicy";

/** Plain, shared state for the player and all-player reward forms; the API enforces the same policy. */
export function rewardManagementUi(): Record<string, string> {
    const locked = getRewardPolicy().management === "automatic"
    return {
        rewardActionDisabled: locked ? "disabled" : "",
        rewardActionLocked: locked ? "true" : "false",
        rewardPolicyNotice: locked ? `<p class="card-text">Automatic reward management locks save uploads, developer mode, progress resets and admin gifts. Switch to Managed in <a class="text-primary underline" href="/settings">Settings</a> to edit them.</p>` : ""
    }
}
