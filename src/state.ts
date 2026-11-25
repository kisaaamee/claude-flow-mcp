import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { STATE_FILE } from "./config.js";

// Per Flow project: the tiles already accounted for (present when the baseline was taken, uploaded by us, or
// fetched). "New" means a finished tile that is not in this set.
type ProjectRecord = { seen: string[]; baseline_at: string; updated_at: string };
type LastProject = { id: string; title?: string; at: string };
type StateFile = { projects: Record<string, ProjectRecord>; last_project?: LastProject };

function load(): StateFile {
  if (!existsSync(STATE_FILE)) return { projects: {} };
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFile;
    return data.projects ? data : { projects: {} };
  } catch {
    return { projects: {} };
  }
}

function save(data: StateFile): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, STATE_FILE);
}

export function seenSet(projectId: string): Set<string> | undefined {
  const rec = load().projects[projectId];
  return rec ? new Set(rec.seen) : undefined;
}

export function baselineAt(projectId: string): string | undefined {
  return load().projects[projectId]?.baseline_at;
}

export function setBaseline(projectId: string, keys: Iterable<string>): void {
  const data = load();
  const now = new Date().toISOString();
  data.projects[projectId] = { seen: [...new Set(keys)], baseline_at: now, updated_at: now };
  save(data);
}

export function addSeen(projectId: string, keys: Iterable<string>): void {
  const data = load();
  const now = new Date().toISOString();
  const rec = data.projects[projectId] ?? { seen: [], baseline_at: now, updated_at: now };
  const all = new Set(rec.seen);
  for (const k of keys) all.add(k);
  rec.seen = [...all];
  rec.updated_at = now;
  data.projects[projectId] = rec;
  save(data);
}

// The project the server worked in last; offered to the user when no project is open.
export function lastProject(): LastProject | undefined {
  return load().last_project;
}

export function setLastProject(id: string, title?: string): void {
  const data = load();
  const prev = data.last_project;
  data.last_project = { id, title: title || (prev?.id === id ? prev.title : undefined), at: new Date().toISOString() };
  save(data);
}
