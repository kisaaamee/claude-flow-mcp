import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { sleep } from "./browser.js";
import { DOWNLOAD_DIR } from "./config.js";
import { placeDownload } from "./files.js";

export type Kind = "image" | "video";

export type Tile = {
  key: string; // "img:<media id>" for images, "vid:<title>" for videos (a resting video tile carries no id)
  title: string;
  kind: Kind;
  mediaId?: string;
  busy: boolean; // still rendering or still processing
  failed: boolean;
  upload: boolean; // looks like a file someone uploaded (its title ends in a file extension)
};

type Raw = {
  title: string;
  kind: "image" | "video" | "other";
  mediaId?: string;
  progress: boolean;
  failed: boolean;
  ready: boolean;
  top: number;
  left: number;
};

const UPLOAD_TITLE = /\.(jpe?g|png|webp|gif|mp4|mov|webm)$/i;

export const tileKey = (kind: Kind, mediaId: string | undefined, title: string) =>
  kind === "image" && mediaId ? `img:${mediaId}` : `vid:${title}`;

function toTile(r: Raw): Tile | undefined {
  if (r.kind === "other") return undefined;
  const kind: Kind = r.kind;
  const busy = r.progress || !r.ready || (kind === "image" && !r.mediaId);
  return {
    key: tileKey(kind, r.mediaId, r.title),
    title: r.title,
    kind,
    mediaId: r.mediaId,
    busy: busy && !r.failed,
    failed: r.failed,
    upload: UPLOAD_TITLE.test(r.title),
  };
}

async function readMounted(page: Page): Promise<Raw[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("flow-grid-tile-container")].map((el) => {
      const box = el.getBoundingClientRect();
      const failed = !!el.querySelector("flow-error-tile");
      const isVideo = !!el.querySelector("flow-video-tile");
      const isImage = !!el.querySelector("flow-image-tile");
      const other = !!el.querySelector("flow-collection-tile, flow-scene-tile, flow-character-tile");
      const idEl = el.querySelector("[data-media-id]");
      const text = (el as HTMLElement).innerText ?? "";
      const ready = isVideo ? !!el.querySelector('img[alt="Generated video thumbnail"], video') : true;
      return {
        title: el.getAttribute("aria-label") ?? "",
        kind: other ? "other" : isVideo ? "video" : isImage || failed ? "image" : "other",
        mediaId: idEl?.getAttribute("data-media-id") ?? undefined,
        progress: /(^|\s)\d{1,3}%/.test(text),
        failed,
        ready,
        top: box.top,
        left: box.left,
      } as const;
    }),
  ) as Promise<Raw[]>;
}

// The grid scrolls inside its own container, not the window.
async function scrollGrid(page: Page, to: "top" | "down"): Promise<boolean> {
  return page.evaluate((dir) => {
    const boxes = [...document.querySelectorAll<HTMLElement>(".page-container")].filter((e) => e.scrollHeight > e.clientHeight);
    if (!boxes.length) return false;
    let moved = false;
    for (const box of boxes) {
      const before = box.scrollTop;
      box.scrollTop = dir === "top" ? 0 : before + box.clientHeight * 0.8;
      if (box.scrollTop !== before) moved = true;
    }
    return moved;
  }, to);
}

export async function toTop(page: Page): Promise<void> {
  await scrollGrid(page, "top");
  await sleep(400);
}

// Shows every kind of media (the left menu may be filtered to Images or Videos). Best effort.
async function showAllMedia(page: Page): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Project navigation" });
  const all = nav.locator("button, a").filter({ hasText: /All media\s*$/ }).first();
  if (await all.isVisible().catch(() => false)) {
    await all.click({ timeout: 5000 }).catch(() => {});
    // Leave the focus outside the side menu: an Escape with the focus inside it closes the menu.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
    await sleep(800);
  }
}

// Reads the grid from the top (newest first). With `seen`, it stops once two whole screens bring nothing unseen,
// because new tiles always appear at the top.
export async function scanGrid(page: Page, seen?: Set<string>, maxScreens = 120): Promise<Tile[]> {
  await showAllMedia(page);
  await toTop(page);
  const found = new Map<string, Tile>();
  let quietScreens = 0;
  for (let screen = 0; screen < maxScreens; screen++) {
    const raw = (await readMounted(page)).sort((a, b) => a.top - b.top || a.left - b.left);
    let fresh = false;
    for (const r of raw) {
      const t = toTile(r);
      if (!t || found.has(t.key)) continue;
      found.set(t.key, t);
      if (!seen?.has(t.key)) fresh = true;
    }
    if (seen) {
      quietScreens = fresh ? 0 : quietScreens + 1;
      if (quietScreens >= 2) break;
    }
    if (!(await scrollGrid(page, "down"))) break;
    await sleep(600);
  }
  await toTop(page);
  return [...found.values()];
}

function locatorFor(page: Page, tile: Pick<Tile, "kind" | "mediaId" | "title">): Locator {
  if (tile.kind === "image" && tile.mediaId) {
    return page.locator(`flow-grid-tile-container:has([data-media-id="${tile.mediaId}"])`).first();
  }
  return page.locator(`flow-grid-tile-container[aria-label="${tile.title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`).first();
}

// The grid is virtual: a tile further down is not in the page until scrolled to.
async function findTile(page: Page, tile: Pick<Tile, "kind" | "mediaId" | "title">): Promise<Locator> {
  await toTop(page);
  const loc = locatorFor(page, tile);
  for (let i = 0; i < 120; i++) {
    if (await loc.count()) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      return loc;
    }
    if (!(await scrollGrid(page, "down"))) break;
    await sleep(500);
  }
  throw new Error(`"${tile.title}" is no longer in the Flow grid.`);
}

// Flow shows a tile's toolbar only for a real pointer movement over it.
// The pointer is moved off the tile first: when it already rests on the tile (right after a download from it), a move
// to the same point fires no event and the toolbar never appears.
async function openTileMenu(page: Page, tile: Locator): Promise<"toolbar" | "right-click"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await tile.boundingBox();
    if (box) {
      await page.mouse.move(Math.max(2, box.x - 40), Math.max(2, box.y - 40));
      await sleep(150);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + attempt * 6, { steps: 6 });
    } else {
      await tile.hover().catch(() => {});
    }
    await sleep(400);
    const more = tile.getByRole("button", { name: "More options" });
    if (await more.waitFor({ state: "visible", timeout: 2500 }).then(() => true, () => false)) {
      await more.click();
      return "toolbar";
    }
  }
  await tile.click({ button: "right" });
  return "right-click";
}

async function offeredMenuItems(page: Page): Promise<string> {
  const items = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => [] as string[]);
  return items.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).join(" | ") || "nothing";
}

async function closeMenus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
}

// ---------- upload ----------

// Uploads a file that already carries its final name; Flow titles the asset after the file name.
export async function uploadFile(page: Page, stagedFile: string, title: string, timeoutMs = 120_000): Promise<void> {
  await toTop(page);
  await page.getByRole("button", { name: "Add media menu" }).click();
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("menuitem", { name: "Upload", exact: true }).click();
  await (await chooser).setFiles(stagedFile);
  // Done when the tile with this title carries a media id, i.e. Flow has finished processing it.
  const done = page.locator(`flow-grid-tile-container[aria-label="${title.replace(/"/g, '\\"')}"]:has([data-media-id])`).first();
  await done.waitFor({ state: "attached", timeout: timeoutMs }).catch(() => {
    throw new Error(`Flow did not finish processing "${title}" within ${Math.round(timeoutMs / 1000)} s.`);
  });
  await sleep(800);
}

export async function mediaIdOfTitle(page: Page, title: string): Promise<string | undefined> {
  const el = page.locator(`flow-grid-tile-container[aria-label="${title.replace(/"/g, '\\"')}"] [data-media-id]`).first();
  return (await el.getAttribute("data-media-id").catch(() => null)) ?? undefined;
}

// ---------- download ----------

const SYSTEM_DOWNLOADS = join(homedir(), "Downloads");

function snapshotDownloads(): Set<string> {
  const s = new Set<string>();
  for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) if (existsSync(dir)) for (const f of readdirSync(dir)) s.add(join(dir, f));
  return s;
}

// Chrome can lose this setting whenever another debugger attaches, so it is set before every download. If it is
// lost anyway, the file lands in ~/Downloads, which is watched too.
async function routeDownloads(page: Page): Promise<void> {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const session = await page.context().newCDPSession(page);
  await session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOAD_DIR, eventsEnabled: true }).catch(() => {});
  await session.detach().catch(() => {});
}

async function waitForArrival(before: Set<string>, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: { path: string; size: number } | undefined;
  while (Date.now() < deadline) {
    await sleep(300);
    for (const dir of [DOWNLOAD_DIR, SYSTEM_DOWNLOADS]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        if (before.has(path) || f.endsWith(".crdownload") || f.endsWith(".tmp") || f.startsWith(".")) continue;
        const size = statSync(path).size;
        if (size > 0 && last?.path === path && last.size === size) return path;
        last = { path, size };
      }
    }
  }
  return undefined;
}

export type Quality = "best" | "original";

// Downloads one tile to <stem>.<ext>. "best" = the free upscale (2K image / 1080p video), falling back to the
// original size when the upscale is not offered or does not arrive in time.
export async function downloadTile(page: Page, tile: Tile, stem: string, quality: Quality): Promise<{ files: string[]; size: string }> {
  const upscaleWait = tile.kind === "video" ? 240_000 : 120_000;
  const plan: ("upscaled" | "original")[] = quality === "best" ? ["upscaled", "original"] : ["original"];
  let lastError = "";
  for (const want of plan) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await routeDownloads(page);
        const loc = await findTile(page, tile);
        const before = snapshotDownloads();
        await openTileMenu(page, loc);
        const download = page.getByRole("menuitem", { name: "Download", exact: true });
        if (!(await download.waitFor({ state: "visible", timeout: 6000 }).then(() => true, () => false))) {
          const offered = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => []);
          throw new Error(offered.length ? `the tile menu has no Download (it offers: ${offered.map((t) => t.trim()).join(" | ")})` : "the tile menu did not open");
        }
        await download.click();
        const enabled = page.locator('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])');
        const choice = enabled.filter({ hasText: want === "upscaled" ? /upscaled/i : /original/i }).first();
        const hasSubmenu = await choice.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false);
        if (!hasSubmenu) {
          if (want === "upscaled") {
            await closeMenus(page);
            break; // no free upscale offered: go to the original
          }
          // No size submenu at all: the click on Download already started it.
        } else {
          await choice.click();
        }
        const label = hasSubmenu ? (await choice.innerText().catch(() => want)).replace(/\s+/g, " ").trim() : "default";
        const arrived = await waitForArrival(before, want === "upscaled" ? upscaleWait : 120_000);
        await closeMenus(page);
        if (!arrived) {
          lastError = `${want} download did not arrive`;
          if (want === "upscaled") break;
          continue;
        }
        return { files: placeDownload(arrived, stem), size: label.replace(/^(download|file_download)\s*/i, "") };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await closeMenus(page);
        await sleep(1500);
      }
    }
  }
  throw new Error(`Could not download "${tile.title}": ${lastError || "unknown reason"}.`);
}

// ---------- rename ----------

// Renames a tile through its menu and checks that the new title really shows. Returns undefined on success, else why not.
export async function renameTile(page: Page, tile: Tile, newTitle: string): Promise<string | undefined> {
  let why = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await closeMenus(page);
      const loc = await findTile(page, tile);
      const via = await openTileMenu(page, loc);
      const rename = page.getByRole("menuitem", { name: /rename/i }).first();
      if (!(await rename.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false))) {
        why = `the tile menu (${via}) has no Rename; it offers: ${await offeredMenuItems(page)}`;
        continue;
      }
      await rename.click();
      await sleep(900);
      // Flow opens a text field with the old title selected; prefer typing into whatever field has the focus.
      const field = page.locator("input:focus, textarea:focus, [contenteditable='true']:focus").first();
      if (await field.count()) {
        await field.fill(newTitle).catch(async () => {
          await page.keyboard.press("ControlOrMeta+a");
          await page.keyboard.type(newTitle, { delay: 10 });
        });
      } else {
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type(newTitle, { delay: 10 });
      }
      await page.keyboard.press("Enter");
      const renamed = page.locator(`flow-grid-tile-container[aria-label="${newTitle.replace(/"/g, '\\"')}"]`).first();
      if (await renamed.waitFor({ state: "attached", timeout: 6000 }).then(() => true, () => false)) {
        await closeMenus(page);
        return undefined;
      }
      why = "the new title did not show on the tile";
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
  }
  await closeMenus(page);
  return why || "unknown reason";
}
