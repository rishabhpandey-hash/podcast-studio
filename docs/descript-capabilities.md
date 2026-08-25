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
- **No explicit zoom-in/zoom-out, layout, or scene-template parameters.** Not in any endpoint or documented example. If achievable, it is only via an agent prompt, unguaranteed. Do NOT promise "automatic zoom effects" in the two-pager; say "dynamic editing chosen by the AI."
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

## Also exists (not used yet)

- **Descript MCP server** (`api.descript.com/v2/mcp`, OAuth) — same Underlord toolkit for interactive Claude sessions; useful for ad-hoc internal work, not for the server pipeline (token auth of the REST API fits better).
- Official CLI: `npm i -g @descript/platform-cli` (`descript-api import/agent/…`) — handy for manual testing.
- Partner "Edit in Descript" API — invite-only, not needed.
