# Hydra: design

Date: 2026-11-21. Status: approved by the owner on 2026-11-21. After approval the owner asked for one change to section 7 (monochrome, smaller corners, match the logo); that change is applied here and in the wireframes. The owner confirmed the result the same day ("Yes, build from it") and allowed color in the Sankey chart only. Build plan: [PLAN.md](PLAN.md). Updated 2026-11-22 with the owner's later decisions (section 2: agent brain on the VPS, voice, undo, label colors, custom controls, wake and stop rules, Mac action rule, UGC cross-posts).
Wireframes (clickable): https://claude.ai/artifact/G9dmkJ8nzvGcHQ7Z4b3XHU. Source copy: `design/wireframes/`.
Logo drafts: `design/logo-sheet-v*.png`. ChatGPT chat title: "Generate Hydra Logo Sheet".

## 1. What Hydra is

One private app for one person. It tracks personal money, UGC creator income and taxes, and it plans the work.
It runs as a web app and as an installable phone app (PWA). Running cost must stay near zero.

Why: Ripple (the current UGC tracker) is shutting down soon. The owner wants one system to carry around
for finances, business and taxes.

## 2. Decisions the owner made

| Topic | Decision |
|---|---|
| Banks | US only. 5 or fewer bank logins. |
| Tax shape | UGC income as a contractor (W-9, 1099). Sole proprietor. One LLC (UGM) is dissolved; keep it as a closed entity for history. |
| Businesses kept apart | UGC creator income. Personal. |
| Phone app | Installable web app. No App Store. |
| UGC pay types | Base pay per video. Pay per view (CPM). View bonus tiers. |
| Bonus scope | Per video. |
| Payouts | Match bank deposits to deals. Show earned vs paid vs owed. |
| Missed money | Opportunity cost: days under the posting target. |
| Views source | Grokbot reads the post pages and writes to Hydra through the Hydra MCP connector. |
| Ripple | Shuts down soon. Import the open deals, logos, bonus structures and everything else first. |
| AI assistant | **Hydra Agent** (owner, 2026-11-21: "call this the hydra agent"). Voice first, with write access to all of Hydra and control of the Mac. One character, Hydra. See section 6, item 9. Answers still cite their rows. |
| Planning | Notion-like. One task list shown as Board, Calendar and Table. Goals track live metrics. Port UGM code. Events are calendar items; bills, tax dates and payouts appear by themselves. |
| Goal metrics | Money numbers, UGC posting numbers, task progress. |
| Google Calendar | Two-way sync. |
| Mobbin | Skipped (needs a paid plan). Use the owner's reference images and one consistent design language. Use shadcn components. |
| Sidebar order | Dashboard, Planning, Notes, Routines, UGC Tracker, Reports, Transactions, Taxes, Accounts. (Routines added 2026-11-22 for the owner's routines page; placed after Planning because both are about time. Notes added 2026-11-22 after Planning, for the owner's Notes page.) |
| Page switch | Component skeletons, same pattern as UGM. |
| Color | No accent color. Off-black `#1D1D1F`, grays and white only. The owner dropped the earlier `#48756C` on 2026-11-21. Red only for money lost or overdue. |
| Corners | Small. |
| Logo | **Decided 2026-11-21:** three linked rings in off-black `#1D1D1F`, with the word "Hydra" in the system sans at Regular 400 (F2 on board 9). Vector files are in `design/logo/`. Earlier options, kept for the record: the owner was choosing between a three-headed hydra silhouette and a minimal three-circle mark (triad, rising, or rings), between a serif word (Origin style) and a sans word (SF Pro semibold), and between `#48756C` and off-black `#1D1D1F` for the mark. All options are on board 9 of the canvas and in `design/logo-sheet-v4` to `v7`. Construction rules are in section 7. Latest lean (2026-11-21): off-black three rings with a sans word whose weight is lighter so the letter stems match the ring stroke (row F on board 9, `design/logo-rings-weight-matched.png`); the owner picked Regular 400. |
| Look | Modern, minimal and simple, matched to the logo. Sans only. Monochrome. Small corners. Informed by Origin's and Apple's design languages. Clear visual hierarchy. No wordiness or subtext. Explanations behind an info dot. Hover gives detail. |
| Sign-in | Stays signed in (cookies) until sign-out. /login goes to the Dashboard when signed in. Idle lock off by default. |
| Agent brain | **Owner, 2026-11-22:** "instead of it relying on my mac why not host it on a vps" (Hostinger KVM 2, Ubuntu 26.04). This replaces the Mac-only brain he picked earlier that day ("just link it to my claude code like it is right now", then "A"). The **server brain** runs on the owner's VPS (`hydra-brain` service, Claude Code on his Claude subscription, paired as a device with role `brain`) and answers web and phone turns. The Mac (Hydra Desktop) is the fallback when the server brain is down, and it runs every Mac action. Gmail and Google Calendar come through his claude.ai connectors. No Anthropic API key. Reminders still fire from the server. |
| Mac app signing | **Owner, 2026-11-22:** "email is fine I dont want to do the apple developer id". The Mac app is ad-hoc signed (right-click, Open once per new build) and signs in with the emailed code; no passkeys inside the Mac app. |
| Sign-in email | A 6-digit code only, no link (a link only works in the browser that asked for it). Codes expire after 10 minutes. |
| Orb | Lives inside the Hydra window by default; floats on the desktop only when detached (owner, 2026-11-22). About 48 px, never follows the cursor, grays and shrinks in place when asleep, no white disc. |
| Waking Hydra | Awake: a double clap or the wake phrase starts listening. Asleep: the wake phrase (being built), a double clap or a tap wakes it ("Hydra at your service, sir.") and it listens at once (owner, 2026-11-22: "Yes, phrase wakes it"; this replaces "only a double clap or a tap"). The wake phrase is a setting, default "Hey Hydra" (owner: "allow me to change the starting phrase too"). After each answer it keeps listening for about 8 s without the phrase. Talking over Hydra stops its speech within about 150 ms and listens. |
| Adding while it thinks | (Being built.) **Owner, 2026-11-22:** "dont cancel but add onto the prompt". Speech or typing while Hydra thinks is added to the running question, never a new one and never a cancel. The sleep word while it thinks cancels and sleeps. |
| Stop and taps | Stop = silence and sleep, on every surface. Tap the orb: asleep, it wakes and listens; listening, it turns off (sleeps); speaking, it stops speaking and listens. |
| Cursor visual | Only for a take started from the keyboard shortcut (owner: "if i dont trigger hydra from my keyboard teh mouse visualiser thing shouldnt show up"). Never for the phrase, a clap, a tap or pointer movement. |
| Model and effort | (Being built.) One shared setting in `agent_settings`, read by every brain (server brain each turn, Hydra Desktop on change); nothing hard-codes a model. Models: Opus 5.5, Sonnet 5.5, Haiku 5.5. Effort: low, medium, high. Default Opus 5.5, low for live talk, medium for routines. Set in the orb menu. |
| Voice model | Fish Audio's free API model `s2.1-pro-free` with the owner's voice `FISH_DEFAULT_VOICE_ID`. His free Fish plan has no API balance, so the paid default answered 402. |
| Controls | **Owner, 2026-11-22:** "all dropdowns and calendar components need to be custom", and "all these dropdowns need to have animations". No native select, date, time or checkbox anywhere. Every popover opens with a short fade and scale from its trigger (about 150 ms) and closes faster; fade only under `prefers-reduced-motion`. |
| Label colors | **Owner:** "for the different statuses or categories or tags there should be a color selector". Statuses, tags (select options) and categories each take a color. This overrides "no color" in section 7 for labels and the charts that show them. See section 7, Color. |
| One setup | Sign in once in the Hydra window; the Mac pairs itself; then Sign in with Claude and allow microphone, app control and screen, all in the same window. |
| Transfers | Card and loan payments pair automatically. Moves between cash accounts are suggested and the owner confirms them, so a payout is never hidden from income. |
| Mac actions | **Owner rule, 2026-11-22:** "only plain reads run without asking; everything else asks". Only plain reads and lists inside Documents, Desktop and Downloads are free. Every other Mac action asks, every time, showing the real target in full: clicks, keys and typing in other apps, opening things, every file write (new files too; this replaces "a new file is written without asking"), restores, deletes and connections. No "skip" setting. The agent has no shell commands (turned off after six safety reviews, 2026-11-21). Secrets are never read. Login items, shell startup files, keys and app bundles are never written. From the phone, Mac steps run on the Mac and their approvals show on the phone (being built). |
| Undo | **Owner, 2026-11-21:** "I should be able to undo deletions and undo past behaviors". Scope: pages and agent. Every change the owner or the agent makes goes in one list on the Activity page (its own page; More on the phone), each with Undo. A delete on any page shows an Undo bar. Deleted items come back exactly, with their linked rows, for 30 days, then are gone for good. Sent emails and payments cannot be undone. |
| Hands-free | Mac app only (owner, 2026-11-22). Clap and the wake phrase work in Hydra Desktop (on by default). The website and phone are tap-to-talk. |
| UGC cross-posts | One video posted on several accounts is paid once, on its best platform (owner: "1 vid across 4 platforms is one payment; max views gets the view bonus"). Applied to the live data on 2026-11-22 with the owner's OK ("Yes, apply it"): UGC earned total $17,950 to $15,570. See section 8. |

## 3. Calls I made (owner did not answer; correct any)

- Top number on the dashboard is net worth with a trend line.
- Accounts: bank, cards, manual assets. No investments or crypto feed in v1.
- No budgets. Track only.
- One login (the owner). Bots use scoped keys.
- Projection uses the owner's words: posts per day x base pay x 30. (Ripple used real month days.)
- Tax numbers are estimates from a set-aside rate the owner types. Hydra does not file and does not give tax advice.
- Time zone is a setting. Default: the browser's zone at first login.

## 4. Approaches

1. **Fork Sure (open-source Maybe fork).** Has rules, recurring, Sankey, Plaid, MCP. But it is Rails + Redis.
   None of the Ripple or UGM code fits it. Rejected.
2. **Build on Ripple's stack (Prisma, NextAuth).** The UGC math ports with zero change. But the Planning port,
   the biggest UI lift, is tied to Supabase SQL, RPCs and triggers. Rejected.
3. **New Next.js app on UGM's stack (picked).** Supabase Postgres with SQL migrations and RLS, Tailwind v4, shadcn.
   Planning and the skeleton pattern port almost as is. Ripple's UGC math is pure TypeScript and comes along
   with one swap (`Prisma.Decimal` to `decimal.js`). Rules are ported from Actual Budget (MIT licence).

## 5. Stack

- **App:** Next.js 16 App Router, React 19, TypeScript, pnpm. Tailwind v4. shadcn components. Recharts (all charts, Sankey included; fall back to d3-sankey only if column order cannot be forced). `@dnd-kit` for the board.
- **Data:** Supabase Postgres. Plain SQL migrations in `supabase/migrations/`. RLS on every table: owner only.
- **Auth:** Supabase Auth, sign-ups off, one allowed user. Passkey (WebAuthn) for login and re-lock. Builder must check Supabase's native passkey support first; if it is missing, use SimpleWebAuthn on top of the session.
- **Hosting:** Vercel + Supabase, on the owner's existing accounts. The web app does not move to a VPS. The agent's server brain alone runs on the owner's VPS (Hostinger KVM 2, Ubuntu 26.04, the `hydra-brain` systemd service; owner, 2026-11-22). Note: Vercel Hobby is for non-commercial use, so use the owner's paid Vercel team if one exists.
- **Jobs:** Vercel cron, daily: bank sync, recurring detection, task repeats, backup check. Plaid and Google webhooks do the fast updates.
- **Backups:** Supabase Free has none. A GitHub Actions job runs `pg_dump` every night, encrypts it, keeps 30 days.
- **Bank feed:** Plaid Trial plan. $0. 10 bank logins for life; removing one does not give the slot back. Build against Plaid Sandbox. Reconnect with update mode. Block duplicate links. All of it sits behind one `BankProvider` interface so SimpleFIN ($15 a year) can be added later. CSV, OFX and QFX import always works.
- **AI:** one tool layer (typed, read-only SQL behind functions; totals computed in SQL, never by the model). Two doors: an MCP server and the Hydra Agent (Claude Code on the owner's subscription, in the server brain or Hydra Desktop, using the Hydra MCP tools). Builder loads the `claude-api` skill before writing it.
- **Money type:** integer cents in the database. `decimal.js` in pay math.

Expected cost: $0 to about $1 a month plus chat usage. Metricool is not used: its API needs the $53 to $67 a month plan.

## 6. Pages

The wireframe canvas is the reference for layout and for what can be clicked. Summary:

1. **Dashboard.** Net worth and trend. Cash. Credit cards with due dates. Income this month (before card bills). Net after card bills. Spending. Recurring per month. UGC revenue (earned, paid, missed, projected). Posting calendar. Recent transactions. Goals. Coming up. Scope switch: All, Personal, UGC.
   **Editable grid (owner, 2026-11-21: "I should be able to resize them and remove certain blocks and add blocks and it'll save on a grid"; he picked the Edit button and an own phone layout).** Every card above is a block on a grid.
   - An **Edit** button (plain, in the top bar) turns on edit mode. Each block then shows a drag handle, a resize corner and a remove ×. **Add block** lists the hidden blocks. **Reset** restores the default layout. **Done** leaves edit mode. Outside edit mode nothing moves.
   - Desktop: 12 columns, 20 px gaps. Moves and sizes snap to the grid. Each block type has a minimum and a maximum size, so a card can never be too small for its content.
   - Phone: its own saved layout on a 2-column grid. Reorder, half or full width, remove, add.
   - Saved to the owner's account in the database: one desktop layout and one phone layout, so they follow him to every device. Changes save by themselves.
   - Remove hides a block. No data is lost; it comes back from Add block.
   - The default layouts are the wireframes: `Main.dc.html` (desktop) and `Mobile.dc.html` (phone).
   - Motion: a block lifts on drag and settles with an ease, no bounce. A resize snaps in 200 ms. Instant under `prefers-reduced-motion`.
2. **Planning.** Goals strip with live metric bars. Views: Board (drag cards, quick add, group by status, category, goal or priority), Calendar (tasks, events, bill dates, tax dates, payouts), Table (sort, edit in place, custom properties). Task drawer with autosave and repeat. Categories on tasks and on goals. A task links to one goal.
3. **UGC Tracker.** Tabs: Overview (five numbers, posting calendar, projection calculator, earned per day), Videos (table, exclude from pay, export), Deals (pay structure editor, bonus tiers, payout matching, logo).
4. **Reports.** Tabs: Cash flow (Sankey), Spending (donut and category table), Income (by payer, year to date), Trends (months). Download: monthly PDF, transactions CSV, income by payer CSV, year-end tax pack.
5. **Transactions.** Table with category and business per row. "Needs review" queue. After a manual category change, offer to make a rule. Rules tab: ordered list and an editor with live preview.
6. **Taxes.** Year and entity switch. Income, deductible expenses, net profit, set-aside. Estimated payment timeline. Schedule C lines with their transactions. Documents (W-9, 1099, uploads).
7. **Accounts and Settings.** Accounts tabs: Accounts (cash, cards, manual assets, add account), Recurring (found by itself, confirm or dismiss, price change flag). **Settings** (owner, 2026-11-22: "there should be a settings page and I should be able to add busineses") holds every setting, in tabs: Businesses (add, edit, close and reopen, delete when nothing uses it; Personal is never closed), General (time zone, idle lock), Agent (model, effort, wake phrase, sleep word, clap sensitivity) and Connections (bank feed, Grokbot connector, Claude Code connector, Google (Gmail and Calendar, one sign-in), Hydra Desktop pairing, security, backups). Old `/accounts?tab=connections` links go to Settings > Connections.
8. **Phone app.** The website is the phone version: same pages, one column. Bottom tabs: Home, Plan, UGC, Reports, More. The Hydra Agent orb (item 9) floats above the tabs; tap it to talk.
9. **Hydra Agent.** The owner, 2026-11-21, in order: "for the ai agent make it function primarily like a voice agent that can naviage the interaface, including pages, add pages, rows, expenses, change expenses, basically have write permission to the entire system"; "it should have smth like this in the sidebar but obviously in our design language and more minimal less tacky looking, it should look closer to this non condensed sphere, as it talks it vibrates and as I talk to it it vibrates too" (references: a purple glowing orb card and an open orange particle sphere); "https://github.com/KenKaiii/Roamies copy the code from this repo and mimic how this functions I want it to be able to control my operating system along with conencted with Hydra data"; "call this the hydra agent"; "There should be only one character hydra And then the whole interface needs to be redesigned for my design language"; "ask hydra should also disapear and be replaced with the new orb and agent, and it shouldnt go onto the taxes page"; "the agent should go inactive after 5 mins of not talking to it, but if I clap 2 times it should reactivate and ask me "Hydra at your service sir" ... I feel like having it on browser and desktop is redundant ... can you just combine it and make it a desktop app, the agent along with the interface from website, then the webapp can be the version I use on my phone".
   - **One character: Hydra.** No other characters, skins or sizes from Roamies.
   - **Two apps, one agent.** (a) **Hydra Desktop**, the Mac app the owner uses at his desk: one window with the whole Hydra interface and the Hydra Agent built in (the orb at the bottom of its sidebar, where "Ask Hydra" was; "Ask Hydra" is removed, and nothing of the agent lives on the Taxes page). It also controls the Mac (owner: "for the desktop version it should be able to control my desktop, open apps, close things, ect"): open and quit apps, close, switch and arrange windows, open files, folders and sites, click and type in other apps, from a fork of Roamies. Only plain reads and lists in Documents, Desktop and Downloads run without asking; every other Mac step asks first (section 2, Mac actions). (b) **The website**, which is the phone version: same pages and the same agent, tap the orb to talk. There is no separate browser agent on the Mac, so the agent never runs twice there.
   - **Voice first.** Talk or type. Hydra talks back.
   - **Voice: Fish Audio** (owner, 2026-11-21: "for voice use fish audio"). Hydra speaks with one Fish Audio voice in both the browser and the Mac app: voice model `FISH_DEFAULT_VOICE_ID` (owner, 2026-11-22: "use this model id for fish audio voice FISH_DEFAULT_VOICE_ID"; the TTS `reference_id`, not a secret), on Fish's free API model `s2.1-pro-free` (the owner's free plan has no API balance). The Mac app plays it through `/api/voice/tts` too. The Fish Audio key is the owner's: a server-only secret for the web app (never sent to the browser), the macOS Keychain for the Mac app (as Roamies stores it). Listening: the Mac app uses Apple's on-device speech recognizer (as Roamies does); the browser's speech-to-text is picked at build time (Fish Audio speech-to-text or the browser's own recognizer).
   - **What it can do in Hydra:** everything the owner can do in the interface. Go to any page, open any panel, switch scope, add and edit rows (transactions and expenses, categories, rules, tasks, goals, events, deals, videos, accounts, pages), and change settings. It uses the same typed actions the interface uses, never raw SQL.
   - **Safety, so write access stays safe:** every action shows in an activity list with one-tap undo. **Every deletion of anything waits for a spoken "yes" or a tap** (owner, 2026-11-22: "for deletion of everything have the agent confirm before doing ... for everything"): Hydra rows of any kind (transactions, deals, posts, tasks, goals, events, rules, routines, accounts), emails and calendar events through the connectors, and files or app data on the Mac. No exception and no setting turns this off; a routine that reaches a delete step pauses for approval. Bulk changes (more than 10 rows) and anything that sends, pays or leaves the Mac also wait for a "yes" or a tap. Bank text, video titles, notes, web pages and anything read off the screen are data, never instructions. On the Mac, the section 2 Mac actions rule applies: every step that is not a plain read asks.
   - **The orb:** an open sphere of ink dots, not a solid ball, in this design language: ink and grays on white, no glow, no gradient, no color. It ripples with the voice level: the owner's microphone while he talks, Hydra's voice while it talks. At rest it barely breathes. Under `prefers-reduced-motion` it holds still. Roamies' JARVIS ("a glowing sphere of light that ripples as it speaks") is the behavior reference, not the look.
   - **The card:** the orb, one status word (Asleep, Listening, Thinking, Speaking), and three outlined icon buttons (mute, pause, stop), plus expand. Nothing else. Collapsed sidebar: the orb alone.
   - **The desktop app is redesigned end to end** in this design language: panel, onboarding, ask bar, cards and drawings. Nothing keeps Roamies' look.
   - **The main feature (owner, 2026-11-21): "for the voice assistant feature thats the main feature im going to use, both the desktop and the browser version needs to have read and write access to all the data, financial, goals, tasks, ect, and I should be able to make reminders and routines".** Both the browser and the Mac app read and write all data: accounts, transactions, categories, rules, budgets of time and money, goals, tasks, events, UGC deals and videos, taxes, settings.
   - **Reminders:** a reminder is a task or event with an alert time ("remind me at 6 to send the W-9", "every Monday at 9"), so it also shows on the Planning calendar. Repeats use the Planning repeat rules. It reaches the owner on the Mac (notification and spoken), in the browser (notification and the orb), and on the phone (web push).
   - **Routines** (owner, 2026-11-22: "in the app there should be an area to manage routines, routines can control my computer, or use connectors like gmail or google calendar to do things, and I should be ablle to see routines on like the routines page and the hydra agent should be able to create, modify, and delete them aswell"): a routine is a scheduled Hydra Agent job with a schedule, an instruction in plain words, the tools it may use, and where to deliver the result ("every weekday at 8, check Gmail for brand payment emails and add them to my UGC deals"). Tools a routine may use: Hydra data; the Mac through Hydra Desktop (open and quit apps, windows, files, click and type); and connectors, Gmail (read, search, draft, send) and Google Calendar (read and write events), with one Google sign-in. Server-side steps run on the server on schedule; Mac steps run only while Hydra Desktop is running, and if the Mac is off at the scheduled time the routine either waits for it or skips and says so (a setting per routine). Every run is logged with its output. The Hydra Agent creates, edits, pauses, runs and deletes routines by voice; the owner does the same on the Routines page (page 10 below). Unattended steps that send, pay or delete, and every Mac step that is not a plain read (section 2, Mac actions), pause and wait for the owner's approval in a notification or on the Routines page.
   - **How it fits together (owner: "Figure out a way to integrate this cleanly"):**
     - One agent service inside Hydra holds the tools, the conversation, the memory, the reminders and routines, the activity log with undo, and the confirm gate. Hydra Desktop and the phone are both clients of it, so they always agree.
     - The thinking runs in the server brain on the owner's VPS. When it is down, Hydra Desktop on the Mac thinks instead. Mac actions always run on the Mac; a phone turn that needs the Mac asks it (being built), and when the Mac is off Hydra says "Your Mac is offline."
     - Hydra Desktop shows the Hydra interface in its window (the same web app, so every page is built once) and adds the native parts: microphone and speaker, the clap detector, notifications, and control of the Mac. Interface steps (go to a page, open a panel, highlight a row) run in that window.
     - The phone uses the website: tap the orb, talk, and Hydra answers the same way, with the same memory.
     - If the phone and the Mac are both awake, the one the owner spoke to last answers; the other stays silent.
   - **Sleep and wake:** after 5 minutes without the owner talking to it, the agent goes to sleep: it stops listening to speech and sends nothing to the cloud. On Hydra Desktop an on-device wake phrase listener and a small clap detector keep running on the Mac only: the wake phrase or two sharp claps 0.25 to 0.8 seconds apart wake it, and it says "Hydra at your service, sir." in its Fish Audio voice and listens. Clap detection is on-device (short-time energy onsets with a broadband check, so speech, typing and music do not wake it), uses almost no CPU, and has a sensitivity setting. A phone browser cannot listen in the background, so on the phone a tap on the orb wakes it.
   - **Sleep word** (owner: "if I say a certain word if it's listening it'll turn itself off until i clap my hands again or manually activate it in the interface"): while it is listening, the owner says the sleep word and Hydra goes to sleep at once, until the wake phrase, a double clap or a tap on the orb. Default "Hydra, sleep"; the word is a setting. Hydra answers with one short sound, not a sentence. Stop does the same: silence and sleep.
   - **While it thinks** (owner: "dont cancel but add onto the prompt"): what the owner says or types is added to the running question. The sleep word still cancels and sleeps.

10. **Routines.** The owner's routines page (item 9, Routines). A list: name, schedule in plain words, next run, last run with its result (ok, waiting for approval, failed, skipped because the Mac was off), and an on/off switch. A click opens the shared panel (`?routine=`): instruction, schedule, tools allowed (Hydra data, Mac, Gmail, Google Calendar), delivery (spoken on the Mac, notification, phone push, email to self), what to do when the Mac is off, and the run history with each run's output and actions taken (each undoable). Buttons: New routine (or just ask Hydra), Run now, Pause, Delete (asks first). A "Waiting for you" strip at the top lists approvals pending from unattended runs, each with Approve and Decline. Phone: in the More sheet.

11. **Notes** (owner, 2026-11-22: "all notes should be stored on a notes page", "I should be able to create and change notes just like notion"). Desktop: the list on the left (search, New note, pinned first then newest change, each row its title and first line, the source and time on hover), the open note on the right (`?note=`). Phone: the list; a tap opens the note full screen with a back button; in the More sheet. The note: a title, then a block editor like Notion (BlockNote): `/` opens the block menu, drag handles move blocks, markdown shortcuts, paste from the web; text, headings 1 to 3, bulleted, numbered, to-do and toggle lists, quote, code, divider, table, links. No colors. Saves by itself 0.6 s after typing stops; a quiet Saving / Saved shows on hover. A note changed elsewhere stops saving and offers Reload; nothing is merged silently. Delete asks first, naming the note, then the 30-day undo. The Hydra Agent creates, finds, reads, changes, pins and deletes notes (delete asks first); Hydra Desktop sends its drawn notes to `/api/agent/notes` (the Mac half comes later). Notes are not memory facts: they never go in the agent's prompt.

## 7. Design language (built from the logo)

The logo is thin off-black rings and a regular-weight sans word. The UI follows it: off-black on white, hairline outlines, regular and medium weights, small corners, no accent color. The owner's last instruction (2026-11-21, after approval): "make the corner radiuses smaller ... remove the green and teal colors, readjust the design language to match the minimal, simple design of the logo". Earlier references still inform it: Apple (system sans, restraint, flat) and Origin (one strong dark block, flat surfaces). Rejected on the way: an all-sans rounded-card dashboard, serif titles, mono caps labels, colored chips, the teal accent, large corners. Short notes on both references are in `docs/references/style-references.md`.

- **Hierarchy:** one hero per page (the Dashboard's is the dark net worth card). Then key figures. Then body. Then gray labels. Use size, weight and space for rank, not boxes. Group related numbers in one strip or one card with hairlines, not in many small cards. One filled button per page.
- **Logo (final):** three linked rings in off-black `#1D1D1F`, then the word "Hydra" in the system sans, Regular 400. x is the cap height of the word. The mark is 1.5x tall and centered on the capitals. The ring stroke is as thick as the letter stem (0.076 of the mark height), so the word and the mark carry the same weight. Space between mark and word is 0.5x. Clear space is 1x. On dark, both turn white. Vector files: `design/logo/hydra-mark.svg`, `hydra-mark-white.svg`, `hydra-app-icon.svg`, `hydra-lockup.svg`. The word in the lockup is live text; convert it to outlines for print or for non-Apple devices. The UI has no accent color either; it uses the logo's off-black.
- **Logo options not picked** (board 9 on the canvas): x is the cap height of the word. The mark is 1.6x tall and centered on the capitals (hydra mark) or exactly 1x tall (three-circle mark). Space between mark and word is 0.5x. Letter stems are as thick as the gaps or strokes in the mark. In the stacked form the word is exactly as wide as the mark. Clear space is 1x. Under 24 px the hydra mark needs a one-head version (not drawn yet). Files: `design/logo-mark-48756C.png`, `design/logo-mark-square-*.png`. A vector trace is still needed before shipping.

Tokens live in `design/wireframes/hydra.css`. Port them to Tailwind theme variables. Do not add new colors or sizes per page.

- **Type:** the system sans everywhere (`-apple-system`, so SF Pro on the owner's Mac and iPhone; Inter as the fallback). No web font is loaded. Titles and key figures are medium 500 with tight negative tracking. The hero figure is light 300 at about 76 px (my call: the earlier serif hero was dropped to match the logo). Body is regular 400. Labels are 13 px gray, sentence case. No serif and no mono in the UI.
- **Color:** monochrome. Ink `#1D1D1F` (the logo color). Secondary text `#424245` and `#6E6E73`. Page and cards `#FFFFFF`. Tint for nested blocks, hover and tracks `#F5F5F7`. Hairlines `#E5E5EA` and `#D2D2D7`. The hero card is solid `#1D1D1F` with white text. Red `#B3261E` is for money lost or overdue and nothing else. Positive numbers are ink with a plus sign. Charts color a category with its label color; a category with no color takes the gray ramp from `#1D1D1F` to `#E5E5EA`. The Sankey (owner, 2026-11-21: "the sankey chart can have color"): the income side stays ink and gray; each place the money goes takes its category color, and with no color set it falls back to one fixed muted color (savings `#3F5F8A`, housing `#D9A441`, taxes set aside `#7B6BB0`, food `#C96A4B`, software `#5E8FC9`, shopping `#C77A9B`, other `#A1A1A6`, transport `#8C6F4E`). The fallback set has no green and no teal (label colors may use them). Bands are the node color at about 32% opacity.
  **Label colors** (owner, 2026-11-21: "for the different statuses or categories or tags there should be a color selector"): statuses, tags (select options) and categories each take one color from a palette of 18 muted swatches (`src/lib/label-colors.ts`: a gray row, then muted tones) or a custom hex. A label shows as a dot or a lightly tinted pill. Category colors also color that category in the Reports and Dashboard charts. The label rose is not the money red.
- **Shape:** flat. No shadows, no gradients. Cards are white with a 1 px hairline outline and 12 px corners. Hero 16 px. Controls and nested blocks 8 px. Small marks 4 px. The filled button is off-black with white text; other buttons are outlined or plain text. Segmented control is a tinted track with an outlined white thumb. Status and tags are 12 px text with their label color (a dot or a tinted pill). Lists and tables use hairlines only. All controls are custom (no native select, date, time or checkbox): a popover opens with a fade and scale from its trigger in about 150 ms and closes in about 100 ms, fade only under reduced motion. Progress bars are 4 px. Calendar days: filled ink = target hit, gray = under, outlined = zero.
- **Copy rule:** no explanatory sentences on a page. A card is a label, a number and a chart. Explanations go behind an info dot (hover on desktop, tap on phone). Use dots, swatches and bars before words.
- **Hover cards** (tap or long-press on phone):

| Element | Hover shows | Click does |
|---|---|---|
| Posting calendar day | Date, posted of target, per deal, earned or missed | Opens the day's videos |
| Net worth line | Date, value, change, assets and debts | - |
| Sankey band, donut slice | From and to, amount, share, count | Opens its transactions |
| Stat card info dot | Formula with the real numbers, last update | - |
| Card account row | Statement balance, due date, use of limit | Opens the account |
| Category pill | Which rule set it | Change category, edit rule |
| Video views | View history sparkline, last update, source | Opens the video |
| Video total | Base, CPM and bonus split | - |
| Goal bar | Metric, window, pace needed per day | Opens the goal |
| Recurring row | Last three charges, price change | - |
| Health pill | Last sync, error text | Reconnect |
| Collapsed sidebar icon | Page name | Goes to page |

- **Slide-out panel:** a click on a row or a mark opens one shared panel from the right (420 px on desktop, a bottom sheet on phone). The open item is in the URL (`?tx=`, `?day=`, `?account=`, `?task=`, `?goal=`, `?deal=`, `?category=`), as UGM does with `?task=`. Fields save by themselves. Esc or a click outside closes it. Focus stays inside it. Start from the slide-outs the owner already likes: Ripple `components/ui/SlideoutPanel.tsx`, `components/posts/PlannerSlideout.tsx`, `components/shadcn/sheet.tsx`; UGM (`origin/main`) `src/components/admin/planning/task-drawer.tsx`, `goal-drawer.tsx`, `drawer-header.tsx`, `src/components/admin/person-drawer.tsx`. Read them before building the shared panel; keep their behavior, restyle to this design language.

| Clicked | Panel lets the owner adjust |
|---|---|
| Transaction row | Category, business, tax line, rename, note, split, receipt, transfer, recurring, hide from reports, link to a UGC deal, make a rule from this |
| Expense category (Reports, dashboard) | Its transactions for the period, trend, rename, merge, color, tax line map |
| Posting calendar day | That day's videos (views, pay, counted or excluded), day target override (a day off has target 0, so no missed money), add a video, note |
| Account | Nickname, type, business, in net worth or not, statement balance and due date override, reconnect, balance history, close |
| Task | Status, category, goal, due, repeat, priority, notes, delete |
| Goal | Metric, target, window, category, linked tasks, mark achieved |
| Recurring item | Amount, gap, category, confirm or dismiss |
| Tax line | Mapped categories, its transactions |

- **Motion (must feel premium):** restrained, as in both references: 0.2 s ease on state changes, no springs, no overshoot, no parallax. Animate transform and opacity only. Enter 180 to 320 ms, exit faster. Panel: slide 28 px and fade, with a scrim fade. Hover cards: 140 ms rise and fade after an 80 ms delay. Tabs and segmented controls: the active marker slides to the new item. Numbers tween to the new value with tabular digits, no layout shift. Charts draw in once on first view (line draws, bars stagger 20 ms); they do not replay on hover. Board cards lift on drag and settle with an ease, no bounce. Skeleton cross-fades to content in 150 ms; no spinners. A page switch keeps the sidebar still and fades the content in. Buttons press to 0.98. All of it turns off under `prefers-reduced-motion`. Use CSS transitions first and the `motion` library for layout, drag and number tweens.
- **Loading:** every route has a `loading.tsx` made of skeleton blocks in the shape of that page's cards (port `src/components/ui/skeleton.tsx` and the `loading.tsx` pattern from UGM `origin/main`). Slow cards sit in their own Suspense boundary. `motion-safe` pulse only.
- **Sidebar:** 232 px open, 64 px closed, toggle with `[` or the arrow. State is kept per device.

## 8. UGC rules

Ported from Ripple (`lib/pay-cpm.ts`, `lib/campaign-earnings.ts`, `lib/money.ts`, `lib/pay-validation.ts`, `lib/pay-tier-seeds.ts`, `lib/view-freeze*.ts`, `lib/finances/projection.ts`, `lib/finances/earnings-calendar.ts`, `lib/brand/creator-cadence.ts`, `lib/brand/posting-calendar.ts`, `lib/analytics/month-day-grid.ts`, `lib/format-views.ts`, `lib/analytics/view-snapshots.ts`, `buildConsistencyResponse`) with their tests.

- **Pay per video** = base (if views reach the minimum) + CPM (rate per 1,000, optional cap and floor) + the highest bonus tier that video passes. This is Ripple's per-video model (`calcPay`), because the owner's deals pay bonuses per video. The per-deal model (`computeAggregatePay`) is ported too and is a deal setting, off by default.
- **Rate snapshot:** a new post copies the deal's rates. Later rate edits do not reprice old videos.
- **Freeze:** views stop counting after the deal's freeze days.
- **Exclude:** owner only. An excluded video pays $0.
- **One video on several accounts** is paid once, on its best platform (most views; the bonus tier comes from those views): posts share a `video_group_id`. Grokbot may send it; else the cross-post matcher (`src/lib/ugc/match.ts`, ported from Ripple's caption matcher) links each new post to its twins in the deal: other platforms, one post per platform, and either the same title within 36 h (word overlap 0.5 within 6 h, 0.8 beyond) or any title posted within 10 minutes (Ripple's time rule). A twin's group with a priced override is joined (the override pays the video once); one with an excluded member or a $0 override is held for the owner. The owner can link and unlink by hand (`video_group_manual`); the matcher never changes those. A new post links only its own video; `scripts/ugc-link` backfills old posts (dry run prints pay before and after, split into same-rate and mixed-rate videos, since a group pays at its most-viewed post's rate, and lists held posts).
- **Missed money** (new) = for each elapsed day of a deal, `max(0, target posts - counted posts that day) x base pay`.
- **Projection** = sum over active deals of `target posts per day x base pay x 30`.
- **Applied 2026-11-22** (owner: "Yes, apply it"): the matcher linked the imported cross-posts in one transaction. UGC earned total $17,950 to $15,570 (Wordwise 229 videos, $10,205). Four Wordwise posts are held for hand linking.
- **Owed** = earned - matched deposits. A deposit matches a deal by the deal's payout rule. One transaction links to one deal.

### Grokbot connector

MCP server (streamable HTTP) with a bearer key, scope `ugc:write`. The same handlers are also plain REST for curl. The key cannot read finance data and cannot exclude videos.

- `ugc_context` : deals, accounts, server time.
- `ugc_add_post` : `{url, platform, account, dealId, postedAt, videoGroupId?}`. Upsert on the normalized URL.
- `ugc_posts_needing_views` : today's work list.
- `ugc_set_views` : `{capturedAt, items: [{postId or url, views, likes?, comments?}]}`. One snapshot per post per day.

Guards: a lower count than the last one is rejected unless forced. A jump over a set multiple is held for review, not paid. A missed day shows a warning on the dashboard.

### Ripple import (one time, before shutdown)

A script reads the Ripple database read-only and writes Hydra rows: the owner's open deals with all pay columns (`Campaign`, `prisma/schema.prisma:985-1110`), logos (`Campaign.logo`, copy the file into Hydra storage), posts, view snapshots, exclude flags and manual overrides. Dry-run mode prints counts first. A rerun does not duplicate. The write runs only as the database owner (no API key can write Ripple rows) and only inserts: a rerun never changes an owner edit or brings back a deleted row. Done 2026-11-22: 13 deals, 96 templates, 19 accounts, 1,192 posts, 7,908 view snapshots, 9 exclude flags, 72 manual overrides, 97 logos.

## 9. Money rules

- **Transactions:** pending and posted versions are one row. Refunds reduce the category. Transfers between own accounts and card payments are matched as pairs and left out of income and spending.
- **Rules** (model from Actual Budget): conditions on name, merchant, amount, account, note. Operators: contains, is exactly, starts with, contains any of, does not contain, is one of, between, regular expression. Case is ignored. "Contains" is a plain substring match. Actions: set category, set business, rename, set tax line, mark transfer, mark recurring. Order matters; first match wins. A manual edit always beats a rule. Preview before save. Option to apply to past rows.
- **Recurring:** same name, steady amount, steady gap. The owner confirms or dismisses. Price change is flagged.
- **Income before card bills** = deposits that are income in the period. **Net after card bills** = that minus current card balances.
- **Taxes:** `tax_lines` table seeded with Schedule C Part II. Each category maps to one line per entity. Income is totalled per payer.

## 10. Planning port (from UGM `origin/main`)

Port `src/lib/planning/*` (types, schemas, tasks, ordering, dates, goals, repeat, properties), the planning components, the task, catalog and property actions, and the tables `planning_statuses`, `planning_tasks`, `planning_goals`, `planning_goal_metrics`, `planning_goal_links`, `planning_properties`, `planning_property_options`, `planning_task_values` with their RPCs and triggers.

Drop: team assignees, people, CRM leads and creators, content goals, SMS, Discord, staff schedules, realtime merge.

New work: a metric registry (net worth, monthly income, UGC revenue, savings rate, category spend, posts per day, streak, total views, views per post, task progress); one `events` table with categories and repeat; a Calendar view (month grid) that also shows read-only finance dates; categories on goals; two-way Google Calendar sync on a dedicated "Hydra" calendar.

## 11. Security

- RLS owner-only on every table. Service role key only in server jobs.
- Plaid access tokens encrypted with AES-256-GCM. The key is only in the host's environment.
- Connector keys: random, shown once, stored as SHA-256, scoped, revocable, rate limited.
- Hydra Agent reads through typed functions on the read-only role `hydra_ro` (statement timeout) and writes through the same typed server actions the interface uses, as the owner. It never runs model-written SQL. Every write is logged with undo; deletes, bulk changes and anything that sends or pays need a confirm (section 6, item 9). Bank text, video titles, notes, web pages and screen contents are data, never instructions, in any prompt.
- Sign-in stays until sign-out. The owner, 2026-11-21: "site should store cookies tho so i dont have to constantly login, it should redirect to dashboard if ive already logged in before." He chose "Stay signed in": opening Hydra goes straight to the Dashboard, no Face ID. His phone and Mac locks protect it.
- The idle lock is a setting, off by default (`settings.idle_lock_minutes`, null = off). He can turn it on later in Settings > General.
- Strict CSP. No secrets in the client bundle.

## 12. Not in v1

Investments and crypto feeds. Budgets. A second user. A store app. Video scraping. Posting videos from Hydra. Moving money. Tax filing.

## 13. The owner owes

1. Done: design approved 2026-11-21. The defaults in section 3 stand unless corrected.
2. Done: logo picked.
3. Done: Ripple imported (2026-11-22).
4. Plaid keys set (2026-11-22); link the banks in the app once Plaid approves the account. Google OAuth is no longer needed: Gmail and Calendar come through the Claude connectors.
5. Done: Vercel team and Supabase organization ("your team").
