import { createWriteStream, mkdirSync } from "fs";
import path from "path";
import { Writable } from "stream";
import { buildAdminServer, buildServer } from "./app";
import { getOpenGachaIdsSync } from "./lib/assets";
import { getServerDate } from "./utils";
import { adminRateLimitFromEnv, gameRateLimitFromEnv, trustProxyFromEnv } from "./lib/rateLimit";
import { CoopSocketServer, coopSocketPort, setCoopSocketServer } from "./lib/coop/socketServer";
import { closeRoom } from "./lib/coop/closeRoom";
import { checkMateAgainstSave } from "./lib/coop/mateCheck";
import { sessionCleanupIntervalFromEnv, startSessionCleanup } from "./lib/sessionCleanup";
import { getSetting } from "./data/serverSettings";

// Request log: one line of JSON per request (method, url, status code, time) plus errors with stack traces.
// Bodies and headers are not logged. It goes to the console and to LOG_FILE (set it empty to skip the file),
// so a failing route can be found afterwards. LOG_LEVEL=silent turns it off.
const logLevel = process.env.LOG_LEVEL ?? "info"
const logFile = process.env.LOG_FILE ?? ".logs/reflipped.log"

const logStreams: Writable[] = [process.stdout]
if (logFile !== "") {
    mkdirSync(path.dirname(logFile), { recursive: true })
    logStreams.push(createWriteStream(logFile, { flags: "a" }))
}
const logStream = new Writable({
    write(chunk, _encoding, callback) {
        for (const stream of logStreams) stream.write(chunk)
        callback()
    }
})

const logger = logLevel === "silent" ? false : { level: logLevel, stream: logStream }
const fastify = buildServer({ logger, rateLimit: gameRateLimitFromEnv(), trustProxy: trustProxyFromEnv() })

// listen
const listenHost = process.env.LISTEN_HOST ?? "localhost"

const envListenPort = process.env.LISTEN_PORT === undefined ? 8000 : Number.parseInt(process.env.LISTEN_PORT)
const listenPort = isNaN(envListenPort) ? 8000 : envListenPort
fastify.listen({ port: listenPort, host: listenHost }, (err, address) => {
    if (err) {
        console.error(err)
        fastify.log.error(err)
        process.exit(1)
    }
    console.log(`Reflipped is listening on http://${listenHost}:${listenPort}`)
    if (getOpenGachaIdsSync(getServerDate()).length === 0)
        console.warn("Warning: no summoning portal is open at the server's clock (SERVER_TIME), so the game fails to load it and new players cannot finish the tutorial")
})

// admin UI and /api/*: no login yet, so it gets its own listener on localhost (or a VPN address) only.
// ADMIN_PORT=0 disables it.
const adminHost = process.env.ADMIN_HOST || "127.0.0.1"
const envAdminPort = process.env.ADMIN_PORT === undefined ? 8001 : Number.parseInt(process.env.ADMIN_PORT)
const adminPort = isNaN(envAdminPort) ? 8001 : envAdminPort
if (adminPort !== 0) {
    if (adminPort === listenPort) {
        console.error(`ADMIN_PORT must differ from LISTEN_PORT (${listenPort}); the admin UI is not started`)
    } else {
        if (["0.0.0.0", "::", "*"].includes(adminHost))
            console.warn(`Warning: ADMIN_HOST=${adminHost} exposes the admin UI, which has no login, on every interface`)
        const admin = buildAdminServer({ logger, rateLimit: adminRateLimitFromEnv() })
        admin.listen({ port: adminPort, host: adminHost }, (err) => {
            if (err) {
                console.error(err)
                admin.log.error(err)
                process.exit(1)
            }
            console.log(`Reflipped admin UI is listening on http://${adminHost}:${adminPort}`)
        })
    }
}

// expired zat/zrt rows (SEC-8); SESSION_CLEANUP_INTERVAL_MS=0 disables it
startSessionCleanup(sessionCleanupIntervalFromEnv())

// co-op realtime socket (docs/coop-research.md); COOP_SOCKET_PORT=0 disables it
if (process.env.COOP_SOCKET_PORT !== "0") {
    const coopPort = coopSocketPort()
    // the lobby keepalive follows the admin's Settings page
    const coopServer = new CoopSocketServer({
        keepAliveMs: () => getSetting("coop.lobby_keepalive_seconds") * 1000,
        abandonedRoomMs: () => getSetting("coop.abandoned_room_seconds") * 1000,
        onExpire: closeRoom,
        // lobby mates as the players' saves have them (SEC-15)
        checkMate: checkMateAgainstSave
    })
    setCoopSocketServer(coopServer)
    coopServer.listen(coopPort, listenHost)
        .then(port => console.log(`Reflipped co-op socket is listening on ${listenHost}:${port}`))
        .catch(error => console.error(`Co-op socket failed to start on port ${coopPort}:`, error))
}
