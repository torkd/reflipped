import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SessionType } from "../data/types";
import { accountHasDeviceSecretHashSync, deleteAccountSessionsOfType, getAccountsFromDeviceSecretHashSync, getSession, insertAccount, insertSession, revokeAccountSessionsSync, setAccountDeviceSecretHashSync, updateAccount, ZAT_TTL_MS, ZRT_TTL_MS } from "../data/wdfpData";
import { deviceSecretFromBody, generatePublicIdpId, hashDeviceSecret } from "../lib/deviceSecret";
import { generateIdpAlias } from "../utils";
import { ignoredBody, jsonBody, string, stringOrInteger } from "./schemas";

// SEC-6: the fields the handlers read; the Kakao SDK and the AIR shell send many more, which are allowed.
// Requiring a field here only moves the handler's own "Invalid request body." 400 earlier.
const zatLoginSchema = jsonBody({ zat: string, playerId: stringOrInteger, whiteKey: string, deviceId: string, lang: string }, ["zat"])
const loginAgreementSchema = jsonBody({ appId: string, country: string, idpCode: string, lang: string })
const loginDeviceSchema = jsonBody({ appId: string, deviceId: string, serialNo: string, whiteKey: string }, ["appId", "deviceId", "serialNo"])

interface CreateDeviceAccessTokenBody {
    adid: string
    appVer: string
    deviceId: string
    market: string
    os: string
    previousDeviceId: string
    previousSerialNo: string
    sdkVer: string
    serialNo: string
}

interface ZatLoginBody {
    adid: string
    appId: string
    appSecret: string
    appVer: string
    clientTime: number
    country: string
    deviceId: string
    deviceModel: string
    fields: string[]
    gsiToken: boolean
    lang: string
    loginType: string
    market: string
    network: string
    os: string
    playerId: string
    resume: boolean
    retryNo: number
    sdkVer: string
    telecom: string
    timezoneOffset: number
    usimCountry: string
    whiteKey: string
    zat: string
}

interface AndroidZatLoginBody extends ZatLoginBody {
    androidId: string
}

interface PushTokenRegisterBody {
    appId: string
    country: string
    deviceId: string
    lang: string
    market: string
    os: string
    playerId: string
    pushToken: string
    timezoneOffset: number
}

interface LoginAgreementBody {
    appId: string
    country: string
    deviceId: string
    idpCode: string
    idpId: string
    lang: string
    os: string
    serialNo: string
}

interface PlayerHeartbeatBody {
    appId: string
    clientTime: number
    country: string
    heartbeatIntervals: number
    market: string
    os: string
    playerId: string
    seq: number
}

interface AuthLoginDeviceBody {
    accessToken: string
    adid: string
    appId: string
    appSecret: string
    appVer: string
    clientTime: number
    country: string
    deviceAppKey: string
    deviceId: string
    deviceModel: string
    fields: string[]
    gsiToken: boolean
    idpId: string
    lang: string
    loginType: string
    market: string
    network: string
    os: string
    osVer: string
    referrer: string
    resume: boolean
    retryNo: string
    sdkVer: string
    serialNo: string
    telecom: string
    timezoneOffset: number
    usimCountry: string
    whiteKey: string
}

interface AndroidAuthLoginDeviceBody extends AuthLoginDeviceBody {
    androidId: string
}

const routes = async (fastify: FastifyInstance) => {

    fastify.post("/v3/util/country/get", { schema: ignoredBody }, (_, reply: FastifyReply) => {
        reply.status(200).send({ 
            "country": "en"
        })
    })

    fastify.post("/v4/device/accessToken/create", { schema: ignoredBody }, (_, reply: FastifyReply) => {
        //const body = request.body as CreateDeviceAccessTokenBody
        
        reply.status(200).send({
            "accessToken": "fwPla7fQ8ty9+DZT/lD//uWZD4uD6C4lD6gGIIZTLKRTQ52/SLCRmk/370jcWGs+e+1iSoZtL7lj8ov9B0/jHmijH4nsHPQT6pchaQM1M9mtwYNQq0BWhVr9hF0jjCK/a5LIVd1kBac/Gemv29WKEDKSrUS9HxxUigoPRwtOy8m+oDj9FmDJZ+rzqWCc0QjES4Ky0fTpXZ7ESoguDzNmRtW3FYr+OFexw8wBPlwiC4w=",
            "expiryTime": new Date().getTime() + 4600000
        })
    })

    fastify.post("/v3/zat/login", { schema: zatLoginSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ZatLoginBody

        const clientZat = body.zat
        if (!clientZat) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        let session = await getSession(clientZat)
        if (session === null) {
            // The zat expired or was revoked: let the device back in only if it proves it owns the account with
            // its device secret (SEC-5). playerId and deviceId alone are public.
            const accountId = Number.parseInt(body.playerId)
            const secret = deviceSecretFromBody(body)
            if (!isNaN(accountId) && secret !== null && accountHasDeviceSecretHashSync(accountId, hashDeviceSecret(secret))) {
                session = await insertSession({
                    expires: new Date(Date.now() + ZAT_TTL_MS),
                    accountId: accountId,
                    type: SessionType.ZAT
                })
            }
        }
        if (session === null || session.type !== SessionType.ZAT) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid zat provided."
        })
        
        // get the Account assigned to the session
        const account = await updateAccount({
            id: session.accountId,
            lastLoginTime: new Date()
        })
        .catch(err => {
            request.log.error({ err }, "zat login: account update failed")
            reply.status(500).send({
                "error": "Internal Server Error",
                "message": "No account assigned to session."
            })
            return null
        })
        if (!account) return

        // rotate: the presented zat (and any other zat of the account) stops working
        await deleteAccountSessionsOfType(account.id, SessionType.ZAT)

        const newSession = await insertSession({
            expires: new Date(Date.now() + ZAT_TTL_MS),
            accountId: account.id,
            type: SessionType.ZAT
        })

        reply.status(200).send({
            "externalToken": "",
            "firstLogin": false,
            "player": {
                "agreement": {
                    "E001": "y",
                    "E002": "y",
                    "E006": "y",
                    "N002": "n",
                    "N003": "n",
                    "timestamp": "1717623430484"
                },
                "appId": account.appId,
                "firstLoginTime": account.firstLoginTime.getTime(),
                "idpAlias": account.idpAlias,
                "idpCode": account.idpCode,
                "idpId": account.idpId,
                "lang": body.lang,
                "lastLoginTime": account.lastLoginTime.getTime(),
                "playerId": account.id.toString(),
                "pushOption": {
                    "night": "n",
                    "player": "n"
                },
                "regTime": account.regTime.getTime(),
                "status": account.status
            },
            "zat": newSession.token,
            "zatExpiryTime": newSession.expires.getTime()
        })
    })

    fastify.post("/v3/push/token/register", { schema: ignoredBody }, (_, reply: FastifyReply) => {
        //const body = request.body as PushTokenRegisterBody
        reply.status(200).send({})
    })

    /**
     * Tells the client the status of the user's policy agreements.
     */
    fastify.post("/v3/agreement/getForLogin", { schema: loginAgreementSchema }, (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as LoginAgreementBody
        
        // We want to skip any policy screens, so we just send data to the client indicating prior completion.
        reply.status(200).send({
            "adAgreementStatus": "n",
            "agreement": {
                "E001": "y",
                "E002": "y",
                "E006": "y",
                "N002": "n",
                "N003": "n",
                "timestamp": (new Date().getTime() * 1000).toString()
            },
            "agreementPopup": "n",
            "appId": body.appId,
            "appName": "World Flipper (NA)",
            "context": "login",
            "country": body.country,
            "firstAgreement": "n",
            "idpCode": body.idpCode,
            "idpId": "6076008646",
            "informationSecurityCountry": "kr",
            "kakaoSyncAgreementGetSet": "n",
            "kakaoSyncStatus": "off",
            "kakaogameSdkVer": "3.0",
            "lang": body.lang,
            "partnerId": 825,
            "partnerName": "주식회사 카카오게임즈",
            "plusFriendStatusInfo": null,
            "policyApplyTime": 1630854000000
        })
    })

    fastify.post("/v3/player/heartbeat", { schema: ignoredBody }, (_, reply: FastifyReply) => {
        //const body = request.body as PlayerHeartbeatBody
        reply.status(200).send({})
    })

    fastify.post("/v4/auth/loginDevice", { schema: loginDeviceSchema }, async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as AuthLoginDeviceBody

        // validate body
        const appId = body.appId
        const deviceId = body.deviceId
        const serialNo = body.serialNo
        if (!appId || !deviceId || !serialNo) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        // SEC-5: the device secret (whiteKey) is what identifies the device's account. The playerid header the
        // client sends on later logins never selects an account: it only breaks ties between accounts the secret
        // already proves (duplicates from before SEC-5).
        const secret = deviceSecretFromBody(body)
        if (secret === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })
        const secretHash = hashDeviceSecret(secret)

        const rawAccountId = request.headers['playerid']
        const headerAccountId = typeof rawAccountId === "string" ? Number.parseInt(rawAccountId) : NaN

        const idpAlias = generateIdpAlias(appId, deviceId, serialNo)

        const matches = getAccountsFromDeviceSecretHashSync(secretHash)
        const existingAccount = matches.find(match => match.id === headerAccountId) ?? matches[0] ?? null
        if (!isNaN(headerAccountId) && existingAccount?.id !== headerAccountId)
            request.log.info({ playerId: headerAccountId, accountId: existingAccount?.id ?? null }, "loginDevice: playerid header does not match the device secret; ignored")

        // an unknown device gets a new account
        const account = existingAccount ?? await insertAccount({
            appId: body.appId,
            idpAlias: idpAlias,
            idpCode: "zd3",
            idpId: generatePublicIdpId(),
            status: "normal",
        })
        if (existingAccount === null) setAccountDeviceSecretHashSync(account.id, secretHash)

        // SEC-8: rotate the openapi tokens; earlier zat/zrt of the account stop working
        revokeAccountSessionsSync(account.id)

        if (account.idpAlias !== idpAlias) {
            await updateAccount({
                id: account.id,
                idpAlias: idpAlias
            })
        }

        const zatToken = await insertSession({
            expires: new Date(Date.now() + ZAT_TTL_MS),
            accountId: account.id,
            type: SessionType.ZAT
        })
        const zrtToken = await insertSession({
            expires: new Date(Date.now() + ZRT_TTL_MS),
            accountId: account.id,
            type: SessionType.ZRT
        })

        reply.status(200).send({
            "externalToken": "",
            "firstLogin": true,
            "player": {
                "appId": account.appId,
                "firstLoginTime": account.firstLoginTime.getTime(),
                "idpAlias": idpAlias,
                "idpCode": account.idpCode,
                "idpId": account.idpId,
                "playerId": account.id.toString(),
                "pushOption": {
                    "night": "n",
                    "player": "n"
                },
                "regTime": account.regTime.getTime(),
                "status": account.status
            },
            "zat": zatToken.token,
            "zatExpiryTime": zatToken.expires.getTime(),
            "zrt": zrtToken.token,
            "zrtExpiryTime": zrtToken.expires.getTime()
        })
    })

}

export default routes;