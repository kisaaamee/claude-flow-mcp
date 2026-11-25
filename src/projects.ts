import type { Page } from "playwright-core";
import { english, flowContext, mainFlowPage, projectIdOf, projectPage, projectTitleOf, signedInOrThrow, sleep } from "./browser.js";
import { FLOW_ORIGIN } from "./config.js";
import { lastProject, setBaseline, setLastProject } from "./state.js";

// Choosing the Flow project to work in: list the account's projects, open one, or create a new one.
// When no project is open, every other tool fails with NO_PROJECT_OPEN and the assistant is told to ask the user,
// using these.

export type ProjectInfo = { id?: string; title: string; url?: string; detail?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const projectUrl = (id: string) => `${FLOW_ORIGIN}/project/${id}`;

// Waits for Flow's start page to show either project cards or the New project button.
async function waitForHome(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signedInOrThrow(page);
    const links = await page.locator('a[href*="/project/"]').count().catch(() => 0);
    if (links || (await newProjectButton(page).isVisible().catch(() => false))) {
      await sleep(800); // let the rest of the cards render
      return;
    }
    await sleep(500);
  }
  throw new Error("Flow's start page did not show any projects or a 'New project' button within 30 s.");
}

function newProjectButton(page: Page) {
  return page.getByRole("button", { name: /new project/i }).or(page.getByRole("link", { name: /new project/i })).first();
}

type RawCard = { id: string; title: string; lines: string[] };

// Flow's start page draws projects as clickable cards, not links, so three ways are tried in turn:
// 1) links to /project/<id>; 2) any attribute carrying a project id, with the card's text; 3) card-sized clickable
// boxes with a short caption (title only; such a project is opened by clicking its card).
async function readCards(page: Page): Promise<ProjectInfo[]> {
  const raw: RawCard[] = await page.evaluate(() => {
    const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
    const SKIP = /^(add\s*)?new project$|^try it now!?$|^last modified|^(sign in|help|faq)$/i;
    const textLines = (el: Element) => ((el as HTMLElement).innerText ?? "").split("\n").map((t) => t.trim()).filter(Boolean);
    const out: { id: string; title: string; lines: string[] }[] = [];

    // A generic label such as "Open project" is not a title: the name is in the card around the link.
    const GENERIC = /^(open|view|go to)( project)?$/i;
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/project/"]')];
    for (const a of links) {
      const id = (a.getAttribute("href") ?? "").match(UUID)?.[1];
      if (!id) continue;
      let lines = textLines(a).filter((l) => !GENERIC.test(l) && !SKIP.test(l));
      // Walk up to the card: the nearest box with text that holds no other project's link.
      for (let box = a.parentElement, i = 0; !lines.length && box && i < 6; box = box.parentElement, i++) {
        if (links.some((o) => o !== a && box!.contains(o) && (o.getAttribute("href") ?? "").match(UUID)?.[1] !== id)) break;
        lines = textLines(box).filter((l) => !GENERIC.test(l) && !SKIP.test(l));
      }
      const label = (a.getAttribute("aria-label") ?? "").trim();
      out.push({ id, title: lines[0] || (GENERIC.test(label) ? "" : label), lines });
    }
    if (out.length) return out;

    for (const el of document.querySelectorAll("body *")) {
      if (el.closest("script, style")) continue;
      let id: string | undefined;
      for (const at of el.getAttributeNames()) {
        id = el.getAttribute(at)?.match(UUID)?.[1];
        if (id) break;
      }
      if (!id) continue;
      let box: Element | null = el;
      while (box && textLines(box).length === 0) box = box.parentElement;
      const lines = box ? textLines(box).slice(0, 4) : [];
      if (lines.some((l) => SKIP.test(l))) continue;
      out.push({ id, title: (el.getAttribute("aria-label") ?? "").trim() || lines[0] || "", lines });
    }
    if (out.length) return out;

    const cards = [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 140 || r.height < 120 || r.width > 900 || r.height > 900) return false;
      const lines = textLines(el);
      if (lines.length < 1 || lines.length > 3 || lines[0].length > 120 || SKIP.test(lines[0])) return false;
      const clickable = getComputedStyle(el).cursor === "pointer" || el.getAttribute("role") === "button" || el.tabIndex >= 0;
      return clickable && !!el.querySelector("img, video, canvas, picture, [style*='background-image']") || (clickable && r.height > 150);
    });
    // keep the outermost box of each card
    const outer = cards.filter((el) => !cards.some((o) => o !== el && o.contains(el)));
    return outer.map((el) => {
      const lines = textLines(el);
      return { id: "", title: lines[lines.length - 1], lines };
    });
  });
  const out: ProjectInfo[] = [];
  for (const r of raw) {
    const title = r.title || "(untitled)";
    if (out.some((p) => (r.id ? p.id === r.id : !p.id && p.title === title))) continue;
    // Icon names (edit, delete, more_vert …) show up as text in Flow's Material icons; they are not details.
    const ICON = /^(edit|delete|more_vert|more_horiz|play_arrow|videocam|image|share|content_copy|open_in_new|[a-z]+(_[a-z]+)+)$/;
    const detail = r.lines.filter((l) => l !== title && !ICON.test(l)).join(" · ") || undefined;
    out.push({ ...(r.id ? { id: r.id, url: projectUrl(r.id) } : {}), title, ...(detail ? { detail } : {}) });
  }
  return out;
}

// What the start page looks like around the project grid, for fixing the reader when Flow changes.
async function homeSketch(page: Page): Promise<string> {
  return page.evaluate(() => {
    const anchor = [...document.querySelectorAll<HTMLElement>("body *")].find((e) => /^last modified/i.test((e.innerText ?? "").trim()) && e.children.length < 4);
    let grid: Element | null | undefined = anchor;
    for (let i = 0; grid && i < 6 && (grid.textContent ?? "").length < 40; i++) grid = grid.parentElement;
    const root = grid?.parentElement ?? document.body;
    const clone = root.cloneNode(true) as Element;
    clone.querySelectorAll("svg, script, style, path").forEach((e) => e.remove());
    clone.querySelectorAll("*").forEach((e) => e.removeAttribute("style"));
    return clone.outerHTML.replace(/\s+/g, " ").slice(0, 4000);
  }).catch((e: Error) => `(no sketch: ${e.message})`);
}

// The start page may load more cards as it scrolls (in the window or in an inner container).
async function scrollHome(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let moved = false;
    const boxes = [document.scrollingElement, ...document.querySelectorAll<HTMLElement>("*")].filter(
      (e): e is Element => !!e && e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY !== "visible",
    );
    for (const box of boxes) {
      const before = box.scrollTop;
      box.scrollTop = before + box.clientHeight * 0.9;
      if (box.scrollTop !== before) moved = true;
    }
    return moved;
  });
}

async function currentProject(): Promise<{ id: string; title?: string; url: string } | undefined> {
  const context = await flowContext();
  for (const p of context.pages()) {
    const id = projectIdOf(p.url());
    if (id) return { id, title: await projectTitleOf(p), url: projectUrl(id) };
  }
  return undefined;
}

// Reads the account's projects in a separate tab, so whatever the user has open stays as it is.
export async function readProjects(limit = 100, sketch?: { text?: string }): Promise<ProjectInfo[]> {
  const context = await flowContext();
  const tab = await context.newPage();
  try {
    await tab.goto(english(`${FLOW_ORIGIN}/`), { waitUntil: "domcontentloaded" });
    await waitForHome(tab);
    let found = await readCards(tab);
    for (let quiet = 0, i = 0; found.length < limit && quiet < 2 && i < 30; i++) {
      if (!(await scrollHome(tab))) break;
      await sleep(900);
      const more = await readCards(tab);
      quiet = more.length > found.length ? 0 : quiet + 1;
      found = more.length >= found.length ? more : found;
    }
    if (sketch) sketch.text = await homeSketch(tab);
    return found.slice(0, limit);
  } finally {
    await tab.close().catch(() => {});
  }
}

export async function projects(a: { limit: number; debug?: boolean }) {
  const sketch: { text?: string } = {};
  const [list, open] = [await readProjects(a.limit, a.debug ? sketch : undefined), await currentProject()];
  const last = lastProject();
  if (last && !last.title) last.title = list.find((p) => p.id === last.id)?.title;
  return {
    open_project: open ?? null,
    last_used: last ? { id: last.id, title: last.title, url: projectUrl(last.id) } : null,
    count: list.length,
    projects: list.map((p) => ({ ...p, ...(isOne(p, open) ? { open: true } : {}), ...(isOne(p, last) ? { last_used: true } : {}) })),
    note:
      list.length === 0
        ? "No projects found on the account (or Flow's start page changed). Offer the user a new project."
        : "Show this list to the user and ask which project to work in, or whether to create a new one (and its name). Then call cfm_open_project.",
    ...(sketch.text && a.debug ? { page_sketch: sketch.text } : {}),
  };
}

function isOne(p: ProjectInfo, other?: { id: string; title?: string }): boolean {
  if (!other) return false;
  return p.id ? p.id === other.id : !!other.title && norm(p.title) === norm(other.title);
}

function norm(s: string) {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// project: an address, a bare id, or a title (exact, else a unique beginning, else a unique part of it).
async function resolveProject(project: string): Promise<{ id?: string; title?: string }> {
  const fromUrl = projectIdOf(project);
  if (fromUrl) return { id: fromUrl };
  if (UUID.test(project.trim())) return { id: project.trim() };
  const list = await readProjects(200);
  const want = norm(project);
  const pick = (ps: ProjectInfo[]) => (ps.length === 1 ? ps[0] : undefined);
  const exact = list.filter((p) => norm(p.title) === want);
  const starts = list.filter((p) => norm(p.title).startsWith(want));
  const contains = list.filter((p) => norm(p.title).includes(want));
  const hit = pick(exact) ?? (exact.length ? undefined : pick(starts) ?? (starts.length ? undefined : pick(contains)));
  if (hit) return { id: hit.id, title: hit.title };
  const candidates = exact.length ? exact : starts.length ? starts : contains;
  if (candidates.length) {
    throw new Error(
      `"${project}" matches several projects: ${candidates.map((p) => `"${p.title}"${p.url ? ` (${p.url})` : ""}`).join(", ")}. Ask the user which one; pass its full title or address.`,
    );
  }
  throw new Error(`No Flow project is called "${project}". Call cfm_projects and show the user the list, or create a new project.`);
}

// Best effort: Flow keeps the project name in an editable field at the top of the project page.
async function renameProject(page: Page, name: string): Promise<string | undefined> {
  const candidates = [
    page.locator('input[aria-label*="project" i]:not(flow-base-prompt-box *)'),
    page.locator('input[aria-label*="title" i]:not(flow-base-prompt-box *), input[aria-label*="name" i]:not(flow-base-prompt-box *)'),
    page.locator("header input[type='text'], header input:not([type]), header [contenteditable='true']"),
    page.getByRole("button", { name: /^(untitled|new project|rename|edit (project )?(name|title))/i }),
    page.getByText(/^untitled( project)?/i),
  ];
  for (const cand of candidates) {
    const el = cand.first();
    if (!(await el.isVisible().catch(() => false))) continue;
    try {
      await el.click({ timeout: 4000 });
      await sleep(500);
      const field = page.locator("input:focus, textarea:focus, [contenteditable='true']:focus").first();
      if (!(await field.count())) continue;
      if (await field.evaluate((e) => !!e.closest("flow-base-prompt-box")).catch(() => false)) continue; // never the prompt box
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(name, { delay: 10 });
      await page.keyboard.press("Enter");
      await sleep(1200);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => {});
      const shown = await projectTitleOf(page);
      const inPage = await page.getByText(name, { exact: true }).first().isVisible().catch(() => false);
      if (shown === name || inPage) return undefined;
    } catch {
      // try the next way in
    }
  }
  return "the name field of the project page was not found; rename the project by hand in Flow";
}

async function createProject(name?: string) {
  const page = await mainFlowPage();
  await page.goto(english(`${FLOW_ORIGIN}/`), { waitUntil: "domcontentloaded" });
  await waitForHome(page);
  const button = newProjectButton(page);
  if (!(await button.isVisible().catch(() => false))) throw new Error("Flow's start page has no 'New project' button.");
  await button.click({ timeout: 8000 });
  await page.waitForURL(/\/project\/[0-9a-f-]{36}/i, { timeout: 45_000 }).catch(() => {
    throw new Error("Clicked 'New project', but Flow did not open a new project within 45 s.");
  });
  const { projectId } = await projectPage(page.url());
  setBaseline(projectId, []); // a brand-new project: everything that appears in it is new
  const renameFailed = name ? await renameProject(page, name) : undefined;
  const title = (await projectTitleOf(page)) ?? name;
  setLastProject(projectId, renameFailed ? undefined : title);
  return {
    created: true,
    project: { id: projectId, title: renameFailed ? await projectTitleOf(page) : title, url: projectUrl(projectId) },
    ...(name ? { renamed: !renameFailed } : {}),
    ...(renameFailed ? { rename_problem: renameFailed } : {}),
  };
}

// For a project known only by its title: click its card on the start page.
async function openByCard(title: string): Promise<string> {
  const page = await mainFlowPage();
  await page.goto(english(`${FLOW_ORIGIN}/`), { waitUntil: "domcontentloaded" });
  await waitForHome(page);
  const label = page.getByText(title, { exact: true });
  for (let i = 0; i < 30 && !(await label.count()); i++) {
    if (!(await scrollHome(page))) break;
    await sleep(800);
  }
  if ((await label.count()) !== 1) throw new Error(`Found ${await label.count()} cards titled "${title}" on Flow's start page; pass the project address instead.`);
  await label.scrollIntoViewIfNeeded().catch(() => {});
  // The caption may sit under the thumbnail rather than inside the clickable part, so the thumbnail above it is tried too.
  const box = await label.boundingBox();
  for (const click of [() => label.click({ timeout: 5000 }), async () => box && page.mouse.click(box.x + box.width / 2, box.y - 80)]) {
    await click().catch(() => {});
    if (await page.waitForURL(/\/project\/[0-9a-f-]{36}/i, { timeout: 15_000 }).then(() => true, () => false)) return page.url();
  }
  throw new Error(`Clicked the card "${title}", but Flow did not open the project.`);
}

export async function openProject(a: { project?: string; create_new: boolean; name?: string }) {
  if (a.create_new) return createProject(a.name?.trim() || undefined);
  if (!a.project?.trim()) throw new Error("Pass project (address, id or title), or create_new: true.");
  const target = await resolveProject(a.project);
  const url = target.id ? projectUrl(target.id) : await openByCard(target.title ?? a.project);
  const { page, projectId } = await projectPage(url);
  const title = (await projectTitleOf(page)) ?? target.title;
  setLastProject(projectId, title);
  return { opened: true, project: { id: projectId, title, url: projectUrl(projectId) } };
}
