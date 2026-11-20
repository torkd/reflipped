// What a ticket gift promo of the special exchange campaigns (Dream Armament Exchange Ticket Gift Promo, campaign 12;
// the Scouting Ticket Gift Promos, 13-17) costs when the server's owner makes it paid (src/lib/campaignModes.ts; free,
// as in the original, by default): the server's campaigns (src/lib/specialExchange.ts) and the client's master rows
// (src/lib/scheduleOverlay.ts) both take these. No data layer here: the schedule overlay is built without the database.

/** The bundle prices: the paid seasons' (Dream Unit Scouting Bundle 1,500 beads, Dream Armament Bundle 750). */
export const PROMO_BUNDLE_PRICES = { character: 1500, equipment: 750 } as const
/** The client's bundle names for them, as the paid seasons' rows have them. */
export const PROMO_BUNDLE_NAMES = { character: "Dream Unit Scouting Bundle", equipment: "Dream Armament Bundle" } as const
