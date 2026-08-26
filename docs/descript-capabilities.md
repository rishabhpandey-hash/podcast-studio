# Descript API — what's possible, what's not (verified 2026-08-25)

Source: full crawl of https://docs.descriptapi.com (OpenAPI spec v1.2) + Descript help center + descript.com/api.
This is the factual basis for the client-facing two-pager and for what we promise.

## The one architectural fact

The Descript API is a **job-queue + AI-agent API, not a timeline-editing API**. Deterministic control exists only at import (media files, multitrack offsets, clip order, canvas size) and at render (resolution, video/audio, access level). **Every editorial decision in between goes through one endpoint — `POST /v1/jobs/agent` — as a natural-language prompt to Underlord** (which runs on Claude models; selectable: `auto`, `claude-opus-4.8` high-cost, `claude-haiku-4.5` low-cost).

## CAN do via API (docs-confirmed)

- Import audio/video by URL or direct upload; automatic transcription (language auto-detected or ISO 639-1).
- Agent edits by prompt: remove filler words, cut timecode ranges ("remove 1:30–2:15"), Studio Sound on all clips, captions, "create a 30-second highlight reel", create new compositions.
- Publish/render a composition: 480p–4K video (or audio), returns permanent share URL + time-limited signed download URL. Republishing overwrites content but keeps the same share URL.
- Export transcript synchronously: txt / markdown / html / rtf / docx / srt (with speaker labels and timecodes).
- Per-job completion webhooks (`callback_url`), job progress polling with human-readable step labels, job cancel.
- List/inspect projects, compositions, media, existing publishes.

## CANNOT do via API (set expectations accordingly)

- **No deterministic edit ops** — no "delete word range", no timeline mutation, no guaranteed outcome. Agent results must be reviewed via the share link or by opening the project in Descript.
- **No explicit zoom/layout/scene API parameters** — but see the verified finding below: the agent CAN do zoom and multicam when asked in prose. There is still no deterministic knob, so treat it as "the AI applies dynamic camera work" rather than a guaranteed setting.
- No caption style controls, no codec/bitrate choice, no burned-caption toggle.
- No word-level transcript JSON / diarization data endpoint (formatted file exports only).
- No project delete/rename/move; no composition CRUD outside import + agent.
- No standing webhook subscriptions (per-job callbacks only), no webhook signing.
- No usage/quota endpoint — you learn credits ran out via HTTP 402.
- YouTube URLs are not importable. Job history queryable max 30 days back.

## Caveats for the two-pager (Kinner's asks)

- **Multi-speaker reels:** the AI auto-selects who's on screen; clients can open the project in Descript and change it themselves (that's their intervention, not our service). Our reel prompt asks the agent to keep the active speaker framed — outcome depends on Underlord.
- **Cost model:** agent edits consume the client's Descript **AI credits**; recording/import consumes **media minutes**. Both are on the client's own paid Descript plan ("API access is available for all paying users at no additional cost").
- **Accounts:** an API token is scoped to one Drive and inherits the creator's permissions. One token per client Drive = clean per-client isolation (our model). A drive admin can disable agent access (→ 403).
- **Transparency:** per the 2026-08-25 meeting — tell clients it runs on Descript (preferred over Riverside because of API/MCP connectivity); do not name the underlying AI stack.
- Releases improve the system quarterly — Descript's model catalog endpoint (`GET /v1/agent/models`) changes as models launch, and our pipeline picks them up via config, no rebuild.

## VERIFIED IN PRODUCTION 2026-08-25/26 (beyond the docs)

These were tested on a real two-person Rooms episode through our own AI-assistant chat, and Underlord delivered them even though no API parameter exists:
- **Randomized zoom in/out per speaker** — prompt produced "randomized zoom levels (1.15x-1.4x) with varied focal points across all scenes for each speaker track… focal point slightly above center (y ~0.36-0.44) to keep faces well-framed". So George's/Kinner's zoom question is answered: **yes, achievable by prompt**, no manual editing.
- **Automatic multicam switching** — prompt produced a composition that "switches between all three cameras based on who is actively speaking, with scenes created throughout the timeline". This resolves the multi-speaker framing caveat from the 25 Aug meeting: the AI does pick the active speaker automatically.
- **Timecoded transcript export works** (`timecodes: {on_paragraphs, on_speakers}` + `include_speaker_labels: "every_paragraph"`) — this is what makes our own clip-scoring layer possible.
- **Agent honours explicit time ranges** ("from 0:40 to 1:22"), which is how we cut scored clips deterministically.
- Caveat that remains: outcomes are prompt-driven, so they are reproducible in practice but not contractually guaranteed. Always review the share link.

## THE reel-quality gotcha (found 26 Aug, fixed)

**A portrait canvas is not a reel.** Told only "vertical 1080x1920", Underlord creates the right canvas but leaves the 16:9 source letterboxed in the middle — a small widescreen island with huge black bars, captions floating below it. Unusable for social, and it looked like the feature was broken.

The fix is prompt-level and now baked into every reel job (`REEL_FRAMING` in the function):
- the footage must FILL the frame edge to edge — scale the source UP and crop the sides; no black bars, no letterboxing, no empty space (stated explicitly, including that a floating 16:9 video "is wrong and unusable")
- frame the person, not the room: head and shoulders filling the width, eyes ~1/3 down, crop sides never the face
- cut to whoever is speaking and re-crop them the same way
- captions burned in, large, bold, centred in the lower third, clear of the bottom edge, never over the face
- plus the client's logo in the chosen corner at ~10% width

Verified: an already-broken reel was repaired with this exact instruction and the agent replied "bounding box expanded to cover the entire canvas, source scales to fill edge-to-edge with sides cropped". There is also a one-click **Fix framing** action on every reel card for the rare miss.

**Lesson for the two-pager:** Descript's agent does what it is told very literally. First-draft quality comes from prompt specificity, not from extra human passes.

## The production standard — corrected after the first client review (26 Aug)

The first attempt only removed filler words, so the episode looked like a raw recording. The **second** attempt over-corrected: constant multicam switching, alternating crops and push-ins on every long stretch. The client's verdict on that cut was blunt — *"looking like a trailer rather than a podcast shoot… video is moving here and there, the screen changing randomly"*. Both failures came from the same prompt, so the standard is now split by format.

**The episode is a calm conversation, not a showreel:**

**Edit:** filler words, false starts, stumbles and retakes out; obviously long silences closed, but the natural rhythm kept — not rushed or clipped; off-topic housekeeping cut.
**Vision:** the camera shows whoever is speaking and **stays** on them. A cut happens *only* because the speaker changed, never mid-sentence and never for energy. Minimum shot ~5s, one consistent crop per camera, and **no zoom, push-in, Ken Burns drift, pan or scaling of any kind**. Hard cuts only. Full 16:9 frame, and never a multi-camera layout where a feed is dead (that leaves a black panel).
**Sound:** Studio Sound on every clip, speakers level-matched, and **no music** — the episode carries the conversation only.
**Finishing:** Eye Contact correction and the branding logo. **No captions** — the episode goes to YouTube, which generates its own subtitles.

**Reels keep the social treatment**, because they play muted in-feed and have no auto-captioning: word-by-word karaoke highlighting, spoken word in a bright accent colour on bold white, heavy sans-serif, dark outline, 3–6 words per line, **max 2 lines**, baseline at 78–82% of frame height, plus the music bed (Subtle / Energetic / None per client).

**Lesson:** "make it look produced" is not a spec. Underlord applies whatever intensity the prompt implies, so the prompt has to say how *restrained* to be, not just what to add.

## The QA pass (the reason a client shouldn't need to send notes)

After the episode is published and **before** reels or posts are built on it, a second agent job re-checks the composition against a 9-point checklist (pacing, cuts landing on speaker changes, minimum shot length, no movement inside a shot, full frame, Studio Sound + levels, no music track, no caption track, logo) and **fixes anything that fails**, then re-renders. Its PASS/FIXED report is stored on the episode and shown in the dashboard. Per-client toggle, on by default; a manual "Re-run quality check" button exists too.

**The checklist has to agree with the production brief.** The original QA list demanded "no static shot longer than 8 seconds" and "framing varies between scenes" — so on the trailer-style cut it did exactly what it was told and *added five more scene splits to the intro*. A QA pass that encodes the wrong standard does not catch the defect, it manufactures it. Both prompts are now changed together, and the QA brief opens by stating that removing cuts and movement **is** the fix.

Cost note: this roughly doubles the agent credits per episode (one production pass + one QA pass). That is the trade for a first draft the client accepts.

## What the first live QA pass actually caught (26 Aug)

Proof the pass is not decoration — on a freshly produced 3-camera episode it found and fixed three defects the production pass had left:
1. **15.2s of dead post-recording chat** still on the end of the composition.
2. **A 44.7-second completely static opening shot** — exactly the "dull" problem. It split the intro into five scenes at 8s intervals with alternating layouts.
3. **A black bar on the right of the final scene**, caused by a 3-camera layout left in place where only 2 feeds were live. Lesson now baked into the production brief: never leave a multi-camera layout where a feed is inactive.

It also surfaced one **hard API limit**: music **fade in/out cannot be applied by the agent** — volume keyframe automation needs manual timeline editing. The music itself, its level and speech ducking all work; only the fades don't. We stopped asking for fades so the report no longer carries a permanent "NOT POSSIBLE" line.

## Reel audio: measure it, don't trust it (26 Aug)

The first three real reels looked perfect and were unusable. Measured with `ffmpeg`:

| | Episode | Reel 1 | Reel 2 | Reel 3 |
|---|---|---|---|---|
| Integrated loudness | **-13.7 LUFS** | -34.7 | -34.9 | -34.8 |
| Voice-above-bed spread | 7.7 dB | **3.9 dB** | — | — |

Same conversation, same 43 seconds: the reel's speech came out **21 dB quieter** than the identical speech in the episode, and the gap between speech and the music bed collapsed to under 4 dB, so the voice sat *level with* the music instead of on top of it. Social platforms normalise to roughly -14 LUFS, so these played as near-silence with the music as loud as the speaker. The client heard it immediately: *"the voice coming low as compared to the music"*.

Nothing in the share-link player reveals this — it looked fine and sounded fine at high volume. The reel prompt now states the target explicitly (about -14 LUFS integrated, peaks near -1 dBFS, music 18–20 dB under the speech, and **never** lower the speech to make room for music).

**Verify reels by measurement, not by eye.** Three commands catch what a player cannot:

```bash
ffprobe -v error -show_entries stream=width,height -of csv=p=0 reel.mp4   # 1080,1920
ffmpeg -i reel.mp4 -vf "fps=1,cropdetect=limit=24:round=2" -f null -      # want crop=1080:1920:0:0
ffmpeg -i reel.mp4 -af ebur128=framelog=quiet -f null -                   # want I: about -14 LUFS
```

`cropdetect` reporting the full frame at offset `0:0` is the definitive proof there is no letterboxing — it is the check that would have caught the original black-bar bug in seconds.

## Reels: always a choice

Clip length adapts to the episode (20–45s on short recordings, 30–60s on real ones), the count targets **at least 3 options** wherever the runtime allows, and regenerating passes the previously offered ranges as a do-not-reuse list so a second pass finds genuinely different moments. Recordings under 25 seconds are skipped with a plain explanation rather than a failure.

## Our reel-selection layer (added 26 Aug, George's spec)

Descript's agent alone picks clips by vibe. We now score them ourselves first:
1. Export the **timecoded** transcript (speaker labels on every paragraph).
2. GPT scores every candidate exchange on **emotion, context, conversation dynamics, ICP relevance** and assigns a **K-factor (0-100)**.
3. Server-side validation: 20-75s length clamp, no overlaps, inside episode bounds, ranked by K-factor, count capped by episode length (~55s of runway per clip so the model is never forced to pad).
4. The picks are **prelisted on the dashboard with scores, hooks and rationale** before any rendering happens.
5. Underlord is then given the **exact ranges and names** to cut as 9:16 subtitled reels.

Known behaviour: on a short episode the model correctly returns fewer clips than the maximum (a 3.7-minute episode yielded 1-2 genuinely strong exchanges, not 7). Quality over quota is intentional — a 45-60 minute episode is what actually yields 7.

## Also exists (not used yet)

- **Descript MCP server** (`api.descript.com/v2/mcp`, OAuth) — same Underlord toolkit for interactive Claude sessions; useful for ad-hoc internal work, not for the server pipeline (token auth of the REST API fits better).
- Official CLI: `npm i -g @descript/platform-cli` (`descript-api import/agent/…`) — handy for manual testing.
- Partner "Edit in Descript" API — invite-only, not needed.
