# Podcast Studio

Agentic podcast production for clients: record once in Descript → get the edited episode, 5–15 short-form reels, and 10–15 LinkedIn posts at one central place. Fully automated after one-time onboarding; clients tweak anything by chatting with the AI editor.

**Live dashboard:** https://rishabhpandey-hash.github.io/podcast-studio/?key=CLIENT_ACCESS_KEY
**API:** `https://mgnjlymtjmcoskqinhid.supabase.co/functions/v1/studio` (edge function `studio`, Supabase project `mgnjlymtjmcoskqinhid`, tables prefixed `ps_`)

## How it works

1. **Onboarding (one time, admin):** client generates a Descript API token (Descript app → Settings → API tokens, scoped to their Drive) and we store it via `POST /admin/clients`. They get an access-key link to this dashboard.
2. **Discovery:** every ~5 minutes (and on "Check for new recordings") we list the Drive's projects via `GET /v1/projects` and register new recordings as episodes. With `auto_produce` on, new recordings (created after onboarding) go straight into production.
3. **Produce:** a Descript **Underlord agent job** (`POST /v1/jobs/agent`) edits the episode — filler words out, dead air cut, Studio Sound, captions. Then `POST /v1/jobs/publish` renders 1080p and returns a share URL + signed download URL.
4. **Reel selection (`select_reels`):** the timecoded transcript is scored by an LLM on emotion, context, conversation dynamics and ICP relevance, producing a **K-factor (0-100)** per candidate exchange. Server-side rules then enforce 20–75s length, no overlaps, episode bounds, and a count capped by episode length (~55s runway per clip). Picks land in `ps_reels` with `rank`/`k_factor`/`hook`/`why`/`start_s`/`end_s` and are **visible on the dashboard before rendering**.
5. **Reel cutting (`make_reels`):** one agent job cuts those **exact ranges** as 1080×1920 subtitled compositions (falls back to a generic prompt only if no selection exists), then each is published in rank order.
6. **LinkedIn posts:** the transcript is exported (`POST /v1/export/transcript`, markdown) and an LLM (OpenAI GPT, `openai_model` config, default gpt-5.5) writes 12 publish-ready posts (hook, body, first comment) tuned to the client's `target_audience` / `brand_notes`.
7. **Tweaks:** each chat message in the dashboard becomes an agent job (optionally targeted at the main episode or a specific reel via `composition_id`), then a republish — republishing reuses the same share URL.

All async work is a state machine in `ps_jobs` (`queued → agent_running → publishing → done/failed`), advanced by:
- Descript **per-job callbacks** → `POST /webhook?secret=…&job=<ps_job_id>` (fast path)
- pg_cron **`studio-minute-runner`** (every minute) → `POST /cron?secret=…` (poller safety net + discovery; 429s are left in place to retry)

## Repo layout

- `index.html` — the whole dashboard (static, GitHub Pages). Agent-friendly: `window.STUDIO` methods + state mirror in `<script id="studio-data">`.
- `function/index.ts` — the whole backend (deploy as Supabase edge function `studio`, `verify_jwt=false`). Before deploying, run the tsc stub check (edge deploys do NOT typecheck).
- `sql/001_init.sql` — schema.
- `docs/descript-capabilities.md` — what the Descript API can and cannot do (source material for the client-facing two-pager).

## API contract

Client (auth `?key=` or `X-Access-Key`):
- `GET /api/overview` · `GET /api/episode?id=` · `POST /api/refresh`
- `POST /api/produce {episode_id}` · `POST /api/reels {episode_id}` (re-scores + regenerates) · `POST /api/posts {episode_id}`
- `POST /api/room {url}` (save the standing guest-room link) · `GET /api/whoami`
- `GET /api/team` · `POST /api/team {email, is_admin}` · `POST /api/team/remove {email}` — email-signed-in admins only
- `POST /api/command {episode_id, text, target?}` — target `"main"` or a reel `composition_id`

Admin (auth `X-Admin-Secret`):
- `GET /admin/overview`
- `POST /admin/clients {name, descript_token?, logo_url?, target_audience?, brand_notes?, reel_count?, auto_produce?, descript_model?}` — validates the token against `GET /v1/status` and runs first discovery
- `POST /admin/clients/update {client_id, …}` · `POST /admin/config {key, value}` (e.g. `openai_api_key`, `openai_model`)

Secrets live in the `ps_config` table (`admin_secret`, `webhook_secret`, `openai_api_key`). Per-client Descript tokens live on `ps_clients.descript_token`. Nothing secret ships in this repo — the HTML contains only the public function URL.

## Onboarding runbook (per client)

1. Client (or we, on a call): Descript → Settings → API tokens → Create token for their Drive.
2. `POST /admin/clients` with name + token + target_audience (+ logo, reel_count, auto_produce).
3. Send them `…/podcast-studio/?key=<access_key>`.
4. They record; the system does the rest.

## Costs & limits (Descript side)

- Agent edits consume **AI credits**; imports/recordings consume **media minutes** — both on the *client's* Descript plan. Exhaustion → HTTP 402, surfaced in the dashboard as a friendly message.
- Job history is only queryable 30 days back (we persist everything in `ps_jobs` anyway).
- Download URLs are time-limited signed URLs; share URLs are permanent (and survive republishing).
