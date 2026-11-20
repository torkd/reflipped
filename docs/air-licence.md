# The AIR SDK licence

The flipper game runs on Adobe AIR, so building the Reflipped app needs the **AIR SDK**, a toolkit now published by Wipro (before 2026, by HARMAN). This page explains what its licence means for you as a player. It is our reading of the licence agreement that comes with the SDK and of public sources (checked on 2026-11-10), not legal advice.

**Using the ready-made app?** You don't need the SDK: this page matters only if you [build the app yourself](building-the-app.md).

**In short: you can build and play the app with the free version of the AIR SDK**, as long as you download it yourself, accept its licence yourself, and leave the AIR logo at startup in place.

## How Reflipped uses it
- **You download the SDK yourself**, from <https://airsdk.wxlift.com>, and accept its licence there. That makes you the licensee for your own build.
- **Reflipped never downloads, copies or ships the SDK.** Its setup script only unpacks the files you downloaded, and the build container contains no SDK either: you put your own copy in the folder you give it. The project's automatic builds of the app run the same way, on a maintainer's own computer with the SDK that maintainer downloaded.
- **The game's files never come with an app the project builds.** You can build your own app from your own copy of the game; the project's ready-made app holds none of the game's files and takes them from your own copy of the game when it first starts.

## What the free version allows
- **It's free for hobbyists and for people and companies with a very low income.** Wipro's FAQ names hobbyists as a group of their own, so building the Reflipped app as a hobby, with no money made from it, fits the free version. The older price sheet (2019–2020) gave only an income limit, a total income under about $50,000 a year; check the current terms on the website. Paid plans exist above that limit.
- **It shows the AIR logo when the app starts.** Only a paid licence removes it. Reflipped keeps it, and you must not remove it.
- **No account, key or time limit** is needed for the free version.
- **Use a stable version**, not a beta: beta versions may not be used for apps given to other people.

## What the licence agreement says
The agreement comes with the SDK, as `AIR SDK license.pdf` in its folder. The copy in SDK 51.5.1 is HARMAN's text of 31 July 2019. The parts that matter for the Reflipped app:
- **Apps you build may contain the AIR runtime**, as long as the SDK's own tools put it there (the build does this) and the SDK isn't a beta.
- **Don't change the AIR runtime or the SDK's tools**, and don't remove HARMAN's or Adobe's notices or the AIR logo.
- **Don't share the SDK itself.** You may install it on your own computers to build apps.
- **If you give your app to other people**, the agreement makes you responsible for it: you need a privacy policy that says what the app does with personal data, with a link to it inside the app, and you answer for claims about the app. Building the app for yourself doesn't raise these points.
- **The SDK's tools send some build information to HARMAN** (operating system, app ID, packaging settings, SDK version and a machine identifier), to check the licence and improve the product. The finished app doesn't send your information to HARMAN.
- **Don't use "Adobe", "AIR" or "HARMAN" in an app's name.** "Works with Adobe AIR" is allowed.
- A newer SDK may come with different terms, so read the agreement in each SDK you download.

## The Reflipped app's own licence
Reflipped's code is licensed under the GNU GPL version 3. The Reflipped app combines our code with the AIR runtime and with the game's own files, which aren't open source, and the GPL alone doesn't allow sharing such a combination. So the app's code (`client/air-shell/`) carries an extra permission that allows it: see [its licence](../client/air-shell/LICENSE.md). The permission only covers our code: whether you may share the AIR runtime or the game's files is still up to their own licences.

## What this means for Reflipped
- Never remove or hide the AIR logo at startup.
- Never download, mirror or bundle the AIR SDK in a script, build server or release. Automatic app builds run only on a computer where a maintainer installed the SDK by hand.
- The player guides say that each player accepts the licence themselves, and link the current terms.

## Not checked
The website's current terms couldn't be read for this summary (the website needs a full browser). If they matter to you, read them on <https://airsdk.wxlift.com>, especially:
1. the current income limit for the free version, and who counts as a hobbyist;
2. whether Wipro has published a newer licence agreement than the one in the SDK;
3. whether anything else changed when the SDK moved from HARMAN to Wipro.

The rights to the game itself are a separate question from the SDK licence.

## Sources
- The AIR SDK licence agreement: `AIR SDK license.pdf` in the SDK's folder (SDK 51.5.1: HARMAN's text of 2019-07-31)
- Wipro, AIR SDK FAQ (the free tier "to support hobbyists and very low-income individuals or companies"): https://airsdk.wxlift.com/faq
- HARMAN, "Adobe AIR – Updated Pricing" (2019/2020): https://airsdk.harman.com/assets/pdfs/Adobe%20AIR%20-%20Updated%20Pricing.pdf (may be out of date)
- Later price changes: https://docs.airnativeextensions.com/news/tags/pricing
- The move to Wipro and the startup logo (March 2026): https://github.com/airsdk/Adobe-Runtime-Support/discussions/1699
- Rules on downloading the SDK (2023–2025): https://github.com/airsdk/Adobe-Runtime-Support/discussions/2715
