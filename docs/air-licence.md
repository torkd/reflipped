# The AIR SDK licence

The flipper game runs on Adobe AIR, so building the Reflipped app needs the **AIR SDK**, a toolkit now published by Wipro (before 2026, by HARMAN). This page explains what its licence means for you as a player. It is our reading of public sources (checked on 2026-10-28), not legal advice.

**In short: you can build and play the app with the free version of the AIR SDK**, as long as you download it yourself, accept its licence yourself, and leave the AIR logo at startup in place.

## How Reflipped uses it
- **You download the SDK yourself**, from <https://airsdk.wxlift.com>, and accept its licence there. That makes you the licensee for your own build.
- **Reflipped never downloads, copies or ships the SDK.** Its setup script only unpacks the files you downloaded, and the build container contains no SDK either: you put your own copy in the folder you give it.
- **Reflipped hands out no apps.** Everyone builds their own app from their own copy of the game.

## What the free version allows
- **It's free for individuals and small companies.** The limit was a total income under about $50,000 a year when it was last published (2019–2020), and may have changed since; check the current terms on the website. For a hobbyist, the income from a separate job doesn't count. Paid plans exist above that limit.
- **It shows the AIR logo when the app starts.** Only a paid licence removes it. Reflipped keeps it, and you must not remove it.
- **No account, key or time limit** is needed for the free version.
- **Use a stable version**, not a beta: beta versions may not be used for apps given to other people.

## What this means for Reflipped
- Never remove or hide the AIR logo at startup.
- Never download, mirror or bundle the AIR SDK in a script, build server or release.
- The player guides say that each player accepts the licence themselves, and link the current terms.

## Not checked
The licence agreement itself couldn't be read for this summary (the website needs a full browser). If the terms matter to you, read them on <https://airsdk.wxlift.com>, especially:
1. the current income limit for the free version and the rules about the AIR logo;
2. anything about apps you build, and about packaging content made by someone else (the game itself);
3. whether the SDK needs to contact Wipro to check your licence;
4. whether anything changed when the SDK moved from HARMAN to Wipro.

The rights to the game itself are a separate question from the SDK licence.

## Sources
- HARMAN, "Adobe AIR – Updated Pricing" (2019/2020): https://airsdk.harman.com/assets/pdfs/Adobe%20AIR%20-%20Updated%20Pricing.pdf (may be out of date)
- Later price changes: https://docs.airnativeextensions.com/news/tags/pricing
- The move to Wipro and the startup logo (March 2026): https://github.com/airsdk/Adobe-Runtime-Support/discussions/1699
- Rules on downloading the SDK (2023–2025): https://github.com/airsdk/Adobe-Runtime-Support/discussions/2715
