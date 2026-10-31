package reflipped.shell.other;

import reflipped.shell.common.StubContext;
import reflipped.shell.common.StubExtension;

/** `com.distriqt.GameServices`: reports itself unsupported. Function names from tools/ane_calls.py. */
public class GameServicesStub extends StubExtension {
    @Override
    protected String extensionId() {
        return "com.distriqt.GameServices";
    }

    @Override
    protected void register(StubContext ctx) {
        ctx.constant(false, "isSupported", "isServiceSupported", "isSignedIn", "achievements_isSupported",
                "achievements_canResetAchievements", "authUtil_isSupported", "leaderboards_isSupported",
                "players_isSupported", "quests_isSupported", "savedGames_isSupported", "screenrecording_isSupported",
                "turnBasedMultiplayer_isSupported");
        ctx.constant("0.0.0", "version");
        ctx.constant("reflipped", "implementation");
        ctx.noop("disconnect", "getPlayer", "initialiseService", "loadPlayer", "loadPlayerIcon",
                "multiplayer_loadInvites", "multiplayer_register", "signIn", "signOut",
                "achievements_achievementReveal", "achievements_achievementStepsIncrement",
                "achievements_achievementStepsSet", "achievements_achievementUnlock",
                "achievements_displayAchievementsUI", "achievements_loadAchievements", "achievements_resetAchievements",
                "authUtil_clearToken", "authUtil_getToken", "leaderboards_displayLeaderboardUI",
                "leaderboards_loadLeaderboards", "leaderboards_loadPlayerCenteredScores", "leaderboards_loadPlayerScore",
                "leaderboards_loadScores", "leaderboards_loadTopScores", "leaderboards_submitScore",
                "players_loadPlayerFriends", "quests_accept", "quests_claim", "quests_displayUI", "quests_incrementEvent",
                "quests_listenForCompletion", "quests_loadEvents", "quests_loadQuests", "savedGames_createGame",
                "savedGames_deleteGame", "savedGames_displaySavedGamesUI", "savedGames_loadSavedGames",
                "savedGames_openGame", "savedGames_resolveConflict", "savedGames_saveGame",
                "screenrecording_checkAvailability", "screenrecording_start", "screenrecording_stop",
                "turnBasedMultiplayer_match_cancelMatch", "turnBasedMultiplayer_match_dismissMatch",
                "turnBasedMultiplayer_match_finishMatch", "turnBasedMultiplayer_match_leaveMatch",
                "turnBasedMultiplayer_match_leaveMatchDuringTurn", "turnBasedMultiplayer_match_rematch",
                "turnBasedMultiplayer_match_takeTurn", "turnBasedMultiplayer_acceptInvitation",
                "turnBasedMultiplayer_createMatch", "turnBasedMultiplayer_declineInvitation",
                "turnBasedMultiplayer_dismissInvitation", "turnBasedMultiplayer_displayCreateMatchUI",
                "turnBasedMultiplayer_loadMatch", "turnBasedMultiplayer_loadMatches");
    }
}
