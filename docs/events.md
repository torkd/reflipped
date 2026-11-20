# Events and rewards

The server's clock runs on real time, including past the original game's closing date. Events are scheduled separately: the server replays the original game's event history, in the way you choose, and tells the app when each event is open.

## Choosing an event mode
1. On the admin website, open **Settings → Events**, card **Event mode**.
2. Pick a mode:
   - **Classic** (the default): the full event history repeats at its original pace, with its original overlaps and gaps.
   - **Accelerated**: the same history, faster (2× to start with; set the speed there).
   - **Time Travel**: each player picks a historical period on their account page on the player portal, and can change it once a minute. Daily rewards still follow normal time.
   - **Manual**: a repeating playlist of events you pick on the **Calendar** page.
3. Save. Players see the change after returning to the title screen.

The schedule keeps its place across restarts.

## The Calendar page
The **Calendar** page lists the events running now, the upcoming ones and a searchable catalogue of every event.

**To jump to an event** (for example, to try one out):
1. Find it in the catalogue.
2. Optionally set the day number beside it (1 is the opening day) for an event that opens more each day.
3. Press **Go to**. The whole server moves to that point (in Manual mode, only to events in the playlist).

Going to another event starts it over as a new run: its missions, login calendar, scores, rankings, raid kills and rewards start from nothing (the earlier run's are kept). Going to a later day of the event that is already running keeps its progress. Rank rewards are handed out during the event's results announcement, so jumping past it skips them.

**Admin time travel** (a separate switch) lets you put one player, or yourself, on a different period while everyone else stays where they are.

**In Manual mode**, add events to the playlist on the same page. An event brings the banners, shops and other content that originally ran alongside it. Editing the playlist starts a new Manual run.

## Rewards
Every mode pays the original amounts.

In **Accelerated** mode an event is that many times shorter, so its own progress counts faster instead: at 2×, each drop of the event's exchange currency counts twice, each battle counts twice toward its missions, and each day's first login earns up to two entries of its limited login calendar. Every event can still be finished with the original effort. Everything paced by real days stays as it was: daily missions, the normal login calendar, and the beads, mana and EXP from battles.

There are two reward rules, chosen in **Settings → Rewards**, card **Reward management**:
- **Automatic** (the default): the rules above, with nothing to edit. Admin gifts, save uploads, progress resets and developer mode are blocked.
- **Managed**: you can set a reward multiplier (in percent; 100 % is the original), with a separate one for boss and co-op battles, and send gifts. Switch to Managed before using developer mode, save uploads or gifts.

Multipliers apply to beads, mana, EXP and farmable currencies, never to units, armaments or tickets, and every reward pays at least 1. Rewards already earned keep their amounts. To start a new server in Managed mode, set `REWARD_MANAGEMENT=managed` in its settings; a choice saved on the Settings page always wins.

## Campaign bundles
The Scouting and Dream Armament Selection seasons, and the Start Dash bundle for new players, give a ticket that trades for a unit or armament of your choice. The original sold them for paid beads only. On Reflipped you choose, per season:
1. Open **Settings → Events**, card **Campaign bundles**.
2. For each season (and for Start Dash), pick:
   - **Paid**: each player can buy the bundle once, for any beads, free ones first;
   - **Free**: it isn't sold; every player gets the same rewards by mail, once, at their first login of the season (Start Dash: of their first 7 days).
3. Press **Save campaign bundles**. "(original)" marks what the original server did.

Tickets already sent stay. You can also mail tickets yourself from the mail form.

## Good to know
- Co-op works across modes: a battle uses the host's event and reward rules, and each player keeps their own daily reset.
- The last ordinary summoning portal stays open after the event history ends, so the late content can still load.
- The server needs the game data's own data files to build the schedule, even when players download the rest from elsewhere.
- `EVENT_SCHEDULING=off` keeps the older clock-based schedule, for older setups.
