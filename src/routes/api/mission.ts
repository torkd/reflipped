// Handles missions (FT-2): the mission screen's progress list and the progress the client counts itself.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders, getServerDate } from "../../utils";
import { arrayOf, gameBody, integer, number, object, string } from "../schemas";
import { atomicHandler } from "../../lib/atomic";
import { clientReportedUpdate, getMissionProgressListSync, grantedDegreeIds, MissionCategory, MissionUpdate, missionReplyFields, updateMissionsSync } from "../../lib/missions";

interface GetMissionProgressBody {
    api_count: number,
    viewer_id: number,
    category_list: {
        category: number
    }[]
}

interface UpdateMissionProgressBody {
    viewer_id: number,
    api_count: number,
    mission_param_list: {
        progress_value: number,
        mission_pattern: string
    }[]
}

const getMissionProgressSchema = gameBody({
    api_count: integer,
    category_list: arrayOf(object({ category: integer }, ["category"]))
}, ["category_list"])

const updateMissionProgressSchema = gameBody({
    api_count: integer,
    mission_param_list: arrayOf(object({ progress_value: number, mission_pattern: string }, ["progress_value", "mission_pattern"]))
}, ["mission_param_list"])

const routes = async (fastify: FastifyInstance) => {
    // The mission screen asks for categories 1 (regular), 2 (daily) and 3 (event); the title screen for 5 (degree).
    fastify.post("/get_mission_progress", { schema: getMissionProgressSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetMissionProgressBody

        const viewerId = request.viewer.viewerId
        const categories = body.category_list.map(entry => entry.category)
        const progress = getMissionProgressListSync(request.viewer.playerId, categories, getServerDate())

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "mission_progress_list": progress.list,
                "mail_arrived": progress.cleared.some(info => info.mission_category_id !== MissionCategory.DEGREE)
            }
        })
    }))

    // Progress the client counts itself (home screen and unit detail actions); any other pattern is ignored.
    fastify.post("/update_mission_progress", { schema: updateMissionProgressSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UpdateMissionProgressBody

        const viewerId = request.viewer.viewerId
        const updates = body.mission_param_list
            .map(param => clientReportedUpdate(param.mission_pattern, param.progress_value))
            .filter((update): update is MissionUpdate => update !== null)
        const missionResult = updateMissionsSync(request.viewer.playerId, getServerDate(), updates)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                ...missionReplyFields(missionResult),
                // the titles the degree missions gave (the client reads them from mission_info and get_degree_list)
                "degree_list": grantedDegreeIds(missionResult).map(degreeId => ({ "viewer_id": viewerId, "degree_id": degreeId }))
            }
        })
    }))
}

export default routes;
