import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CLIENTS_ROOT, STAGING_DIR } from "./config.js";

export const MEDIA_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".webm"]);

// Relative paths mean "inside the client folders root": "acme_bakery/03_photos_styled".
export function resolveClientPath(p: string): string {
  const cleaned = p.trim().replace(/^["']|["']$/g, "");
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(CLIENTS_ROOT, cleaned);
}

// The brand is the first folder under the clients root, the section the rest: D:\hustle\acme_bakery\03_photos_styled
// -> brand "acme_bakery", section "03_photos_styled".
export function brandOf(p: string): { brand?: string; section?: string } {
  const rel = relative(CLIENTS_ROOT, p);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return {};
  const parts = rel.split(sep).filter(Boolean);
  return { brand: parts[0], section: parts.slice(1).join("_") || undefined };
}

export function safeName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 80);
}

// Default stem for fetched files: <brand>-<section without its number>, e.g. acme_bakery-photos_styled.
export function defaultPrefix(folder: string): string {
  const { brand, section } = brandOf(folder);
  const sectionName = section?.replace(/^\d+_?/, "");
  const parts = [brand, sectionName || (!brand ? basename(folder) : undefined)].filter(Boolean) as string[];
  return safeName(parts.join("-")) || "flow";
}

// Next free number for <prefix>-NN.* in a folder, so earlier files are never overwritten.
export function nextNumber(folder: string, prefix: string): number {
  if (!existsSync(folder)) return 1;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)`, "i");
  let max = 0;
  for (const f of readdirSync(folder)) {
    const n = Number(f.match(re)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max + 1;
}

export function listMedia(folder: string): string[] {
  return readdirSync(folder)
    .filter((f) => MEDIA_EXT.has(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => join(folder, f));
}

// A copy of the file under the name it should carry in Flow (Flow titles an upload after its file name).
export function stageForUpload(file: string, title: string): string {
  mkdirSync(STAGING_DIR, { recursive: true });
  const dir = mkdtempSync(join(STAGING_DIR, "up-"));
  const staged = join(dir, title);
  copyFileSync(file, staged);
  return staged;
}

// Chrome names downloads with a bare id and no extension, so the real type is read from the first bytes.
export function sniffExtension(file: string): string {
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const ascii = (a: number, b: number) => head.subarray(a, b).toString("latin1");
  if (head[0] === 0xff && head[1] === 0xd8) return ".jpg";
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return ".png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return ".webp";
  if (ascii(4, 8) === "ftyp") return ".mp4";
  if (ascii(0, 4) === "GIF8") return ".gif";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  return ".bin";
}

// Moves a downloaded file to <stem><ext>. A ZIP (a tile holding several takes) is unpacked into <stem>, <stem>-v2...
export function placeDownload(file: string, stem: string): string[] {
  mkdirSync(dirname(stem), { recursive: true });
  const ext = sniffExtension(file);
  if (ext !== ".zip") {
    const target = `${stem}${ext}`;
    moveFile(file, target);
    return [target];
  }
  mkdirSync(STAGING_DIR, { recursive: true });
  const work = mkdtempSync(join(STAGING_DIR, "zip-"));
  unzip(file, work);
  const inner = walk(work).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out: string[] = [];
  inner.forEach((path, i) => {
    const target = `${stem}${i ? `-v${i + 1}` : ""}${sniffExtension(path)}`;
    moveFile(path, target);
    out.push(target);
  });
  unlinkSync(file);
  if (!out.length) throw new Error("Flow sent a ZIP with nothing inside it.");
  return out;
}

// Windows 10+ ships bsdtar, which reads ZIPs; PowerShell and unzip are the fallbacks.
function unzip(file: string, into: string): void {
  const attempts: [string, string[]][] = [
    ["tar", ["-xf", file, "-C", into]],
    ...(process.platform === "win32"
      ? ([["powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${file.replace(/'/g, "''")}.zip' -DestinationPath '${into.replace(/'/g, "''")}' -Force`]]] as [string, string[]][])
      : []),
    ["unzip", ["-o", "-q", file, "-d", into]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      // Expand-Archive insists on a .zip extension.
      if (cmd === "powershell") copyFileSync(file, `${file}.zip`);
      execFileSync(cmd, args, { stdio: "ignore", windowsHide: true });
      if (readdirSync(into).length) return;
    } catch {
      // next one
    } finally {
      if (cmd === "powershell" && existsSync(`${file}.zip`)) unlinkSync(`${file}.zip`);
    }
  }
  throw new Error(`Could not unpack the ZIP Flow sent (${file}).`);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// rename() fails across drives (C: -> D:), so fall back to copy + delete.
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}
