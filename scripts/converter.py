# Converts the output/orderedmap files into a format readable by the server.
import json
import os
from math import floor

ROOT = os.path.dirname(os.path.realpath(__file__))
FILE_INPUT = os.path.join(ROOT, 'in')
FILE_OUTPUT = os.path.join(ROOT, "out")

# create output directory if it doesn't exist
if not os.path.exists(FILE_OUTPUT):
    os.makedirs(FILE_OUTPUT)

# create input directory if it doesn't exist
if not os.path.exists(FILE_INPUT):
    os.makedirs(FILE_INPUT)

# parses a json file into an object.
def parse_file(file_name):
    if file_name.endswith(".json") and os.path.exists(file_name):
        with open(file_name, "r", encoding='utf8') as file:
            return json.load(file)
    return None

# A battle quest's row holds its recommended element (`battle_recommended_element`, 0 red, 1 blue, 2 yellow, 3 green,
# 4 white, 5 black), the one strong against its enemies. The client turns it into the enemies' element (the one it
# beats) before picking an element or aether reward's item from `reward/reward_element_map`, so the converted quests
# store that instead (`enemyElement`). Rows without one ("" or "(None)") get none.
RECOMMENDED_TO_ENEMY_ELEMENT = {0: 3, 1: 0, 2: 1, 3: 2, 4: 5, 5: 4}

# A battle quest's S+ reward (`battle_rank_ss_reward_id`, a `reward/clear_reward` id, paid on its first S+ clear; FT-7).
# Rows without one ("" or "(None)") get None, which `with_s_plus_rewards` then leaves out.
def s_plus_reward_id(cell):
    return None if cell in ("", "(None)") else int(cell)

def with_s_plus_rewards(converter):
    def convert(obj, *args):
        converted = converter(obj, *args)
        for quest in converted.values():
            if quest.get("sPlusRewardId", 0) is None:
                del quest["sPlusRewardId"]
        return converted
    return convert

# A quest's own attempts (`daily_challenge_point_id`, column 128 of the world story and story event quest rows; FT-30):
# per-boss Solo Boss Challenges and the one-off anniversary and event quests.
def add_challenge_point(converted, row, column):
    if row[column] not in ("", "(None)"):
        converted["challengePointId"] = int(row[column])
    return converted

# Items a quest takes to start (`battle_startable_use_item_mode` and its item_ids and item_counts, the next two columns;
# FT-8): mode 0 (Once) takes them on the first clear only, the quest staying open afterwards; mode 1 (Always) on every
# clear (the Treasure Zone's Golden Skull). The client: "The item(s) will only be used up once the quest has been
# cleared."
def add_use_items(converted, row, column):
    if row[column] not in ("", "(None)"):
        ids, counts = row[column + 1].split(" "), row[column + 2].split(" ")
        converted["useItems"] = {
            "always": row[column] == "1",
            "items": [{"id": int(item_id), "count": int(count)} for item_id, count in zip(ids, counts)]
        }
    return converted

# A battle quest's stamina cost (`battle_stamina_cost`, the column before the score reward group in most tables; FT-25).
# The ranking quests' column (66, 20 for all five) is inferred from the data: their row parser wasn't found.
# A battle quest's enemy level (`battle_enemy_level`, 37 columns after the stamina cost in the long quest tables): the
# collect item events' quest drops go by it (FT-2). The daily quests keep it in their odds table (column 11).
def add_enemy_level(converted, row, column):
    if row[column] not in ("", "(None)"):
        converted["enemyLevel"] = int(row[column])
    return converted

def odds_enemy_levels(name):
    odds = parse_file(os.path.join(FILE_INPUT, f"{name}.json")) or {}
    return {group_id: int(next(iter(rows.values()))[11]) for group_id, rows in odds.items()}

def add_stamina_cost(converted, row, column):
    if row[column] not in ("", "(None)"):
        converted["staminaCost"] = int(row[column])
    return converted

def add_enemy_element(converted, row, column):
    if row[column] not in ("", "(None)"):
        converted["enemyElement"] = RECOMMENDED_TO_ENEMY_ELEMENT[int(row[column])]
    return converted

# A battle quest's time limit (`battle_time_limit`, in frames at 60 a second, kept in milliseconds): SEC-18's R5 checks
# a finish's clear time against it, and the Carnival's time bonus counts what is left of it. It is the column right after
# the battle's background (`*_battle*`, `area_*`), found by that pattern in every quest table: 111 in the main, EX, boss,
# world story boss and challenge dungeon quests, 112 world story, practice and hard multi, 113 story event, 114 expert,
# 115 advent, 100 tower, carnival, rush and raid, 103 Chrono Trial and Score Scramble, 94 ranking. The daily quest
# tables have no battle columns of their own. Story rows ("") get none.
def add_time_limit(converted, row, column):
    if row[column] not in ("", "(None)"):
        converted["timeLimitMs"] = int(row[column]) * 1000 // 60
    return converted

# converts a json quest list object into the correct form. `lose_battle_column`: the main quest row's quest kind
# (NormalQuestKind: 0 story, 1 battle, 2 lose battle), whose lose battles (one, 7014002) the player is meant to lose:
# the game finishes them with is_accomplished false, and they count as cleared (SEC-16)
def score_reward_rolls(row, group_column):
    """How many times a quest draws its score reward group's fixed items per battle: the column before the group's
    (10 for most story event quests, 13 to 20 for bosses, 30 or 40 for the tower dungeons). None if it is blank."""
    value = row[group_column - 1]
    return int(float(value)) if value not in ("", None) else None

@with_s_plus_rewards
def convert_main_ex_quests(obj, lose_battle_column=None):
    converted = {}
    for _, chapter_stages in obj.items():
        for _, sub_stages in chapter_stages.items():
            for _, chapter in sub_stages.items():
                # determine whether the quest is a story or not
                if chapter[84] == "":
                    # is story
                    converted[chapter[0]] = {
                        "name": "", #chapter[1],
                        "clearRewardId": int(chapter[3])
                    }
                else:
                    converted_chapter = {
                        "name": "", #chapter[1],
                        "clearRewardId": int(chapter[3]),
                        "sPlusRewardId": s_plus_reward_id(chapter[71]),
                        "scoreRewardGroup": int(chapter[70]),
                        "scoreRewardRolls": score_reward_rolls(chapter, 70),
                        "bRankTime": floor(float(chapter[84]) * 1000),
                        "aRankTime": floor(float(chapter[85]) * 1000),
                        "sRankTime": floor(float(chapter[86]) * 1000),
                        "sPlusRankTime":  floor(float(chapter[87]) * 1000),
                        "rankPointReward": int(chapter[93]),
                        "characterExpReward": int(chapter[94]),
                        "manaReward": int(chapter[95]),
                        "poolExpReward": int(chapter[96])
                    }
                    add_stamina_cost(converted_chapter, chapter, 69)
                    add_time_limit(converted_chapter, chapter, 111)
                    add_enemy_level(converted_chapter, chapter, 106)
                    if chapter[118] != "(None)":
                        converted_chapter["fixedParty"] = int(chapter[118])
                    if lose_battle_column is not None and chapter[lose_battle_column] == "2":
                        converted_chapter["loseBattle"] = True
                    converted[chapter[0]] = add_enemy_element(converted_chapter, chapter, 72)
    return converted

@with_s_plus_rewards
def convert_boss_quests(obj):
    converted = {}
    for _, chapter_stages in obj.items():
        for _, sub_stages in chapter_stages.items():
            for _, chapter in sub_stages.items():
                # determine whether the quest is a story or not
                if chapter[84] == "":
                    # is story
                    converted[chapter[0]] = {
                        "name": "", #chapter[1],
                        "clearRewardId": int(chapter[3])
                    }
                else:
                    converted[chapter[0]] = {
                        "name": "", #chapter[2],
                        "clearRewardId": int(chapter[4]),
                        "sPlusRewardId": s_plus_reward_id(chapter[71]),
                        "scoreRewardGroup": int(chapter[70]),
                        "scoreRewardRolls": score_reward_rolls(chapter, 70),
                        "bRankTime": floor(float(chapter[84]) * 1000),
                        "aRankTime": floor(float(chapter[85]) * 1000),
                        "sRankTime": floor(float(chapter[86]) * 1000),
                        "sPlusRankTime":  floor(float(chapter[87]) * 1000),
                        "rankPointReward": int(chapter[93]),
                        "characterExpReward": int(chapter[94]),
                        "manaReward": int(chapter[95]),
                        "poolExpReward": int(chapter[96]),
                        # battle_quest_rank: read at column 107 by the client's boss battle row parser.
                        "questRankId": int(chapter[107])
                    }
                    add_stamina_cost(converted[chapter[0]], chapter, 69)
                    add_time_limit(converted[chapter[0]], chapter, 111)
                    add_enemy_level(converted[chapter[0]], chapter, 106)
                    add_enemy_element(converted[chapter[0]], chapter, 72)
    return converted

@with_s_plus_rewards
def convert_world_story_event_quest(obj):
    converted = {}
    for _, chapter_stages in obj.items():
        for _, chapter in chapter_stages.items():
            # determine whether the quest is a story or not
            if chapter[85] == "":
                # is story
                converted[chapter[0]] = {
                    "name": "", #chapter[1],
                    "clearRewardId": int(chapter[4])
                }
            else:
                converted_chapter = {
                    "name": "", #chapter[2],
                    "clearRewardId": int(chapter[4]),
                    "sPlusRewardId": s_plus_reward_id(chapter[72]),
                    "bRankTime": floor(float(chapter[85]) * 1000),
                    "aRankTime": floor(float(chapter[86]) * 1000),
                    "sRankTime": floor(float(chapter[87]) * 1000),
                    "sPlusRankTime":  floor(float(chapter[88]) * 1000),
                    "rankPointReward": int(chapter[94]),
                    "characterExpReward": int(chapter[95]),
                    "manaReward": int(chapter[96]),
                    "poolExpReward": int(chapter[97]),
                }
                add_stamina_cost(converted_chapter, chapter, 70)
                add_time_limit(converted_chapter, chapter, 112)
                if chapter[71] != "(None)":
                    converted_chapter["scoreRewardGroup"] = int(chapter[71])
                    converted_chapter["scoreRewardRolls"] = score_reward_rolls(chapter, 71)
                if chapter[119] != "(None)":
                    converted_chapter["fixedParty"] = int(chapter[119])
                add_challenge_point(converted_chapter, chapter, 128)
                add_use_items(converted_chapter, chapter, 56)
                converted[chapter[0]] = add_enemy_element(converted_chapter, chapter, 73)

    return converted

@with_s_plus_rewards
def convert_world_story_event_boss_battle_quest(obj):
    converted = {}
    for _, chapter_stages in obj.items():
        for _, chapter in chapter_stages.items():
            converted_chapter = {
                "name": "", #chapter[2],
                "clearRewardId": int(chapter[4]),
                "sPlusRewardId": s_plus_reward_id(chapter[71]),
                "bRankTime": floor(float(chapter[84]) * 1000),
                "aRankTime": floor(float(chapter[85]) * 1000),
                "sRankTime": floor(float(chapter[86]) * 1000),
                "sPlusRankTime":  floor(float(chapter[87]) * 1000),
                "rankPointReward": int(chapter[93]),
                "characterExpReward": int(chapter[94]),
                "manaReward": int(chapter[95]),
                # battle_reward_pool_exp is column 96 in the client's boss battle row parser (97 was read before, FT-11)
                "poolExpReward": int(chapter[96])
            }
            add_stamina_cost(converted_chapter, chapter, 69)
            add_time_limit(converted_chapter, chapter, 111)
            if chapter[70] != "(None)":
                converted_chapter["scoreRewardGroup"] = int(chapter[70])
                converted_chapter["scoreRewardRolls"] = score_reward_rolls(chapter, 70)
            converted[chapter[0]] = add_enemy_element(converted_chapter, chapter, 72)

    return converted

@with_s_plus_rewards
def convert_advent_quest(obj):
    converted = {}
    for _, chapter_stages in obj.items():
        for _, chapter in chapter_stages.items():
            # determine whether the quest is a story or not
            if chapter[88] == "":
                # is story
                converted[chapter[0]] = {
                    "name": "", #chapter[1],
                    "clearRewardId": int(chapter[4])
                }
            else:
                converted[chapter[0]] = {
                    "name": "", #chapter[2],
                    "clearRewardId": int(chapter[4]),
                    "sPlusRewardId": s_plus_reward_id(chapter[75]),
                    "scoreRewardGroup": int(chapter[74]),
                    "scoreRewardRolls": score_reward_rolls(chapter, 74),
                    "bRankTime": floor(float(chapter[88]) * 1000),
                    "aRankTime": floor(float(chapter[89]) * 1000),
                    "sRankTime": floor(float(chapter[90]) * 1000),
                    "sPlusRankTime":  floor(float(chapter[91]) * 1000),
                    "rankPointReward": int(chapter[97]),
                    "characterExpReward": int(chapter[98]),
                    "manaReward": int(chapter[99]),
                    "poolExpReward": int(chapter[100])
                }
                add_stamina_cost(converted[chapter[0]], chapter, 73)
                add_time_limit(converted[chapter[0]], chapter, 115)
                add_enemy_level(converted[chapter[0]], chapter, 110)
                add_enemy_element(converted[chapter[0]], chapter, 76)
                add_use_items(converted[chapter[0]], chapter, 59)

    return converted

def convert_daily_exp_mana_event_quest(obj):
    converted = {}
    enemy_levels = odds_enemy_levels("daily_exp_mana_event_quest_odds")
    for _, chapter_stages in obj.items():
        for _, chapter in chapter_stages.items():
            converted[chapter[0]] = {
                "name": "", #chapter[2],
                "clearRewardId": int(chapter[4]),
                "scoreRewardGroup": int(chapter[66]),
                "scoreRewardRolls": score_reward_rolls(chapter, 66),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime":  0,
                "rankPointReward": int(chapter[68]),
                "characterExpReward": int(chapter[69]),
                "manaReward": int(chapter[70]),
                "poolExpReward": int(chapter[71])
            }
            add_stamina_cost(converted[chapter[0]], chapter, 65)
            if chapter[72] in enemy_levels:
                converted[chapter[0]]["enemyLevel"] = enemy_levels[chapter[72]]

    return converted

def convert_daily_week_event_quest(obj):
    converted = {}
    enemy_levels = odds_enemy_levels("daily_week_event_quest_odds")
    for _, chapter_stages in obj.items():
        for _, chapter in chapter_stages.items():
            converted[chapter[0]] = {
                "name": "", #chapter[2],
                "clearRewardId": int(chapter[3]),
                "scoreRewardGroup": int(chapter[65]),
                "scoreRewardRolls": score_reward_rolls(chapter, 65),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime":  0,
                "rankPointReward": int(chapter[67]),
                "characterExpReward": int(chapter[68]),
                "manaReward": int(chapter[69]),
                "poolExpReward": int(chapter[70])
            }
            add_stamina_cost(converted[chapter[0]], chapter, 64)
            if chapter[71] in enemy_levels:
                converted[chapter[0]]["enemyLevel"] = enemy_levels[chapter[71]]

    return converted

@with_s_plus_rewards
def convert_challenge_dungeon_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "clearRewardId": int(quest[4]),
                "scoreRewardGroup": int(quest[71]),
                "scoreRewardRolls": score_reward_rolls(quest, 71),
                "sPlusRewardId": s_plus_reward_id(quest[72]),
                "bRankTime": floor(float(quest[85]) * 1000),
                "aRankTime": floor(float(quest[86]) * 1000),
                "sRankTime": floor(float(quest[87]) * 1000),
                "sPlusRankTime":  floor(float(quest[88]) * 1000),
                "rankPointReward": int(quest[92]),
                "characterExpReward": int(quest[93]),
                "manaReward": int(quest[94]),
                "poolExpReward": int(quest[95])
            }
            add_stamina_cost(converted[quest[0]], quest, 70)
            add_time_limit(converted[quest[0]], quest, 111)
            add_enemy_level(converted[quest[0]], quest, 107)
            add_enemy_element(converted[quest[0]], quest, 73)
            add_use_items(converted[quest[0]], quest, 56)
            # viewable_need_quest_1 (FT-8): the quest the game shows it after (main 1-8-4 for the Treasure Zone, the
            # previous Depths floor for a Depths quest), as in the expert quests
            if quest[7] != "(None)":
                converted[quest[0]]["needQuest"] = {"kind": int(quest[7]), "questId": int(quest[11])}
    return converted 

# Practice Combat (`quest/practice/practice_quest`, FT-17): 58 Lignoid quests keyed by id (6 elements of the same
# Lignoid share a folder, column 1). Their columns are the challenge dungeon quests' up to the enemy level (rank
# times 85-88 in seconds, rank point and unit exp 92-93, mana and pooled exp 94-95 (0), stamina 70 (0), recommended
# element 73); they have no clear, S+ or score reward (columns 4, 71 and 72 are "(None)"), so they drop nothing. Their
# armaments and titles come from missions (regular 56-60, titles 12000-12040).
def convert_practice_quest(obj):
    converted = {}
    for quest_id, quest in obj.items():
        converted[quest_id] = {
            "name": "",
            "bRankTime": floor(float(quest[85]) * 1000),
            "aRankTime": floor(float(quest[86]) * 1000),
            "sRankTime": floor(float(quest[87]) * 1000),
            "sPlusRankTime": floor(float(quest[88]) * 1000),
            "rankPointReward": int(quest[92]),
            "characterExpReward": int(quest[93]),
            "manaReward": int(quest[94]),
            "poolExpReward": int(quest[95])
        }
        add_stamina_cost(converted[quest_id], quest, 70)
        add_time_limit(converted[quest_id], quest, 112)
        add_enemy_level(converted[quest_id], quest, 107)
        add_enemy_element(converted[quest_id], quest, 73)
    return converted

@with_s_plus_rewards
def convert_story_event_single_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            if quest[86] == "":
                # is story
                converted_quest = {
                    "name": ""
                }

                if quest[4] != "(None)":
                    converted_quest['clearRewardId'] = int(quest[4])

                converted[quest[0]] = converted_quest
            else:
                converted[quest[0]] = {
                    "name": "",
                    "clearRewardId": int(quest[4]),
                    "scoreRewardGroup": int(quest[72]),
                    "scoreRewardRolls": score_reward_rolls(quest, 72),
                    "sPlusRewardId": s_plus_reward_id(quest[73]),
                    "bRankTime": floor(float(quest[86]) * 1000),
                    "aRankTime": floor(float(quest[87]) * 1000),
                    "sRankTime": floor(float(quest[88]) * 1000),
                    "sPlusRankTime":  floor(float(quest[89]) * 1000),
                    "rankPointReward": int(quest[94]),
                    "characterExpReward": int(quest[95]),
                    "manaReward": int(quest[96]),
                    "poolExpReward": int(quest[97])
                }
                add_stamina_cost(converted[quest[0]], quest, 71)
                add_time_limit(converted[quest[0]], quest, 113)
                add_enemy_level(converted[quest[0]], quest, 108)
                add_enemy_element(converted[quest[0]], quest, 74)
                add_challenge_point(converted[quest[0]], quest, 128)
    return converted 

def convert_ranking_event_single_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": 0,
                "characterExpReward": 0,
                "manaReward": 0,
                "poolExpReward": 0
            }
            add_stamina_cost(converted[quest[0]], quest, 66)
            add_time_limit(converted[quest[0]], quest, 94)
    return converted 

def convert_solo_time_attack_event_quest(obj):
    converted = {}
    for event_id, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "eventId": int(event_id),
                "scoreRewardGroup": int(quest[71]),
                "scoreRewardRolls": score_reward_rolls(quest, 71),
                # no S+ reward: a Chrono Trial pays trophies and beads by clear time instead (FT-11)
                "bRankTime": floor(float(quest[51]) * 1000),
                "aRankTime": floor(float(quest[52]) * 1000),
                "sRankTime": floor(float(quest[53]) * 1000),
                "sPlusRankTime":  floor(float(quest[54]) * 1000),
                "rankPointReward": int(quest[85]),
                "characterExpReward": int(quest[86]),
                "manaReward": int(quest[87]),
                "poolExpReward": int(quest[88])
            }
            add_stamina_cost(converted[quest[0]], quest, 70)
            add_time_limit(converted[quest[0]], quest, 103)
            add_enemy_element(converted[quest[0]], quest, 72)
    return converted 

# The Haunt (FT-6): each monthly cycle has its own ten quests of three floors, all with the cycle's period (master
# dates, Japan time; the last cycles have no end).
def convert_tower_dungeon_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "start": quest[5],
                "end": None if quest[6] in ("", "(None)") else quest[6],
                "scoreRewardGroup": int(quest[69]),
                "scoreRewardRolls": score_reward_rolls(quest, 69),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": int(quest[82]),
                "characterExpReward": int(quest[83]),
                "manaReward": int(quest[84]),
                "poolExpReward": int(quest[85])
            }
            add_stamina_cost(converted[quest[0]], quest, 68)
            add_time_limit(converted[quest[0]], quest, 100)
            add_enemy_element(converted[quest[0]], quest, 70)
    return converted 

# Solo Boss Challenges and Nostalgia Trials (FT-7), keyed by event: besides the battle, the event (whose attempts the
# quest spends, `expert_single_event`), the player rank needed to start it (`selectable_player_rank`) and the quest that
# must be cleared first (`viewable_need_quest_1`: the client's QuestReferenceIdKind code and the multiplied quest id;
# a Hell quest needs its Godly+ one).
@with_s_plus_rewards
def convert_expert_single_event_quest(obj):
    converted = {}
    for event_id, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "eventId": int(event_id),
                "clearRewardId": int(quest[6]),
                "scoreRewardGroup": int(quest[73]),
                "scoreRewardRolls": score_reward_rolls(quest, 73),
                "sPlusRewardId": s_plus_reward_id(quest[74]),
                "bRankTime": floor(float(quest[87]) * 1000),
                "aRankTime": floor(float(quest[88]) * 1000),
                "sRankTime": floor(float(quest[89]) * 1000),
                "sPlusRankTime":  floor(float(quest[90]) * 1000),
                "rankPointReward": int(quest[96]),
                "characterExpReward": int(quest[97]),
                "manaReward": int(quest[98]),
                "poolExpReward": int(quest[99])
            }
            add_stamina_cost(converted[quest[0]], quest, 72)
            add_time_limit(converted[quest[0]], quest, 114)
            add_enemy_element(converted[quest[0]], quest, 75)
            if quest[48] != "(None)":
                converted[quest[0]]["playerRank"] = int(quest[48])
            if quest[9] != "(None)":
                converted[quest[0]]["needQuest"] = {"kind": int(quest[9]), "questId": int(quest[13])}
    return converted 

# The Solo Boss Challenge events (FT-7): the daily challenge point each one's quests spend on a clear.
def convert_expert_single_event(obj):
    return {event_id: {"challengePointId": int(row[10])} for event_id, row in obj.items()}

# The Chrono Trial events (FT-30): the daily challenge point each one's quests spend when they start.
def convert_solo_time_attack_event(obj):
    return {event_id: {"challengePointId": int(row[9])} for event_id, row in obj.items()}

# Border rewards by event and quest number (FT-11): each tier's reward id (the row key), its border (column 4), mail
# reason and up to six rewards (GeneralRewardKind: 0 item, 1 equipment, 2 beads, 3 mana, 4 pooled exp, 5 character,
# 6 title), sorted from the easiest border (`easiest_first` gives the order of the borders' values).
def convert_border_rewards(obj, border_key, easiest_first):
    converted = {}
    for reward_id, row in obj.items():
        rewards = []
        for slot in range(6):
            kind = row[6 + slot * 3]
            if kind in ("", "(None)"):
                continue
            reward = {"kind": int(kind), "number": int(row[8 + slot * 3])}
            if row[7 + slot * 3] not in ("", "(None)"):
                reward["id"] = int(row[7 + slot * 3])
            rewards.append(reward)
        quests = converted.setdefault(row[1], {}).setdefault(row[2], [])
        quests.append({"id": int(reward_id), border_key: float(row[4]), "reasonId": int(row[5]), "rewards": rewards})
    for quests in converted.values():
        for tiers in quests.values():
            tiers.sort(key=lambda tier: easiest_first(tier[border_key]))
    return converted

# Chrono Trials (`quest/event/solo_time_attack_clear_time_reward`): the border is a clear time in seconds, the mail
# reason 15001-15007 ("::item:: earned from the 1-minute Border Reward for Chrono Trials").
def convert_solo_time_attack_clear_time_reward(obj):
    return convert_border_rewards(obj, "seconds", lambda seconds: -seconds)

# Score Scramble (`quest/event/score_attack_border_reward`): the border is a score, the mail reason 16001 (a score
# border reward); the rewards are the event's coins.
def convert_score_attack_border_reward(obj):
    return convert_border_rewards(obj, "score", lambda score: score)

# Ranking events (FT-33, `quest/event/ranking_event`): each event's periods (column 3, Japan time: the start, the end of
# the battles, the end of the results calculation, which opens the rewards, and the end of the results announcement,
# which closes them).
def convert_ranking_event(obj):
    converted = {}
    for event_id, row in obj.items():
        start, battle_end, results_start, results_end = row[3].split(",")
        converted[event_id] = {"start": start, "battleEnd": battle_end, "resultsStart": results_start, "resultsEnd": results_end}
    return converted

# Ranking event rewards (FT-33, `quest/event/ranking_event_ranking_reward`) by event: each band's id, the share of
# players it covers from the top (0.03 is the top 3 %), mail reason ("Rewards for obtaining an S+ rank in ...") and up
# to ten rewards (GeneralRewardKind, as in the border rewards), the best band first.
def convert_ranking_event_ranking_reward(obj):
    converted = {}
    for event_id, bands in obj.items():
        rows = []
        for _, row in bands.items():
            rewards = []
            for slot in range(10):
                column = 3 + slot * 3
                if column + 2 >= len(row) or row[column] in ("", "(None)"):
                    continue
                reward = {"kind": int(row[column]), "number": int(row[column + 2])}
                if row[column + 1] not in ("", "(None)"):
                    reward["id"] = int(row[column + 1])
                rewards.append(reward)
            rows.append({"id": int(row[0]), "share": float(row[1]), "reasonId": int(row[2]), "rewards": rewards})
        converted[event_id] = sorted(rows, key=lambda band: band["share"])
    return converted

# Raid events (FT-12, `quest/event/raid_event`): each event's periods (column 2: the start, the end of the battles,
# the end of the results calculation, which opens the ranking rewards, and the end of the announcement) and the boss's
# damage pool (column 17, in kill weight: one kill each time the server's clears fill it).
def convert_raid_event(obj):
    converted = {}
    for event_id, row in obj.items():
        start, battle_end, results_start, results_end = row[2].split(",")
        converted[event_id] = {"start": start, "battleEnd": battle_end, "resultsStart": results_start, "resultsEnd": results_end, "bossHp": int(row[17])}
    return converted

def general_rewards(row, first_column, slots):
    """Up to `slots` GeneralRewardKind triples (kind, id, number) from `first_column` on."""
    rewards = []
    for slot in range(slots):
        column = first_column + slot * 3
        if column + 2 >= len(row) or row[column] in ("", "(None)"):
            continue
        reward = {"kind": int(row[column]), "number": int(row[column + 2])}
        if row[column + 1] not in ("", "(None)"):
            reward["id"] = int(row[column + 1])
        rewards.append(reward)
    return rewards

# Raid kill tally rewards (FT-12, `quest/event/raid_event_overall_reward`) by event: kind 0 (column 2) are the tally
# tiers, each with its server kill count (column 3); kind 1 is paid for every kill ("For Every 1 Boss Defeated"). Each
# has its mail reason and rewards; the tiers come lowest first.
def convert_raid_event_overall_reward(obj):
    converted = {}
    for reward_id, row in obj.items():
        event = converted.setdefault(row[0], {"tiers": [], "perKill": None})
        reward = {"id": int(reward_id), "reasonId": int(row[5]), "rewards": general_rewards(row, 6, 10)}
        if row[2] == "1":
            event["perKill"] = reward
        else:
            event["tiers"].append({**reward, "kills": int(row[3])})
    for event in converted.values():
        event["tiers"].sort(key=lambda tier: tier["kills"])
    return converted

# Raid ranking rewards (FT-12, `quest/event/raid_event_ranking_reward`) by event and quest (difficulty): each band of
# rank numbers (from, to), its mail reason and rewards.
def convert_raid_event_ranking_reward(obj):
    converted = {}
    for event_id, quests in obj.items():
        for _, bands in quests.items():
            for band_id, row in bands.items():
                converted.setdefault(event_id, {}).setdefault(row[0], []).append({
                    "id": int(band_id), "from": int(row[1]), "to": int(row[2]), "reasonId": int(row[3]), "rewards": general_rewards(row, 4, 10)
                })
    for quests in converted.values():
        for bands in quests.values():
            bands.sort(key=lambda band: band["from"])
    return converted

# What unlocks each game system (`game_system_unlock/game_system_unlock_condition`; FT-30): every condition row of a
# system must hold. A row names a quest to have cleared (cleared_quest: the client's QuestReferenceIdKind code and
# the multiplied quest id) and the player rank needed; its need_viewable/need_selectable quest columns (5-14) are left
# out, as nothing reads them yet.
def convert_game_system_unlock_condition(obj):
    converted = {}
    for system, rows in obj.items():
        conditions = []
        for _, row in rows.items():
            condition = {}
            if row[0] != "(None)":
                condition["clearedQuest"] = {"kind": int(row[0]), "questId": int(row[4])}
            if row[15] != "(None)":
                condition["playerRank"] = int(row[15])
            conditions.append(condition)
        converted[system.removeprefix("condition_")] = conditions
    return converted

# Hanifolk Carnival (FT-11): each quest is one difficulty of a boss (its folder). The score of a clear is the quest's
# difficulty_score (column 104: 200,000 / 2,000,000 / 2,650,000) plus a time bonus, one point per millisecond left of
# battle_time_limit (column 100, in frames at 60 a second: 30, 20 and 15 minutes). The battle rewards are columns 82-85
# (battle_reward_rp, _exp, _mana, _pool_exp; they were read from 94-97, the boss TP correction, enemy level, quest
# rank and fever gauge limit).
def convert_carnival_event_quest(obj):
    converted = {}
    for event_id, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "eventId": int(event_id),
                "folderId": int(quest[1]),
                "clearRewardId": int(quest[6]),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": int(quest[82]),
                "characterExpReward": int(quest[83]),
                "manaReward": int(quest[84]),
                "poolExpReward": int(quest[85]),
                "timeLimitMs": int(quest[100]) * 1000 // 60,
                "difficultyScore": int(float(quest[104]))
            }
            add_stamina_cost(converted[quest[0]], quest, 67)
    return converted 

# The Carnival's total score rewards (`quest/event/carnival_event_total_score_reward`), by event: each threshold's
# reward id (the row key), total score, mail reason (20001 milestones, 20002 ranks) and up to six rewards
# (GeneralRewardKind, as in the border rewards), the lowest threshold first.
def convert_carnival_event_total_score_reward(obj):
    converted = {}
    for reward_id, row in obj.items():
        rewards = []
        for slot in range(6):
            kind = row[4 + slot * 3]
            if kind in ("", "(None)"):
                continue
            reward = {"kind": int(kind), "number": int(row[6 + slot * 3])}
            if row[5 + slot * 3] not in ("", "(None)"):
                reward["id"] = int(row[5 + slot * 3])
            rewards.append(reward)
        converted.setdefault(row[0], []).append({"id": int(reward_id), "score": int(row[2]), "reasonId": int(row[3]), "rewards": rewards})
    for tiers in converted.values():
        tiers.sort(key=lambda tier: tier["score"])
    return converted

# Raid events (FT-12): each quest is a difficulty of the event's boss; a clear adds its kill_count_weight (column 51)
# to the server's damage pool. The battle rewards are columns 82-85 (battle_reward_rp, _exp, _mana, _pool_exp; they
# were read one column early, from 81-84, battle_item_count to battle_reward_mana).
def convert_raid_event_quest(obj):
    converted = {}
    for event_id, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "eventId": int(event_id),
                "killWeight": int(quest[51]),
                "clearRewardId": int(quest[5]),
                "scoreRewardGroup": int(quest[68]),
                "scoreRewardRolls": score_reward_rolls(quest, 68),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": int(quest[82]),
                "characterExpReward": int(quest[83]),
                "manaReward": int(quest[84]),
                "poolExpReward": int(quest[85])
            }
            add_stamina_cost(converted[quest[0]], quest, 67)
            add_time_limit(converted[quest[0]], quest, 100)
            add_enemy_element(converted[quest[0]], quest, 69)
    return converted 

def convert_rush_event_quest(obj):
    converted = {}
    for rush_event_id_str, quests in obj.items():
        rush_event_id = int(rush_event_id_str)
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": int(quest[82]),
                "characterExpReward": int(quest[83]),
                "manaReward": int(quest[84]),
                "poolExpReward": int(quest[85]),
                "rushEventId": rush_event_id,
                "rushEventFolderId": int(quest[1]),
                "rushEventRound": int(quest[2])
            }
            add_stamina_cost(converted[quest[0]], quest, 67)
            add_time_limit(converted[quest[0]], quest, 100)
    return converted 

def convert_score_attack_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": 0,
                "characterExpReward": 0,
                "manaReward": 0,
                "poolExpReward": 0
            }
            add_stamina_cost(converted[quest[0]], quest, 70)
            add_time_limit(converted[quest[0]], quest, 103)
    return converted 

# Melting, conversion and selling (FT-40): the rules behind `equipment/sell_stack`, `expod/stack_to_exp`, their bulk
# versions and `item/sell`, from the client's masters.
# - `item/equipment_craft_point_exchange`: per armament rarity, the Wrightpieces a melted duplicate gives (column 0) and
#   an awakening costs (column 1).
# - `character/experience_conversion_rate`: per unit rarity, the pooled EXP (column 0) and Star Specks (column 1) a
#   converted duplicate gives.
# - `item/equipment`: column 13 `sellable` (can be melted), column 15 `obtain_source` (only 0, from portals, gives Star
#   Specks when melted); `character/character` column 32 `obtain_source` (likewise for converted units).
# - `item/item`: the sellable items (column 21) with their `sale_price` in mana (column 15), category (column 13; 5 is an
#   ability core) and period (columns 18-19, Japan time).
def convert_sell_rules(craft_points, conversion_rates, equipment, characters, items):
    def period_end(value):
        return None if value in ("", "(None)") else value
    return {
        "craftPoints": {rarity: {"dissolve": int(row[0]), "awaken": int(row[1])} for rarity, row in craft_points.items()},
        "experienceConversion": {rarity: {"exp": int(row[0]), "starGrain": int(row[1])} for rarity, row in conversion_rates.items()},
        "unmeltableEquipment": sorted(int(equipment_id) for equipment_id, row in equipment.items() if row[13] != "true"),
        "equipmentWithoutStarGrain": sorted(int(equipment_id) for equipment_id, row in equipment.items() if row[15] != "0"),
        "charactersWithoutStarGrain": sorted(int(character_id) for character_id, row in characters.items() if row[32] != "0"),
        "items": {item_id: {"price": int(row[15]), "category": int(row[13]),
                            "start": period_end(row[18]), "end": period_end(row[19])}
                  for item_id, row in items.items() if row[21] == "true" and row[15] not in ("", "(None)")}
    }

# Armament augmentation (FT-54, the augment shop, the client's shop type 10): `equipment_enhancement/*`. The shop's rows
# (`equipment_enhancement_shop`, columns from the client's record: 0 category, 2 the chain (one per armament, unique
# within its category), 3 the stage, 4 the kind (1, augmentation, in every row), 5 the list order, 14-21 up to four
# (item id, count) costs per level, 22-23 the period, 24 the release rank, 29 the armament, 30 the stage's highest
# level, 31 the awakening level needed), its categories (`equipment_enhancement_shop_category`: 8-9 the period), the
# armaments (`equipment_enhancement`: 0 the highest level, 8 the start) and the feature's start
# (`equipment_enhancement_config`). Dates stay as the master writes them (Japan time); "(None)" is no end.
def convert_equipment_enhancement(shop, categories, armaments, config):
    def end(value):
        return None if value in ("", "(None)") else value
    rows = {}
    for row_id, row in shop.items():
        rows[row_id] = {
            "category": int(row[0]),
            "chain": int(row[2]),
            "stage": int(row[3]),
            "order": int(row[5]),
            "costs": [{"id": int(row[i]), "count": int(row[i + 1])} for i in range(14, 22, 2) if row[i] not in ("", "(None)")],
            "start": row[22],
            "end": end(row[23]),
            "releaseRank": int(row[24]) if row[24] not in ("", "(None)") else 0,
            "equipmentId": int(row[29]),
            "maxLevel": int(row[30]),
            "awakening": int(row[31]) if row[31] not in ("", "(None)") else 1
        }
    return {
        "start": next(iter(config.values()))[0],
        "categories": {category_id: {"start": row[8], "end": end(row[9])} for category_id, row in categories.items()},
        "equipment": {equipment_id: {"maxLevel": int(row[0]), "start": row[8]} for equipment_id, row in armaments.items()},
        "shop": rows
    }

# The co-op boss events (FT-23, `quest/event/hard_multi_event_quest`, "For The Reckoning ... Steambot"): one quest per
# event, its id `event id * 1000 + 1`. The row is the advent quest row's layout with three columns fewer from column 49
# on (checked on the cells both have: rank times, rewards, enemy level, banner and battle names), plus column 123, the
# `reward/periodic_reward` group of the special reward a clear drops while the player has a daily count left
# (`periodicRewardGroup`; inferred: the client reads a `periodicRewardGroupId` and this is the only column holding the
# group ids). The event row's column 14 is the event's `reward/periodic_reward_point`, the daily count
# (`periodicRewardPointId`; the client's `getPeriodicRewardPointId` reads it from the event), and its column 13 the
# `game_system_unlock` key of the event's unlock (`unlockSystem`, e.g. `hard_multi_red`: player rank 120 and two
# quests cleared, in `assets/game_system_unlock_condition.json`).
@with_s_plus_rewards
def convert_hard_multi_event_quest(quests, events):
    converted = {}
    for event_id, rows in quests.items():
        event = events.get(event_id)
        point = event[14] if event is not None else ""
        unlock = event[13] if event is not None else ""
        for _, quest in rows.items():
            entry = converted[quest[0]] = {
                "name": "",
                "eventId": int(event_id),
                "clearRewardId": int(quest[4]),
                "sPlusRewardId": s_plus_reward_id(quest[72]),
                "scoreRewardGroup": int(quest[71]),
                "scoreRewardRolls": score_reward_rolls(quest, 71),
                "bRankTime": floor(float(quest[85]) * 1000),
                "aRankTime": floor(float(quest[86]) * 1000),
                "sRankTime": floor(float(quest[87]) * 1000),
                "sPlusRankTime": floor(float(quest[88]) * 1000),
                "rankPointReward": int(quest[94]),
                "characterExpReward": int(quest[95]),
                "manaReward": int(quest[96]),
                "poolExpReward": int(quest[97])
            }
            add_stamina_cost(entry, quest, 70)
            add_time_limit(entry, quest, 112)
            add_enemy_level(entry, quest, 107)
            add_enemy_element(entry, quest, 73)
            add_use_items(entry, quest, 56)
            if quest[123] not in ("", "(None)"):
                entry["periodicRewardGroup"] = int(quest[123])
            if point not in ("", "(None)"):
                entry["periodicRewardPointId"] = int(point)
            if unlock not in ("", "(None)"):
                entry["unlockSystem"] = unlock
    return converted

# `reward/periodic_reward` (FT-23): group id -> the special rewards a co-op boss clear drops while the player has a
# daily count left, by index. Columns: name, reward type (0, an item, in every row), item id, count, and a last column
# (1 in every row; a weight or a chance, unknown with one entry a group). The client resolves a dropped
# `{group_id, index, number}` (`drop_periodic_reward_ids`) against this table.
def convert_periodic_reward(obj):
    return {group_id: [{"index": int(index), "rewardType": int(row[1]), "id": int(row[2]), "count": int(row[3]), "weight": int(row[4])}
                       for index, row in rows.items()] for group_id, rows in obj.items()}

def convert_character_quests(obj):
    converted = {}
    for story_id, character_story in obj.items():
        converted[story_id] = {
            "name": "", #character_story[3],
            "clearRewardId": int(character_story[5])
        }
    return converted

def convert_clear_rewards(obj):
    converted = {}
    # type map
    # 0 = ?, 1 = equipment, 2 = character, 3 = beads, 4 = mana
    for reward_id, data in obj.items():
        reward_type = int(data[1])
        new = {
            "name": "", #data[0],
            "type": reward_type,
        }
        if (data[2]) != "":
            new["id"] = int(data[2])
        if (data[3]) != "":
            new["count"] = int(data[3])
        converted[reward_id] = new
                
    return converted

def convert_score_reward(obj):
    converted = {}
    # type map
    # 0 = item, 1 = rare score group + id
    for group_id, score_group in obj.items():
        converted_group = []
        for _, reward in score_group.items():
            type = int(reward[1])
            if type == 0:
                converted_reward = {
                    "name": "", #reward[0],
                    "type": type,
                    "reward_type": int(reward[2]),
                    "count": int(reward[4]),
                    "field5": int(reward[5]),
                }
                if reward[3] != "":
                    converted_reward["id"] = int(reward[3])

                converted_group.append(converted_reward)
            elif type == 1:
                converted_group.append({
                    "name": "", #reward[0],
                    "type": type,
                    "id": int(reward[6]),
                    "rarity": float(reward[7])
                })
        converted[group_id] = converted_group
    return converted

# `reward/reward_element_map`: kind (1 element, 2 aether: the rare score rewards of types 6 and 7) -> rarity ->
# enemy element -> item id, the item such a reward gives for the quest's enemy element.
def convert_reward_element_map(obj):
    return {kind: {rarity: {element: int(row[0]) for element, row in elements.items()}
                   for rarity, elements in rarities.items()}
            for kind, rarities in obj.items()}

def convert_rare_score_reward(obj):
    converted = {}
    for group_id, rare_group in obj.items():
        converted_group = []
        for _, reward in rare_group.items():
            name = reward[0]
            type = int(reward[1])
            id = int(reward[2]) if reward[2] != "" else None
            amount = int(reward[3]) if reward[3] != "" else None
            rarity = float(reward[4])

            new_obj = {
                "name": "", #name,
                "type": type,
                "rarity": rarity
            }

            if id != None:
                new_obj['id'] = id
            if amount != None:
                new_obj['count'] = amount
            converted_group.append(new_obj)

        converted[group_id] = converted_group
    return converted

def convert_characters(obj):
    converted = {}
    for characterId, data in obj.items():
        converted[characterId] = {
            "name": "", #data[0],
            "rarity": int(data[2]),
            "element": int(data[3]),
            "skill_count": data[36].split(",").count("6")
        }
    return converted

def convert_mana_nodes(obj):
    converted = {}
    for characterId, data in obj.items():
        levels = {}
        for level, nodes in data.items():
            mana_nodes = {}
            for _, node in nodes.items():
                item_list = {}
                item_costs = node[3].split(",")
                
                for n, item_id in enumerate(node[2].split(",")):
                    item_list[item_id.strip()] = int(item_costs[n].strip())

                mana_nodes[node[0]] = {
                    "items": item_list,
                    "manaCost": int(node[4]),
                    "field1": node[1],
                    "field5": node[5],
                    "field6": node[6]
                }
            levels[level] = mana_nodes
        converted[characterId] = levels
    return converted

def convert_ex_boost(obj):
    converted = {}
    for item_id, ex_boost_item in obj.items():
        name = ex_boost_item[1]
        new =  {
            "tier": 3 if name.endswith("r5") else 2 if name.endswith("r4") else 1,
            "count": int(ex_boost_item[0])
        }
        if len(ex_boost_item[2]) == 1:
            new['element'] = int(ex_boost_item[2])
        converted[item_id] = new
    return converted

def convert_ex_status(obj):
    converted = {
        1: [], # 3*
        2: [], # 4*
        3: []  # 5*
    }
    for status_id, status in obj.items():
        tier = int(status[3]) - 2

        converted[tier].append(int(status_id))
    return converted

def convert_ex_ability(obj):
    converted = {
        1: [], # 3*
        2: [], # 4*
        3: []  # 5*
    }
    for ability_id, status in obj.items():
        tier = int(status[2]) - 2

        converted[tier].append(int(ability_id))
    return converted

box_total_counts = {}

def convert_box_rewards(obj):
    converted = {}
    for gacha_id, boxes in obj.items():
        converted_gacha = {}
        box_total_counts[str(gacha_id)] = {}
        for box_id, box in boxes.items():
            converted_box = {}
            box_total_counts[str(gacha_id)][str(box_id)] = 0
            for _, reward in box.items():
                converted_reward = {
                    "type": int(reward[2]),
                    "count": int(reward[4]),
                    "available": int(reward[5]),
                    "tier": int(reward[6])
                }
                box_total_counts[str(gacha_id)][str(box_id)] += converted_reward["available"]
                if reward[3] != "":
                    converted_reward["id"] = int(reward[3])
                
                converted_box[reward[0]] = converted_reward
            converted_gacha[box_id] = converted_box
        converted[gacha_id] = converted_gacha
    return converted

def convert_box_gacha(obj):
    converted = {}
    for gacha_id, gacha in obj.items():
        converted[gacha_id] = {
            "itemId": int(gacha[2]),
            "count": int(gacha[3]),
            "availableCounts": box_total_counts[str(gacha_id)]
        }
    return converted

def convert_gacha_rarities(path):
    converted = []
    with open(path, "r") as file:
        obj = json.load(file)
        total_odds = 0
        for rarity_entry in list(obj.values())[0].values():
            odds = int(rarity_entry[2])
            converted.append({
                "id": int(rarity_entry[0]),
                "rank": int(rarity_entry[1]),
                "odds": odds,
                "isRateUp": True if rarity_entry[3] == 'true' else False
            })
            total_odds += odds

        # calculate rarities
        for converted_rarity in converted:
            converted_rarity["rarity"] = round((converted_rarity["odds"] / total_odds) * 1000, 2)

    return converted

# A portal's star rates: `gacha_odds/<column 11>` (e.g. normal_rarity: 5 stars 5, 4 stars 25, 3 stars 70; fes_rarity:
# 75, 250, 675), rows of [stars, weight]. Written by pool key ("1" 5 stars, "2" 4 stars, "3" 3 stars). The guaranteed
# pulls of a 10-pull (column 9, how many; column 10, their least stars) use the same weights with the lower ranks folded
# into that rank, as the client's odds page computes them.
def convert_gacha_rank_weights(gacha_data):
    rows = parse_file(os.path.join(FILE_INPUT, "gacha_odds", f"{gacha_data[11]}.json"))
    weights = {str(6 - int(row[0])): int(row[1]) for row in next(iter(rows.values())).values()}
    return {
        "rankWeights": {key: weights.get(key, 0) for key in ("1", "2", "3")},
        "guaranteeNumber": int(gacha_data[9]),
        "guaranteeRarity": int(gacha_data[10])
    }

def convert_gacha(obj):
    converted = {}
    for gacha_id, gacha_data in obj.items():
        payment_type = int(gacha_data[4])

        # 0 = character; 1 = weapon
        gacha_type = int(gacha_data[13])
        if payment_type == 0:
            single_cost = int(gacha_data[5])
            multi_cost = int(gacha_data[6])
            discount_single_cost = int(gacha_data[7])

            if gacha_type == 0:
                converted_gacha = {
                    "type": gacha_type,
                    "paymentType": payment_type,
                    "singleCost": single_cost,
                    "multiCost": multi_cost,
                    "discountCost": discount_single_cost,
                    "movieName": gacha_data[17],
                    "guaranteeMovieName": gacha_data[18],
                    #"onceFreeMulti": True if gacha_data[20] == "true" else False,
                    #"dailyFreeMulti": True if gacha_data[21] == "true" else False,
                    "startDate": gacha_data[29],
                    "endDate": gacha_data[30],
                    **convert_gacha_rank_weights(gacha_data)
                }
                # get rarity files
                converted_gacha["pool"] = {
                    "3": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{gacha_data[14]}.json")),
                    "2": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{gacha_data[15]}.json")),
                    "1": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{gacha_data[16]}.json")),
                }
                converted[gacha_id] = converted_gacha 

            elif gacha_type == 1:
                converted_gacha = {
                    "type": gacha_type,
                    "paymentType": payment_type,
                    "singleCost": single_cost,
                    "multiCost": multi_cost,
                    "discountCost": discount_single_cost,
                    "startDate": gacha_data[29],
                    "endDate": gacha_data[30],
                    **convert_gacha_rank_weights(gacha_data)
                }
                # get rarity files
                converted_gacha["pool"] = {
                    "3": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{gacha_data[22]}.json")),
                    "2": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{gacha_data[23]}.json")),
                    "1": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{gacha_data[24]}.json")),
                }
                converted[gacha_id] = converted_gacha
                pass
    
    return converted

def convert_gacha_campaigns(obj):
    campaign_map = {}
    for campaign_id, data in obj.items():
        campaign_id = int(campaign_id)
        for gacha_id in data[5].split(","):
            campaign_map[gacha_id] = campaign_id
    return campaign_map

# Purchase limits of a shop product, from the columns after its sale period (the client's shop master parsers):
# release_rank, buy_max_count (most per purchase), max_frequency (ever), daily_stock, then per table the
# specified_months (general shop only) and monthly_stock. "(None)" means no such limit; absent keys mean none.
def shop_limits(item, release_rank_column, months_column=None, monthly_column=None):
    limits = {
        "buyMaxCount": int(item[release_rank_column + 1]),
    }
    if item[release_rank_column] not in ("", "(None)") and int(item[release_rank_column]) > 1:
        limits["releaseRank"] = int(item[release_rank_column])
    optional = {"maxFrequency": release_rank_column + 2, "dailyStock": release_rank_column + 3}
    if monthly_column is not None:
        optional["monthlyStock"] = monthly_column
    for key, column in optional.items():
        if item[column] != "(None)":
            limits[key] = int(item[column])
    if months_column is not None and item[months_column] not in ("", "(None)"):
        limits["specifiedMonths"] = [int(month) for month in item[months_column].split(",")]
    return limits

# shop/special_pack_shop, the Bundle Marketplace (FT-89): one bead price (column 8 the cost type, 0 = beads; column 9 the
# amount; column 7 is 3 for every row), its sale period (19, 20), the purchase limits from column 21 (release rank, most per
# purchase, most ever, per day) with the monthly one in column 25, and up to five rewards from column 26 as
# (kind, id, count): kind 0 an item, 1 EXP (no id). The original took paid beads only; this server takes any (FT-46).
def convert_special_pack_shop(obj):
    converted = {}
    for item_id, item in obj.items():
        rewards = []
        for offset in range(26, 41, 3):
            if item[offset] in ("", "(None)"):
                continue
            reward = {"type": int(item[offset])}
            if item[offset + 1] != "":
                reward["id"] = int(item[offset + 1])
            if item[offset + 2] != "":
                reward["count"] = int(item[offset + 2])
            rewards.append(reward)
        converted[item_id] = {
            "costs": [],
            "rewards": rewards,
            "availableFrom": item[19],
            "availableUntil": item[20] if item[20] != "(None)" else None,
            **shop_limits(item, 21, monthly_column=25),
            "userCost": {"type": int(item[8]), "amount": int(item[9])},
        }
    return converted

def convert_general_shop(obj):
    converted = {}
    for item_id, item in obj.items():

        costs = []
        cost_offset = 12
        for _ in range(4):
            if item[cost_offset] != "(None)":
                costs.append({
                    "id": int(item[cost_offset]),
                    "amount": int(item[cost_offset + 1])
                })
            cost_offset += 2

        rewards = []
        reward_offset = 29
        for _ in range (6):
            if item[reward_offset] != "(None)":
                reward = {
                    "type": int(item[reward_offset])
                }
                if item[reward_offset + 1] != "":
                    reward['id'] = int(item[reward_offset + 1])
                if item[reward_offset + 2] != "":
                    reward['count'] = int(item[reward_offset + 2])
                rewards.append(reward)
            reward_offset += 3
        
        converted_item = {
            "costs": costs,
            "rewards": rewards,
            "availableFrom": item[20],
            "availableUntil": item[21] if item[21] != "(None)" else None,
            **shop_limits(item, 22, months_column=26, monthly_column=27),
        }

        if (item[9]) != "(None)":
            converted_item['userCost'] = {
                "type": int(item[9]),
                "amount": int(item[10])
            }
        
        converted[item_id] = converted_item

    return converted

def convert_boss_coin_shop(obj):
    converted = {}
    map_output = {}
    for item_id, item in obj.items():
        costs = []
        cost_offset = 16
        for _ in range(4):
            if item[cost_offset] != "(None)":
                costs.append({
                    "id": int(item[cost_offset]),
                    "amount": int(item[cost_offset + 1])
                })
            cost_offset += 2

        rewards = []
        reward_offset = 31
        for _ in range (6):
            if item[reward_offset] != "(None)":
                reward = {
                    "type": int(item[reward_offset])
                }
                if item[reward_offset + 1] != "":
                    reward['id'] = int(item[reward_offset + 1])
                if item[reward_offset + 2] != "":
                    reward['count'] = int(item[reward_offset + 2])
                rewards.append(reward)
            reward_offset += 3
        
        category = int(item[0])

        converted_item = {
            "costs": costs,
            "rewards": rewards,
            "availableFrom": item[24],
            "availableUntil": item[25] if item[25] != "(None)" else None,
            **shop_limits(item, 26, monthly_column=30),
        }
        
        if not converted.get(category):
            converted[category] = {}

        map_output[item_id] = category
        converted[category][item_id] = converted_item
        
    save_json(map_output, os.path.join(FILE_OUTPUT, "boss_coin_shop_item_category_map.json"))
    return converted

def convert_event_item_shop(obj):
    converted = {}

    map_output = {}
    
    for item_id, item in obj.items():
        costs = []
        cost_offset = 18
        for _ in range(4):
            if item[cost_offset] != "(None)":
                costs.append({
                    "id": int(item[cost_offset]),
                    "amount": int(item[cost_offset + 1])
                })
            cost_offset += 2

        rewards = []
        reward_offset = 32
        for _ in range (6):
            if item[reward_offset] != "(None)":
                reward = {
                    "type": int(item[reward_offset])
                }
                if item[reward_offset + 1] != "":
                    reward['id'] = int(item[reward_offset + 1])
                if item[reward_offset + 2] != "":
                    reward['count'] = int(item[reward_offset + 2])
                rewards.append(reward)
            reward_offset += 3
        
        event_type = int(item[2])
        event_id = int(item[1])

        converted_item = {
            "costs": costs,
            "rewards": rewards,
            "availableFrom": item[26],
            "availableUntil": item[27] if item[27] != "(None)" else None,
            **shop_limits(item, 28),
        }
        
        if not converted.get(event_type):
            converted[event_type] = {}

        if not converted[event_type].get(event_id):
            converted[event_type][event_id] = {}

        map_output[item_id] = {
            "eventType": event_type,
            "eventId": event_id
        }

        converted[event_type][event_id][item_id] = converted_item

    save_json(map_output, os.path.join(FILE_OUTPUT, "event_item_shop_id_map.json"))
    return converted

def convert_treasure_shop(obj):
    converted = {}
    for item_id, item in obj.items():
        costs = []
        cost_offset = 10
        for _ in range(4):
            if item[cost_offset] != "(None)":
                costs.append({
                    "id": int(item[cost_offset]),
                    "amount": int(item[cost_offset + 1])
                })
            cost_offset += 2

        rewards = []
        reward_offset = 24
        for _ in range (6):
            if item[reward_offset] != "(None)":
                reward = {
                    "type": int(item[reward_offset])
                }
                if item[reward_offset + 1] != "":
                    reward['id'] = int(item[reward_offset + 1])
                if item[reward_offset + 2] != "":
                    reward['count'] = int(item[reward_offset + 2])
                rewards.append(reward)
            reward_offset += 3

        converted_item = {
            "costs": costs,
            "rewards": rewards,
            "availableFrom": item[18],
            "availableUntil": item[19] if item[19] != "(None)" else None,
            **shop_limits(item, 20),
            # the daily lineup (FT-9): the product's weight in the draw of the day's products and its chance of a
            # discount (`treasure_shop_discount_rate` picks the rate); the client reads neither column
            "lineupWeight": int(item[42]),
            "discountChance": float(item[43]),
        }

        if (item[7]) != "(None)":
            converted_item['userCost'] = {
                "type": int(item[7]),
                "amount": int(item[8])
            }

        converted[item_id] = converted_item

    return converted

# The Star Sliver Exchange (FT-58, `shop/star_crumb_exchange`): what each exchange gives (kind 0 unit, 1 item,
# 2 armament: the client's StarCrumbExchangeKind), its period, the Welcome Back Portal that holds it (when it has
# one, the exchange follows that portal's period instead) and the rarity that sets its price. Columns: kind, target
# ID, short description, start, end, is_limited, comeback_gacha_id, rarity.
def convert_star_crumb_exchange(obj):
    return {exchange_id: {
        "kind": int(row[0]),
        "targetId": int(row[1]),
        "startTime": row[3],
        "endTime": row[4],
        "comebackGachaId": int(row[6]) if row[6] != "(None)" else None,
        "rarity": int(row[7]),
    } for exchange_id, row in obj.items()}

# Its prices (`shop/star_crumb_exchange_cost`), keyed by the same kind: Star Slivers for a 4-star and a 5-star target.
def convert_star_crumb_exchange_cost(obj):
    return {kind: {"rarity4": int(row[0]), "rarity5": int(row[1])} for kind, row in obj.items()}

# The Trove's discounts (FT-9, `shop/treasure_shop_discount_rate`): each discount's rate and its weight in the draw.
def convert_treasure_shop_discount_rate(obj):
    return {discount_id: {"rate": float(row[0]), "weight": int(row[1])} for discount_id, row in obj.items()}

def convert_star_grain_shop(obj):
    converted = {}
    for item_id, item in obj.items():
        costs = []
        cost_offset = 10
        for _ in range(4):
            if item[cost_offset] != "(None)":
                costs.append({
                    "id": int(item[cost_offset]),
                    "amount": int(item[cost_offset + 1])
                })
            cost_offset += 2

        rewards = []
        reward_offset = 25
        for _ in range (6):
            if item[reward_offset] != "(None)":
                reward = {
                    "type": int(item[reward_offset])
                }
                if item[reward_offset + 1] != "":
                    reward['id'] = int(item[reward_offset + 1])
                if item[reward_offset + 2] != "":
                    reward['count'] = int(item[reward_offset + 2])
                rewards.append(reward)
            reward_offset += 3

        converted_item = {
            "costs": costs,
            "rewards": rewards,
            "availableFrom": item[18],
            "availableUntil": item[19] if item[19] != "(None)" else None,
            **shop_limits(item, 20, monthly_column=24),
        }

        if (item[7]) != "(None)":
            converted_item['userCost'] = {
                "type": int(item[7]),
                "amount": int(item[8])
            }

        converted[item_id] = converted_item

    return converted

def convert_encyclopedia(obj):
    converted = {}
    for _, entries in obj.items():
        for _, item in entries.items():
            converted[int(item[0])] = {
                "read": True
            }
    return converted

def convert_rush_event_quest_folder(obj):
    converted = {}
    for rush_event_id, folders in obj.items():
        converted_folders = {}
        for folder_id, folder in folders.items():

            rewards = []
            reward_offset = 7
            for _ in range (10):
                if folder[reward_offset] != "(None)":
                    reward = {
                        "type": int(folder[reward_offset])
                    }
                    if folder[reward_offset + 1] != "":
                        reward['id'] = int(folder[reward_offset + 1])
                    if folder[reward_offset + 2] != "":
                        reward['count'] = int(folder[reward_offset + 2])
                    rewards.append(reward)
                reward_offset += 3

            converted_folders[folder_id] = rewards

        converted[rush_event_id] = converted_folders
    return converted
# def convert_mana_nodes_save_data(obj):
#     converted = {}

#     for character_id, levels in obj.items():
#         nodes = []
#         for _, level in levels.items():
#             for _, node in level.items():
#                 nodes.append(int(node[0]))
#         converted[character_id] = nodes

#     return {
#         "user_character_mana_node_list": converted
#     }

# multi special exchange (FT-13). Campaign row: 0 name, 1 title, 2 type, 3 campaign_start_time, 4 campaign_end_time,
# 5 exchange_end_time, 6-9 images and help ids, 10/12/14 special_exchange_ticket_item_id 1-3 ("(None)" if unused).
def convert_multi_special_exchange_campaigns(obj):
    converted = {}
    for campaign_id, data in obj.items():
        converted[campaign_id] = {
            "startDate": data[3],
            "endDate": data[4],
            "exchangeEndDate": data[5],
            "ticketItemIds": [int(data[i]) for i in (10, 12, 14) if data[i] != "(None)"]
        }
    return converted

# ticket item id -> the characters it can be exchanged for
def convert_multi_special_exchange_campaign_characters(obj):
    return {ticket_id: [int(character_id) for character_id in characters] for ticket_id, characters in obj.items()}

# The event calendar's choices (FT-5, src/lib/eventCalendar.ts): every event with a period, and the name of every
# portal in assets/gacha.json. Per table: the name column, then either the start and end columns (`start_time`,
# `end_time`; a third date, `receive_end_time`, follows) or one column with a comma-separated schedule whose first two
# dates are the start and the end. Rows with a start only are permanent (rerun archives) and left out. Dates stay as
# the master writes them (Japan time). Names come from the English overlay (i18n/en/master) where it has one.
EVENT_TABLES = {
    "story_event": (2, 16, 17),
    "world_story_event": (2, 22, 23),
    "advent_event": (2, 23, 24),
    "carnival_event": (1, 20, 21),
    "hard_multi_event": (2, 23, 24),
    "raid_event": (1, 2),
    "ranking_event": (2, 3),
    "rush_event": (1, 2),
}
I18N_MASTER = os.path.join(ROOT, "..", "i18n", "en", "master")

def is_master_date(value):
    return isinstance(value, str) and len(value) == 19 and value[4] == "-" and value[10] == " "

# a master end date; "(None)" or empty is no end
def master_end_time(value):
    return None if value in ("(None)", "", None) else value

# a multi-line master name on one line
def master_name(value):
    return " · ".join(line for line in value.split("\n") if line)

# the English overlay of a master table (i18n/en/master/<file>), {} when there is none
def english_overlay(file_name):
    return parse_file(os.path.join(I18N_MASTER, file_name)) or {}

# a row's text in the English overlay, or the master's own (Japanese) text where the overlay has none
def english_text(overlay, row_id, column, row):
    return overlay.get(row_id, {}).get(str(column), {}).get("text") or row[column]

def convert_event_calendar(tables, gachas):
    events = []
    for kind, columns in EVENT_TABLES.items():
        rows = tables.get(kind)
        if rows is None:
            continue
        english = english_overlay(f"quest__event__{kind}.json")
        for event_id, row in rows.items():
            dates = row[columns[1]].split(",")[:2] if len(columns) == 2 else [row[columns[1]], row[columns[2]]]
            if len(dates) < 2 or not all(is_master_date(date) for date in dates):
                continue
            name = english_text(english, event_id, columns[0], row)
            events.append({"id": f"{kind}/{event_id}", "kind": kind, "name": name, "start": dates[0], "end": dates[1]})
    events.sort(key=lambda event: (event["start"], event["id"]))
    # the portals the server knows (convert_gacha keeps paid unit and armament portals only)
    portals = {gacha_id: row[1] for gacha_id, row in gachas.items() if row[4] == "0" and row[13] in ("0", "1")}
    return {"events": events, "portals": portals}

# player/player_rank_iosbundled (ranks 1-100) and player/player_rank (101-250): row = max stamina, total rank points
# needed, ?. Written as one list, the rank points each rank needs (index 0 = rank 1).
def convert_player_rank(bundled, later):
    rows = {**bundled, **later}
    return [int(rows[str(rank)][1]) for rank in range(1, len(rows) + 1)]

# character_election/character_election (the unit poll, FT-2): 0 string_id, 1 banner, 2-3 the voting period.
def convert_character_election(obj):
    return {election_id: {"start": row[2], "end": row[3]} for election_id, row in obj.items()}

# Collect item events' quest drops (FT-2), one output from four tables:
# - reward/event/collect_item_event: 3 kind (0 Collect, 1 CollectAndExchange, 2 Special), 6 the event item, 20-21 the
#   period (the drops' too), 22 the end of a kind 1 event's exchange;
# - collect_item_event_quest_relation, per event: 0 id, 1 the quests' QuestRangeReferenceIdKind and 2-4 its id lists
#   ("(None)" = any), 5 the reward relation;
# - collect_item_event_reward_relation, per relation and keyed by the lowest enemy level it applies from: 2 the
#   additional reward group. A quest drops from every group whose level its enemy level reaches;
# - additional_reward, per group and keyed by index: 1 QuestRewardKind (0 item), 2 its id, 3 the amount, 4 the weight.
def convert_collect_item_event_drops(events, quest_relations, reward_relations, additional_rewards):
    relations = {relation_id: sorted(((int(level), int(row[2])) for level, row in rows.items()), key=lambda tier: tier[0])
                 for relation_id, rows in reward_relations.items()}
    return {
        "events": {event_id: {"kind": int(row[3]), "itemId": int(row[6]), "start": row[20], "end": row[21],
                              "exchangeEnd": master_end_time(row[22])}
                   for event_id, row in events.items() if row[3] in ("0", "1")},
        "quests": {event_id: [{"kind": int(row[1]), "ids": [stamina_ids(row[2]), stamina_ids(row[3]), stamina_ids(row[4])],
                               "tiers": [{"minEnemyLevel": level, "groupId": group} for level, group in relations.get(row[5], [])]}
                              for row in rows.values()]
                   for event_id, rows in quest_relations.items()},
        "additionalRewards": {group_id: [{"index": int(index), "kind": int(row[1]), "id": int(row[2]), "amount": int(row[3]),
                                          "weight": int(row[4])} for index, row in rows.items()]
                              for group_id, rows in additional_rewards.items()}
    }

# Stamina (FT-25), one output from several tables:
# - player/player_rank_iosbundled and player_rank: max stamina (column 0) and stamina_heal_time_decrease_rate (2) per rank;
# - config/config_iosbundled, row 1: 1 stamina_recovery_virtual_money, 2 stamina_recovery_seconds, 3 stamina_recovery_value,
#   4 max_stamina_overflow;
# - campaign/stamina_campaign: 0 repeat kind (0 once: 1-2 its period), 5 stamina_consumption_rate, 6 the quests'
#   QuestRangeReferenceIdKind and 7-9 its id lists ("(None)" = any);
# - quest/battle_no_stamina_return: 0 QuestRangeReferenceIdKind and 1-3 its id lists, the quests whose abort refunds nothing;
# - item/item: 5 effect kind (2 StaminaFixed, 3 StaminaRate) and 6 its value.
def stamina_ids(value):
    return None if value in ("(None)", "") else [int(part) for part in value.split(",")]

# campaign/reward_campaign (FT-37): boosted rewards on the quests a campaign covers. Row (the client's row parser):
# 0 repeat kind (0 once: 1-2 its period; 1 weekly, 3 day of week and 4 a time: none occur), 5 reward kind
# (CampaignRewardMultiplierKind: 0 Item, 1 Exp, 2 Mana), 6 its rate, 7 the quests' QuestRangeReferenceIdKind and 8-10
# its id lists, as in the stamina campaigns.
REWARD_CAMPAIGN_KINDS = {"0": "item", "1": "exp", "2": "mana"}

def convert_reward_campaign(obj):
    return [{"start": row[1], "end": row[2], "reward": REWARD_CAMPAIGN_KINDS[row[5]], "rate": float(row[6]), "kind": int(row[7]),
             "ids": [stamina_ids(row[8]), stamina_ids(row[9]), stamina_ids(row[10])]}
            for _, row in sorted(obj.items()) if row[0] == "0"]

def convert_stamina(rank_bundled, rank_later, config, campaigns, no_return, items):
    ranks = {**rank_bundled, **rank_later}
    config_row = config["1"]
    return {
        "recoverySeconds": int(config_row[2]),
        "recoveryVmoney": int(config_row[1]),
        "recoveryValue": int(config_row[3]),
        "overflowMax": int(config_row[4]),
        "ranks": [{"maxStamina": int(ranks[str(rank)][0]), "healTimeDecreaseRate": float(ranks[str(rank)][2])}
                  for rank in range(1, len(ranks) + 1)],
        # only the "once" repeat kind occurs
        "campaigns": [{"start": row[1], "end": row[2], "rate": float(row[5]), "kind": int(row[6]),
                       "ids": [stamina_ids(row[7]), stamina_ids(row[8]), stamina_ids(row[9])]}
                      for row in campaigns.values() if row[0] == "0"],
        "noStaminaReturn": [{"kind": int(row[0]), "ids": [stamina_ids(row[1]), stamina_ids(row[2]), stamina_ids(row[3])]}
                            for row in no_return.values()],
        "items": {item_id: {"kind": "fixed" if row[5] == "2" else "rate", "value": int(row[6])}
                  for item_id, row in items.items() if row[5] in ("2", "3")}
    }

# mission/daily_mission, regular_mission and event_mission (FT-2; layout in docs/missions.md). Mission row: 0 string_id,
# 1 name, 2 pattern (MissionPatternKind), 3 statistics kind, 4 statistics max value kind, 5 battle_kind, 6 client_check,
# 7 quest kind and 8-10 its id lists, 11 quest_rank_id, 12 item_id, 13 equipment_id, 14 character_id, 15-16 campaign,
# 17 mission_ids, 18 need_mission_id, 19 need_mission_reward_stage, 20-21 enable period, 22-23 show period,
# 24 is_hidden_mission, 25 is_repeat, 26 display_order, 27-29 display. Reward row (one per stage): 0 mission_reward_id,
# 1 target_progress, 2-4 clear seconds and image, then four rewards of six columns from 5: kind, amount, item_id,
# character_id, equipment_id, degree_id.
def mission_int(value):
    return None if value in ("", "(None)") else int(value)

def mission_ints(value):
    return [] if value in ("", "(None)") else [int(part) for part in value.split(",")]

def convert_mission_rewards(row, slots=(5, 11, 17, 23)):
    rewards = []
    for base in slots:
        kind = mission_int(row[base])
        if kind is None:
            continue
        reward = {"kind": kind}
        if kind == 6:
            reward["id"] = int(row[base + 5])
        else:
            reward["amount"] = int(row[base + 1])
            # item (1), armament (2) and unit (4) rewards name what they give
            id_column = {1: 2, 2: 4, 4: 3}.get(kind)
            if id_column is not None:
                reward["id"] = int(row[base + id_column])
        rewards.append(reward)
    return rewards

# Column layouts (decoded from the client's row parsers): regular, daily and event missions, and the active
# (Step Up) missions, whose rows put the same fields further right. Rewards: the target column and the four slots.
MISSION_COLUMNS = {
    "pattern": 2, "statistics": 3, "statisticsMaxValue": 4, "battleKind": 5, "clientCheck": 6, "questKind": 7,
    "questIds": (8, 9, 10), "questRankId": 11, "itemId": 12, "equipmentId": 13, "characterId": 14, "missionIds": 17,
    "needMissionId": 18, "needMissionStage": 19, "startDate": 20, "endDate": 21, "showStartDate": 22, "showEndDate": 23, "repeat": 25,
    "target": 1, "clearSeconds": 2, "rewards": (5, 11, 17, 23)
}
ACTIVE_MISSION_COLUMNS = {
    "pattern": 24, "statistics": 25, "statisticsMaxValue": 26, "battleKind": 27, "clientCheck": 28, "questKind": 29,
    "questIds": (30, 31, 32), "questRankId": 35, "itemId": 36, "equipmentId": 37, "characterId": 38, "missionIds": 50,
    # the row's `need` (mission and stage); columns 59-60 (need_mission_id) are empty in every row
    "needMissionId": 51, "needMissionStage": 52, "startDate": 55, "endDate": 56, "showStartDate": 57, "showEndDate": 58, "repeat": 62,
    "target": 3, "rewards": (7, 13, 19, 25)
}

# degree (title) missions: the regular layout one column further right (column 0 is a display category)
DEGREE_MISSION_COLUMNS = {
    **{key: (tuple(column + 1 for column in value) if isinstance(value, tuple) else value + 1)
       for key, value in MISSION_COLUMNS.items() if key not in ("target", "clearSeconds", "rewards")},
    "target": 1, "clearSeconds": 2, "rewards": (5, 11, 17, 23)
}

# collect item event missions (category 4): the regular layout two columns further right (column 0 is the
# collect_item_event id, column 1 the round the mission belongs to); their reward rows are one column further right
# (column 1 is a display value)
COLLECT_ITEM_EVENT_MISSION_COLUMNS = {
    **{key: (tuple(column + 2 for column in value) if isinstance(value, tuple) else value + 2)
       for key, value in MISSION_COLUMNS.items() if key not in ("target", "clearSeconds", "rewards")},
    "eventId": 0, "round": 1,
    "target": 2, "clearSeconds": 3, "rewards": (6, 12, 18, 24)
}

def convert_missions(missions, rewards, columns=MISSION_COLUMNS):
    converted = {}
    for mission_id, row in missions.items():
        mission = {"pattern": int(row[columns["pattern"]])}
        for key in ("eventId", "round"):
            if key in columns and mission_int(row[columns[key]]) is not None:
                mission[key] = mission_int(row[columns[key]])
        optional = {key: mission_int(row[columns[key]]) for key in (
            "statistics", "statisticsMaxValue", "battleKind", "questKind", "questRankId", "itemId", "characterId",
            "needMissionId", "needMissionStage")}
        # the active missions' equipment column is a list; every row names at most one
        optional["equipmentId"] = next(iter(mission_ints(row[columns["equipmentId"]])), None)
        for key in ("startDate", "endDate", "showStartDate", "showEndDate"):
            optional[key] = None if row[columns[key]] in ("", "(None)") else row[columns[key]]
        for show, enable in (("showStartDate", "startDate"), ("showEndDate", "endDate")):
            if optional[show] == optional[enable]:
                optional[show] = None
        mission.update({key: value for key, value in optional.items() if value is not None})
        if row[columns["clientCheck"]] not in ("", "(None)"):
            mission["clientCheck"] = row[columns["clientCheck"]]
        quest_ids = [mission_ints(row[column]) for column in columns["questIds"]]
        if any(quest_ids):
            mission["questIds"] = quest_ids
        if mission_ints(row[columns["missionIds"]]):
            mission["missionIds"] = mission_ints(row[columns["missionIds"]])
        if row[columns["repeat"]] == "true":
            mission["repeat"] = True
        mission["stages"] = []
        for _, stage in sorted(rewards.get(mission_id, {}).items(), key=lambda item: int(item[0])):
            converted_stage = {"target": int(float(stage[columns["target"]])), "rewards": convert_mission_rewards(stage, columns["rewards"])}
            # the time limit of "clear a solo battle in N seconds" (pattern 13)
            clear_seconds = mission_int(stage[columns["clearSeconds"]]) if "clearSeconds" in columns else None
            if clear_seconds is not None:
                converted_stage["clearSeconds"] = clear_seconds
            mission["stages"].append(converted_stage)
        converted[mission_id] = mission
    return converted

def convert_active_missions(missions, rewards):
    """Step Up Missions (active mission event 1), with the phase (Rookie 1 to Advanced 4) each belongs to. Events 2
    (the content guide) and 3 (a campaign) have Japanese texts only and party conditions the server doesn't check."""
    step_up = {mission_id: row for mission_id, row in missions.items() if row[0] == "1"}
    converted = convert_missions(step_up, rewards, ACTIVE_MISSION_COLUMNS)
    for mission_id, mission in converted.items():
        mission["phase"] = int(step_up[mission_id][1])
    return converted

def convert_character_level(obj):
    """Exp thresholds by rarity (index 0 is level 1). Rarities 3-5 live in the bundled table."""
    bundled = parse_file(os.path.join(FILE_INPUT, "character_level_iosbundled.json"))
    if bundled is None:
        raise ValueError("character_level_iosbundled.json is required for the rarity 3-5 EXP curves")
    return {rarity: [int(rows[level][0]) for level in sorted(rows, key=int)]
            for rarity, rows in {**obj, **bundled}.items()}

# bonus/login_bonus: groups keyed by string id, then by one-based day. Each day has up to seven rewards.
def convert_login_bonus(obj):
    group_types = ["Normal", "Limited", "Comeback", "ComebackAlways", "ActiveUser"]
    def optional(value):
        return None if value in ("", "(None)") else value
    converted = []
    for group_id, entries in obj.items():
        rows = sorted(entries.items(), key=lambda pair: int(pair[0]))
        first = rows[0][1]
        days = []
        for index, row in rows:
            rewards = []
            for offset in (6, 10, 14, 18, 22, 26, 30):
                if optional(row[offset]) is None:
                    continue
                reward = {"kind": int(row[offset]), "amount": int(row[offset + 1])}
                if reward["kind"] == 1:
                    reward["itemId"] = int(row[offset + 2])
                elif reward["kind"] == 2:
                    reward["characterId"] = int(row[offset + 3])
                rewards.append(reward)
            days.append({"index": int(index), "rewards": rewards})
        converted.append({
            "id": group_id,
            "groupType": group_types[int(first[0])],
            "startDate": optional(first[40]), "endDate": optional(first[41]),
            "annualStart": optional(first[42]), "annualEnd": optional(first[43]),
            "conditionStart": optional(first[38]), "conditionEnd": optional(first[39]),
            "reasonId": int(first[44]), "comebackGroupId": optional(first[45]),
            "includeBeginner": None if optional(first[46]) is None else first[46] == "true",
            "days": days
        })
    return converted


# Ability Cores (`ability/ability_soul`): only their ids, so a party sent to other players (FT-50's suggested parties)
# holds no core the client doesn't know; an unknown one stops it with C8601. Cores are items too (item_max_count), but
# 20 of them have six-digit ids among other items', so the item table can't tell them apart.
def convert_ability_souls(obj):
    return sorted(int(soul_id) for soul_id in obj)

def save_json(obj, file_path):
    with open(file_path, 'w', encoding='utf8') as file:
        json.dump(obj, file, indent=4, ensure_ascii=False)

# Units that join through the story (FT-16): character/story_join_character rows, keyed by unit: 1-3 the story's part,
# chapter and episode, 4 the main quest after which it joins, 6 how ("town": the player taps it in the town, which
# sends character/add_character_from_town; "quest": the quest brings it).
def convert_story_join_characters(obj):
    return {character_id: {"questId": int(row[4]), "via": row[6]} for character_id, row in obj.items()}

# define the files to convert
to_convert_files = {
    "ability_soul": convert_ability_souls,
    "login_bonus": convert_login_bonus,
    "main_quest": lambda obj: convert_main_ex_quests(obj, 49),
    "ex_quest": convert_main_ex_quests, 
    "boss_battle_quest": convert_boss_quests,
    "character_quest": convert_character_quests,
    "clear_reward": convert_clear_rewards,
    "score_reward": convert_score_reward,
    "character": convert_characters,
    "rare_score_reward": convert_rare_score_reward,
    "reward_element_map": convert_reward_element_map,
    "mana_node": convert_mana_nodes,
    "character_level": convert_character_level,
    "ex_boost": convert_ex_boost,
    "ex_status": convert_ex_status,
    "ex_ability": convert_ex_ability,
    "world_story_event_boss_battle_quest": convert_world_story_event_boss_battle_quest,
    "world_story_event_quest": convert_world_story_event_quest,
    "advent_event_quest": convert_advent_quest,
    "daily_exp_mana_event_quest": convert_daily_exp_mana_event_quest,
    "daily_week_event_quest": convert_daily_week_event_quest,
    "challenge_dungeon_event_quest": convert_challenge_dungeon_event_quest,
    "practice_quest": convert_practice_quest,
    "reward_campaign": convert_reward_campaign,
    "story_event_single_quest": convert_story_event_single_quest,
    "ranking_event_single_quest": convert_ranking_event_single_quest,
    "solo_time_attack_event_quest": convert_solo_time_attack_event_quest,
    "tower_dungeon_event_quest": convert_tower_dungeon_event_quest,
    "expert_single_event_quest": convert_expert_single_event_quest,
    "expert_single_event": convert_expert_single_event,
    "solo_time_attack_event": convert_solo_time_attack_event,
    "solo_time_attack_clear_time_reward": convert_solo_time_attack_clear_time_reward,
    "score_attack_border_reward": convert_score_attack_border_reward,
    "game_system_unlock_condition": convert_game_system_unlock_condition,
    "carnival_event_quest": convert_carnival_event_quest,
    "carnival_event_total_score_reward": convert_carnival_event_total_score_reward,
    "ranking_event": convert_ranking_event,
    "ranking_event_ranking_reward": convert_ranking_event_ranking_reward,
    "raid_event": convert_raid_event,
    "raid_event_overall_reward": convert_raid_event_overall_reward,
    "raid_event_ranking_reward": convert_raid_event_ranking_reward,
    "rush_event_quest": convert_rush_event_quest,
    "raid_event_quest": convert_raid_event_quest,
    "score_attack_event_quest": convert_score_attack_event_quest,
    "box_reward": convert_box_rewards,
    "box_gacha": convert_box_gacha,
    "gacha": convert_gacha,
    "gacha_campaign": convert_gacha_campaigns,
    "general_shop": convert_general_shop,
    "special_pack_shop": convert_special_pack_shop,
    "boss_coin_shop": convert_boss_coin_shop,
    "event_item_shop": convert_event_item_shop,
    "treasure_shop": convert_treasure_shop,
    "treasure_shop_discount_rate": convert_treasure_shop_discount_rate,
    "star_grain_shop": convert_star_grain_shop,
    "star_crumb_exchange": convert_star_crumb_exchange,
    "star_crumb_exchange_cost": convert_star_crumb_exchange_cost,
    "encyclopedia": convert_encyclopedia,
    "rush_event_quest_folder": convert_rush_event_quest_folder,
    "multi_special_exchange_campaign": convert_multi_special_exchange_campaigns,
    "multi_special_exchange_campaign_character": convert_multi_special_exchange_campaign_characters,
    "character_election": convert_character_election,
    "periodic_reward": convert_periodic_reward,
    "story_join_character": convert_story_join_characters
}

# tables merged into one output
player_rank_bundled = parse_file(os.path.join(FILE_INPUT, "player_rank_iosbundled.json"))
player_rank_later = parse_file(os.path.join(FILE_INPUT, "player_rank.json"))
if player_rank_bundled is None or player_rank_later is None:
    print("player_rank_iosbundled.json or player_rank.json not found inside the '/in' folder. Skipping...")
else:
    save_json(convert_player_rank(player_rank_bundled, player_rank_later), os.path.join(FILE_OUTPUT, "player_rank.json"))

collect_item_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("collect_item_event.json",
    "collect_item_event_quest_relation.json", "collect_item_event_reward_relation.json", "additional_reward.json")]
if None in collect_item_inputs:
    print("collect_item_event, its quest and reward relations or additional_reward .json not found inside the '/in' folder. Skipping collect item event drops...")
else:
    save_json(convert_collect_item_event_drops(*collect_item_inputs), os.path.join(FILE_OUTPUT, "collect_item_event_drops.json"))

sell_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("equipment_craft_point_exchange.json",
    "experience_conversion_rate.json", "equipment.json", "character.json", "item.json")]
if None in sell_inputs:
    print("equipment_craft_point_exchange, experience_conversion_rate, equipment, character or item .json not found inside the '/in' folder. Skipping sell rules...")
else:
    save_json(convert_sell_rules(*sell_inputs), os.path.join(FILE_OUTPUT, "sell_rules.json"))

enhancement_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("equipment_enhancement_shop.json",
    "equipment_enhancement_shop_category.json", "equipment_enhancement.json", "equipment_enhancement_config.json")]
if None in enhancement_inputs:
    print("equipment_enhancement(_shop, _shop_category, _config) .json not found inside the '/in' folder. Skipping armament augmentation...")
else:
    save_json(convert_equipment_enhancement(*enhancement_inputs), os.path.join(FILE_OUTPUT, "equipment_enhancement.json"))

hard_multi_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("hard_multi_event_quest.json", "hard_multi_event.json")]
if None in hard_multi_inputs:
    print("hard_multi_event_quest or hard_multi_event .json not found inside the '/in' folder. Skipping hard multi event quests...")
else:
    save_json(convert_hard_multi_event_quest(*hard_multi_inputs), os.path.join(FILE_OUTPUT, "hard_multi_event_quest.json"))

stamina_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("player_rank_iosbundled.json", "player_rank.json",
    "config_iosbundled.json", "stamina_campaign.json", "battle_no_stamina_return.json", "item.json")]
if None in stamina_inputs:
    print("player_rank(_iosbundled), config_iosbundled, stamina_campaign, battle_no_stamina_return or item .json not found inside the '/in' folder. Skipping stamina...")
else:
    save_json(convert_stamina(*stamina_inputs), os.path.join(FILE_OUTPUT, "stamina.json"))

# Lineup choices (FT-38): a select item campaign makes the player pick one lineup of a shop's items, once.
# shop/boss_coin_shop_select_item_campaign (Boss Coin shop, the client's shop_type 7; the Co-Op Challenge seasons) and
# quest/event/event_shop_select_item_campaign (event item shop, shop_type 4; the Beast of the Abyss shop) rows:
# 1-2 the shop group (Boss Coin shop: an item's column 1 and its category, column 0; event shop: the event type and id,
# an item's columns 2 and 1), 6-7 the choosing period, 8 when the exchange ends (Japan time). Lineup rows: Boss Coin
# shop, entries of six columns (campaign id, position, type 1 armament or 0 item, id, name, letter); event shop, one
# entry (campaign id, type, id). A lineup's shop items are those of the campaign's group whose first reward is one of
# its entries and whose sale overlaps the campaign.
def convert_select_item_campaigns(boss_campaigns, boss_lineups, boss_shop, event_campaigns, event_lineups, event_shop):
    def overlaps(item_from, item_until, start, end):
        return item_from <= end and (item_until in ("(None)", "") or item_until >= start)

    def campaign_entry(row):
        return {"selectStart": row[6], "selectEnd": row[7], "exchangeEnd": row[8], "lineups": {}}

    boss = {}
    for campaign_id, row in boss_campaigns.items():
        campaign = boss[campaign_id] = campaign_entry(row)
        for lineup_id, lineup in boss_lineups.items():
            entries = [(lineup[i + 2], lineup[i + 3]) for i in range(0, len(lineup) - 5, 6) if lineup[i] == campaign_id]
            if not entries:
                continue
            ids = {entry_id for _, entry_id in entries}
            campaign["lineups"][lineup_id] = sorted(int(item_id) for item_id, item in boss_shop.items()
                if item[0] == row[2] and item[1] == row[1] and item[32] in ids and overlaps(item[24], item[25], row[6], row[8]))

    event = {}
    for campaign_id, row in event_campaigns.items():
        campaign = event[campaign_id] = campaign_entry(row)
        for lineup_id, lineup in event_lineups.items():
            if lineup[0] != campaign_id:
                continue
            campaign["lineups"][lineup_id] = sorted(int(item_id) for item_id, item in event_shop.items()
                if item[2] == row[1] and item[1] == row[2] and item[33] == lineup[2] and overlaps(item[26], item[27], row[6], row[8]))
    return {"7": boss, "4": event}

# Special exchange campaigns (FT-39): campaign/special_exchange/special_exchange_campaign rows: 1 name, 2 kind (0 units,
# 1 armaments), 3-4 the ticket's sale period, 5-6 the exchange period (Japan time), 8 the exchange ticket item, 9 1 for
# the ticket gift promos (free tickets, no price), 10 the ticket bundle's price in paid beads. The _character and
# _equipment tables list each campaign's targets (row = campaign id: the ids).
def convert_special_exchange_campaigns(campaigns, characters, equipment):
    # English names of the campaigns added late in Japanese only, from the translation overlay (i18n/en)
    overlay = parse_file(os.path.join(ROOT, "..", "i18n", "en", "master", "campaign__special_exchange__special_exchange_campaign.json")) or {}
    converted = {}
    for campaign_id, row in campaigns.items():
        kind = "character" if row[2] == "0" else "equipment"
        targets = (characters if kind == "character" else equipment).get(campaign_id, [])
        converted[campaign_id] = {
            "kind": kind,
            "name": overlay.get(campaign_id, {}).get("1", {}).get("text", row[1]),
            "saleStart": row[3], "saleEnd": row[4],
            "exchangeStart": row[5], "exchangeEnd": row[6],
            "ticketItemId": int(row[8]),
            "gift": row[9] == "1",
            "price": int(row[10]) if row[10] not in ("", "(None)") else None,
            "targets": [int(target) for target in targets if target not in ("", "(None)")]
        }
    return converted

special_exchange_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("special_exchange_campaign.json",
    "special_exchange_campaign_character.json", "special_exchange_campaign_equipment.json")]
if None in special_exchange_inputs:
    print("special_exchange_campaign(_character, _equipment).json not found inside the '/in' folder. Skipping special_exchange_campaign...")
else:
    save_json(convert_special_exchange_campaigns(*special_exchange_inputs), os.path.join(FILE_OUTPUT, "special_exchange_campaign.json"))

# Box resets (FT-14): box_gacha/box rows (the client's row parser): 0 multiplied id, 1-2 name, 3 the box it needs open,
# 10 advance draw number, 11 reset_kind (0 none, 1 once every required reward is drawn, 2 once the box is empty),
# 12 reset_limit ("(None)": unlimited), 13-14 the box's period (Japan time). Only boxes that can reset are written; in the
# data every gacha's last box is kind 2 without a limit, every other box kind 0.
def convert_box_resets(boxes):
    converted = {}
    for gacha_id, gacha_boxes in boxes.items():
        for box_id, row in gacha_boxes.items():
            if row[11] == "0":
                continue
            converted.setdefault(gacha_id, {})[box_id] = {
                "kind": int(row[11]),
                "limit": None if row[12] in ("", "(None)") else int(row[12]),
                "start": row[13], "end": row[14]
            }
    return converted

# Portals' own tickets (FT-14): gacha/gacha columns 27 (once_ticket_item_id) and 28 (ten_times_ticket_item_id), the
# tickets of draw kinds 3 and 4 (e.g. the Launch Gala Portal's 20001 and 20002). Only portals with one are written.
# Column 31 (ticket_expiry_time, FT-52) is how long a player holding one of them may still use it after the portal
# closes: the client keeps the portal listed until then (getExtendedEndTime), with only these two draw kinds.
def convert_gacha_tickets(gachas):
    def ticket(value):
        return None if value in ("", "(None)") else int(value)
    converted = {}
    for gacha_id, row in gachas.items():
        once, ten = ticket(row[27]), ticket(row[28])
        if once is not None or ten is not None:
            converted[gacha_id] = {"once": once, "tenTimes": ten,
                                   "expiry": None if row[31] in ("", "(None)") else row[31]}
    return converted

# Portals that take the wildcard tickets (FIX-9): gacha/gacha column 20 (wildcard_character_ticket_available) for a unit
# portal (column 13 is 0), column 26 (wildcard_equipment_ticket_available) for an armament portal. The client offers the
# Summoning Tickets (999001, 999003), the 4 & 5-Star Portal Ticket (999008) and the Armament Tickets (999004, 999005) only
# where the portal's flag is "true": its GachaPrizeKind carries the flag, and the gacha only gets wildcard ticket item ids
# with it. No ticket-only or Star Heroes portal has it, nor the early bead portals (before 2022-01-26).
def convert_gacha_wildcard_tickets(gachas):
    return sorted(int(gacha_id) for gacha_id, row in gachas.items() if (row[20] if row[13] == "0" else row[26]) == "true")

# Ticket portals: gacha/gacha rows whose column 4 (the client's GachaPageKind) is 2 (TicketOnly: its single-pull and
# 10-pull tickets, the New Year's Grab Bag, 57, with the 2021 Grab Bag tickets 20065 and 20064), 3 (a single-pull ticket
# only: the 4 & 5-Star Exclusive Portal, the 5-Star Exclusive Portal, the Premium Portal, the 4 & 5-Star Exclusive &
# Limited Portal) or 4 (a 10-pull ticket only: the Grab Bag and Returning Units portals). `convert_gacha` writes only the bead
# portals (payment type 0), because everything that lists portals (the open-portal check, Start Dash, co-op companions,
# the Calendar) means those; these go to their own file, which only the portal lookup reads, so a draw with their
# ticket finds them. Same shape as `convert_gacha`'s character portals, with no bead costs.
def convert_ticket_gacha(obj):
    converted = {}
    for gacha_id, row in obj.items():
        payment_type = int(row[4])
        if payment_type not in (2, 3, 4) or int(row[13]) != 0:
            continue
        converted[gacha_id] = {
            "type": 0,
            "paymentType": payment_type,
            "singleCost": 0,
            "multiCost": 0,
            "discountCost": 0,
            "movieName": row[17],
            "guaranteeMovieName": row[18],
            "startDate": row[29],
            "endDate": row[30],
            **convert_gacha_rank_weights(row),
            "pool": {
                "3": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[14]}.json")),
                "2": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[15]}.json")),
                "1": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[16]}.json")),
            }
        }
    return converted

# Star Heroes portals: gacha/gacha rows of payment type 1 (the client's GachaPageKind.TenTimesPerAccount): one 10-pull
# per account for column 8's beads (1500), whose guaranteed pull (columns 9-10: 1 pull, 5 stars) is a 5-star one drawn
# by the 5-star pool's own odds ("When performing a 10-Pull on this type of portal, one of the pulls is guaranteed to
# be a 5* unit, using special drop rates that only include 5* units", the portal's notes). Kept out of
# assets/gacha.json for the same reason as the ticket portals: nothing that lists portals should pick them.
def convert_star_heroes_gacha(obj):
    converted = {}
    for gacha_id, row in obj.items():
        if int(row[4]) != 1 or int(row[13]) != 0:
            continue
        converted[gacha_id] = {
            "type": 0,
            "paymentType": 1,
            "singleCost": 0,
            "multiCost": int(row[8]),
            "discountCost": 0,
            "movieName": row[17],
            "guaranteeMovieName": row[18],
            "startDate": row[29],
            "endDate": row[30],
            **convert_gacha_rank_weights(row),
            "pool": {
                "3": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[14]}.json")),
                "2": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[15]}.json")),
                "1": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[16]}.json")),
            }
        }
    return converted

# Welcome Back Portals (FT-62): gacha/gacha rows of payment type 7 (the client's GachaPageKind.WithoutDaily: beads at
# columns 5 and 6, no daily discounted pull) marked as comeback portals in column 43 (700000 to 700004, one per lineup,
# opening 2023-07-25 to 2024-05-07). The client ignores their own period: it shows one only to a player whose
# gacha_info_list entry carries a comeback_campaign period (src/lib/comebackGacha.ts). Kept out of assets/gacha.json for
# the same reason as the ticket portals.
def convert_comeback_gacha(obj):
    converted = {}
    for gacha_id, row in obj.items():
        if int(row[4]) != 7 or int(row[13]) != 0 or row[43] != "true":
            continue
        converted[gacha_id] = {
            "type": 0,
            "paymentType": 7,
            "singleCost": int(row[5]),
            "multiCost": int(row[6]),
            "discountCost": 0,
            "movieName": row[17],
            "guaranteeMovieName": row[18],
            "startDate": row[29],
            "endDate": row[30],
            **convert_gacha_rank_weights(row),
            "pool": {
                "3": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[14]}.json")),
                "2": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[15]}.json")),
                "1": convert_gacha_rarities(os.path.join(FILE_INPUT, "gacha_odds", f"{row[16]}.json")),
            }
        }
    return converted

gacha_input = parse_file(os.path.join(FILE_INPUT, "gacha.json"))
if gacha_input is not None:
    save_json(convert_gacha_tickets(gacha_input), os.path.join(FILE_OUTPUT, "gacha_tickets.json"))
    save_json(convert_gacha_wildcard_tickets(gacha_input), os.path.join(FILE_OUTPUT, "gacha_wildcard_tickets.json"))
    save_json(convert_ticket_gacha(gacha_input), os.path.join(FILE_OUTPUT, "ticket_gacha.json"))
    save_json(convert_star_heroes_gacha(gacha_input), os.path.join(FILE_OUTPUT, "star_heroes_gacha.json"))
    save_json(convert_comeback_gacha(gacha_input), os.path.join(FILE_OUTPUT, "comeback_gacha.json"))

# Free portal pulls (FT-14): gacha/gacha_campaign column 2 is the pulls a campaign gives each day (1 a free pull,
# 2 a free 10-pull), so the draw's size comes from the campaign rather than from the draw kind the client sends.
# Their periods (columns 3-4, Japan time, both included) and portals (column 5): the original /load listed every portal
# of an open campaign in `gacha_campaign_list` (count 1 until the day's pull), and the client shows the free pull button
# only for a listed portal.
def convert_gacha_campaign_periods(obj):
    return {campaign_id: {"start": row[3], "end": row[4], "gachaIds": [int(gacha_id) for gacha_id in row[5].split(",") if gacha_id]}
            for campaign_id, row in obj.items()}

gacha_campaign_input = parse_file(os.path.join(FILE_INPUT, "gacha_campaign.json"))
if gacha_campaign_input is not None:
    save_json({campaign_id: (10 if row[2] == "2" else 1) for campaign_id, row in gacha_campaign_input.items()},
              os.path.join(FILE_OUTPUT, "gacha_campaign_draws.json"))
    save_json(convert_gacha_campaign_periods(gacha_campaign_input), os.path.join(FILE_OUTPUT, "gacha_campaign_periods.json"))

box_input = parse_file(os.path.join(FILE_INPUT, "box.json"))
if box_input is None:
    print("box.json not found inside the '/in' folder. Skipping box_gacha_reset...")
else:
    save_json(convert_box_resets(box_input), os.path.join(FILE_OUTPUT, "box_gacha_reset.json"))

# The Start Dash bundle (FT-44): campaign/start_dash_exchange/start_dash_exchange_campaign rows: 1 name, 2-3 the
# campaign's period ("(None)": no end), 4 the days each player has from their start, 6 the exchange ticket item, 7 the
# bundle's price in beads, 9 the bundle's name; _term rows: the term indexes and their start; _exclude_character
# (campaign, term) the units left out of the exchange (empty in the data).
def convert_start_dash(campaigns, terms, excluded):
    converted = {}
    for campaign_id, row in campaigns.items():
        converted[campaign_id] = {
            "name": row[1], "start": row[2], "end": None if row[3] in ("", "(None)") else row[3],
            "days": int(row[4]), "ticketItemId": int(row[6]), "price": int(row[7]), "bundleName": row[9],
            "terms": {index: starts[0] for index, starts in terms.get(campaign_id, {}).items()},
            "excluded": {index: [int(entry[0]) for entry in rows] for index, rows in (excluded or {}).get(campaign_id, {}).items()}
        }
    return converted

start_dash_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("start_dash_exchange_campaign.json",
    "start_dash_exchange_campaign_term.json")]
if None in start_dash_inputs:
    print("start_dash_exchange_campaign(_term).json not found inside the '/in' folder. Skipping start_dash_exchange_campaign...")
else:
    save_json(convert_start_dash(*start_dash_inputs, parse_file(os.path.join(FILE_INPUT, "start_dash_exchange_campaign_exclude_character.json"))),
              os.path.join(FILE_OUTPUT, "start_dash_exchange_campaign.json"))

select_campaign_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("boss_coin_shop_select_item_campaign.json",
    "boss_coin_shop_select_item_campaign_lineup.json", "boss_coin_shop.json", "event_shop_select_item_campaign.json",
    "event_shop_select_item_campaign_lineup.json", "event_item_shop.json")]
if None in select_campaign_inputs:
    print("the select item campaign, lineup and shop .json files not found inside the '/in' folder. Skipping select_item_campaign...")
else:
    save_json(convert_select_item_campaigns(*select_campaign_inputs), os.path.join(FILE_OUTPUT, "select_item_campaign.json"))

# missions by category (the client's mission_category: 1 regular, 2 daily, 3 event, 4 collect item event, 5 degree),
# each with its reward table
mission_categories = {"1": "regular_mission", "2": "daily_mission", "3": "event_mission", "4": "collect_item_event_mission", "5": "degree_mission"}
mission_columns = {"degree_mission": DEGREE_MISSION_COLUMNS, "collect_item_event_mission": COLLECT_ITEM_EVENT_MISSION_COLUMNS}
mission_tables = {name: (parse_file(os.path.join(FILE_INPUT, f"{name}.json")), parse_file(os.path.join(FILE_INPUT, f"{name}_reward.json")))
                  for name in mission_categories.values()}
if any(table is None for tables in mission_tables.values() for table in tables):
    print("A mission table (regular_mission, daily_mission, event_mission, collect_item_event_mission, degree_mission and their _reward tables) is missing from the '/in' folder. Skipping missions...")
else:
    save_json({category: convert_missions(*mission_tables[name], mission_columns.get(name, MISSION_COLUMNS))
               for category, name in mission_categories.items()}, os.path.join(FILE_OUTPUT, "mission.json"))

# the event calendar's events and portal names
event_tables = {kind: parse_file(os.path.join(FILE_INPUT, f"{kind}.json")) for kind in EVENT_TABLES}
gacha_table = parse_file(os.path.join(FILE_INPUT, "gacha.json"))
if gacha_table is None or all(table is None for table in event_tables.values()):
    print("gacha.json or the event tables (story_event, advent_event, ...) not found inside the '/in' folder. Skipping the event calendar...")
else:
    save_json(convert_event_calendar(event_tables, gacha_table), os.path.join(FILE_OUTPUT, "event_calendar.json"))

# The open periods of the modes the event calendar doesn't hold (FT-51): the Kaleidoscope dailies, the Necropolis and
# the Treasure Zone, Solo Boss Challenges and Nostalgia Trials, Chrono Trials and Score Scramble. The client shows a
# mode's quests only inside its row's period, so the server checks the same one (src/lib/questPeriods.ts). Every one
# of these rows ends in its start, end and exchange end (Japan time; "(None)" is open-ended).
QUEST_MODE_TABLES = ("daily_week_event", "daily_exp_mana_event", "challenge_dungeon_event", "expert_single_event",
                     "solo_time_attack_event", "score_attack_event")
mode_tables = {kind: parse_file(os.path.join(FILE_INPUT, f"{kind}.json")) for kind in QUEST_MODE_TABLES}
if any(table is None for table in mode_tables.values()):
    print(f"A mode table ({', '.join(QUEST_MODE_TABLES)}) is missing from the '/in' folder. Skipping quest_mode_periods...")
else:
    save_json({kind: {event_id: {"start": row[-3], "end": master_end_time(row[-2])} for event_id, row in table.items()}
               for kind, table in mode_tables.items()}, os.path.join(FILE_OUTPUT, "quest_mode_periods.json"))

# titles: the ids the game has (`degree/degree`), for checking the ones players set or are sent
degrees = parse_file(os.path.join(FILE_INPUT, "degree.json"))
if degrees is None:
    print("degree.json not found inside the '/in' folder. Skipping titles...")
else:
    save_json(sorted(int(degree_id) for degree_id in degrees), os.path.join(FILE_OUTPUT, "degree.json"))

# The admin mail picker's catalog (ADM-1): every unit, armament, item and title of the master data, with its English
# name (the overlay's where the master row is Japanese only). Columns:
# - character/character_text: 0 name (1 the Japanese name);
# - item/equipment: 0 string_id, 1 name, 11 rarity;
# - item/item: 0 string_id, 1 name, 2 icon, 5 item type (2 and 3 stamina potions, 11 armament cores, 15 boss coins...),
#   13 the item list's category (0 consumables, 2 growth materials, 3 event items, 4 tickets, 5 armament cores, 6 boss
#   coins, 7 Wrightpiece, 8 Star Speck, 9 armament materials);
# - degree/degree: 2 name.
# Names that are empty in the master are left out. The ids double as the list of what the client can show.
def convert_catalog_names(character_texts, equipment, items, degree_rows):
    def names(rows, overlay_file, column):
        overlay = english_overlay(overlay_file)
        return {row_id: name for row_id, row in rows.items() if (name := english_text(overlay, row_id, column, row).strip())}
    equipment_names = names(equipment, "item__equipment.json", 1)
    item_names = names(items, "item__item.json", 1)
    return {
        "characters": names(character_texts, "character__character_text.json", 0),
        "equipment": {equipment_id: {"name": equipment_names.get(equipment_id), "rarity": int(row[11])}
                      for equipment_id, row in equipment.items()},
        "items": {item_id: {"name": item_names.get(item_id), "category": int(row[13])} for item_id, row in items.items()},
        "degrees": names(degree_rows, "degree__degree.json", 2)
    }

catalog_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("character_text.json", "equipment.json", "item.json", "degree.json")]
if None in catalog_inputs:
    print("character_text.json, equipment.json, item.json or degree.json not found inside the '/in' folder. Skipping catalog_names...")
else:
    save_json(convert_catalog_names(*catalog_inputs), os.path.join(FILE_OUTPUT, "catalog_names.json"))

# daily challenge points (`quest/event/daily_challenge_point`, mail type 14) and their campaigns, and periodic reward
# points (`reward/periodic_reward_point`, mail type 15): caps, daily refills and periods (master dates, Japan time).
# Column names are the client's row parsers' (docs/routes/mail_index.md). Names come from the English overlay.
challenge_points = parse_file(os.path.join(FILE_INPUT, "daily_challenge_point.json"))
challenge_point_campaigns = parse_file(os.path.join(FILE_INPUT, "daily_challenge_point_campaign.json"))
if challenge_points is None or challenge_point_campaigns is None:
    print("daily_challenge_point.json or daily_challenge_point_campaign.json not found inside the '/in' folder. Skipping daily challenge points...")
else:
    challenge_point_names = english_overlay("quest__event__daily_challenge_point.json")
    save_json({
        "points": {point_id: {
            "max": int(row[1]),               # max_challenge_point
            "daily": int(row[2]),             # max_display_challenge_point
            "recovers": row[3].lower() == "true",  # is_recovery
            "name": master_name(english_text(challenge_point_names, point_id, 4, row)),
            "start": row[7],
            "end": master_end_time(row[8])
        } for point_id, row in challenge_points.items()},
        "campaigns": {campaign_id: {
            "point_id": int(row[1]),          # daily_challenge_point_id
            "additional": int(row[2]),        # additional_challenge_point
            "start": row[3],
            "end": master_end_time(row[4])
        } for campaign_id, row in challenge_point_campaigns.items()}
    }, os.path.join(FILE_OUTPUT, "daily_challenge_point.json"))

reward_points = parse_file(os.path.join(FILE_INPUT, "periodic_reward_point.json"))
if reward_points is None:
    print("periodic_reward_point.json not found inside the '/in' folder. Skipping periodic reward points...")
else:
    reward_point_names = english_overlay("reward__periodic_reward_point.json")
    save_json({point_id: {
        "max": int(row[1]),                   # max_reward_point
        "recovery": int(row[2]),              # recovery_point
        "cycle": int(row[3]),                 # recovery_cycle: 0 is daily, the only one the client names
        "name": master_name(english_text(reward_point_names, point_id, 4, row)),
        "start": row[7],
        "end": master_end_time(row[8])
    } for point_id, row in reward_points.items()}, os.path.join(FILE_OUTPUT, "periodic_reward_point.json"))

# Party power (FT-63, src/lib/partyPower.ts): the stat tables the client's party power score reads. Columns are the
# client's row parsers':
# - character/character_status (+ _iosbundled, which holds 4 more units): per unit, rows keyed by level = hp, atk;
# - character/evolution_status: per rarity = atk_plus_value_1, hp_plus_value_1, atk_plus_value_2, hp_plus_value_2;
# - character/level_cap (rarities 1-3) + level_cap_iosbundled (4-5): base_level_cap, max_over_limit_count,
#   uncap_level_per_over_limit, hp_up_by_over_limit, atk_up_by_over_limit (percent per over limit step);
# - ex_boost/ex_status: string_id, hp, atk, rarity; ex_boost/ex_ability: string_id, unisonable, rarity, battle_power;
# - item/equipment_status: per armament, rows keyed by level = hp, atk;
# - equipment_enhancement/equipment_enhancement_status: per augmentable armament, rows keyed by enhancement level;
# - item/item: column 16 is the rarity, which an Ability Core (an item, assets/ability_soul.json) adds.
# Rows keyed by level become [level, hp, atk] lists sorted by level, the client interpolating between them.
def leveled_rows(table):
    return {row_id: sorted([int(level), int(values[0]), int(values[1])] for level, values in rows.items())
            for row_id, rows in table.items()}

party_power_names = ("character_status.json", "character_status_iosbundled.json", "evolution_status.json", "level_cap.json",
                     "level_cap_iosbundled.json", "ex_status.json", "ex_ability.json", "equipment_status.json",
                     "equipment_enhancement_status.json", "item.json", "ability_soul.json")
party_power_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in party_power_names]
if None in party_power_inputs:
    print(f"{', '.join(party_power_names)} are needed inside the '/in' folder. Skipping party_power...")
else:
    (status, status_bundled, evolution, level_cap, level_cap_bundled, ex_status, ex_ability, equipment_status,
     enhancement_status, items, ability_souls) = party_power_inputs
    save_json({
        "characterStatus": leveled_rows({**status, **status_bundled}),
        "evolution": {rarity: [int(value) for value in row] for rarity, row in evolution.items()},
        "overLimitPercent": {rarity: [float(row[3]), float(row[4])] for rarity, row in {**level_cap, **level_cap_bundled}.items()},
        "exStatus": {status_id: [int(row[1]), int(row[2])] for status_id, row in ex_status.items()},
        "exAbilityPower": {ability_id: int(row[3]) for ability_id, row in ex_ability.items()},
        "equipmentStatus": leveled_rows(equipment_status),
        "equipmentEnhancementStatus": leveled_rows(enhancement_status),
        "abilitySoulRarity": {soul_id: int(items[soul_id][16]) for soul_id in ability_souls if soul_id in items}
    }, os.path.join(FILE_OUTPUT, "party_power.json"))

for file_name, converter in to_convert_files.items():
    file_name = f"{file_name}.json" # add extension
    parsed = parse_file(os.path.join(FILE_INPUT, file_name))
    if parsed == None:
        print(f"{file_name} file not found inside the '/in' folder. Skipping...")
    else:
        save_json(converter(parsed), os.path.join(FILE_OUTPUT, file_name))

# Step Up Missions (active missions)
active_missions = parse_file(os.path.join(FILE_INPUT, "active_mission.json"))
active_mission_rewards = parse_file(os.path.join(FILE_INPUT, "active_mission_reward.json"))
if active_missions is None or active_mission_rewards is None:
    print("active_mission.json or active_mission_reward.json not found inside the '/in' folder. Skipping active missions...")
else:
    save_json(convert_active_missions(active_missions, active_mission_rewards), os.path.join(FILE_OUTPUT, "active_mission.json"))

# Co-Op Challenge seasons (FT-34, the boss battle multi pickups): quest/boss_battle/boss_battle_multi_pickup_event rows
# (the client's row parser): 0 string id, 1 top background, 2 rich text, 3 reward_increase_rate, 4 flash_frame_reference,
# 5 mission_link, 6-7 the season's period (Japan time). The _schedule table holds each season's spotlights (row = season id: its entries):
# 0 chapter_id and 1 stage_node_id (the boss battle stage the spotlight is on: quests chapter * 1,000,000 + stage * 1,000
# + n), 2 header background, 3 the additional score reward ("(None)" in every global row: no extra drops), 6-7 the
# spotlight's period. The client's text: co-op battles against the boss in the spotlight give rate times the Boss Coins,
# exp and mana. Boss Coins are the items of item/item category 6 (column 13), stored with the seasons.
def convert_boss_battle_multi_pickup(events, schedules, items):
    seasons = {}
    for event_id, row in events.items():
        seasons[event_id] = {
            "rate": float(row[3]),
            "start": row[6],
            "end": row[7],
            "spotlights": [{
                "chapterId": int(entry[0]),
                "stageNodeId": int(entry[1]),
                "start": entry[6],
                "end": entry[7]
            } for _, entry in sorted(schedules.get(event_id, {}).items(), key=lambda pair: int(pair[0]))]
        }
    boss_coins = sorted(int(item_id) for item_id, row in items.items() if len(row) > 13 and row[13] == "6")
    return {"bossCoinItemIds": boss_coins, "seasons": seasons}

multi_pickup_inputs = [parse_file(os.path.join(FILE_INPUT, name)) for name in ("boss_battle_multi_pickup_event.json",
    "boss_battle_multi_pickup_event_schedule.json", "item.json")]
if None in multi_pickup_inputs:
    print("boss_battle_multi_pickup_event(_schedule) or item .json not found inside the '/in' folder. Skipping Co-Op Challenge seasons...")
else:
    save_json(convert_boss_battle_multi_pickup(*multi_pickup_inputs), os.path.join(FILE_OUTPUT, "boss_battle_multi_pickup.json"))
