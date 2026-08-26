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

## Immediately next
1. The Convergence episode (`c3480cf6-9d46-4923-b2e3-20435ecb436c`) was re-produced under v18 — confirm the published cut and the new reels measure correctly (cuts, no music, no captions, reels at ~-14 LUFS).
2. Set a branding logo for Edbound in ⚙ Settings to test the logo overlay path end to end.
3. Turn on auto-produce for the first real client at onboarding.
4. Open question for the client: captions on reels are currently ON. Confirm that is wanted.
