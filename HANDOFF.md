# Handoff — Podcast Studio (2026-08-26)

Read `docs/descript-capabilities.md` and the `podcast-studio-project` memory first.

## Live now
- Dashboard: https://rishabhpandey-hash.github.io/podcast-studio/ (email sign-in; owners = rishabh.pandey@knorish.com, george.r@knorish.com)
- Backend: Supabase project `mgnjlymtjmcoskqinhid`, edge function `studio` **v16**, tables `ps_*`, pg_cron `studio-minute-runner`
- Pilot client: Edbound (`b24f5d3a-7426-4335-9d2a-2a434c5cec53`), Descript drive "George's Drive" connected, OpenAI key set (gpt-5.5)
- Repo: https://github.com/rishabhpandey-hash/podcast-studio (local `~/projects/podcast-studio`)

## Pipeline
record/upload → discover → (branding import) → **produce** → publish → **QA pass** (re-checks 8 points, fixes, republishes) → **select_reels** (K-factor scoring) → **make_reels** (exact ranges, full-frame 9:16) → publish each → **generate_posts**

## Immediately next
1. Check reel job `fcc8b815-2329-4411-91a7-e8375e5e8618` on episode `c3480cf6-9d46-4923-b2e3-20435ecb436c` — expect ~5 ranked reels; verify each is full-frame portrait with yellow karaoke captions and music.
2. Deploy the staged prompt fixes in `function/index.ts` (music fades removed, inactive-feed layout warning) — committed but NOT yet deployed as of v16.
3. Set a branding logo for Edbound in ⚙ Settings to test the logo overlay path end to end.
4. Turn on auto-produce for the first real client at onboarding.

## Hard-won rules
- Be **specific** in prompts: "vertical 1080x1920" alone gives a letterboxed 16:9 island; you must say "fill the frame, scale up, crop the sides, no black bars".
- Never ask for music fades (impossible via agent).
- Verify a `target` composition id before POSTing /api/command — an empty target silently means "whole project".
- Always run the tsc stub check before deploying; edge deploys don't typecheck.
