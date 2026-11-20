// Admin site login sessions (ACC-5, docs/accounts.md "Admin login"): like the portal's (src/data/portalSessions.ts),
// in their own table and shorter, since the admin site can change every player's save.
import { LoginSessionStore } from "./portalSessions";

/** How long an admin session lasts without use; each use slides it forward. */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export const adminSessions = new LoginSessionStore("admin_sessions", ADMIN_SESSION_TTL_MS)
