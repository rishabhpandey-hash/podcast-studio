// Podcast Studio — agentic podcast production pipeline
// Edge function `studio` in Supabase project mgnjlymtjmcoskqinhid (verify_jwt = false).
//
// Flow: client records in Descript → we discover the project → Underlord agent job
// produces the episode (filler words, studio sound, captions) → publish (share +
// download URLs) → agent job creates N vertical reel compositions → each published →
// transcript exported → Claude writes LinkedIn posts. Clients chat tweaks from the
// dashboard; each message becomes an Underlord agent job, then a republish.
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
async function dscTranscript(token: string, project_id: string, composition_id?: string): Promise<string> {
  const res = await fetch(`${DSC_BASE}/export/transcript`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id,
      ...(composition_id ? { composition_id } : {}),
      format: "markdown",
      include_speaker_labels: "changes",
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
async function clientFromKey(req: Request, url: URL) {
  const key = url.searchParams.get("key") || req.headers.get("x-access-key") || "";
  if (!key) return null;
  const { data } = await supabase.from("ps_clients").select("*").eq("access_key", key).eq("active", true).maybeSingle();
  return data ?? null;
}
async function isAdmin(req: Request, url: URL): Promise<boolean> {
  const secret = req.headers.get("x-admin-secret") || url.searchParams.get("admin_secret") || "";
  if (!secret) return false;
  const stored = await cfg("admin_secret");
  return !!stored && secret === stored;
}

// ---------- prompts ----------
function producePrompt(client: any): string {
  return [
    "You are producing a podcast episode recording so it is ready to publish. In the main (longest) video composition of this project:",
    "1. Remove all filler words (um, uh, like, you know) and awkward false starts.",
    "2. Cut long silences and dead air, keeping the conversation natural.",
    "3. Apply Studio Sound to all clips so the audio is clean and consistent.",
    "4. Add tasteful captions.",
    "5. Do not change the order of the conversation, do not remove substantive content, and do not add music.",
    "Keep the composition's existing name.",
  ].join("\n");
}

function reelsPrompt(client: any, episodeName: string, n: number): string {
  return [
    `From this project's main podcast composition, create ${n} NEW separate compositions, each a short-form social reel.`,
    "Requirements for every reel:",
    "- Vertical portrait format, 1080x1920.",
    "- 30 to 60 seconds long, a single self-contained highlight: a strong insight, story, or bold statement from the episode.",
    "- Start mid-action with a hook moment; no intros or outros.",
    "- Remove filler words within the reel and apply Studio Sound.",
    "- Add bold, readable captions suitable for sound-off viewing.",
    "- When several people speak, keep the speaker who is talking framed and centered.",
    `- Name each new composition exactly like: "Reel 1 — <short title>", "Reel 2 — <short title>", and so on.`,
    "Pick genuinely different moments across the episode; do not overlap the same segment twice.",
    "Do not modify the original main composition.",
    client?.target_audience ? `The audience for these reels: ${client.target_audience}. Choose moments that will resonate with them.` : "",
  ].filter(Boolean).join("\n");
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

// ---------- OpenAI (post writer) ----------
async function generatePosts(client: any, episode: any, transcript: string): Promise<any[]> {
  const apiKey = await cfg("openai_api_key");
  if (!apiKey) throw new Error("openai_api_key not configured (admin: POST /admin/config)");
  const model = (await cfg("openai_model")) || "gpt-5.5";
  const trimmed = transcript.length > 180_000 ? transcript.slice(0, 180_000) + "\n[transcript truncated]" : transcript;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: postsPrompt(client, episode.name, trimmed) }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`post generation failed: ${data?.error?.message || res.status}`);
  const text = data.choices?.[0]?.message?.content ?? "";
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < 0) throw new Error("post generation returned no JSON array");
  const posts = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(posts) || !posts.length) throw new Error("post generation returned empty array");
  return posts;
}

// ---------- job helpers ----------
async function updateJob(id: string, patch: Record<string, unknown>) {
  await supabase.from("ps_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

async function failJob(job: any, err: unknown) {
  const msg = humanDscError(err);
  await updateJob(job.id, { step: "failed", error: msg });
  await logEvent("job_failed", { job_id: job.id, kind: job.kind, error: msg });
  if (job.kind === "produce_main" && job.episode_id) {
    await supabase.from("ps_episodes").update({ status: "failed", error: msg }).eq("id", job.episode_id);
  }
  if (job.kind === "generate_posts" && job.episode_id) {
    await supabase.from("ps_episodes").update({ posts_status: "failed" }).eq("id", job.episode_id);
  }
  if (job.kind === "command" && job.payload?.command_id) {
    await supabase.from("ps_commands").update({ status: "failed", agent_response: msg }).eq("id", job.payload.command_id);
  }
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

      if (job.kind === "produce_main") {
        await supabase.from("ps_episodes").update({ status: "producing", error: null }).eq("id", episode.id);
        await startAgentJob(token, job, producePrompt(client), {
          project_id: episode.descript_project_id, model: client.descript_model,
        });
        return;
      }

      if (job.kind === "make_reels") {
        const project = await getProject(token, episode.descript_project_id);
        const before = (project.compositions ?? []).map((c: any) => c.id);
        const n = Math.min(Math.max(client.reel_count ?? 8, 1), 15);
        const j2 = { ...job, payload: { ...job.payload, before } };
        await updateJob(job.id, { payload: j2.payload });
        await startAgentJob(token, j2, reelsPrompt(client, episode.name, n), {
          project_id: episode.descript_project_id, model: client.descript_model,
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
      await updateJob(job.id, { result: { progress: dscStatus.progress ?? null } });
      return;
    }
    if (state === "cancelled") { await failJob(job, new Error("The editing job was cancelled in Descript.")); return; }
    const r = dscStatus.result ?? {};
    const failed = r.status === "error" || r.status === "failed";

    // ----- agent job finished -----
    if (job.step === "agent_running") {
      if (failed) { await failJob(job, new Error(r.error_message || "The AI editor could not complete this request.")); return; }
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
        if (!fresh.length) { await failJob(job, new Error("The AI finished but no reel compositions were found.")); return; }
        fresh.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
        const rows = fresh.map((c: any, i: number) => ({
          episode_id: episode.id, title: c.name ?? `Reel ${i + 1}`, composition_id: c.id, status: "pending", sort: i,
        }));
        await supabase.from("ps_reels").upsert(rows, { onConflict: "episode_id,composition_id" });
        const queue = fresh.map((c: any) => c.id);
        const first = queue.shift();
        await supabase.from("ps_reels").update({ status: "publishing" }).eq("episode_id", episode.id).eq("composition_id", first);
        await startPublishJob(token, job, episode.descript_project_id, first, { publish_queue: queue });
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
        const { data: existing } = await supabase.from("ps_jobs").select("id,kind")
          .eq("episode_id", episode.id).in("kind", ["make_reels", "generate_posts"])
          .not("step", "in", "(failed,cancelled)");
        const kinds = new Set((existing ?? []).map((x: any) => x.kind));
        if (!kinds.has("generate_posts")) await enqueue(job.client_id, episode.id, "generate_posts");
        if (!kinds.has("make_reels")) await enqueue(job.client_id, episode.id, "make_reels");
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
    // 429s and transient errors: leave the job in place; the next cron tick retries.
    if (e instanceof DscError && e.status === 429) {
      await logEvent("rate_limited", { job_id: job.id });
      return;
    }
    await failJob(job, e);
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
      }).eq("id", existing.id);
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
  const { data: jobs } = await supabase.from("ps_jobs").select("*")
    .not("step", "in", "(done,failed,cancelled)")
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
function episodePublic(e: any) {
  return {
    id: e.id, name: e.name, status: e.status, posts_status: e.posts_status,
    duration_seconds: e.duration_seconds, folder_path: e.folder_path,
    share_url: e.main_share_url, download_url: e.main_download_url,
    download_expires_at: e.main_download_expires_at,
    project_url: e.project_url, error: e.error,
    recorded_at: e.descript_created_at, produced_at: e.produced_at,
  };
}

async function apiOverview(client: any) {
  const { data: episodes } = await supabase.from("ps_episodes").select("*")
    .eq("client_id", client.id).order("descript_created_at", { ascending: false, nullsFirst: false }).limit(200);
  const ids = (episodes ?? []).map((e: any) => e.id);
  let reelCounts: Record<string, number> = {}, postCounts: Record<string, number> = {};
  if (ids.length) {
    const { data: reels } = await supabase.from("ps_reels").select("episode_id,status").in("episode_id", ids);
    for (const rl of reels ?? []) if (rl.status === "ready") reelCounts[rl.episode_id] = (reelCounts[rl.episode_id] ?? 0) + 1;
    const { data: posts } = await supabase.from("ps_posts").select("episode_id").in("episode_id", ids);
    for (const p of posts ?? []) postCounts[p.episode_id] = (postCounts[p.episode_id] ?? 0) + 1;
  }
  return {
    client: { name: client.name, logo_url: client.logo_url, connected: !!client.descript_token, auto_produce: client.auto_produce },
    episodes: (episodes ?? []).map((e: any) => ({ ...episodePublic(e), reels: reelCounts[e.id] ?? 0, posts: postCounts[e.id] ?? 0 })),
  };
}

async function apiEpisode(client: any, id: string) {
  const { data: e } = await supabase.from("ps_episodes").select("*").eq("id", id).eq("client_id", client.id).maybeSingle();
  if (!e) return null;
  const [{ data: reels }, { data: posts }, { data: commands }, { data: jobs }] = await Promise.all([
    supabase.from("ps_reels").select("*").eq("episode_id", id).order("sort"),
    supabase.from("ps_posts").select("*").eq("episode_id", id).order("sort"),
    supabase.from("ps_commands").select("*").eq("episode_id", id).order("created_at").limit(100),
    supabase.from("ps_jobs").select("id,kind,step,error,created_at,updated_at,result").eq("episode_id", id).order("created_at", { ascending: false }).limit(20),
  ]);
  return {
    episode: episodePublic(e),
    reels: (reels ?? []).map((r: any) => ({ id: r.id, title: r.title, status: r.status, share_url: r.share_url, download_url: r.download_url, composition_id: r.composition_id })),
    posts: (posts ?? []).map((p: any) => ({ id: p.id, hook: p.hook, body: p.body, first_comment: p.first_comment, status: p.status })),
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
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

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
          reel_count: reel_count ?? 8, auto_produce: auto_produce ?? false, descript_model: descript_model ?? null,
        }).select().single();
        if (error) return json({ error: error.message }, 400);
        if (descript_token) { try { await discoverClient(data); } catch { /* first discovery is best-effort */ } }
        return json({ ok: true, client: { ...data, descript_token: data.descript_token ? "set" : null } });
      }

      if (path === "/admin/clients/update" && req.method === "POST") {
        const { client_id, ...fields } = body;
        if (!client_id) return json({ error: "client_id required" }, 400);
        const allowed = ["name", "logo_url", "target_audience", "brand_notes", "reel_count", "auto_produce", "active", "descript_model", "descript_token"];
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

    // ----- client API -----
    if (path.startsWith("/api/")) {
      const client = await clientFromKey(req, url);
      if (!client) return json({ error: "invalid_key" }, 401);

      if (path === "/api/overview" && req.method === "GET") return json(await apiOverview(client));

      if (path === "/api/episode" && req.method === "GET") {
        const detail = await apiEpisode(client, url.searchParams.get("id") ?? "");
        return detail ? json(detail) : json({ error: "not_found" }, 404);
      }

      if (path === "/api/refresh" && req.method === "POST") {
        if (!client.descript_token) return json({ error: "Descript is not connected yet. Ask your account manager to complete onboarding." }, 400);
        const r = await discoverClient(client);
        return json({ ok: true, ...r, ...(await apiOverview(client)) });
      }

      if (path === "/api/produce" && req.method === "POST") {
        const { episode_id } = body;
        const { data: ep } = await supabase.from("ps_episodes").select("*").eq("id", episode_id).eq("client_id", client.id).maybeSingle();
        if (!ep) return json({ error: "not_found" }, 404);
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
        const jb = await enqueue(client.id, ep.id, "make_reels");
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
