// first: the run profile fills in settings the modules below read when they load
import "./profileDefaults";
import { unlinkSync } from "node:fs";
// then the data pack, checked before any module reads game data
import "./dataPackStartup";
import { createWriteStream, mkdirSync } from "fs";
import { flushCompileCache } from "module";
import path from "path";
import { Writable } from "stream";
import { buildAdminServer, buildServer } from "./app";
import { getOpenGachaIdsSync } from "./lib/assets";
import { getServerDate } from "./utils";
import { adminAuthFromEnv } from "./lib/adminAuth";
import { countAdminsSync } from "./data/users";
import { adminRateLimitFromEnv, gameRateLimitFromEnv, isLoopbackHost, trustProxyFromEnv } from "./lib/rateLimit";
import { CoopSocketServer, coopSocketPort, setCoopSocketServer } from "./lib/coop/socketServer";
import { closeRoom } from "./lib/coop/closeRoom";
import { checkMateAgainstSave } from "./lib/coop/mateCheck";
import { decideLoungeTicketsSync } from "./lib/multiSpecialExchange";
import { sessionCleanupIntervalFromEnv, startSessionCleanup } from "./lib/sessionCleanup";
import { getSetting } from "./data/serverSettings";
import { Metrics } from "./lib/metrics";
import { publishDueNews } from "./lib/newsAuto";
import { closeDatabases } from "./data";
import { isLocalProfile } from "./lib/serverProfile";

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
const metrics = new Metrics()
const fastify = buildServer({ metrics, logger, rateLimit: gameRateLimitFromEnv(), trustProxy: trustProxyFromEnv() })

// listen
const listenHost = process.env.LISTEN_HOST ?? "localhost"
// SEC-16: a reverse proxy on another address needs TRUST_PROXY, or every player shares its address (one rate-limit bucket)
if (!isLoopbackHost(listenHost) && (process.env.TRUST_PROXY ?? "").trim() === "")
    console.warn(`The game listener is on ${listenHost} and TRUST_PROXY is unset. Behind a reverse proxy, set TRUST_PROXY to its address, or every player shares the proxy's rate limits (docs/hardening.md). Players connecting directly need nothing.`)

const envListenPort = process.env.LISTEN_PORT === undefined ? 8000 : Number.parseInt(process.env.LISTEN_PORT)
const listenPort = isNaN(envListenPort) ? 8000 : envListenPort
// SH-13: the server on the phone listens on a Unix socket in the app's private storage instead of a TCP port, which
// any app on the phone could take while the server is down (security review 2026-11-13); the app's own process holds
// the game's port 8000 and passes connections here. A socket file left by a killed process would block the bind.
const listenSocket = process.env.LISTEN_SOCKET?.trim() || null
if (listenSocket !== null) { try { unlinkSync(listenSocket) } catch { /* none left */ } }
fastify.listen(listenSocket !== null ? { path: listenSocket } : { port: listenPort, host: listenHost }, (err, address) => {
    if (err) {
        console.error(err)
        fastify.log.error(err)
        process.exit(1)
    }
    console.log(listenSocket !== null ? `Reflipped is listening on ${listenSocket}` : `Reflipped is listening on http://${listenHost}:${listenPort}`)
    // Node writes its compile cache (NODE_COMPILE_CACHE, set by the app's launcher) at exit, but the server on the
    // phone never exits: Android ends its process. Write it once the code has loaded.
    if (process.env.NODE_COMPILE_CACHE) setTimeout(() => { try { flushCompileCache() } catch { /* only a cache */ } }, 1000).unref()
    if (getOpenGachaIdsSync(getServerDate()).length === 0)
        console.warn("Warning: no summoning portal is open at the server's clock (SERVER_TIME), so the game fails to load it and new players cannot finish the tutorial")
    // the automatic event posts (ADM-4): published when due, also if nobody opens the news page
    const publishNews = () => { try { publishDueNews() } catch (error) { fastify.log.error({ err: error }, "automatic news posts failed") } }
    publishNews()
    setInterval(publishNews, 5 * 60 * 1000).unref()
})

// admin UI and /api/*: its own listener, on localhost by default, behind the admin login (ACC-5) unless
// ADMIN_AUTH=off. ADMIN_PORT=0 disables it.
const adminHost = process.env.ADMIN_HOST || "127.0.0.1"
const envAdminPort = process.env.ADMIN_PORT === undefined ? 8001 : Number.parseInt(process.env.ADMIN_PORT)
const adminPort = isNaN(envAdminPort) ? 8001 : envAdminPort
if (adminPort !== 0) {
    if (adminPort === listenPort) {
        console.error(`ADMIN_PORT must differ from LISTEN_PORT (${listenPort}); the admin UI is not started`)
    } else {
        if (!adminAuthFromEnv())
            console.warn(`Warning: ADMIN_AUTH=off: the admin UI needs no login${["0.0.0.0", "::", "*"].includes(adminHost) ? `, and ADMIN_HOST=${adminHost} opens it on every interface` : ""}`)
        else if (countAdminsSync() === 0)
            console.log(`The admin UI has no admin yet: open http://localhost:${adminPort}/setup on this machine to create one`)
        const admin = buildAdminServer({ metrics, logger, rateLimit: adminRateLimitFromEnv() })
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

// SH-13: the app stops the server on the phone with SIGTERM (the game away for a while, the app swiped away). Stop
// taking requests, let the ones running finish, close the database (SQLite checkpoints its WAL) and exit; the app ends
// the process itself after 5 s.
if (isLocalProfile()) {
    process.once("SIGTERM", () => {
        console.log("Reflipped is stopping (SIGTERM)")
        const exit = () => { closeDatabases(); process.exit(0) }
        setTimeout(exit, 3000).unref()
        fastify.close().then(exit, exit)
    })
}

// expired zat/zrt rows (SEC-8), link codes (ACC-1) and portal sessions (ACC-2); SESSION_CLEANUP_INTERVAL_MS=0 disables it
startSessionCleanup(sessionCleanupIntervalFromEnv())

// co-op realtime socket (docs/coop-research.md); COOP_SOCKET_PORT=0 disables it
if (process.env.COOP_SOCKET_PORT !== "0") {
    const coopPort = coopSocketPort()
    // the lobby keepalive follows the admin's Settings page
    const coopServer = new CoopSocketServer({
        keepAliveMs: () => getSetting("coop.lobby_keepalive_seconds") * 1000,
        abandonedRoomMs: () => getSetting("coop.abandoned_room_seconds") * 1000,
        resumeGraceMs: () => getSetting("coop.lobby_resume_grace_seconds") * 1000,
        startCountdownSeconds: () => getSetting("coop.start_countdown_seconds"),
        battleStartWaitMs: () => getSetting("coop.battle_start_timeout_seconds") * 1000,
        onExpire: closeRoom,
        // lobby mates as the players' saves have them (SEC-15)
        checkMate: checkMateAgainstSave,
        // the exchange lounge's Go decides every member's ticket (CO-3)
        onLoungeStart: (lounge, members) => decideLoungeTicketsSync(lounge.campaignId, members.map(member => member.playerId), getServerDate())
    })
    setCoopSocketServer(coopServer)
    // its own address when the game listener stays on loopback behind a proxy (the systemd unit): players reach the
    // co-op socket directly
    const coopHost = process.env.COOP_SOCKET_HOST?.trim() || listenHost
    coopServer.listen(coopPort, coopHost)
        .then(port => console.log(`Reflipped co-op socket is listening on ${coopHost}:${port}`))
        .catch(error => console.error(`Co-op socket failed to start on port ${coopPort}:`, error))
}
