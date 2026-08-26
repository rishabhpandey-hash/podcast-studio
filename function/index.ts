// Podcast Studio — agentic podcast production pipeline
// Edge function `studio` in Supabase project mgnjlymtjmcoskqinhid (verify_jwt = false).
//
// Flow: client records in Descript → we discover the project → Underlord agent job
// produces the episode (filler words, studio sound, captions) → publish (share +
// download URLs) → our own selection layer scores every conversational exchange
// (emotion, context, dynamics, ICP fit, K-factor) and ranks the best N → an agent
// job cuts those exact ranges as 9:16 subtitled reels → each published → transcript
// exported → an LLM writes LinkedIn posts. Clients chat tweaks from the dashboard;
// each message becomes an Underlord agent job, then a republish.
//
// Descript API: https://docs.descriptapi.com (base https://descriptapi.com/v1)
// All editorial ops go through POST /jobs/agent (natural-language prompt).

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DSC_BASE = "https://descriptapi.com/v1";
const PUBLIC_ORIGIN = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const FN_URL = `${PUBLIC_ORIGIN}/functions/v1/studio`;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-access-key, x-admin-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- config ----------
async function cfg(key: string): Promise<string | null> {
  const { data } = await supabase.from("ps_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function setCfg(key: string, value: string) {
  await supabase.from("ps_config").upsert({ key, value, updated_at: new Date().toISOString() });
}
async function logEvent(event_type: string, payload: unknown) {
  await supabase.from("ps_events").insert({ event_type, payload });
}

// ---------- Descript client ----------
class DscError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function dsc(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${DSC_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text?.slice(0, 500) }; }
  if (!res.ok) {
    const msg = data?.message || data?.error || data?.raw || `HTTP ${res.status}`;
    throw new DscError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

// Transcript export returns the file itself, not JSON.
async function dscTranscript(token: string, project_id: string, composition_id?: string, timed = false): Promise<string> {
  const res = await fetch(`${DSC_BASE}/export/transcript`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id,
      ...(composition_id ? { composition_id } : {}),
      format: "markdown",
      // Every speaker turn labelled; timecodes on speakers+paragraphs give the
      // selection model the anchors it needs to name exact clip ranges.
      include_speaker_labels: timed ? "every_paragraph" : "changes",
      ...(timed ? { timecodes: { on_paragraphs: true, on_speakers: true } } : {}),
    }),
  });
  if (!res.ok) throw new DscError(res.status, `transcript export failed: ${(await res.text()).slice(0, 300)}`);
  return await res.text();
}

function humanDscError(e: unknown): string {
  if (e instanceof DscError) {
    if (e.status === 402) return "The connected Descript plan has run out of media minutes or AI credits. Top up the Descript plan and retry.";
    if (e.status === 401) return "The Descript connection is no longer valid. Please reconnect the account.";
    if (e.status === 403) return "The Descript account does not allow this action (agent access may be disabled by a drive admin).";
    if (e.status === 429) return "The editing service is busy right now. It will retry automatically.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

// ---------- auth ----------
// Two ways in: a per-client access key (external clients) or a Supabase Auth
// magic-link session (team members whitelisted in ps_users).
type Authn = { client: any; email?: string; is_admin?: boolean; is_owner?: boolean };

async function resolveClient(req: Request, url: URL): Promise<Authn | null> {
  const key = url.searchParams.get("key") || req.headers.get("x-access-key") || "";
  if (key) {
    const { data } = await supabase.from("ps_clients").select("*").eq("access_key", key).eq("active", true).maybeSingle();
    if (data) return { client: data };
  }
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data: u } = await supabase.auth.getUser(jwt);
  const email = u?.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: memb } = await supabase.from("ps_users").select("*").eq("email", email).maybeSingle();
  if (!memb) return null;

  // Owners (our team) may act on any client; everyone else is locked to theirs.
  const wanted = url.searchParams.get("client_id");
  if (memb.is_owner) {
    let q = supabase.from("ps_clients").select("*").eq("active", true);
    const { data: c } = wanted
      ? await q.eq("id", wanted).maybeSingle()
      : await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!c) return null;
    return { client: c, email, is_admin: true, is_owner: true };
  }
  if (!memb.client_id) return null;
  if (wanted && wanted !== memb.client_id) return null; // never cross client lines
  const { data: own } = await supabase.from("ps_clients").select("*")
    .eq("id", memb.client_id).eq("active", true).maybeSingle();
  if (!own) return null;
  return { client: own, email, is_admin: !!memb.is_admin, is_owner: false };
}
async function isAdmin(req: Request, url: URL): Promise<boolean> {
  const secret = req.headers.get("x-admin-secret") || url.searchParams.get("admin_secret") || "";
  if (!secret) return false;
  const stored = await cfg("admin_secret");
  return !!stored && secret === stored;
}

// ---------- prompts ----------

function musicLine(client: any, forReel: boolean): string {
  const m = client?.music_style ?? "subtle";
  if (m === "none") return "";
  const energy = m === "energetic"
    ? (forReel ? "an upbeat, driving track that suits a punchy social clip" : "a light, modern track with gentle energy")
    : "an understated, tasteful track that sits far behind the voices";
  return `- Add background music from Descript's royalty-free library: ${energy}. Keep it clearly under the speech at all times (duck it whenever anyone talks) and never let it compete with the dialogue. Start it with the first frame and end it with the last.`;
}

function captionLine(client: any): string {
  const trending = (client?.caption_style ?? "trending") !== "clean";
  return trending
    ? "- Captions in the modern social style: burned in, with word-by-word karaoke highlighting where the word currently being spoken is emphasised in a bright accent colour against bold white text. Heavy sans-serif face, never thin or light weights, with a subtle dark outline or shadow so it reads on any background. Large enough to read on a phone at arm's length. 3 to 6 words per line, two lines maximum on screen at once, centred. Place the caption block so its baseline sits around 78-82% of the frame height: clearly inside the lower third, with breathing room beneath it, never touching the bottom edge and never covering a face."
    : "- Captions: burned in, clean and understated, bold white sans-serif with a soft shadow, 3 to 6 words per line, two lines maximum, centred, baseline around 78-82% of the frame height, never touching the bottom edge or covering a face.";
}

function reelFraming(client: any, shortEpisode: boolean): string[] {
  return [
    "- Canvas: vertical 1080x1920 (9:16).",
    "- CRITICAL FRAMING: the footage must FILL the entire vertical frame, edge to edge. Scale the widescreen source UP and crop the left and right sides. There must be NO black bars, NO letterboxing at the top or bottom, and no empty space anywhere in the frame. A small 16:9 video floating in the middle of a black portrait canvas is wrong and unusable.",
    "- Frame the person, not the room: the speaker's head and shoulders should fill most of the width, face in the upper-middle of the frame with the eyes roughly a third of the way down, and comfortable headroom. Crop the sides, never crop the face.",
    "- When several people speak, cut to whoever is speaking and re-crop so that person is centred and filling the frame the same way.",
    captionLine(client),
    "- Cut hard into the first word with no fade in, and end cleanly on the last word.",
    "- Remove filler words and dead air inside the clip so it never drags, and apply Studio Sound.",
    "- Add a subtle push-in on the strongest line so the frame is never static for the whole clip.",
    musicLine(client, true),
    `- Length: ${shortEpisode ? "20 to 45 seconds" : "30 to 60 seconds"} \u2014 whatever makes the moment land without padding.`,
    "- No intro, no outro, no title cards, no stock footage.",
  ].filter(Boolean);
}

// After production, verify the result against the standard the client will judge
// it by and fix whatever is missing. This is the pass that stops half-finished
// work reaching a client.
function qaPrompt(client: any, brandFile?: string | null): string {
  const pos = (client?.watermark_position === "top-left") ? "top-left" : "top-right";
  const music = (client?.music_style ?? "subtle") !== "none";
  return [
    "Quality-check the main (longest) video composition of this project against the checklist below. For every item: if it is already satisfied, leave it alone; if it is NOT satisfied, fix it now.",
    "",
    "1. No filler words, stumbles, retakes or dead air remain, and the pacing feels crisp.",
    "2. If multiple cameras or speaker tracks exist, the visible camera follows the active speaker across the whole timeline, with no static shot held longer than about 8 seconds.",
    "3. Framing varies between scenes and no stretch is completely frozen; faces are well framed with the eyeline in the upper third.",
    "4. The footage fills the entire 16:9 frame: no black bars, no letterboxing, no empty space.",
    "5. Studio Sound is applied to every clip and all speakers are level-matched.",
    music ? "6. Background music is present and sits clearly under the speech. (Volume fades need manual keyframes and are out of scope \u2014 do not report them as a failure.)" : "6. There is no unintended background music or noise.",
    "7. Captions are burned in, bold, readable on a phone, correctly timed, two lines maximum, and never cover a face or touch the bottom edge.",
    brandFile ? `8. The branding image "${brandFile}" is visible in the ${pos} corner for the whole episode and covers nothing important.` : "8. No stray overlays or leftover graphics remain.",
    "",
    "Then reply with one short line per item saying PASS or FIXED (naming what you changed). If something genuinely cannot be done with this footage, say NOT POSSIBLE and why.",
  ].filter(Boolean).join("\n");
}
function producePrompt(client: any, brandFile?: string | null): string {
  const pos = (client?.watermark_position === "top-left") ? "top-left" : "top-right";
  return [
    "You are producing a recorded podcast episode into a finished, publish-ready video. The result must look like a professionally edited show, not a raw recording. Work on the main (longest) video composition of this project.",
    "",
    "TIGHTEN THE EDIT:",
    "- Remove every filler word (um, uh, like, you know), false start, stumble and repeated sentence.",
    "- Remove retakes, keeping the best take of anything said twice.",
    "- Shorten the gaps between words and sentences so the pacing feels crisp, and cut all dead air and long pauses.",
    "- Cut throat-clearing, background chatter and any off-topic housekeeping at the start or the end.",
    "",
    "MAKE IT VISUALLY ALIVE (this is what separates a finished show from a static talking head):",
    "- If there is more than one camera or speaker track, set up automatic multicam: the visible camera must follow whoever is speaking, with scenes across the entire timeline. Never hold one static shot for more than about 8 seconds when another angle exists; cut on speaker changes and on reactions.",
    "- Vary the framing between scenes: alternate slightly wider and tighter crops (roughly 1.05x to 1.35x) with the focal point a little above centre so faces stay well framed and the eyeline sits in the upper third.",
    "- On any long single-speaker stretch, add a slow, subtle push-in or Ken Burns style drift so the frame is never frozen.",
    "- Use clean, quick transitions between scenes: simple cuts, or a short crossfade where it genuinely helps. Nothing flashy.",
    "- The footage must fill the whole 16:9 frame: no black bars, no letterboxing, no empty space. Never leave a multi-camera layout in place when one of its feeds is inactive \u2014 that leaves a black panel; switch that scene to a layout that matches the number of live speakers.",
    "",
    "MAKE IT SOUND PROFESSIONAL:",
    "- Apply Studio Sound to every clip so voices are clean, warm and level-matched across speakers.",
    "- Balance the speakers against each other so nobody is noticeably louder or quieter.",
    musicLine(client, false),
    "",
    "FINISHING:",
    captionLine(client),
    "- Apply Eye Contact correction to the speaker tracks if the footage supports it, so speakers appear to look at the camera.",
    brandFile
      ? `- The image "${brandFile}" is in this project. Place it as a small persistent branding overlay in the ${pos} corner, about 8-10% of the frame width, inside a comfortable safe margin, visible for the entire episode, never covering a face or the captions.`
      : "",
    "",
    "Do not reorder the conversation, do not remove substantive content, and do not add stock footage or b-roll. Keep the composition's existing name.",
    client?.intro_notes ? `Extra production notes from the client: ${client.intro_notes}` : "",
  ].filter(Boolean).join("\n");
}


function brandLine(client: any, brandFile?: string | null): string {
  if (!brandFile) return "";
  const pos = (client?.watermark_position === "top-left") ? "top-left" : "top-right";
  return `- Place the image "${brandFile}" as a small logo in the ${pos} corner at about 10% of the frame width, inside a comfortable safe margin, visible for the whole clip and never covering a face or the captions.`;
}

function reelsPrompt(client: any, episodeName: string, n: number, brandFile?: string | null, shortEpisode = false): string {
  return [
    `From this project's main podcast composition, create ${n} NEW separate compositions, each a ready-to-post short-form social reel built around one strong self-contained moment.`,
    "Requirements for every reel:",
    ...reelFraming(client, shortEpisode),
    brandLine(client, brandFile),
    `- Name each new composition exactly like: "Reel 1 — <short title>", "Reel 2 — <short title>", and so on.`,
    "Pick genuinely different moments across the episode; never overlap the same segment twice.",
    "Do not modify the original main composition.",
    client?.target_audience ? `The audience for these reels: ${client.target_audience}.` : "",
  ].filter(Boolean).join("\n");
}

function fmtTc(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Build the Underlord prompt from clips our own selection layer already chose,
// so the agent cuts exact ranges instead of guessing what is interesting.
function timedReelsPrompt(client: any, picks: any[], brandFile?: string | null, shortEpisode = false): string {
  const lines = picks.map((p: any, i: number) =>
    `${i + 1}. "Reel ${i + 1} — ${String(p.title ?? "Clip").replace(/"/g, "")}" — from ${fmtTc(p.start_s)} to ${fmtTc(p.end_s)}${p.hook ? ` (opens on: "${String(p.hook).slice(0, 120)}")` : ""}`);
  return [
    `Create ${picks.length} NEW separate compositions from this project's main podcast composition. Use EXACTLY these time ranges and names:`,
    "",
    ...lines,
    "",
    "Every one of these must be a finished, ready-to-post vertical reel that needs no further editing:",
    ...reelFraming(client, shortEpisode),
    "- Keep the full conversational exchange inside the given range: the hook AND the response that pays it off.",
    brandLine(client, brandFile),
    "Do not modify the original main composition, and do not create any compositions beyond the ones listed.",
    client?.target_audience ? `Audience context: ${client.target_audience}.` : "",
  ].filter(Boolean).join("\n");
}

// George's reel-selection spec: emotion + context + conversation dynamics + ICP
// relevance, scored by K-factor, top N ranked, each standing alone as a reel.
function reelSelectionPrompt(client: any, episodeName: string, transcript: string, n: number, episodeDuration: number, avoid: [number, number][] = []): string {
  return `You are a short-form virality strategist. Below is the timecoded transcript of a podcast episode titled "${episodeName}".

${client?.target_audience ? `ICP / target audience: ${client.target_audience}` : "ICP / target audience: senior professionals in the speaker's industry."}
${client?.brand_notes ? `Brand and tone notes: ${client.brand_notes}` : ""}

Find up to ${n} of the highest-virality CONVERSATIONAL EXCHANGES to cut as vertical reels.
The episode is ${Math.round(Number(episodeDuration) || 0)} seconds long, so returning FEWER than ${n} clips is correct and expected when there simply is not enough strong material. Never pad, never overlap, never stretch a weak moment to fill the count.

How to judge every candidate (this is the whole job):
- EMOTION: tension, surprise, conviction, humour, vulnerability, a strong opinion.
- CONTEXT: it makes sense with zero knowledge of the rest of the episode.
- CONVERSATION DYNAMICS: prefer a real exchange — one person makes a statement or asks something that creates intrigue, the other answers and pays it off. A back-and-forth beats an isolated soundbite.
- ICP RELEVANCE: it speaks to the audience above and their problems.
- K-FACTOR (0-100): how likely a viewer is to share, save or comment. Weigh hook strength, emotional charge, specificity (numbers, names, stakes), contrarian value, and how quotable the payoff is. Be honest and discriminating — spread the scores, do not give everything 80+.

${avoid.length ? `Already offered to this client and REJECTED as options \u2014 do not choose these ranges or anything substantially overlapping them, find genuinely different moments: ${avoid.map(([a, b]) => `${a}-${b}s`).join(", ")}\n` : ""}Hard rules for each clip:
- ${Number(episodeDuration) > 0 && Number(episodeDuration) < 420 ? "20 to 45 seconds long (this is a short episode, so shorter clips are expected)" : "30 to 60 seconds long, aiming for ~45 seconds"}.
- Give the client a CHOICE: return several distinct options spread across the episode, not one.
- Must START on the hook line itself — the first sentence has to earn attention with no setup.
- Must CONTAIN the response/payoff, so the exchange resolves inside the clip.
- Use timecodes that exist in the transcript; start_s and end_s are SECONDS from the episode start (integers).
- Clips must not overlap each other, and must be spread across the episode, not all from one stretch.
- Never invent words that were not said.

Return ONLY a JSON array of 1 to ${n} objects (as many as genuinely deserve it), ranked by k_factor descending, no markdown fences. Never return an empty array — if the material is weak, still return your single best exchange:
[{"title":"<3-6 word title>","hook":"<the opening line, verbatim>","why":"<1-2 sentences: why this will travel — name the emotion, the dynamic and the ICP relevance>","k_factor":<0-100 integer>,"start_s":<integer seconds>,"end_s":<integer seconds>,"speakers":"<who speaks, comma separated>","excerpt":"<the key 1-3 lines of the exchange, verbatim>"}]

TRANSCRIPT (timecodes are [HH:MM:SS] or [MM:SS]):
${transcript}`;
}

function commandPrompt(text: string): string {
  return [
    "You are helping the owner of this project refine their podcast content. Apply the following request exactly and conservatively — change only what the request asks for, in this project only:",
    "",
    text.trim(),
  ].join("\n");
}

function postsPrompt(client: any, episodeName: string, transcript: string): string {
  return `You are a world-class LinkedIn ghostwriter. Below is the transcript of a podcast episode titled "${episodeName}".

${client?.target_audience ? `Target audience: ${client.target_audience}` : "Target audience: senior professionals in the speaker's industry."}
${client?.brand_notes ? `Brand and tone notes: ${client.brand_notes}` : ""}

Write 12 publish-ready LinkedIn posts extracted from this episode. Rules:
- Each post stands alone: one sharp idea, insight, story, or contrarian take actually said in the episode. Never invent claims.
- Line 1 is a killer hook (short, curiosity or tension, no clickbait lies). Then short lines, generous whitespace, plain language.
- 80-180 words each. No hashtags. No emojis unless one genuinely lands. No "In today's episode..." framing — write as the speaker sharing their own thinking.
- Vary the formats across the 12: personal story, contrarian take, listicle, observation, hard-won lesson, question post.
- For each post also write a "first_comment": one sentence the author can post as the first comment (a link tease, context, or question that invites replies).

Return ONLY a JSON array, no markdown fences, of objects: {"hook": "<line 1 only>", "body": "<the full post text including the hook line>", "first_comment": "<text>"}.

TRANSCRIPT:
${transcript}`;
}

// ---------- OpenAI ----------
function trimTranscript(t: string): string {
  return t.length > 180_000 ? t.slice(0, 180_000) + "\n[transcript truncated]" : t;
}

async function llmJsonArray(prompt: string, what: string): Promise<any[]> {
  const apiKey = await cfg("openai_api_key");
  if (!apiKey) throw new Error("openai_api_key not configured (admin: POST /admin/config)");
  const model = (await cfg("openai_model")) || "gpt-5.5";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${what} failed: ${data?.error?.message || res.status}`);
  const text = data.choices?.[0]?.message?.content ?? "";
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < 0) throw new Error(`${what} returned no JSON array`);
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr) || !arr.length) throw new Error(`${what} returned an empty array`);
  return arr;
}

async function generatePosts(client: any, episode: any, transcript: string): Promise<any[]> {
  return await llmJsonArray(postsPrompt(client, episode.name, trimTranscript(transcript)), "post generation");
}

// Score + rank candidate clips, then sanity-check them against George's rules
// (30-60s, no overlaps, inside the episode) before they reach the editor.
async function selectReelClips(client: any, episode: any, transcript: string, n: number, avoid: [number, number][] = []): Promise<any[]> {
  const dur = Number(episode.duration_seconds ?? 0);
  const text = trimTranscript(transcript);
  let raw: any[];
  try {
    raw = await llmJsonArray(reelSelectionPrompt(client, episode.name, text, n, dur, avoid), "reel selection");
  } catch (e) {
    // A count the episode cannot satisfy makes the model give up; ask for less.
    const fewer = Math.max(1, Math.floor(n / 2));
    if (fewer >= n) throw e;
    raw = await llmJsonArray(reelSelectionPrompt(client, episode.name, text, fewer, dur, avoid), "reel selection");
  }
  const clean = raw.map((c: any) => {
    let start = Math.max(0, Math.floor(Number(c.start_s ?? 0)));
    let end = Math.ceil(Number(c.end_s ?? 0));
    if (!(end > start)) return null;
    const minLen = dur > 0 && dur < 420 ? 15 : 20;     // short episodes allow shorter clips
    if (end - start < minLen) return null;
    if (end - start > 75) end = start + 60;            // clamp overlong picks
    if (dur > 0 && end > dur) { end = Math.floor(dur); if (end - start < minLen) return null; }
    const k = Math.max(0, Math.min(100, Math.round(Number(c.k_factor ?? 0))));
    return {
      title: String(c.title ?? "Clip").slice(0, 120),
      hook: c.hook ? String(c.hook).slice(0, 400) : null,
      why: c.why ? String(c.why).slice(0, 600) : null,
      k_factor: k,
      start_s: start, end_s: end,
      speakers: c.speakers ? String(c.speakers).slice(0, 200) : null,
      excerpt: c.excerpt ? String(c.excerpt).slice(0, 1200) : null,
    };
  }).filter(Boolean) as any[];

  clean.sort((a, b) => b.k_factor - a.k_factor);
  const picked: any[] = [];
  for (const c of clean) {
    if (picked.some((p) => c.start_s < p.end_s && p.start_s < c.end_s)) continue; // no overlaps
    picked.push(c);
    if (picked.length >= n) break;
  }
  if (!picked.length) throw new Error("No usable clips were found in this episode.");
  return picked.map((c, i) => ({ ...c, rank: i + 1 }));
}

// ---------- job helpers ----------
async function updateJob(id: string, patch: Record<string, unknown>) {
  await supabase.from("ps_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

async function failJob(job: any, err: unknown) {
  const msg = humanDscError(err);
  await updateJob(job.id, { step: "failed", error: msg });
  await logEvent("job_failed", { job_id: job.id, kind: job.kind, error: msg });
  if ((job.kind === "produce_main" || job.kind === "import") && job.episode_id) {
    await supabase.from("ps_episodes").update({ status: "failed", error: msg }).eq("id", job.episode_id);
  }
  if (job.kind === "generate_posts" && job.episode_id) {
    await supabase.from("ps_episodes").update({ posts_status: "failed" }).eq("id", job.episode_id);
  }
  if (job.kind === "command" && job.payload?.command_id) {
    await supabase.from("ps_commands").update({ status: "failed", agent_response: msg }).eq("id", job.payload.command_id);
  }
}

// Atomic step claim — cron ticks can overlap (a slow tick + the next one, or a tick
// + a Descript callback), so every state transition must be won exactly once.
async function claim(jobId: string, from: string, to: string): Promise<boolean> {
  const { data } = await supabase.from("ps_jobs")
    .update({ step: to, updated_at: new Date().toISOString() })
    .eq("id", jobId).eq("step", from).select("id");
  return !!(data && data.length);
}

async function enqueue(client_id: string, episode_id: string | null, kind: string, payload: Record<string, unknown> = {}) {
  const { data, error } = await supabase.from("ps_jobs")
    .insert({ client_id, episode_id, kind, step: "queued", payload })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

function callbackUrlFor(jobId: string, secret: string) {
  return `${FN_URL}/webhook?secret=${secret}&job=${jobId}`;
}

async function startAgentJob(token: string, job: any, prompt: string, opts: { project_id: string; composition_id?: string; model?: string | null }) {
  const secret = (await cfg("webhook_secret"))!;
  const body: Record<string, unknown> = {
    prompt,
    project_id: opts.project_id,
    callback_url: callbackUrlFor(job.id, secret),
  };
  if (opts.composition_id) body.composition_id = opts.composition_id;
  if (opts.model) body.model = opts.model;
  const res = await dsc(token, "POST", "/jobs/agent", body);
  await updateJob(job.id, {
    step: "agent_running",
    descript_job_id: res.job_id,
    payload: { ...job.payload, project_url: res.project_url, conversation_id: res.conversation_id },
  });
  return res;
}

async function startPublishJob(token: string, job: any, project_id: string, composition_id: string, extraPayload: Record<string, unknown> = {}) {
  const secret = (await cfg("webhook_secret"))!;
  const base: Record<string, unknown> = {
    project_id,
    composition_id,
    media_type: "Video",
    resolution: "1080p",
    callback_url: callbackUrlFor(job.id, secret),
  };
  let res;
  try {
    res = await dsc(token, "POST", "/jobs/publish", { ...base, access_level: "unlisted" });
  } catch (e) {
    // Some drives forbid certain access levels — fall back to the drive default.
    if (e instanceof DscError && e.status === 403) res = await dsc(token, "POST", "/jobs/publish", base);
    else throw e;
  }
  await updateJob(job.id, {
    step: "publishing",
    descript_job_id: res.job_id,
    payload: { ...job.payload, ...extraPayload, publishing_composition_id: composition_id },
  });
  return res;
}

async function getProject(token: string, project_id: string) {
  return await dsc(token, "GET", `/projects/${project_id}`);
}

function mainComposition(project: any): any | null {
  const comps = (project?.compositions ?? []).filter((c: any) => c?.id);
  if (!comps.length) return null;
  const videos = comps.filter((c: any) => (c.media_type ?? "video").toLowerCase() !== "audio");
  const pool = videos.length ? videos : comps;
  return pool.reduce((a: any, b: any) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a));
}

// ---------- pipeline: advance one job ----------
// Called from the cron tick (with a freshly polled Descript status, or none for queued
// jobs) and from the Descript callback webhook (with the posted status payload).
async function advanceJob(job: any, dscStatus: any | null) {
  const { data: client } = await supabase.from("ps_clients").select("*").eq("id", job.client_id).maybeSingle();
  if (!client) { await failJob(job, new Error("client missing")); return; }
  const token = client.descript_token;
  if (!token) { await failJob(job, new Error("Descript is not connected for this client yet.")); return; }

  const episode = job.episode_id
    ? (await supabase.from("ps_episodes").select("*").eq("id", job.episode_id).maybeSingle()).data
    : null;

  try {
    // ----- start queued jobs -----
    if (job.step === "queued") {
      if (!episode) { await failJob(job, new Error("episode missing")); return; }
      if (!(await claim(job.id, "queued", "starting"))) return; // someone else is starting it

      if (job.kind === "produce_main") {
        await supabase.from("ps_episodes").update({ status: "producing", error: null }).eq("id", episode.id);
        // Branding overlay: the logo has to exist inside the project before the
        // editor can place it, so import it first and continue on its callback.
        const brand = client.watermark_url ? String(client.watermark_url) : null;
        if (brand && !job.payload?.brand_ready) {
          const ext = (brand.split("?")[0].match(/\.(png|jpg|jpeg|webp)$/i)?.[1] ?? "png").toLowerCase();
          const brandFile = `Branding/podcast-logo.${ext}`;
          const secret = (await cfg("webhook_secret"))!;
          try {
            const imp = await dsc(token, "POST", "/jobs/import/project_media", {
              project_id: episode.descript_project_id,
              add_media: { [brandFile]: { url: brand } },
              callback_url: callbackUrlFor(job.id, secret),
            });
            await updateJob(job.id, {
              step: "brand_import", descript_job_id: imp.job_id,
              payload: { ...job.payload, brand_file: brandFile },
            });
            return;
          } catch (e) {
            // Already imported (name clash) or unreachable image: carry on and
            // still reference the file if it is a plain conflict.
            const conflict = e instanceof DscError && e.status === 400;
            await logEvent("brand_import_skipped", { episode_id: episode.id, conflict, error: humanDscError(e) });
            await startAgentJob(token, job, producePrompt(client, conflict ? brandFile : null), {
              project_id: episode.descript_project_id, model: client.descript_model,
            });
            return;
          }
        }
        await startAgentJob(token, job, producePrompt(client, job.payload?.brand_file ?? null), {
          project_id: episode.descript_project_id, model: client.descript_model,
        });
        return;
      }

      // Our own selection layer: score every candidate exchange, keep the best N.
      if (job.kind === "select_reels") {
        // Too short to cut anything from: say so plainly instead of failing.
        const dSec = Number(episode.duration_seconds ?? 0);
        if (dSec > 0 && dSec < 25) {
          await updateJob(job.id, {
            step: "done",
            result: { skipped: "Recording is too short to cut reels from (under 25 seconds)." },
          });
          await logEvent("reels_skipped_short", { episode_id: episode.id, duration: dSec });
          return;
        }
        // The client should always have a choice, so aim for several clips: shorter
        // targets on a short episode rather than collapsing to a single reel.
        const dur = Number(episode.duration_seconds ?? 0);
        const want = Math.min(Math.max(client.reel_count ?? 7, 1), 15);
        const per = dur > 0 && dur < 420 ? 40 : 55;
        let n = dur > 0 ? Math.max(1, Math.min(want, Math.floor(dur / per))) : want;
        if (n < 3 && dur >= 150) n = Math.min(want, Math.max(n, Math.floor(dur / 35)));
        // Only when the client asked for a different set do we steer away from
        // what was already offered; a fresh production should pick the best.
        let avoid: [number, number][] = [];
        if (job.payload?.avoid_prior) {
          const { data: prior } = await supabase.from("ps_reels").select("start_s,end_s")
            .eq("episode_id", episode.id).not("start_s", "is", null);
          avoid = (prior ?? []).map((r: any) => [Number(r.start_s), Number(r.end_s)] as [number, number]);
        }
        const transcript = await dscTranscript(
          token, episode.descript_project_id, episode.main_composition_id ?? undefined, true);
        const picks = await selectReelClips(client, episode, transcript, n, avoid);
        // A fresh selection supersedes the previous one for this episode.
        await supabase.from("ps_reels").delete().eq("episode_id", episode.id);
        await supabase.from("ps_reels").insert(picks.map((c: any) => ({
          episode_id: episode.id, title: c.title, status: "selected", sort: c.rank - 1,
          rank: c.rank, k_factor: c.k_factor, hook: c.hook, why: c.why,
          start_s: c.start_s, end_s: c.end_s, speakers: c.speakers, excerpt: c.excerpt,
        })));
        await updateJob(job.id, { step: "done", result: { selected: picks.length, top_k: picks[0]?.k_factor ?? null } });
        await logEvent("reels_selected", { episode_id: episode.id, count: picks.length });
        await enqueue(job.client_id, episode.id, "make_reels");
        return;
      }

      if (job.kind === "make_reels") {
        const project = await getProject(token, episode.descript_project_id);
        const before = (project.compositions ?? []).map((c: any) => c.id);
        const n = Math.min(Math.max(client.reel_count ?? 7, 1), 15);
        const { data: picks } = await supabase.from("ps_reels").select("*")
          .eq("episode_id", episode.id).not("start_s", "is", null).order("rank");
        const j2 = { ...job, payload: { ...job.payload, before, picked_ids: (picks ?? []).map((p: any) => p.id) } };
        await updateJob(job.id, { payload: j2.payload });
        // Cut the exact ranges our selection layer chose; only fall back to a
        // generic "find something good" prompt if no selection exists.
        // The branding image was imported into this project during production,
        // so reels can carry the same logo without importing it again.
        let brandFile: string | null = null;
        if (client.watermark_url) {
          const ext = (String(client.watermark_url).split("?")[0].match(/\.(png|jpg|jpeg|webp)$/i)?.[1] ?? "png").toLowerCase();
          const candidate = `Branding/podcast-logo.${ext}`;
          if (Object.keys(project.media_files ?? {}).some((k: string) => k === candidate)) brandFile = candidate;
        }
        const shortEp = Number(episode.duration_seconds ?? 0) > 0 && Number(episode.duration_seconds) < 420;
        const prompt = picks?.length
          ? timedReelsPrompt(client, picks, brandFile, shortEp)
          : reelsPrompt(client, episode.name, n, brandFile, shortEp);
        await startAgentJob(token, j2, prompt, {
          project_id: episode.descript_project_id, model: client.descript_model,
        });
        return;
      }

      if (job.kind === "qa_pass") {
        const brandFile = client.watermark_url
          ? `Branding/podcast-logo.${(String(client.watermark_url).split("?")[0].match(/\.(png|jpg|jpeg|webp)$/i)?.[1] ?? "png").toLowerCase()}`
          : null;
        await startAgentJob(token, job, qaPrompt(client, brandFile), {
          project_id: episode.descript_project_id,
          composition_id: episode.main_composition_id ?? undefined,
          model: client.descript_model,
        });
        return;
      }

      if (job.kind === "generate_posts") {
        await supabase.from("ps_episodes").update({ posts_status: "generating" }).eq("id", episode.id);
        const transcript = await dscTranscript(token, episode.descript_project_id, episode.main_composition_id ?? undefined);
        await supabase.from("ps_episodes").update({ transcript_md: transcript }).eq("id", episode.id);
        const posts = await generatePosts(client, episode, transcript);
        await supabase.from("ps_posts").delete().eq("episode_id", episode.id);
        await supabase.from("ps_posts").insert(posts.slice(0, 15).map((p: any, i: number) => ({
          episode_id: episode.id,
          hook: String(p.hook ?? "").slice(0, 500),
          body: String(p.body ?? ""),
          first_comment: p.first_comment ? String(p.first_comment) : null,
          sort: i,
        })));
        await supabase.from("ps_episodes").update({ posts_status: "ready" }).eq("id", episode.id);
        await updateJob(job.id, { step: "done", result: { posts: posts.length } });
        return;
      }

      if (job.kind === "command") {
        const target = job.payload?.target_composition_id as string | undefined;
        await startAgentJob(token, job, commandPrompt(String(job.payload?.text ?? "")), {
          project_id: episode.descript_project_id, composition_id: target, model: client.descript_model,
        });
        return;
      }

      await failJob(job, new Error(`unknown job kind ${job.kind}`));
      return;
    }

    // ----- poll/receive Descript job state -----
    if (!dscStatus && job.descript_job_id) {
      dscStatus = await dsc(token, "GET", `/jobs/${job.descript_job_id}`);
    }
    if (!dscStatus) return;
    const state = dscStatus.job_state;
    if (state === "queued" || state === "running") {
      await updateJob(job.id, { result: { ...(job.result ?? {}), progress: dscStatus.progress ?? null } });
      return;
    }
    if (state === "cancelled") { await failJob(job, new Error("The editing job was cancelled in Descript.")); return; }
    const r = dscStatus.result ?? {};
    const failed = r.status === "error" || r.status === "failed";

    // ----- branding image landed: now run the production edit -----
    if (job.step === "brand_import") {
      if (!(await claim(job.id, "brand_import", "starting"))) return;
      const okBrand = !failed && (Object.values(r.media_status ?? {})[0] as any)?.status !== "failed";
      if (!okBrand) await logEvent("brand_import_failed", { episode_id: job.episode_id, result: r });
      await startAgentJob(token, job, producePrompt(client, okBrand ? (job.payload?.brand_file ?? null) : null), {
        project_id: episode!.descript_project_id, model: client.descript_model,
      });
      return;
    }

    // ----- import job finished (dashboard upload) -----
    if (job.step === "waiting_import") {
      if (failed) { await failJob(job, new Error(r.error_message || "Importing the recording failed.")); return; }
      if (!(await claim(job.id, "waiting_import", "finalizing_import"))) return;
      const first: any = Object.values(r.media_status ?? {})[0] ?? null;
      if (first?.status === "failed") { await failJob(job, new Error(first.error_message || "The file could not be processed.")); return; }
      if (job.episode_id) {
        await supabase.from("ps_episodes").update({
          status: "new", duration_seconds: first?.duration_seconds ?? null, error: null,
        }).eq("id", job.episode_id);
      }
      await updateJob(job.id, { step: "done", media_seconds_used: r.media_seconds_used ?? null });
      if (client.auto_produce && job.episode_id) await enqueue(job.client_id, job.episode_id, "produce_main");
      return;
    }

    // ----- agent job finished -----
    if (job.step === "agent_running") {
      if (failed) { await failJob(job, new Error(r.error_message || "The AI editor could not complete this request.")); return; }
      if (!(await claim(job.id, "agent_running", "advancing"))) return;
      await updateJob(job.id, {
        ai_credits_used: r.ai_credits_used ?? null,
        result: { agent_response: r.agent_response, project_changed: r.project_changed },
      });

      if (job.kind === "produce_main" && episode) {
        const project = await getProject(token, episode.descript_project_id);
        const main = mainComposition(project);
        if (!main) { await failJob(job, new Error("No composition found in the project after editing.")); return; }
        await supabase.from("ps_episodes").update({
          main_composition_id: main.id,
          duration_seconds: main.duration ?? null,
        }).eq("id", episode.id);
        await startPublishJob(token, job, episode.descript_project_id, main.id);
        return;
      }

      if (job.kind === "make_reels" && episode) {
        const project = await getProject(token, episode.descript_project_id);
        const before = new Set((job.payload?.before ?? []) as string[]);
        let fresh = (project.compositions ?? []).filter((c: any) => c.id && !before.has(c.id));
        if (!fresh.length) fresh = (project.compositions ?? []).filter((c: any) => /^reel/i.test(c.name ?? ""));
        if (!fresh.length) {
          await failJob(job, new Error("The editor did not produce any clips from this recording \u2014 it may be too short or too quiet. Try 'Re-score & regenerate'."));
          return;
        }
        fresh.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
        const pickedIds = (job.payload?.picked_ids ?? []) as string[];
        let queue: string[] = [];
        if (pickedIds.length) {
          // Selection rows already carry rank/K-factor — attach the rendered
          // compositions to them in rank order instead of creating new rows.
          const { data: picks } = await supabase.from("ps_reels").select("*").in("id", pickedIds).order("rank");
          const pairs = Math.min((picks ?? []).length, fresh.length);
          for (let i = 0; i < pairs; i++) {
            await supabase.from("ps_reels").update({
              composition_id: fresh[i].id, title: fresh[i].name ?? picks![i].title, status: "pending",
            }).eq("id", picks![i].id);
            queue.push(fresh[i].id);
          }
          // Anything the model produced beyond our list, or picks it skipped.
          for (let i = pairs; i < fresh.length; i++) {
            await supabase.from("ps_reels").insert({
              episode_id: episode.id, title: fresh[i].name ?? `Reel ${i + 1}`,
              composition_id: fresh[i].id, status: "pending", sort: 90 + i,
            });
            queue.push(fresh[i].id);
          }
          for (let i = pairs; i < (picks ?? []).length; i++) {
            await supabase.from("ps_reels").delete().eq("id", picks![i].id);
          }
        } else {
          const rows = fresh.map((c: any, i: number) => ({
            episode_id: episode.id, title: c.name ?? `Reel ${i + 1}`, composition_id: c.id, status: "pending", sort: i,
          }));
          await supabase.from("ps_reels").upsert(rows, { onConflict: "episode_id,composition_id" });
          queue = fresh.map((c: any) => c.id);
        }
        const first = queue.shift();
        await supabase.from("ps_reels").update({ status: "publishing" }).eq("episode_id", episode.id).eq("composition_id", first);
        await startPublishJob(token, job, episode.descript_project_id, first, { publish_queue: queue });
        return;
      }

      if (job.kind === "qa_pass" && episode) {
        await supabase.from("ps_episodes").update({
          qa_report: r.agent_response ?? null, qa_at: new Date().toISOString(),
        }).eq("id", episode.id);
        if (r.project_changed && episode.main_composition_id) {
          await startPublishJob(token, job, episode.descript_project_id, episode.main_composition_id);
        } else {
          await updateJob(job.id, { step: "done" });
        }
        return;
      }

      if (job.kind === "command" && episode) {
        const commandId = job.payload?.command_id;
        if (commandId) {
          await supabase.from("ps_commands").update({
            agent_response: r.agent_response ?? "Done.",
            status: r.project_changed ? "working" : "done",
          }).eq("id", commandId);
        }
        // Republish whatever the command targeted so the dashboard links show the new cut.
        const target = (job.payload?.target_composition_id as string) || episode.main_composition_id;
        if (r.project_changed && target) {
          await startPublishJob(token, job, episode.descript_project_id, target);
        } else {
          if (commandId) await supabase.from("ps_commands").update({ status: "done" }).eq("id", commandId);
          await updateJob(job.id, { step: "done" });
        }
        return;
      }

      await updateJob(job.id, { step: "done" });
      return;
    }

    // ----- publish job finished -----
    if (job.step === "publishing") {
      if (failed) { await failJob(job, new Error(r.error_message || "Publishing the video failed.")); return; }
      // Descript's completion callback can fire while the export file is still
      // finalizing (download_url null). Stay in `publishing` so the minute cron
      // re-polls until the download link exists (~8 min cap, then take what we have).
      const retries = Number(job.payload?.download_retries ?? 0);
      if (!r.download_url && retries < 8) {
        await updateJob(job.id, { payload: { ...job.payload, download_retries: retries + 1 } });
        return;
      }
      if (!(await claim(job.id, "publishing", "finishing"))) return;
      const compId = (job.payload?.publishing_composition_id as string) || r.composition_id;
      const urls = {
        share_url: r.share_url ?? null,
        download_url: r.download_url ?? null,
        download_expires_at: r.download_url_expires_at ?? null,
      };

      if (job.kind === "produce_main" && episode) {
        await supabase.from("ps_episodes").update({
          main_share_url: urls.share_url,
          main_download_url: urls.download_url,
          main_download_expires_at: urls.download_expires_at,
          status: "ready", produced_at: new Date().toISOString(), error: null,
        }).eq("id", episode.id);
        await updateJob(job.id, { step: "done", result: { ...(job.result ?? {}), ...urls } });
        // Chain the rest of the pipeline.
        // Only skip follow-up work that is already IN FLIGHT. Anything that
        // finished against a previous edit is stale and must run again, or the
        // client ends up with reels cut against timings that no longer exist.
        const { data: existing } = await supabase.from("ps_jobs").select("id,kind")
          .eq("episode_id", episode.id).in("kind", ["qa_pass", "select_reels", "make_reels", "generate_posts"])
          .not("step", "in", "(done,failed,cancelled)");
        const kinds = new Set((existing ?? []).map((x: any) => x.kind));
        // QA first: the episode the client sees gets checked and fixed before we
        // build anything on top of it.
        if (client.qa_pass !== false && !kinds.has("qa_pass")) await enqueue(job.client_id, episode.id, "qa_pass");
        if (!kinds.has("generate_posts")) await enqueue(job.client_id, episode.id, "generate_posts");
        if (!kinds.has("select_reels") && !kinds.has("make_reels")) await enqueue(job.client_id, episode.id, "select_reels");
        await logEvent("episode_ready", { episode_id: episode.id, share_url: urls.share_url });
        return;
      }

      if (job.kind === "make_reels" && episode) {
        await supabase.from("ps_reels").update({ ...urls, status: "ready" })
          .eq("episode_id", episode.id).eq("composition_id", compId);
        const queue = [...((job.payload?.publish_queue ?? []) as string[])];
        if (queue.length) {
          const next = queue.shift();
          await supabase.from("ps_reels").update({ status: "publishing" }).eq("episode_id", episode.id).eq("composition_id", next);
          await startPublishJob(token, job, episode.descript_project_id, next!, { publish_queue: queue });
        } else {
          await updateJob(job.id, { step: "done" });
          await logEvent("reels_ready", { episode_id: episode.id });
        }
        return;
      }

      if (job.kind === "qa_pass" && episode) {
        await supabase.from("ps_episodes").update({
          main_share_url: urls.share_url ?? episode.main_share_url,
          main_download_url: urls.download_url ?? episode.main_download_url,
          main_download_expires_at: urls.download_expires_at ?? episode.main_download_expires_at,
        }).eq("id", episode.id);
        await updateJob(job.id, { step: "done", result: { ...(job.result ?? {}), ...urls } });
        return;
      }

      if (job.kind === "command" && episode) {
        if (compId && compId === episode.main_composition_id) {
          await supabase.from("ps_episodes").update({
            main_share_url: urls.share_url ?? episode.main_share_url,
            main_download_url: urls.download_url ?? episode.main_download_url,
            main_download_expires_at: urls.download_expires_at ?? episode.main_download_expires_at,
          }).eq("id", episode.id);
        } else if (compId) {
          await supabase.from("ps_reels").update({ ...urls, status: "ready" })
            .eq("episode_id", episode.id).eq("composition_id", compId);
        }
        if (job.payload?.command_id) {
          await supabase.from("ps_commands").update({ status: "done" }).eq("id", job.payload.command_id);
        }
        await updateJob(job.id, { step: "done", result: { ...(job.result ?? {}), ...urls } });
        return;
      }

      await updateJob(job.id, { step: "done" });
      return;
    }
  } catch (e) {
    // 429s and transient errors: release any claim so the next cron tick retries.
    if (e instanceof DscError && e.status === 429) {
      await supabase.from("ps_jobs").update({ step: job.step })
        .eq("id", job.id).in("step", ["starting", "advancing", "finishing", "finalizing_import"]);
      await logEvent("rate_limited", { job_id: job.id });
      return;
    }
    await failJob(job, e);
  }
}

// A worker that died mid-transition leaves a job stuck in a claim state — return
// it to its base state after 10 quiet minutes so the pipeline self-heals.
// (10, not 5: a legitimate posts-writing claim can run several minutes.)
async function recoverStuckClaims() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const backTo: Record<string, string> = {
    starting: "queued", advancing: "agent_running", finishing: "publishing", finalizing_import: "waiting_import",
  };
  for (const [claimed, base] of Object.entries(backTo)) {
    await supabase.from("ps_jobs").update({ step: base }).eq("step", claimed).lt("updated_at", cutoff);
  }
}

// ---------- discovery ----------
async function discoverClient(client: any): Promise<{ found: number; added: number }> {
  if (!client.descript_token) return { found: 0, added: 0 };
  const res = await dsc(client.descript_token, "GET", "/projects?sort=updated_at&direction=desc&limit=100");
  const projects = res.data ?? [];
  let added = 0;
  for (const p of projects) {
    const { data: existing } = await supabase.from("ps_episodes").select("id,descript_updated_at")
      .eq("client_id", client.id).eq("descript_project_id", p.id).maybeSingle();
    if (existing) {
      await supabase.from("ps_episodes").update({
        name: p.name, folder_path: p.folder_path ?? null, descript_updated_at: p.updated_at ?? null,
      }).eq("id", existing.id); // display_name is ours and is never overwritten
      continue;
    }
    const { data: ep } = await supabase.from("ps_episodes").insert({
      client_id: client.id,
      descript_project_id: p.id,
      name: p.name ?? "Untitled recording",
      folder_path: p.folder_path ?? null,
      status: "new",
      descript_created_at: p.created_at ?? null,
      descript_updated_at: p.updated_at ?? null,
    }).select().single();
    added++;
    // Auto-produce only recordings created after onboarding — never a client's back catalog.
    if (client.auto_produce && ep && p.created_at && new Date(p.created_at) > new Date(client.created_at)) {
      await enqueue(client.id, ep.id, "produce_main");
      await logEvent("auto_produce", { episode_id: ep.id, project: p.name });
    }
  }
  return { found: projects.length, added };
}

// ---------- cron tick ----------
async function cronTick(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  await recoverStuckClaims();
  const { data: jobs } = await supabase.from("ps_jobs").select("*")
    .in("step", ["queued", "agent_running", "publishing", "waiting_import", "brand_import"])
    .order("created_at", { ascending: true }).limit(20);
  out.active_jobs = jobs?.length ?? 0;
  for (const job of jobs ?? []) {
    await advanceJob(job, null);
  }
  // Discovery every ~5 minutes.
  const last = await cfg("last_discovery");
  if (!last || Date.now() - new Date(last).getTime() > 5 * 60 * 1000) {
    await setCfg("last_discovery", new Date().toISOString());
    const { data: clients } = await supabase.from("ps_clients").select("*").eq("active", true).not("descript_token", "is", null);
    const disc: Record<string, unknown> = {};
    for (const c of clients ?? []) {
      try { disc[c.name] = await discoverClient(c); }
      catch (e) { disc[c.name] = { error: humanDscError(e) }; }
    }
    out.discovery = disc;
  }
  return out;
}

// ---------- API payload builders ----------
function embedOf(share: string | null): string | null {
  // share.descript.com/view/<slug> is frame-blocked; /embed/<slug> is not.
  if (!share) return null;
  const m = String(share).match(/^https:\/\/share\.descript\.com\/view\/([A-Za-z0-9_-]+)/);
  return m ? `https://share.descript.com/embed/${m[1]}` : null;
}

function episodePublic(e: any) {
  return {
    id: e.id, name: e.display_name || e.name, original_name: e.name, embed_url: embedOf(e.main_share_url),
    has_transcript: !!e.transcript_md, status: e.status, posts_status: e.posts_status,
    duration_seconds: e.duration_seconds, folder_path: e.folder_path,
    share_url: e.main_share_url, download_url: e.main_download_url,
    download_expires_at: e.main_download_expires_at,
    project_url: e.project_url, error: e.error, qa_report: e.qa_report, qa_at: e.qa_at,
    recorded_at: e.descript_created_at, produced_at: e.produced_at,
  };
}

async function apiOverview(client: any) {
  const { data: episodes } = await supabase.from("ps_episodes").select("*")
    .eq("client_id", client.id).order("descript_created_at", { ascending: false, nullsFirst: false }).limit(200);
  const ids = (episodes ?? []).map((e: any) => e.id);
  let reelCounts: Record<string, number> = {}, postCounts: Record<string, number> = {};
  if (ids.length) {
    const { data: reels } = await supabase.from("ps_reels").select("episode_id,status,hidden").in("episode_id", ids);
    for (const rl of reels ?? []) if (rl.status === "ready" && !rl.hidden) reelCounts[rl.episode_id] = (reelCounts[rl.episode_id] ?? 0) + 1;
    const { data: posts } = await supabase.from("ps_posts").select("episode_id").in("episode_id", ids);
    for (const p of posts ?? []) postCounts[p.episode_id] = (postCounts[p.episode_id] ?? 0) + 1;
  }
  return {
    client: { name: client.name, logo_url: client.logo_url, connected: !!client.descript_token, auto_produce: client.auto_produce, room_url: client.room_url ?? null },
    episodes: (episodes ?? []).map((e: any) => ({ ...episodePublic(e), reels: reelCounts[e.id] ?? 0, posts: postCounts[e.id] ?? 0 })),
  };
}

async function apiEpisode(client: any, id: string) {
  const { data: e } = await supabase.from("ps_episodes").select("*").eq("id", id).eq("client_id", client.id).maybeSingle();
  if (!e) return null;
  const [{ data: reels }, { data: posts }, { data: commands }, { data: jobs }] = await Promise.all([
    supabase.from("ps_reels").select("*").eq("episode_id", id).order("sort").order("rank", { nullsFirst: false }),
    supabase.from("ps_posts").select("*").eq("episode_id", id).order("sort"),
    supabase.from("ps_commands").select("*").eq("episode_id", id).order("created_at").limit(100),
    supabase.from("ps_jobs").select("id,kind,step,error,created_at,updated_at,result").eq("episode_id", id).order("created_at", { ascending: false }).limit(20),
  ]);
  return {
    episode: episodePublic(e),
    reels: (reels ?? []).filter((r: any) => !r.hidden).map((r: any) => ({
      id: r.id, title: r.title, status: r.status, share_url: r.share_url, download_url: r.download_url,
      embed_url: embedOf(r.share_url),
      composition_id: r.composition_id, rank: r.rank, k_factor: r.k_factor, hook: r.hook, why: r.why,
      start_s: r.start_s, end_s: r.end_s, speakers: r.speakers, excerpt: r.excerpt,
    })),
    posts: (posts ?? []).map((p: any) => ({ id: p.id, hook: p.hook, body: p.body, first_comment: p.first_comment, status: p.status, edited_at: p.edited_at })),
    commands: (commands ?? []).map((c: any) => ({ id: c.id, text: c.text, status: c.status, agent_response: c.agent_response, target: c.target, created_at: c.created_at })),
    jobs: jobs ?? [],
  };
}

// ---------- HTTP handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  // Path after the function name: /studio/api/overview → /api/overview
  const path = url.pathname.replace(/^\/studio/, "") || "/";
  // /api/upload carries the raw file as its body — everything else is JSON.
  const body = req.method === "POST" && path !== "/api/upload" ? await req.json().catch(() => ({})) : {};

  try {
    // ----- machine endpoints -----
    if (path === "/webhook" && req.method === "POST") {
      const secret = url.searchParams.get("secret") ?? "";
      if (secret !== (await cfg("webhook_secret"))) return json({ error: "bad_secret" }, 403);
      const jobId = url.searchParams.get("job") ?? "";
      const { data: job } = await supabase.from("ps_jobs").select("*").eq("id", jobId).maybeSingle();
      if (!job) return json({ error: "unknown_job" }, 404);
      // Callback payload matches GET /jobs/{id}; guard against stale callbacks from a prior step.
      if (body?.job_id && job.descript_job_id && body.job_id !== job.descript_job_id) return json({ ok: true, ignored: true });
      await advanceJob(job, body);
      return json({ ok: true });
    }

    if (path === "/cron" && req.method === "POST") {
      const secret = url.searchParams.get("secret") ?? "";
      if (secret !== (await cfg("webhook_secret"))) return json({ error: "bad_secret" }, 403);
      const result = await cronTick();
      return json({ ok: true, ...result });
    }

    // ----- admin -----
    if (path.startsWith("/admin/")) {
      if (!(await isAdmin(req, url))) return json({ error: "not_authorized" }, 401);

      if (path === "/admin/overview" && req.method === "GET") {
        const { data: clients } = await supabase.from("ps_clients").select("*").order("created_at");
        const { data: jobs } = await supabase.from("ps_jobs").select("id,kind,step,error,client_id,episode_id,ai_credits_used,created_at").order("created_at", { ascending: false }).limit(30);
        const openaiSet = !!(await cfg("openai_api_key"));
        return json({
          clients: (clients ?? []).map((c: any) => ({ ...c, descript_token: c.descript_token ? "set" : null })),
          recent_jobs: jobs ?? [],
          config: { openai_api_key: openaiSet },
        });
      }

      if (path === "/admin/clients" && req.method === "POST") {
        const { name, descript_token, logo_url, target_audience, brand_notes, reel_count, auto_produce, descript_model } = body;
        if (!name) return json({ error: "name required" }, 400);
        let drive: any = null;
        if (descript_token) {
          try { drive = await dsc(descript_token, "GET", "/status"); }
          catch (e) { return json({ error: `Descript token rejected: ${humanDscError(e)}` }, 400); }
        }
        const access_key = `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
        const { data, error } = await supabase.from("ps_clients").insert({
          name, access_key,
          descript_token: descript_token ?? null,
          descript_drive_id: drive?.drive_id ?? null,
          descript_drive_name: drive?.drive_name ?? null,
          logo_url: logo_url ?? null, target_audience: target_audience ?? null, brand_notes: brand_notes ?? null,
          reel_count: reel_count ?? 7, auto_produce: auto_produce ?? false, descript_model: descript_model ?? null,
        }).select().single();
        if (error) return json({ error: error.message }, 400);
        if (descript_token) { try { await discoverClient(data); } catch { /* first discovery is best-effort */ } }
        return json({ ok: true, client: { ...data, descript_token: data.descript_token ? "set" : null } });
      }

      if (path === "/admin/clients/update" && req.method === "POST") {
        const { client_id, ...fields } = body;
        if (!client_id) return json({ error: "client_id required" }, 400);
        const allowed = ["name", "logo_url", "target_audience", "brand_notes", "reel_count", "auto_produce", "active", "descript_model", "descript_token", "room_url"];
        const patch: Record<string, unknown> = {};
        for (const k of allowed) if (k in fields) patch[k] = fields[k];
        if (typeof patch.descript_token === "string" && patch.descript_token) {
          try {
            const drive = await dsc(patch.descript_token as string, "GET", "/status");
            patch.descript_drive_id = drive?.drive_id ?? null;
            patch.descript_drive_name = drive?.drive_name ?? null;
          } catch (e) { return json({ error: `Descript token rejected: ${humanDscError(e)}` }, 400); }
        }
        const { error } = await supabase.from("ps_clients").update(patch).eq("id", client_id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      if (path === "/admin/config" && req.method === "POST") {
        const { key, value } = body;
        if (!key || typeof value !== "string") return json({ error: "key and value required" }, 400);
        if (["webhook_secret", "admin_secret"].includes(key)) return json({ error: "immutable key" }, 400);
        await setCfg(key, value);
        return json({ ok: true });
      }

      return json({ error: "not_found" }, 404);
    }

    // Pre-login whitelist check so the UI can say "no access" before sending an email.
    if (path === "/auth/allowed" && req.method === "POST") {
      const email = String(body?.email ?? "").trim().toLowerCase();
      if (!email || !email.includes("@")) return json({ allowed: false });
      const { data } = await supabase.from("ps_users").select("email").eq("email", email).maybeSingle();
      return json({ allowed: !!data });
    }

    // ----- client API -----
    if (path.startsWith("/api/")) {
      const authn = await resolveClient(req, url);
      if (!authn) return json({ error: "invalid_key" }, 401);
      const client = authn.client;

      if (path === "/api/whoami" && req.method === "GET") {
        let clients: any[] = [];
        if (authn.is_owner) {
          const { data } = await supabase.from("ps_clients").select("id,name,logo_url")
            .eq("active", true).order("name");
          clients = data ?? [];
        }
        return json({
          client: client.name, client_id: client.id, email: authn.email ?? null,
          is_admin: !!authn.is_admin, is_owner: !!authn.is_owner, clients,
        });
      }

      // ----- clients: owners onboard and configure workspaces from the dashboard -----
      if (path === "/api/clients" && req.method === "POST") {
        if (!authn.is_owner) return json({ error: "Only the studio team can add clients." }, 403);
        const name = String(body?.name ?? "").trim();
        if (!name) return json({ error: "Give the client a name." }, 400);
        const tok = body?.descript_token ? String(body.descript_token).trim() : null;
        let drive: any = null;
        if (tok) {
          try { drive = await dsc(tok, "GET", "/status"); }
          catch (e) { return json({ error: `That Descript token was rejected: ${humanDscError(e)}` }, 400); }
        }
        const access_key = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client"}-${crypto.randomUUID().slice(0, 8)}`;
        const { data: created, error } = await supabase.from("ps_clients").insert({
          name, access_key, descript_token: tok,
          descript_drive_id: drive?.drive_id ?? null, descript_drive_name: drive?.drive_name ?? null,
          logo_url: body?.logo_url ? String(body.logo_url).slice(0, 500) : null,
          target_audience: body?.target_audience ? String(body.target_audience).slice(0, 2000) : null,
          brand_notes: body?.brand_notes ? String(body.brand_notes).slice(0, 2000) : null,
          reel_count: Math.min(Math.max(Number(body?.reel_count ?? 7), 1), 15),
          auto_produce: !!body?.auto_produce,
          watermark_url: body?.watermark_url ? String(body.watermark_url).slice(0, 500) : null,
        }).select().single();
        if (error) return json({ error: error.message }, 400);
        // The client's own people see ONLY this workspace.
        const invites = String(body?.invite_emails ?? "").split(/[,\s]+/)
          .map((e: string) => e.trim().toLowerCase()).filter((e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        for (const em of invites) {
          const { data: taken } = await supabase.from("ps_users").select("email").eq("email", em).maybeSingle();
          if (!taken) await supabase.from("ps_users").insert({ email: em, client_id: created.id, is_admin: !!body?.invite_as_admin });
        }
        if (tok) { try { await discoverClient(created); } catch { /* best effort */ } }
        await logEvent("client_created", { by: authn.email, client: name, invited: invites.length });
        return json({ ok: true, client_id: created.id, access_key: created.access_key, invited: invites });
      }

      // ----- settings: content brief + connection, editable in-app -----
      if (path === "/api/settings" && req.method === "GET") {
        return json({
          name: client.name, logo_url: client.logo_url,
          target_audience: client.target_audience, brand_notes: client.brand_notes,
          reel_count: client.reel_count, auto_produce: client.auto_produce,
          watermark_url: client.watermark_url, watermark_position: client.watermark_position,
          intro_notes: client.intro_notes, music_style: client.music_style,
          caption_style: client.caption_style, qa_pass: client.qa_pass,
          room_url: client.room_url, connected: !!client.descript_token,
          drive_name: client.descript_drive_name, access_key: authn.is_owner ? client.access_key : null,
          can_edit: !!authn.is_admin,
        });
      }
      if (path === "/api/settings" && req.method === "POST") {
        if (!authn.is_admin) return json({ error: "Only admins can change settings." }, 403);
        const patch: Record<string, unknown> = {};
        if ("target_audience" in body) patch.target_audience = String(body.target_audience ?? "").slice(0, 2000) || null;
        if ("brand_notes" in body) patch.brand_notes = String(body.brand_notes ?? "").slice(0, 2000) || null;
        if ("reel_count" in body) patch.reel_count = Math.min(Math.max(Number(body.reel_count) || 7, 1), 15);
        if ("auto_produce" in body) patch.auto_produce = !!body.auto_produce;
        if ("logo_url" in body) patch.logo_url = String(body.logo_url ?? "").slice(0, 500) || null;
        if ("intro_notes" in body) patch.intro_notes = String(body.intro_notes ?? "").slice(0, 1000) || null;
        if ("music_style" in body) patch.music_style = ["none", "subtle", "energetic"].includes(body.music_style) ? body.music_style : "subtle";
        if ("caption_style" in body) patch.caption_style = body.caption_style === "clean" ? "clean" : "trending";
        if ("qa_pass" in body) patch.qa_pass = !!body.qa_pass;
        if ("watermark_position" in body) patch.watermark_position = body.watermark_position === "top-left" ? "top-left" : "top-right";
        if ("watermark_url" in body) {
          const w = String(body.watermark_url ?? "").trim();
          if (!w) patch.watermark_url = null;
          else if (!/^https:\/\/\S+\.(png|jpg|jpeg|webp)(\?|$)/i.test(w)) {
            return json({ error: "The branding logo must be a public https link ending in .png, .jpg or .webp" }, 400);
          } else patch.watermark_url = w.slice(0, 500);
        }
        if ("name" in body && authn.is_owner) patch.name = String(body.name ?? "").slice(0, 120) || client.name;
        if (body?.descript_token) {
          try {
            const drive = await dsc(String(body.descript_token), "GET", "/status");
            patch.descript_token = String(body.descript_token);
            patch.descript_drive_id = drive?.drive_id ?? null;
            patch.descript_drive_name = drive?.drive_name ?? null;
          } catch (e) { return json({ error: `That Descript token was rejected: ${humanDscError(e)}` }, 400); }
        }
        const { error } = await supabase.from("ps_clients").update(patch).eq("id", client.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      // ----- read the transcript without opening the editor -----
      if (path === "/api/transcript" && req.method === "GET") {
        const { data: e } = await supabase.from("ps_episodes").select("transcript_md,name,display_name")
          .eq("id", url.searchParams.get("id") ?? "").eq("client_id", client.id).maybeSingle();
        if (!e) return json({ error: "not_found" }, 404);
        return json({ name: e.display_name || e.name, transcript: e.transcript_md ?? null });
      }

      if (path === "/api/episode/rename" && req.method === "POST") {
        const name = String(body?.name ?? "").trim().slice(0, 200);
        if (!name) return json({ error: "Give it a title." }, 400);
        const { data: renamed, error } = await supabase.from("ps_episodes").update({ display_name: name })
          .eq("id", body?.episode_id ?? "").eq("client_id", client.id).select("id");
        if (error) return json({ error: error.message }, 400);
        if (!renamed?.length) return json({ error: "not_found" }, 404); // never fake success
        return json({ ok: true });
      }

      if (path === "/api/reel/hide" && req.method === "POST") {
        const { data: r } = await supabase.from("ps_reels").select("id,episode_id").eq("id", body?.reel_id ?? "").maybeSingle();
        if (!r) return json({ error: "not_found" }, 404);
        const { data: ep } = await supabase.from("ps_episodes").select("id").eq("id", r.episode_id).eq("client_id", client.id).maybeSingle();
        if (!ep) return json({ error: "not_found" }, 404);
        await supabase.from("ps_reels").update({ hidden: !!body?.hidden }).eq("id", r.id);
        return json({ ok: true });
      }

      if (path === "/api/post/save" && req.method === "POST") {
        const { data: pst } = await supabase.from("ps_posts").select("id,episode_id").eq("id", body?.post_id ?? "").maybeSingle();
        if (!pst) return json({ error: "not_found" }, 404);
        const { data: ep } = await supabase.from("ps_episodes").select("id").eq("id", pst.episode_id).eq("client_id", client.id).maybeSingle();
        if (!ep) return json({ error: "not_found" }, 404);
        const patch: Record<string, unknown> = { edited_at: new Date().toISOString() };
        if ("body" in body) patch.body = String(body.body ?? "").slice(0, 8000);
        if ("first_comment" in body) patch.first_comment = String(body.first_comment ?? "").slice(0, 2000) || null;
        if ("status" in body) patch.status = body.status === "approved" ? "approved" : "draft";
        await supabase.from("ps_posts").update(patch).eq("id", pst.id);
        return json({ ok: true });
      }

      // ----- team management (email-signed-in admins only) -----
      if (path.startsWith("/api/team")) {
        if (!authn.email || !authn.is_admin) return json({ error: "Only admins signed in with email can manage the team." }, 403);
        // Owner rows are the studio team and are never listed/edited as client members.

        if (path === "/api/team" && req.method === "GET") {
          const { data } = await supabase.from("ps_users").select("email,label,is_admin,is_owner,created_at")
            .eq("client_id", client.id).order("created_at");
          const { data: owners } = authn.is_owner
            ? await supabase.from("ps_users").select("email,is_owner").eq("is_owner", true).order("email")
            : { data: [] as any[] };
          return json({ team: data ?? [], owners: owners ?? [], you: authn.email, client: client.name });
        }

        if (path === "/api/team" && req.method === "POST") {
          const email = String(body?.email ?? "").trim().toLowerCase();
          const label = body?.label ? String(body.label).slice(0, 60) : null;
          const makeAdmin = !!body?.is_admin;
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
          const { data: existing } = await supabase.from("ps_users").select("client_id,is_admin").eq("email", email).maybeSingle();
          if (existing && existing.client_id !== client.id) return json({ error: "That email already belongs to another workspace." }, 400);
          if (existing?.is_admin && !makeAdmin) {
            const { count } = await supabase.from("ps_users").select("email", { count: "exact", head: true })
              .eq("client_id", client.id).eq("is_admin", true);
            if ((count ?? 0) <= 1) return json({ error: "You can't demote the last admin." }, 400);
          }
          const { error } = await supabase.from("ps_users").upsert(
            { email, client_id: client.id, label, is_admin: makeAdmin }, { onConflict: "email" });
          if (error) return json({ error: error.message }, 400);
          await logEvent("team_member_upsert", { by: authn.email, email, is_admin: makeAdmin });
          return json({ ok: true });
        }

        if (path === "/api/team/remove" && req.method === "POST") {
          const email = String(body?.email ?? "").trim().toLowerCase();
          if (email === authn.email) return json({ error: "You can't remove yourself." }, 400);
          const { data: row } = await supabase.from("ps_users").select("is_admin,client_id").eq("email", email).maybeSingle();
          if (!row || row.client_id !== client.id) return json({ error: "not_found" }, 404);
          if (row.is_admin) {
            const { count } = await supabase.from("ps_users").select("email", { count: "exact", head: true })
              .eq("client_id", client.id).eq("is_admin", true);
            if ((count ?? 0) <= 1) return json({ error: "You can't remove the last admin." }, 400);
          }
          await supabase.from("ps_users").delete().eq("email", email).eq("client_id", client.id);
          await logEvent("team_member_removed", { by: authn.email, email });
          return json({ ok: true });
        }
      }

      if (path === "/api/overview" && req.method === "GET") return json(await apiOverview(client));

      if (path === "/api/episode" && req.method === "GET") {
        const detail = await apiEpisode(client, url.searchParams.get("id") ?? "");
        return detail ? json(detail) : json({ error: "not_found" }, 404);
      }

      // Save this client's standing Descript Room / SquadCast link (one-time; Rooms links are persistent).
      if (path === "/api/room" && req.method === "POST") {
        const raw = String(body?.url ?? "").trim();
        if (raw === "") {
          await supabase.from("ps_clients").update({ room_url: null }).eq("id", client.id);
          return json({ ok: true, room_url: null });
        }
        let u: URL;
        try { u = new URL(raw); } catch { return json({ error: "That doesn't look like a link." }, 400); }
        const host = u.hostname.toLowerCase();
        const okHost = u.protocol === "https:" && (host === "descript.com" || host.endsWith(".descript.com") || host === "squadcast.fm" || host.endsWith(".squadcast.fm"));
        if (!okHost) return json({ error: "Paste a Descript Rooms or SquadCast link (descript.com / squadcast.fm)." }, 400);
        if (raw.length > 500) return json({ error: "Link too long." }, 400);
        await supabase.from("ps_clients").update({ room_url: raw }).eq("id", client.id);
        return json({ ok: true, room_url: raw });
      }

      if (path === "/api/refresh" && req.method === "POST") {
        if (!client.descript_token) return json({ error: "Descript is not connected yet. Ask your account manager to complete onboarding." }, 400);
        const r = await discoverClient(client);
        return json({ ok: true, ...r, ...(await apiOverview(client)) });
      }

      if (path === "/api/upload" && req.method === "POST") {
        if (!client.descript_token) return json({ error: "Descript is not connected yet." }, 400);
        const rawName = (url.searchParams.get("name") || "Recording").slice(0, 120);
        const ctype = url.searchParams.get("type") || "application/octet-stream";
        const clean = rawName.replace(/[^\w\-. ()]/g, " ").replace(/\s+/g, " ").trim() || "Recording";
        const extMatch = clean.match(/\.(\w{2,5})$/);
        const ext = (extMatch?.[1] || (ctype.split("/")[1] ?? "mp4")).toLowerCase();
        const base = extMatch ? clean.slice(0, -(ext.length + 1)) : clean;
        const mediaKey = `${base}.${ext}`;
        const projName = `${base} — ${new Date().toISOString().slice(0, 10)}`;
        const buf = await req.arrayBuffer();
        if (!buf.byteLength) return json({ error: "The file arrived empty — try again." }, 400);
        if (buf.byteLength > 100 * 1024 * 1024) return json({ error: "Files up to 100 MB can be uploaded here. For bigger recordings, use Record in Descript." }, 400);
        const secret = (await cfg("webhook_secret"))!;
        const { data: jb, error: jbErr } = await supabase.from("ps_jobs").insert({
          client_id: client.id, episode_id: null, kind: "import", step: "waiting_import", payload: { name: projName },
        }).select().single();
        if (jbErr || !jb) return json({ error: jbErr?.message ?? "job_insert_failed" }, 500);
        let imp: any;
        try {
          imp = await dsc(client.descript_token, "POST", "/jobs/import/project_media", {
            project_name: projName,
            add_media: { [mediaKey]: { content_type: ctype, file_size: buf.byteLength } },
            add_compositions: [{ name: projName, clips: [{ media: mediaKey }] }],
            callback_url: callbackUrlFor(jb.id, secret),
          });
        } catch (e) { await failJob(jb, e); return json({ error: humanDscError(e) }, 400); }
        const upUrl = imp.upload_urls?.[mediaKey]?.upload_url;
        if (!upUrl) { await failJob(jb, new Error("Descript did not return an upload URL.")); return json({ error: "upload_init_failed" }, 500); }
        const { data: ep } = await supabase.from("ps_episodes").upsert({
          client_id: client.id, descript_project_id: imp.project_id, name: projName,
          status: "importing", project_url: imp.project_url ?? null,
          descript_created_at: new Date().toISOString(),
        }, { onConflict: "client_id,descript_project_id" }).select().single();
        await updateJob(jb.id, { episode_id: ep?.id ?? null, descript_job_id: imp.job_id });
        const put = await fetch(upUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: buf });
        if (!put.ok) {
          await failJob({ ...jb, episode_id: ep?.id ?? null }, new Error(`Sending the file to the editor failed (${put.status}). Try again.`));
          return json({ error: "upload_failed" }, 502);
        }
        return json({ ok: true, episode_id: ep?.id ?? null });
      }

      if (path === "/api/produce" && req.method === "POST") {
        const { episode_id } = body;
        const { data: ep } = await supabase.from("ps_episodes").select("*").eq("id", episode_id).eq("client_id", client.id).maybeSingle();
        if (!ep) return json({ error: "not_found" }, 404);
        if (ep.status === "importing") return json({ error: "This recording is still importing — give it a minute." }, 409);
        const { data: running } = await supabase.from("ps_jobs").select("id").eq("episode_id", ep.id)
          .eq("kind", "produce_main").not("step", "in", "(done,failed,cancelled)").limit(1);
        if (running?.length) return json({ error: "This episode is already being produced." }, 409);
        const jb = await enqueue(client.id, ep.id, "produce_main");
        await advanceJob(jb, null); // kick immediately, don't wait for the cron
        return json({ ok: true, job_id: jb.id });
      }

      if (path === "/api/reels" && req.method === "POST") {
        const { episode_id } = body;
        const { data: ep } = await supabase.from("ps_episodes").select("*").eq("id", episode_id).eq("client_id", client.id).maybeSingle();
        if (!ep) return json({ error: "not_found" }, 404);
        const jb = await enqueue(client.id, ep.id, "select_reels", { avoid_prior: !!body?.fresh });
        await advanceJob(jb, null);
        return json({ ok: true, job_id: jb.id });
      }

      if (path === "/api/posts" && req.method === "POST") {
        const { episode_id } = body;
        const { data: ep } = await supabase.from("ps_episodes").select("*").eq("id", episode_id).eq("client_id", client.id).maybeSingle();
        if (!ep) return json({ error: "not_found" }, 404);
        const jb = await enqueue(client.id, ep.id, "generate_posts");
        await advanceJob(jb, null);
        return json({ ok: true, job_id: jb.id });
      }

      if (path === "/api/qa" && req.method === "POST") {
        const { episode_id } = body;
        const { data: ep } = await supabase.from("ps_episodes").select("*").eq("id", episode_id).eq("client_id", client.id).maybeSingle();
        if (!ep) return json({ error: "not_found" }, 404);
        if (ep.status !== "ready") return json({ error: "Produce the episode first." }, 409);
        const jb = await enqueue(client.id, ep.id, "qa_pass");
        await advanceJob(jb, null);
        return json({ ok: true, job_id: jb.id });
      }

      if (path === "/api/command" && req.method === "POST") {
        const { episode_id, text, target } = body;
        if (!text || !String(text).trim()) return json({ error: "text required" }, 400);
        if (String(text).length > 4000) return json({ error: "Keep requests under 4000 characters." }, 400);
        const { data: ep } = await supabase.from("ps_episodes").select("*").eq("id", episode_id).eq("client_id", client.id).maybeSingle();
        if (!ep) return json({ error: "not_found" }, 404);
        let target_composition_id: string | undefined;
        let targetLabel: string | null = null;
        if (target && target !== "main") {
          const { data: reel } = await supabase.from("ps_reels").select("*").eq("episode_id", ep.id).eq("composition_id", target).maybeSingle();
          if (!reel) return json({ error: "unknown target" }, 400);
          target_composition_id = reel.composition_id;
          targetLabel = reel.title;
        } else if (target === "main" && ep.main_composition_id) {
          target_composition_id = ep.main_composition_id;
          targetLabel = "main episode";
        }
        const { data: cmd, error } = await supabase.from("ps_commands").insert({
          episode_id: ep.id, client_id: client.id, text: String(text).trim(), target: targetLabel, status: "working",
        }).select().single();
        if (error) return json({ error: error.message }, 400);
        const jb = await enqueue(client.id, ep.id, "command", { command_id: cmd.id, text: String(text).trim(), target_composition_id });
        await supabase.from("ps_commands").update({ job_id: jb.id }).eq("id", cmd.id);
        await advanceJob(jb, null);
        return json({ ok: true, command_id: cmd.id, job_id: jb.id });
      }

      return json({ error: "not_found" }, 404);
    }

    return new Response(
      "Podcast Studio API. Client endpoints under /api/* (access key required). Runs on Descript + AI agents.",
      { headers: { ...CORS, "Content-Type": "text/plain" } },
    );
  } catch (e) {
    await logEvent("unhandled_error", { path, error: String(e) });
    return json({ error: "internal_error" }, 500);
  }
});
