import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { chromeConnected, projectPage } from "./browser.js";
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
    const ext = extname(path).toLowerCase();
    if (!MEDIA_EXT.has(ext)) throw new Error(`Not an image or video: ${path}`);
    const { brand } = brandOf(path);
    const base = safeName(it.name ? it.name.replace(/\.[a-z0-9]{2,4}$/i, "") : basename(path, extname(path)));
    const stem = it.name || !brand || base.toLowerCase().startsWith(brand.toLowerCase()) ? base : `${brand}-${base}`;
    return { path, title: `${stem}${ext}` };
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
