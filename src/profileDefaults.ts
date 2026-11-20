// The run profile's defaults (src/lib/serverProfile.ts). Its own module so src/server.ts can import it before anything
// else: imports run in order, and the modules after it read their settings when they load.
import { applyProfileDefaults, serverProfile } from "./lib/serverProfile";

const applied = applyProfileDefaults()
if (serverProfile() === "local")
    console.log(`Reflipped runs with the local profile${applied.length > 0 ? ` (defaults for ${applied.join(", ")})` : ""}`)
