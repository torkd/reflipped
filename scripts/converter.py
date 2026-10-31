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

# converts a json quest list object into the correct form
def convert_main_ex_quests(obj):
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
                        "sPlusRewardId": 1,
                        "scoreRewardGroup": int(chapter[70]),
                        "bRankTime": floor(float(chapter[84]) * 1000),
                        "aRankTime": floor(float(chapter[85]) * 1000),
                        "sRankTime": floor(float(chapter[86]) * 1000),
                        "sPlusRankTime":  floor(float(chapter[87]) * 1000),
                        "rankPointReward": int(chapter[93]),
                        "characterExpReward": int(chapter[94]),
                        "manaReward": int(chapter[95]),
                        "poolExpReward": int(chapter[96])
                    }
                    if chapter[118] != "(None)":
                        converted_chapter["fixedParty"] = int(chapter[118])
                    converted[chapter[0]] = converted_chapter
    return converted

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
                        "sPlusRewardId": 1,
                        "scoreRewardGroup": int(chapter[70]),
                        "bRankTime": floor(float(chapter[84]) * 1000),
                        "aRankTime": floor(float(chapter[85]) * 1000),
                        "sRankTime": floor(float(chapter[86]) * 1000),
                        "sPlusRankTime":  floor(float(chapter[87]) * 1000),
                        "rankPointReward": int(chapter[93]),
                        "characterExpReward": int(chapter[94]),
                        "manaReward": int(chapter[95]),
                        "poolExpReward": int(chapter[96])
                    }
    return converted

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
                    "sPlusRewardId": 1,
                    "bRankTime": floor(float(chapter[85]) * 1000),
                    "aRankTime": floor(float(chapter[86]) * 1000),
                    "sRankTime": floor(float(chapter[87]) * 1000),
                    "sPlusRankTime":  floor(float(chapter[88]) * 1000),
                    "rankPointReward": int(chapter[94]),
                    "characterExpReward": int(chapter[95]),
                    "manaReward": int(chapter[96]),
                    "poolExpReward": int(chapter[97]),
                }
                if chapter[71] != "(None)":
                    converted_chapter["scoreRewardGroup"] = int(chapter[71])
                if chapter[119] != "(None)":
                    converted_chapter["fixedParty"] = int(chapter[119])
                converted[chapter[0]] = converted_chapter

    return converted

def convert_world_story_event_boss_battle_quest(obj):
    converted = {}
    for _, chapter_stages in obj.items():
        for _, chapter in chapter_stages.items():
            converted_chapter = {
                "name": "", #chapter[2],
                "clearRewardId": int(chapter[4]),
                "sPlusRewardId": 1,
                "bRankTime": floor(float(chapter[84]) * 1000),
                "aRankTime": floor(float(chapter[85]) * 1000),
                "sRankTime": floor(float(chapter[86]) * 1000),
                "sPlusRankTime":  floor(float(chapter[87]) * 1000),
                "rankPointReward": int(chapter[93]),
                "characterExpReward": int(chapter[94]),
                "manaReward": int(chapter[95]),
                "poolExpReward": int(chapter[97])
            }
            if chapter[70] != "(None)":
                converted_chapter["scoreRewardGroup"] = int(chapter[70])
            converted[chapter[0]] = converted_chapter

    return converted

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
                    "sPlusRewardId": 1,
                    "scoreRewardGroup": int(chapter[74]),
                    "bRankTime": floor(float(chapter[88]) * 1000),
                    "aRankTime": floor(float(chapter[89]) * 1000),
                    "sRankTime": floor(float(chapter[90]) * 1000),
                    "sPlusRankTime":  floor(float(chapter[91]) * 1000),
                    "rankPointReward": int(chapter[97]),
                    "characterExpReward": int(chapter[98]),
                    "manaReward": int(chapter[99]),
                    "poolExpReward": int(chapter[100])
                }

    return converted

def convert_daily_exp_mana_event_quest(obj):
    converted = {}
    for _, chapter_stages in obj.items():
        for _, chapter in chapter_stages.items():
            converted[chapter[0]] = {
                "name": "", #chapter[2],
                "clearRewardId": int(chapter[4]),
                "scoreRewardGroup": int(chapter[66]),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime":  0,
                "rankPointReward": int(chapter[68]),
                "characterExpReward": int(chapter[69]),
                "manaReward": int(chapter[70]),
                "poolExpReward": int(chapter[71])
            }

    return converted

def convert_daily_week_event_quest(obj):
    converted = {}
    for _, chapter_stages in obj.items():
        for _, chapter in chapter_stages.items():
            converted[chapter[0]] = {
                "name": "", #chapter[2],
                "clearRewardId": int(chapter[3]),
                "scoreRewardGroup": int(chapter[65]),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime":  0,
                "rankPointReward": int(chapter[67]),
                "characterExpReward": int(chapter[68]),
                "manaReward": int(chapter[69]),
                "poolExpReward": int(chapter[70])
            }

    return converted

def convert_challenge_dungeon_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "clearRewardId": int(quest[4]),
                "scoreRewardGroup": int(quest[71]),
                "sPlusRewardId": 1,
                "bRankTime": floor(float(quest[85]) * 1000),
                "aRankTime": floor(float(quest[86]) * 1000),
                "sRankTime": floor(float(quest[87]) * 1000),
                "sPlusRankTime":  floor(float(quest[88]) * 1000),
                "rankPointReward": int(quest[92]),
                "characterExpReward": int(quest[93]),
                "manaReward": int(quest[94]),
                "poolExpReward": int(quest[95])
            }
    return converted 

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
                    "sPlusRewardId": 1,
                    "bRankTime": floor(float(quest[86]) * 1000),
                    "aRankTime": floor(float(quest[87]) * 1000),
                    "sRankTime": floor(float(quest[88]) * 1000),
                    "sPlusRankTime":  floor(float(quest[89]) * 1000),
                    "rankPointReward": int(quest[94]),
                    "characterExpReward": int(quest[95]),
                    "manaReward": int(quest[96]),
                    "poolExpReward": int(quest[97])
                }
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
    return converted 

def convert_solo_time_attack_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "scoreRewardGroup": int(quest[71]),
                "sPlusRewardId": 1,
                "bRankTime": floor(float(quest[51]) * 1000),
                "aRankTime": floor(float(quest[52]) * 1000),
                "sRankTime": floor(float(quest[53]) * 1000),
                "sPlusRankTime":  floor(float(quest[54]) * 1000),
                "rankPointReward": int(quest[85]),
                "characterExpReward": int(quest[86]),
                "manaReward": int(quest[87]),
                "poolExpReward": int(quest[88])
            }
    return converted 

def convert_tower_dungeon_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "scoreRewardGroup": int(quest[69]),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": int(quest[82]),
                "characterExpReward": int(quest[83]),
                "manaReward": int(quest[84]),
                "poolExpReward": int(quest[85])
            }
    return converted 

def convert_expert_single_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "clearRewardId": int(quest[6]),
                "scoreRewardGroup": int(quest[73]),
                "sPlusRewardId": 1,
                "bRankTime": floor(float(quest[87]) * 1000),
                "aRankTime": floor(float(quest[88]) * 1000),
                "sRankTime": floor(float(quest[89]) * 1000),
                "sPlusRankTime":  floor(float(quest[90]) * 1000),
                "rankPointReward": int(quest[96]),
                "characterExpReward": int(quest[97]),
                "manaReward": int(quest[98]),
                "poolExpReward": int(quest[99])
            }
    return converted 

def convert_carnival_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "clearRewardId": int(quest[6]),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": int(quest[94]),
                "characterExpReward": int(quest[95]),
                "manaReward": int(quest[96]),
                "poolExpReward": int(quest[97])
            }
    return converted 

def convert_raid_event_quest(obj):
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            converted[quest[0]] = {
                "name": "",
                "clearRewardId": int(quest[5]),
                "scoreRewardGroup": int(quest[68]),
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": int(quest[81]),
                "characterExpReward": int(quest[82]),
                "manaReward": int(quest[83]),
                "poolExpReward": int(quest[84])
            }
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
    return converted 

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
                    "endDate": gacha_data[30]
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
                    "endDate": gacha_data[30]
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
        }

        if (item[7]) != "(None)":
            converted_item['userCost'] = {
                "type": int(item[7]),
                "amount": int(item[8])
            }

        converted[item_id] = converted_item

    return converted

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

# player/player_rank_iosbundled (ranks 1-100) and player/player_rank (101-250): row = max stamina, total rank points
# needed, ?. Written as one list, the rank points each rank needs (index 0 = rank 1).
def convert_player_rank(bundled, later):
    rows = {**bundled, **later}
    return [int(rows[str(rank)][1]) for rank in range(1, len(rows) + 1)]

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
    "needMissionId": 18, "needMissionStage": 19, "startDate": 20, "endDate": 21, "repeat": 25,
    "target": 1, "clearSeconds": 2, "rewards": (5, 11, 17, 23)
}
ACTIVE_MISSION_COLUMNS = {
    "pattern": 24, "statistics": 25, "statisticsMaxValue": 26, "battleKind": 27, "clientCheck": 28, "questKind": 29,
    "questIds": (30, 31, 32), "questRankId": 35, "itemId": 36, "equipmentId": 37, "characterId": 38, "missionIds": 50,
    # the row's `need` (mission and stage); columns 59-60 (need_mission_id) are empty in every row
    "needMissionId": 51, "needMissionStage": 52, "startDate": 55, "endDate": 56, "repeat": 62,
    "target": 3, "rewards": (7, 13, 19, 25)
}

# degree (title) missions: the regular layout one column further right (column 0 is a display category)
DEGREE_MISSION_COLUMNS = {
    **{key: (tuple(column + 1 for column in value) if isinstance(value, tuple) else value + 1)
       for key, value in MISSION_COLUMNS.items() if key not in ("target", "clearSeconds", "rewards")},
    "target": 1, "clearSeconds": 2, "rewards": (5, 11, 17, 23)
}

def convert_missions(missions, rewards, columns=MISSION_COLUMNS):
    converted = {}
    for mission_id, row in missions.items():
        mission = {"pattern": int(row[columns["pattern"]])}
        optional = {key: mission_int(row[columns[key]]) for key in (
            "statistics", "statisticsMaxValue", "battleKind", "questKind", "questRankId", "itemId", "characterId",
            "needMissionId", "needMissionStage")}
        # the active missions' equipment column is a list; every row names at most one
        optional["equipmentId"] = next(iter(mission_ints(row[columns["equipmentId"]])), None)
        for key in ("startDate", "endDate"):
            optional[key] = None if row[columns[key]] in ("", "(None)") else row[columns[key]]
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
    """The exp each unit level starts at (index 0 is level 1). The table has one copy per level group (1 and 2);
    both are the same."""
    levels = next(iter(obj.values()))
    return [int(levels[level][0]) for level in sorted(levels, key=int)]

def save_json(obj, file_path):
    with open(file_path, 'w', encoding='utf8') as file:
        json.dump(obj, file, indent=4, ensure_ascii=False)

# define the files to convert
to_convert_files = {
    "main_quest": convert_main_ex_quests, 
    "ex_quest": convert_main_ex_quests, 
    "boss_battle_quest": convert_boss_quests,
    "character_quest": convert_character_quests,
    "clear_reward": convert_clear_rewards,
    "score_reward": convert_score_reward,
    "character": convert_characters,
    "rare_score_reward": convert_rare_score_reward,
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
    "story_event_single_quest": convert_story_event_single_quest,
    "ranking_event_single_quest": convert_ranking_event_single_quest,
    "solo_time_attack_event_quest": convert_solo_time_attack_event_quest,
    "tower_dungeon_event_quest": convert_tower_dungeon_event_quest,
    "expert_single_event_quest": convert_expert_single_event_quest,
    "carnival_event_quest": convert_carnival_event_quest,
    "rush_event_quest": convert_rush_event_quest,
    "raid_event_quest": convert_raid_event_quest,
    "score_attack_event_quest": convert_score_attack_event_quest,
    "box_reward": convert_box_rewards,
    "box_gacha": convert_box_gacha,
    "gacha": convert_gacha,
    "gacha_campaign": convert_gacha_campaigns,
    "general_shop": convert_general_shop,
    "boss_coin_shop": convert_boss_coin_shop,
    "event_item_shop": convert_event_item_shop,
    "treasure_shop": convert_treasure_shop,
    "star_grain_shop": convert_star_grain_shop,
    "encyclopedia": convert_encyclopedia,
    "rush_event_quest_folder": convert_rush_event_quest_folder,
    "multi_special_exchange_campaign": convert_multi_special_exchange_campaigns,
    "multi_special_exchange_campaign_character": convert_multi_special_exchange_campaign_characters
}

# tables merged into one output
player_rank_bundled = parse_file(os.path.join(FILE_INPUT, "player_rank_iosbundled.json"))
player_rank_later = parse_file(os.path.join(FILE_INPUT, "player_rank.json"))
if player_rank_bundled is None or player_rank_later is None:
    print("player_rank_iosbundled.json or player_rank.json not found inside the '/in' folder. Skipping...")
else:
    save_json(convert_player_rank(player_rank_bundled, player_rank_later), os.path.join(FILE_OUTPUT, "player_rank.json"))

# missions by category (the client's mission_category: 1 regular, 2 daily, 3 event, 5 degree), each with its reward table
mission_categories = {"1": "regular_mission", "2": "daily_mission", "3": "event_mission", "5": "degree_mission"}
mission_tables = {name: (parse_file(os.path.join(FILE_INPUT, f"{name}.json")), parse_file(os.path.join(FILE_INPUT, f"{name}_reward.json")))
                  for name in mission_categories.values()}
if any(table is None for tables in mission_tables.values() for table in tables):
    print("A mission table (regular_mission, daily_mission, event_mission, degree_mission and their _reward tables) is missing from the '/in' folder. Skipping missions...")
else:
    save_json({category: convert_missions(*mission_tables[name], DEGREE_MISSION_COLUMNS if name == "degree_mission" else MISSION_COLUMNS)
               for category, name in mission_categories.items()}, os.path.join(FILE_OUTPUT, "mission.json"))

# titles: the ids the game has (`degree/degree`), for checking the ones players set or are sent
degrees = parse_file(os.path.join(FILE_INPUT, "degree.json"))
if degrees is None:
    print("degree.json not found inside the '/in' folder. Skipping titles...")
else:
    save_json(sorted(int(degree_id) for degree_id in degrees), os.path.join(FILE_OUTPUT, "degree.json"))

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
