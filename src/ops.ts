import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Page } from "playwright-core";
import { chromeConnected, mainFlowPage, noProjectMessage, projectIdOf, projectPage } from "./browser.js";
import * as C from "./compose.js";
import { CLIENTS_ROOT } from "./config.js";
import { brandOf, defaultPrefix, listMedia, MEDIA_EXT, nextNumber, resolveClientPath, safeName, stageForUpload } from "./files.js";
import { downloadTile, mediaIdOfTitle, renameTile, scanGrid, tileKey, uploadFile, type Kind, type Quality, type Tile } from "./flow.js";
import { addSeen, baselineAt, seenSet, setBaseline } from "./state.js";

// One Flow action at a time: two at once would fight over the same tab.
let chain: Promise<unknown> = Promise.resolve();
export function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const view = (t: Tile) => ({ title: t.title, kind: t.kind, ...(t.busy ? { rendering: true } : {}), ...(t.failed ? { failed: true } : {}) });

export async function status(a: { project_url?: string }) {
  if (!(await chromeConnected()) && !a.project_url) {
    return { chrome: "not running", note: "Chrome starts by itself on the next call that needs Flow." };
  }
  if (!a.project_url && !projectIdOf((await mainFlowPage()).url())) {
    return { chrome: "connected", project: null, clients_root: CLIENTS_ROOT, note: noProjectMessage() };
  }
  const { projectId, page } = await projectPage(a.project_url);
  const seen = seenSet(projectId);
  const tiles = await scanGrid(page, seen);
  const fresh = seen ? tiles.filter((t) => !seen.has(t.key) && !t.upload) : [];
  return {
    chrome: "connected",
    project: page.url().replace(/\?.*$/, ""),
    clients_root: CLIENTS_ROOT,
    baseline: baselineAt(projectId) ?? "none yet (cfm_upload or cfm_mark_seen sets it)",
    new_ready: fresh.filter((t) => !t.busy && !t.failed).length,
    new_rendering: fresh.filter((t) => t.busy).length,
    new_failed: fresh.filter((t) => t.failed).length,
  };
}

export async function list(a: { project_url?: string; only_new: boolean }) {
  const { projectId, page } = await projectPage(a.project_url);
  const seen = seenSet(projectId);
  const tiles = await scanGrid(page, a.only_new ? seen : undefined);
  const shown = a.only_new && seen ? tiles.filter((t) => !seen.has(t.key) && !t.upload) : tiles;
  return {
    project: page.url().replace(/\?.*$/, ""),
    count: shown.length,
    tiles: shown.map((t) => ({ ...view(t), ...(seen && !seen.has(t.key) && !t.upload ? { new: true } : {}) })),
  };
}

export async function markSeen(a: { project_url?: string }) {
  const { projectId, page } = await projectPage(a.project_url);
  const tiles = await scanGrid(page);
  setBaseline(projectId, tiles.filter((t) => !t.busy).map((t) => t.key));
  return { marked: tiles.length, note: "Everything now in the project counts as seen; cfm_fetch will only take what appears after this." };
}

type UploadItem = { path: string; name?: string };

// Flow title an uploaded file will carry: "<brand>-<file name>.<ext>" unless a name is given.
function uploadTitle(path: string, name?: string): string {
  const ext = extname(path).toLowerCase();
  const { brand } = brandOf(path);
  const base = safeName(name ? name.replace(/\.[a-z0-9]{2,4}$/i, "") : basename(path, extname(path)));
  const stem = name || !brand || base.toLowerCase().startsWith(brand.toLowerCase()) ? base : `${brand}-${base}`;
  return `${stem}${ext}`;
}

// A reference is "asset:<title>" (already in the project) or a local path, uploaded unless a tile with its name exists.
async function ensureReference(page: Page, projectId: string, ref: string, titles: Set<string>): Promise<{ title: string; uploaded: boolean }> {
  const asset = /^asset:\s*(.+)$/i.exec(ref.trim());
  if (asset) return { title: asset[1].trim(), uploaded: false };
  const path = resolveClientPath(ref);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Reference not found: ${path}`);
  if (!MEDIA_EXT.has(extname(path).toLowerCase())) throw new Error(`Reference is not an image or video: ${path}`);
  const title = uploadTitle(path);
  if (titles.has(title)) return { title, uploaded: false };
  await uploadFile(page, stageForUpload(path, title), title);
  const id = await mediaIdOfTitle(page, title);
  addSeen(projectId, [tileKey("image", id, title), tileKey("video", undefined, title)]);
  titles.add(title);
  return { title, uploaded: true };
}

export async function upload(a: { project_url?: string; files: UploadItem[]; folder?: string; skip_existing: boolean }) {
  const items: UploadItem[] = [...a.files];
  if (a.folder) {
    const dir = resolveClientPath(a.folder);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
    for (const f of listMedia(dir)) items.push({ path: f });
  }
  if (!items.length) throw new Error("Nothing to upload: give files or a folder.");

  // Resolve and name everything before touching Flow, so a bad path fails fast.
  const plan = items.map((it) => {
    const path = resolveClientPath(it.path);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`File not found: ${path}`);
    if (!MEDIA_EXT.has(extname(path).toLowerCase())) throw new Error(`Not an image or video: ${path}`);
    return { path, title: uploadTitle(path, it.name) };
  });
  const titles = plan.map((p) => p.title);
  const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
  if (dupes.length) throw new Error(`Two files would get the same name in Flow: ${[...new Set(dupes)].join(", ")}. Give them distinct names.`);

  const { projectId, page } = await projectPage(a.project_url);
  const tilesBefore = await scanGrid(page);
  // First contact with this project: whatever is there now is the baseline, so a later fetch takes only new work.
  if (!seenSet(projectId)) setBaseline(projectId, tilesBefore.filter((t) => !t.busy).map((t) => t.key));
  const existing = new Set(tilesBefore.map((t) => t.title));

  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const p of plan) {
    if (a.skip_existing && existing.has(p.title)) {
      skipped.push(p.title);
      continue;
    }
    const staged = stageForUpload(p.path, p.title);
    try {
      await uploadFile(page, staged, p.title);
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : err} (uploaded before this: ${uploaded.length ? uploaded.join(", ") : "none"})`);
    }
    const id = await mediaIdOfTitle(page, p.title);
    addSeen(projectId, [tileKey("image", id, p.title), tileKey("video", undefined, p.title)]);
    uploaded.push(p.title);
  }
  return {
    project: page.url().replace(/\?.*$/, ""),
    uploaded,
    ...(skipped.length ? { already_in_flow: skipped } : {}),
  };
}

export async function fetchNew(a: {
  project_url?: string;
  folder: string;
  kind: Kind | "all";
  quality: Quality;
  prefix?: string;
  limit?: number;
  titles?: string[];
  rename_in_flow: boolean;
}) {
  const folder = resolveClientPath(a.folder);
  mkdirSync(folder, { recursive: true });
  const prefix = safeName(a.prefix ?? "") || defaultPrefix(folder);

  const { projectId, page } = await projectPage(a.project_url);
  const seen = seenSet(projectId);
  if (!seen && !a.titles?.length) {
    throw new Error(
      "This project has no baseline yet, so there is no telling what is new. Call cfm_mark_seen (everything now in it counts as old), or pass titles.",
    );
  }
  const tiles = await scanGrid(page, a.titles?.length ? undefined : seen);
  // Fetching by title on a project never seen before: take the baseline now, or everything else would look new later.
  if (!seen) setBaseline(projectId, tiles.filter((t) => !t.busy).map((t) => t.key));
  let candidates = a.titles?.length
    ? a.titles.map((title) => {
        const t = tiles.find((x) => x.title === title) ?? tiles.find((x) => x.title.toLowerCase().startsWith(title.toLowerCase()));
        if (!t) throw new Error(`No tile titled "${title}" in this project.`);
        return t;
      })
    : tiles.filter((t) => !seen!.has(t.key) && !t.upload).reverse(); // grid is newest first; files are numbered oldest first
  if (a.kind !== "all") candidates = candidates.filter((t) => t.kind === a.kind);
  const rendering = candidates.filter((t) => t.busy);
  const failed = candidates.filter((t) => t.failed);
  let ready = candidates.filter((t) => !t.busy && !t.failed);
  if (a.limit) ready = ready.slice(0, a.limit);

  let n = nextNumber(folder, prefix);
  const saved: { title: string; files: string[]; size: string; renamed_in_flow?: string; rename_failed?: string }[] = [];
  const errors: string[] = [];
  for (const tile of ready) {
    const stem = `${prefix}-${String(n).padStart(2, "0")}`;
    try {
      const got = await downloadTile(page, tile, join(folder, stem), a.quality);
      n++;
      const entry: (typeof saved)[number] = { title: tile.title, files: got.files, size: got.size };
      const keys = [tile.key];
      if (a.rename_in_flow) {
        const failure = await renameTile(page, tile, stem);
        if (failure) entry.rename_failed = failure;
        else {
          entry.renamed_in_flow = stem;
          keys.push(tileKey(tile.kind, tile.mediaId, stem));
        }
      }
      addSeen(projectId, keys);
      saved.push(entry);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (failed.length) addSeen(projectId, failed.map((t) => t.key));

  return {
    folder,
    saved,
    ...(rendering.length ? { still_rendering: rendering.map((t) => t.title), note_rendering: "Not taken yet: call cfm_fetch again when they finish." } : {}),
    ...(failed.length ? { failed_in_flow: failed.map((t) => t.title) } : {}),
    ...(errors.length ? { errors } : {}),
    ...(!ready.length && !rendering.length && !failed.length ? { note: "Nothing new in the project since the last fetch or upload." } : {}),
  };
}

export async function rename(a: { project_url?: string; renames: { title: string; to: string }[] }) {
  const { projectId, page } = await projectPage(a.project_url);
  const tiles = await scanGrid(page);
  const done: { from: string; to: string }[] = [];
  const failed: { from: string; to: string; why: string }[] = [];
  for (const r of a.renames) {
    const to = r.to.trim();
    const exact = tiles.filter((t) => t.title === r.title);
    const matches = exact.length ? exact : tiles.filter((t) => t.title.toLowerCase().startsWith(r.title.toLowerCase()));
    if (matches.length !== 1) {
      failed.push({ from: r.title, to, why: matches.length ? `${matches.length} tiles carry this title; rename them in Flow by hand` : "no tile with this title" });
      continue;
    }
    const tile = matches[0];
    const why = await renameTile(page, tile, to);
    if (why) {
      failed.push({ from: tile.title, to, why });
      continue;
    }
    // Keep the "already seen" record pointing at the tile under its new name too.
    const seen = seenSet(projectId);
    if (seen?.has(tile.key)) addSeen(projectId, [tileKey(tile.kind, tile.mediaId, to)]);
    tile.title = to;
    done.push({ from: r.title, to });
  }
  return { renamed: done, ...(failed.length ? { failed } : {}) };
}

// ---------- generation (fire and forget) ----------

const PRICE_RULE =
  "Anything Flow prices above 0 credits needs max_credits at or above Flow's quote; the quote is read from Flow before starting.";

export async function generate(a: {
  project_url?: string;
  prompt: string;
  type: "image" | "video";
  aspect?: string;
  count: number;
  model?: string;
  references: string[];
  video_mode?: "ingredients" | "frames";
  first_frame?: string;
  last_frame?: string;
  resolution?: string;
  duration?: number;
  max_credits?: number;
  keep_lines: boolean;
}) {
  const frames = Boolean(a.first_frame || a.last_frame) || a.video_mode === "frames";
  if (a.type === "image" && (a.first_frame || a.last_frame || a.video_mode || a.duration || a.resolution)) {
    throw new Error("first_frame, last_frame, video_mode, duration and resolution are for videos only.");
  }
  if (frames && a.references.length) {
    throw new Error("Flow's prompt box takes either frames (first/last) or references, not both. Use one or the other.");
  }

  const { projectId, page } = await projectPage(a.project_url);
  const tiles = await scanGrid(page);
  if (!seenSet(projectId)) setBaseline(projectId, tiles.filter((t) => !t.busy).map((t) => t.key));
  const titles = new Set(tiles.map((t) => t.title));

  // References and frames first (uploading touches the grid), then the prompt box.
  const refs: string[] = [];
  const uploaded: string[] = [];
  for (const r of a.references) {
    const got = await ensureReference(page, projectId, r, titles);
    refs.push(got.title);
    if (got.uploaded) uploaded.push(got.title);
  }
  const frameTitles: { which: "Start" | "End"; title: string }[] = [];
  for (const [which, ref] of [["Start", a.first_frame], ["End", a.last_frame]] as const) {
    if (!ref) continue;
    const got = await ensureReference(page, projectId, ref, titles);
    frameTitles.push({ which, title: got.title });
    if (got.uploaded) uploaded.push(got.title);
  }

  await C.setAgent(page, false);
  await C.clearPrompt(page);
  const applied = await C.applySettings(page, {
    type: a.type,
    aspect: a.aspect,
    count: a.count,
    model: a.model,
    video_mode: a.type === "video" ? (frames ? "frames" : "ingredients") : undefined,
    resolution: a.resolution,
    duration: a.duration,
  });
  if (applied.quote === undefined && a.type === "video") {
    throw new Error("Could not read Flow's credit quote for this video, so nothing was started.");
  }
  if ((applied.quote ?? 0) > (a.max_credits ?? 0)) {
    throw new Error(`Flow quotes ${applied.quote} credits (${applied.model}). max_credits is ${a.max_credits ?? "not set"}. Nothing was started. ${PRICE_RULE}`);
  }

  for (const f of frameTitles) await C.attach(page, C.frameButton(page, f.which), f.title);
  for (const t of refs) await C.attach(page, C.plusButton(page), t);
  if (refs.length) {
    const n = await C.attachedCount(page);
    if (n < refs.length) throw new Error(`Only ${n} of ${refs.length} references attached. Nothing was started.`);
  }
  await C.writePrompt(page, a.prompt, a.keep_lines);
  await C.start(page);
  return {
    started: true,
    type: a.type,
    model: applied.model,
    credits_quoted: applied.quote ?? 0,
    settings: { aspect: a.aspect ?? "(Flow's current)", count: a.count, ...(a.type === "video" ? { mode: frames ? "frames" : "ingredients", resolution: a.resolution, duration: a.duration } : {}) },
    ...(refs.length ? { references: refs } : {}),
    ...(frameTitles.length ? { frames: frameTitles } : {}),
    ...(uploaded.length ? { uploaded } : {}),
    note: "Started; not waiting for the render. Fetch with cfm_fetch when it is done.",
  };
}

export async function agent(a: {
  project_url?: string;
  prompt: string;
  references: string[];
  aspect?: string;
  count: number;
  confirm: "never" | "always";
  allow_video: boolean;
  acknowledge_cost: boolean;
  guard_line: boolean;
  keep_lines: boolean;
}) {
  if (a.allow_video && !a.acknowledge_cost) {
    throw new Error("Flow Agent shows no price before it starts, and video costs credits: pass acknowledge_cost: true once the user has agreed to the spend.");
  }
  const { projectId, page } = await projectPage(a.project_url);
  const tiles = await scanGrid(page);
  if (!seenSet(projectId)) setBaseline(projectId, tiles.filter((t) => !t.busy).map((t) => t.key));
  const titles = new Set(tiles.map((t) => t.title));
  const refs: string[] = [];
  const uploaded: string[] = [];
  for (const r of a.references) {
    const got = await ensureReference(page, projectId, r, titles);
    refs.push(got.title);
    if (got.uploaded) uploaded.push(got.title);
  }

  await C.setAgent(page, true);
  const notes = await C.setAgentSettings(page, { confirm: a.confirm === "never" ? "Never" : "Always", aspect: a.aspect, count: a.count });
  await C.clearPrompt(page);
  for (const t of refs) await C.attach(page, C.plusButton(page), t);
  if (refs.length) {
    const n = await C.attachedCount(page);
    if (n < refs.length) throw new Error(`Only ${n} of ${refs.length} references attached. Nothing was sent to the agent.`);
  }
  const guard = a.guard_line
    ? `${a.allow_video ? "" : "Images only, never video. "}Do not ask questions; generate everything now.${refs.length ? ` The attached images are, in order: ${refs.map((t, i) => `Reference ${String.fromCharCode(65 + i)} = ${t}`).join("; ")}.` : ""}\n`
    : "";
  await C.writePrompt(page, guard + a.prompt, a.keep_lines);
  await C.start(page);
  return {
    sent_to_agent: true,
    confirm: a.confirm,
    ...(refs.length ? { references: refs } : {}),
    ...(uploaded.length ? { uploaded } : {}),
    ...(notes.length ? { notes } : {}),
    note: "Sent; not waiting. Flow Agent is left on while it works; the next cfm_generate turns it off. Fetch with cfm_fetch when the batch is done.",
  };
}

// ---------- development aid ----------

const FORBIDDEN_CLICK = /start generation|^generate|send|delete|trash|sign out|upgrade|buy|purchase|subscribe|add ai credits|done editing|save new voice/i;

export async function inspect(a: {
  project_url?: string;
  open?: "settings" | "ingredients" | "agent_settings" | "model_menu";
  click?: { role: string; name: string };
  selector?: string;
  escape_after: boolean;
  max_chars: number;
}) {
  const { page } = await projectPage(a.project_url);
  const steps: string[] = [];
  if (a.open === "settings") {
    await page.getByRole("button", { name: "Settings trigger" }).click({ timeout: 5000 });
    steps.push("opened settings");
  } else if (a.open === "ingredients") {
    await C.plusButton(page).click({ timeout: 5000 });
    steps.push("opened + picker");
  } else if (a.open === "agent_settings") {
    await page.locator("flow-base-prompt-box").getByRole("button", { name: /^(Agent s|S)ettings$/ }).click({ timeout: 5000 });
    steps.push("opened agent settings");
  } else if (a.open === "model_menu") {
    await page.getByRole("button", { name: "Select model family" }).click({ timeout: 5000 });
    steps.push("opened model menu");
  }
  if (a.click) {
    if (FORBIDDEN_CLICK.test(a.click.name)) throw new Error(`cfm_inspect never clicks "${a.click.name}".`);
    await page.getByRole(a.click.role as Parameters<Page["getByRole"]>[0], { name: a.click.name }).first().click({ timeout: 5000 });
    steps.push(`clicked ${a.click.role} "${a.click.name}"`);
  }
  await new Promise((r) => setTimeout(r, 900));
  const parts: string[] = [];
  const targets = a.selector ? [a.selector] : ["flow-base-prompt-box", ".cdk-overlay-container", "flow-agent-panel"];
  for (const sel of targets) {
    const loc = page.locator(sel).first();
    if (!(await loc.count())) continue;
    const snap = await loc.ariaSnapshot({ timeout: 5000 }).catch((e: Error) => `(no snapshot: ${e.message.split("\n")[0]})`);
    if (snap.trim()) parts.push(`## ${sel}\n${snap}`);
  }
  if (a.escape_after) {
    await C.clearBackdrops(page);
    await C.blurFocus(page);
    await page.keyboard.press("Escape").catch(() => {});
  }
  const text = parts.join("\n\n") || "(nothing found)";
  return { steps, agent_on: await C.agentIsOn(page), snapshot: text.length > a.max_chars ? `${text.slice(0, a.max_chars)}\n… (cut at ${a.max_chars} chars)` : text };
}
