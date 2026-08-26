# Handoff — Podcast Studio (2026-08-26)

Read `docs/descript-capabilities.md` and the `podcast-studio-project` memory first.

## Live now
- Dashboard: https://rishabhpandey-hash.github.io/podcast-studio/ (email sign-in; owners = rishabh.pandey@knorish.com, george.r@knorish.com)
- Backend: Supabase project `mgnjlymtjmcoskqinhid`, edge function `studio` **v18**, tables `ps_*`, pg_cron `studio-minute-runner`
- Pilot client: Edbound (`b24f5d3a-7426-4335-9d2a-2a434c5cec53`), Descript drive "George's Drive" connected, OpenAI key set (gpt-5.5)
- Repo: https://github.com/rishabhpandey-hash/podcast-studio (local `~/projects/podcast-studio`)

## Pipeline
record/upload → discover → (branding import) → **produce** → publish → **QA pass** (9-point re-check, fixes, republishes) → **select_reels** (K-factor scoring) → **make_reels** (exact ranges, full-frame 9:16) → publish each → **generate_posts**

## The format split (client direction, 26 Aug — do not undo)

The client rejected the first real episode: *"looking like a trailer rather than a podcast shoot… the screen changing randomly"* and *"the voice coming low as compared to the music"*. The episode and the reels are now deliberately different products.

**Episode** — calm conversation. Cuts land only on speaker changes, never mid-sentence, minimum ~5s shots, one fixed crop per camera, **no zoom / push-in / Ken Burns / pan of any kind**. **No music. No captions** (it goes to YouTube, which auto-generates them).

**Reels** — social treatment. Karaoke captions and a music bed stay, because reels play muted in-feed and have no auto-captioning.

## Hard-won rules
- Be **specific** in prompts: "vertical 1080x1920" alone gives a letterboxed 16:9 island; you must say "fill the frame, scale up, crop the sides, no black bars".
- **Change `producePrompt` and `qaPrompt` together.** The old QA list demanded "no static shot longer than 8s" and "framing varies between scenes", so it *added five scene splits* to the intro. A QA pass encoding the wrong standard manufactures the defect instead of catching it.
- Never ask for music fades (impossible via agent — needs manual volume keyframes).
- **Verify reels by measurement, not in the player.** The first three reels looked perfect and were unusable at -34.7 LUFS (episode: -13.7), voice only 3.9 dB above the music. See the ffprobe/cropdetect/ebur128 commands in `docs/descript-capabilities.md`.
- Verify a `target` composition id before POSTing /api/command — an empty target silently means "whole project".
- Always run the tsc stub check before deploying; edge deploys don't typecheck.

## Deploy discipline — read this before deploying
`function/index.ts` is the source of truth, **but confirm that before you trust it.** On 26 Aug the deployed v16 had drifted: the publish-retry counter, the admin allowlist for branding/music/caption/QA fields, and the owner guards on team add/remove existed only in production, never committed. Deploying the repo file would have silently reverted all three.

Every deploy should be:
1. `get_edge_function` → extract `files[0].content` → `diff` against `function/index.ts`. Reconcile anything production has that the repo doesn't.
2. Typecheck (Deno globals + supabase-js stubbed; see below).
3. Deploy with the whole file inline, `verify_jwt: false`.
4. **Re-fetch and diff again** — confirm the deployed bytes match the file exactly.
5. Commit and push so the repo keeps matching production.

Typecheck harness (no Deno/tsc on this machine by default):
```bash
npm install typescript@5.6.3
# stubs.d.ts: declare Deno.env.get/Deno.serve and the npm:@supabase/supabase-js@2 module
npx tsc --noEmit --skipLibCheck --target ES2022 --lib ES2022,DOM --moduleResolution Bundler stubs.d.ts index.ts
```

## BLOCKED: the Descript drive is out of AI credits (26 Aug)

`make_reels` failed with *"Insufficient AI credits to complete the request"*. **Nothing agent-driven can run until the plan is topped up** — no produce, no QA, no reels. Usage on this drive: 208 credits on 25 Aug, 692 on 26 Aug. A single production pass is 40–90 credits and QA adds ~30, so iterating on prompts is expensive; change the prompt once, run once, measure.

**When credits are back**, one click of Produce on the Convergence episode exercises everything that is fixed but never yet tested end to end: the required fixed crop, protected reaction shots, and the Shorts caption geometry.

State of that episode right now: the **episode itself is good** (no music, no captions, -14.0 LUFS, full 16:9, host visible, 8 cuts) but the framing is still raw-camera loose and QA had stripped two reaction shots before v21 protected them. **Reels are selected but not rendered** — `select_reels` replaces prior picks, so the two reels that had already rendered correctly are no longer listed. Their compositions still exist and Descript share links are permanent:

- Reel 1 — AI Slop Is Common · comp `90672bfb-64bd-4454-afed-931a16a70f31` · https://share.descript.com/view/669jbhGrtBI
- Reel 2 — Content Got Commoditized · comp `3c593208-0747-489c-bf52-019b285342a5` · https://share.descript.com/view/FmAXWtPZTpZ

Both measured correctly (-14.3 and -13.7 LUFS, 1080x1920, `crop=0:0`) but carry the old sentence-block captions.

## Known limitation: Shorts-style captions may not be reachable

Descript exposes font, size, alignment, colours, borders, active/future word styling and placement — but **no words-per-line, max-lines or caption-box-width setting**, and "one word on screen at a time" is an [open feature request since Nov 2020](https://feedback.descript.com/features/p/captions-word-one-the-screen). v21 tries the only available lever (narrow caption box + single-line height + large text, so Descript must split into more cards). **This is untested** — credits ran out before it rendered.

If it does not work, the options are: accept 2-line karaoke captions as Descript's ceiling; burn our own captions after render (needs word-level timings, which Descript does not expose — Whisper via the existing OpenAI key could supply them, but the pipeline runs on Edge Functions and cannot run ffmpeg, so this needs a media worker); or use a dedicated captioning tool for the reel stage.

## Immediately next
1. Top up Descript AI credits, then press Produce on the Convergence episode and measure.
2. Verify the two untested v21 changes: is a fixed crop actually applied, and do reaction shots survive QA?
3. Set a branding logo for Edbound in ⚙ Settings to test the logo overlay path end to end.
4. Turn on auto-produce for the first real client at onboarding.
