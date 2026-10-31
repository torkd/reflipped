import { stopRecruiting } from "./recruitment"
import { deleteRoom } from "./rooms"
import { coopSocketServer } from "./socketServer"

/**
 * Closes a co-op room for good: anyone still in its lobby is told it was disbanded, its recruiting stops, and it leaves
 * the registry. Used by `disband_room` (the host's game) and by the socket server for a room its host abandoned.
 */
export function closeRoom(roomNumber: string): void {
    coopSocketServer?.disband(roomNumber)
    stopRecruiting(roomNumber)
    deleteRoom(roomNumber)
}
