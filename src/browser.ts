import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { CDP_PORT, FLOW_ORIGIN, PROFILE_DIR } from "./config.js";

const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function findChrome(): string {
  const candidates = [
    process.env.CFM_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ];
  const found = candidates.find((p): p is string => Boolean(p) && existsSync(p as string));
  if (!found) throw new Error("Chrome was not found. Set CFM_CHROME to the full path of chrome.exe.");
  return found;
}

async function debuggerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Flow's buttons are found by their English names, and ?hl=en keeps the page in English whatever the account says.
export function english(url: string): string {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
}

export function projectIdOf(url: string): string | undefined {
  return url.match(/\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
}

export async function launchChrome(url = `${FLOW_ORIGIN}/`): Promise<void> {
  if (await debuggerUp()) return;
  mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(
    findChrome(),
    [`--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check", english(url)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await debuggerUp()) return;
    await sleep(500);
  }
  throw new Error(`Chrome started, but its debugging port ${CDP_PORT} did not open. Close every Chrome window using this profile and try again.`);
}

let browser: Browser | null = null;

async function connect(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  await launchChrome();
  browser = await chromium.connectOverCDP(CDP_URL);
  browser.on("disconnected", () => {
    browser = null;
  });
  return browser;
}

export async function chromeConnected(): Promise<boolean> {
  return debuggerUp();
}

// Returns the Flow tab showing the project's grid (All media). With no project_url, the project already open in the
// server's Chrome is used.
export async function projectPage(projectUrl?: string): Promise<{ page: Page; projectId: string }> {
  const b = await connect();
  const context = b.contexts()[0];
  if (!context) throw new Error("The server's Chrome has no window. Close it and call the tool again.");
  const flowTabs = context.pages().filter((p) => p.url().startsWith(FLOW_ORIGIN));
  const wantedId = projectUrl ? projectIdOf(projectUrl) : undefined;
  if (projectUrl && !wantedId) throw new Error(`"${projectUrl}" is not a Flow project address (flow.google.com/project/<id>).`);

  let page = wantedId ? flowTabs.find((p) => projectIdOf(p.url()) === wantedId) : flowTabs.find((p) => projectIdOf(p.url()));
  page ??= flowTabs[0] ?? (await context.newPage());
  const projectId = wantedId ?? projectIdOf(page.url());
  if (!projectId) {
    if (page.url() === "about:blank") await page.goto(english(`${FLOW_ORIGIN}/`), { waitUntil: "domcontentloaded" });
    throw new Error("No Flow project is open. Open the project in the server's Chrome window, or pass project_url.");
  }

  const grid = english(`${FLOW_ORIGIN}/project/${projectId}`);
  const here = new URL(page.url());
  const lang = await page.evaluate(() => document.documentElement.lang).catch(() => "");
  if (here.pathname !== `/project/${projectId}` || (lang && !/^en\b/i.test(lang))) {
    await page.goto(grid, { waitUntil: "domcontentloaded" });
  }
  if (/\/about|accounts\.google\.com/.test(page.url())) {
    throw new Error("Chrome is not signed in to Google Flow. Run `npm run login` in the server folder and sign in by hand.");
  }
  await page.getByRole("button", { name: "Add media menu" }).waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error("The Flow project page did not finish loading (no 'Add media menu' button after 30 s).");
  });
  await page.bringToFront().catch(() => {});
  return { page, projectId };
}
