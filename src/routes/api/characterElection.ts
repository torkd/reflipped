// The unit poll ("WF Unit Poll", `character_election/character_election`, FT-2): one vote per election and player,
// during the election's period (result code 11003 outside it, InvalidPeriod). A vote counts for the "vote in the
// poll" missions (pattern 65). The server keeps the votes but publishes no results: the poll's results were news.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import elections from "../../../assets/character_election.json";
import { getPlayerCharacterElectionVoteSync, insertPlayerCharacterElectionVoteSync } from "../../data/wdfpData";
import { atomicHandler } from "../../lib/atomic";
import { isContentPeriodOpen } from "../../lib/eventSchedule";
import { MissionPattern, missionReplyFields, updateMissionsSync } from "../../lib/missions";
import { generateDataHeaders, getServerDate, masterDate } from "../../utils";
import { gameBody, integer } from "../schemas";

/** The client's result code for a vote outside the election's period. */
export const CHARACTER_ELECTION_INVALID_PERIOD = 11003

const electionPeriods = elections as Record<string, { start: string, end: string }>

/** Whether an election takes votes at a date (projected like every event's period when event scheduling is on). */
export function isElectionOpen(electionId: number, date: Date): boolean {
    const election = electionPeriods[String(electionId)]
    return election !== undefined && isContentPeriodOpen(masterDate(election.start).getTime(), masterDate(election.end).getTime(), date)
}

const statusSchema = gameBody({ election_id: integer }, ["election_id"])
const voteSchema = gameBody({ election_id: integer, keyword_id: integer }, ["election_id", "keyword_id"])

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_vote_status", { schema: statusSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { election_id: number }
        const viewerId = request.viewer.viewerId
        reply.header("content-type", "application/x-msgpack")
        if (!isElectionOpen(body.election_id, getServerDate())) return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: CHARACTER_ELECTION_INVALID_PERIOD }),
            "data": []
        })
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": { "is_voted": getPlayerCharacterElectionVoteSync(request.viewer.playerId, body.election_id) !== null }
        })
    })

    fastify.post("/vote", { schema: voteSchema }, atomicHandler((request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { election_id: number, keyword_id: number }
        const viewerId = request.viewer.viewerId
        const playerId = request.viewer.playerId
        const now = getServerDate()
        reply.header("content-type", "application/x-msgpack")
        if (!isElectionOpen(body.election_id, now)) return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId, result_code: CHARACTER_ELECTION_INVALID_PERIOD }),
            "data": []
        })
        // the client asks get_vote_status first and shows "You've already voted"
        if (getPlayerCharacterElectionVoteSync(playerId, body.election_id) !== null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Already voted."
        })

        insertPlayerCharacterElectionVoteSync(playerId, body.election_id, body.keyword_id)
        const missions = updateMissionsSync(playerId, now, [{ pattern: MissionPattern.CHARACTER_ELECTION_VOTE_COUNT, amount: 1 }])
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": missionReplyFields(missions)
        })
    }))
}

export default routes;
