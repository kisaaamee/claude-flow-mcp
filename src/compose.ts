import type { Locator, Page } from "playwright-core";
import { sleep } from "./browser.js";

// Everything that drives Flow's prompt box: settings, references, Agent mode, submitting.
// Nothing here waits for a render: a call ends as soon as Flow has accepted the job.

// ---------- small helpers ----------

export async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => {});
}

// An open Material menu leaves an invisible backdrop that swallows every click; clicking it closes the menu.
export async function clearBackdrops(page: Page): Promise<void> {
  const showing = page.locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing");
  for (let i = 0; i < 4 && (await showing.count().catch(() => 0)); i++) {
    await showing.last().click({ force: true, timeout: 3000 }).catch(() => {});
    await sleep(400);
  }
}

// Escape with the focus inside the left menu closes that menu, so the focus is moved out first.
async function escape(page: Page): Promise<void> {
  await blurFocus(page);
  await page.keyboard.press("Escape");
  await sleep(350);
}

const promptBox = (page: Page) => page.locator("flow-base-prompt-box");
const agentToggle = (page: Page) => page.getByRole("button", { name: /^(Flow )?Agent$/ });
const startButton = (page: Page) => page.getByRole("button", { name: "Start generation" });
const settingsPopover = (page: Page) => page.locator(".cdk-overlay-pane:has(.credit-cost-label)");

// ---------- Agent mode ----------

async function closeAgentPanels(page: Page): Promise<void> {
  const back = page.locator("flow-agent-panel").getByRole("button", { name: "Back", exact: true });
  for (let i = 0; i < 3 && (await back.isVisible().catch(() => false)); i++) {
    await clearBackdrops(page);
    await back.click({ timeout: 4000 }).catch(() => {});
    await sleep(700);
  }
  // The agent's session panel covers the plain prompt box.
  if (await page.getByRole("button", { name: "Start new session" }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Close", exact: true }).click({ timeout: 4000 }).catch(() => {});
    await sleep(800);
  }
}

export async function agentIsOn(page: Page): Promise<boolean> {
  return (await agentToggle(page).getAttribute("aria-pressed").catch(() => null)) === "true";
}

// Flips Agent mode and checks that it really flipped: a click that lands under a panel changes nothing.
export async function setAgent(page: Page, on: boolean): Promise<void> {
  let why = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    await clearBackdrops(page);
    await closeAgentPanels(page);
    if ((await agentIsOn(page)) === on) return;
    await agentToggle(page)
      .click({ timeout: 6000 })
      .catch((err: Error) => {
        why = err.message.split("\n").find((l) => /intercepts|not visible|not enabled|detached/.test(l))?.trim() ?? err.message.split("\n")[0];
      });
    await sleep(1200);
  }
  if ((await agentIsOn(page)) !== on) throw new Error(`Could not switch Flow Agent ${on ? "on" : "off"}${why ? ` (${why.slice(0, 160)})` : ""}.`);
}

// The agent's own settings: whether it asks before generating, and its image defaults.
export async function setAgentSettings(page: Page, s: { confirm: "Never" | "Always"; aspect?: string; count?: number }): Promise<string[]> {
  const notes: string[] = [];
  await clearBackdrops(page);
  const button = promptBox(page).getByRole("button", { name: /^(Agent s|S)ettings$/ });
  if (!(await button.isVisible().catch(() => false))) {
    notes.push("agent settings button not found; Flow's own agent settings were used");
    return notes;
  }
  await button.click({ timeout: 5000 });
  try {
    const panel = page.locator("flow-agent-panel");
    await page.getByRole("heading", { name: "Agent settings" }).waitFor({ state: "visible", timeout: 8000 });
    const confirm = panel.getByRole("radio", { name: new RegExp(`^${s.confirm}`) }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click({ timeout: 4000 });
    else notes.push(`no "${s.confirm}" confirmation option in the agent settings`);
    if (s.aspect || s.count) {
      const defaults = panel.getByRole("button", { name: /^Image defaults/ });
      if (await defaults.isVisible().catch(() => false)) {
        await defaults.click();
        await page.getByRole("heading", { name: "Image defaults" }).waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
      }
      if (s.aspect) {
        const r = panel.getByRole("radio", { name: s.aspect, exact: true }).first();
        if (await r.isVisible().catch(() => false)) await r.click();
        else notes.push(`agent image defaults have no ${s.aspect}`);
      }
      const x = panel.getByRole("radio", { name: `x${s.count ?? 1}`, exact: true }).first();
      if (await x.isVisible().catch(() => false)) await x.click();
      await pickAgentImageModel(page);
    }
    const save = page.getByRole("button", { name: "Save", exact: true });
    if (await save.isVisible().catch(() => false)) await save.click();
    await sleep(800);
  } finally {
    await closeAgentPanels(page);
  }
  return notes;
}

// ---------- models ----------

// The newest Nano Banana: the highest version number that is not a Lite model.
export function newestNanoBanana(names: string[]): number {
  const version = (n: string) => /nano banana\s+(\d+(?:\.\d+)*)/i.exec(n)?.[1]?.split(".").map(Number);
  const newer = (a: number[], b: number[]) => {
    for (let k = 0; k < Math.max(a.length, b.length); k++) if ((a[k] ?? 0) !== (b[k] ?? 0)) return (a[k] ?? 0) > (b[k] ?? 0);
    return false;
  };
  let best = -1;
  names.forEach((n, i) => {
    const v = version(n);
    if (!v || /\blite\b/i.test(n)) return;
    if (best < 0 || newer(v, version(names[best])!)) best = i;
  });
  return best;
}

async function pickAgentImageModel(page: Page): Promise<void> {
  const radios = page.locator("flow-agent-panel").getByRole("radiogroup", { name: "Model" }).getByRole("radio");
  if (!(await radios.first().isVisible().catch(() => false))) return;
  const names = await radios.evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").replace(/\s+/g, " ").trim()));
  const i = newestNanoBanana(names);
  if (i >= 0 && !(await radios.nth(i).isChecked().catch(() => true))) await radios.nth(i).click({ timeout: 4000 }).catch(() => {});
}

// ---------- settings popover ----------

async function openSettings(page: Page): Promise<void> {
  const probe = page.getByRole("radio", { name: "Image", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await probe.isVisible().catch(() => false)) return;
    await clearBackdrops(page);
    await page.getByRole("button", { name: "Settings trigger" }).click({ timeout: 5000 });
    await probe.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }
  if (!(await probe.isVisible().catch(() => false))) throw new Error("Flow's generation settings did not open (tried 3 times).");
}

async function closeSettings(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await settingsPopover(page).count()); i++) await escape(page);
  if (await settingsPopover(page).count()) await page.getByRole("button", { name: "Settings trigger" }).click({ timeout: 4000 }).catch(() => {});
  await clearBackdrops(page);
}

async function pickRadio(page: Page, name: string | RegExp, what: string): Promise<void> {
  const radio = page.getByRole("radio", { name, exact: typeof name === "string" }).first();
  // Closing a menu with Escape can close the whole popover too: reopen and look again.
  if (!(await radio.isVisible().catch(() => false))) await openSettings(page).catch(() => {});
  if (!(await radio.isVisible().catch(() => false))) {
    const offered = await page.getByRole("radio").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? e.textContent ?? "").trim()).filter(Boolean));
    throw new Error(`Flow offers no ${what} "${name}" for this mode/model (it offers: ${offered.join(", ") || "nothing"}).`);
  }
  if (!(await radio.isChecked().catch(() => false))) {
    await radio.click({ timeout: 4000 });
    await sleep(400);
  }
}

async function pickModel(page: Page, model: string | undefined, type: "image" | "video"): Promise<string> {
  const button = page.getByRole("button", { name: "Select model family" });
  if (!(await button.isVisible().catch(() => false))) return "(model menu not shown)";
  const current = clean(await button.innerText().catch(() => ""));
  const wantNewestBanana = type === "image" && (!model || /^nano banana( 2)?$|^latest$/i.test(model.trim()));
  if (!wantNewestBanana && (!model || current.toLowerCase().includes(model.toLowerCase()))) return current;
  await button.click({ timeout: 5000 });
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map(clean);
  const index = wantNewestBanana ? newestNanoBanana(names) : names.findIndex((n) => n.toLowerCase().includes(model!.toLowerCase()));
  if (index < 0 || current.includes(names[index])) {
    await escape(page);
    await clearBackdrops(page);
    if (index < 0 && !wantNewestBanana) throw new Error(`Model "${model}" is not in Flow's list here: ${names.join(", ")}.`);
    return current;
  }
  await items.nth(index).click();
  await sleep(600);
  return names[index];
}

// Older models have 4s/6s/8s/10s radios; newer ones a "Length" slider whose label reads "Length <N> Sec".
async function pickDuration(page: Page, seconds: number): Promise<void> {
  const slider = page.getByRole("slider", { name: /Length/i }).first();
  if (!(await slider.isVisible().catch(() => false))) return pickRadio(page, `${seconds}s`, "length");
  const pane = settingsPopover(page).last();
  const shown = async () => Number(/Length\s*(\d+)\s*Sec/i.exec(await pane.innerText().catch(() => ""))?.[1] ?? NaN);
  await slider.focus();
  await page.keyboard.press("Home");
  await sleep(250);
  const min = await shown();
  const steps = Number(await slider.getAttribute("max")) - Number(await slider.getAttribute("min"));
  if (Number.isNaN(min) || Number.isNaN(steps)) throw new Error("Could not read Flow's length slider.");
  if (seconds < min || seconds > min + steps) throw new Error(`This model's clips run ${min}–${min + steps} s; ${seconds} s is outside that.`);
  for (let i = 0; i < seconds - min; i++) await page.keyboard.press("ArrowRight");
  await sleep(400);
  const now = await shown();
  if (now !== seconds) throw new Error(`Flow's length slider shows ${now} s instead of ${seconds} s.`);
}

async function readQuote(page: Page): Promise<number | undefined> {
  const label = settingsPopover(page).locator(".credit-cost-label").first();
  let text = await label.innerText().catch(() => "");
  if (!/\d/.test(text)) text = await page.getByRole("link", { name: /^\d[\d,]*\s+credits?$/ }).first().innerText().catch(() => "");
  const n = Number(text.replace(/,/g, "").match(/\d+/)?.[0] ?? NaN);
  return Number.isNaN(n) ? undefined : n;
}

export type Settings = {
  type: "image" | "video";
  aspect?: string;
  count: number;
  model?: string;
  video_mode?: "ingredients" | "frames";
  resolution?: string;
  duration?: number;
};

// Applies the settings and returns what Flow quotes for them.
export async function applySettings(page: Page, s: Settings): Promise<{ quote?: number; model: string }> {
  await openSettings(page);
  await pickRadio(page, s.type === "image" ? "Image" : "Video", "type");
  if (s.type === "video") await pickRadio(page, s.video_mode === "frames" ? "Frames" : "Ingredients", "video mode");
  if (s.aspect) await pickRadio(page, s.aspect, "aspect ratio");
  const model = await pickModel(page, s.model, s.type);
  if (s.type === "video" && s.resolution) await pickRadio(page, new RegExp(`^${s.resolution}`), "resolution");
  if (s.type === "video" && s.duration) await pickDuration(page, s.duration);
  await pickRadio(page, `x${s.count}`, "number of outputs");
  await sleep(500);
  const quote = await readQuote(page);
  await closeSettings(page);
  return { quote, model };
}

// ---------- references ----------

// Button texts carry Material icon names ("arrow_drop_down"); drop them.
const clean = (t: string) => t.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, "").replace(/\s+/g, " ").trim();

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Opens a media picker (the + button, or Start / End) and attaches the asset with this name.
export async function attach(page: Page, opener: Locator, name: string): Promise<void> {
  const list = page.getByRole("listbox", { name: "Asset list" });
  const allTab = page.getByRole("tab", { name: "All", exact: true });
  const visible = (l: Locator, ms: number) => l.waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    if (attempt) await escape(page);
    await clearBackdrops(page);
    await opener.click({ timeout: 5000 });
    opened = await Promise.race([visible(list, 5000), visible(allTab, 5000)]);
  }
  if (!opened) throw new Error(`Flow's media picker did not open while attaching "${name}".`);
  if ((await allTab.isVisible().catch(() => false)) && (await allTab.getAttribute("aria-selected")) !== "true") {
    await allTab.click();
    await sleep(800);
  }
  await list.waitFor({ state: "visible", timeout: 8000 });
  const optionFor = () => list.getByRole("option", { name: new RegExp(`^${escapeRe(name)}`, "i") }).first();
  let option = optionFor();
  if (!(await option.isVisible().catch(() => false))) {
    const search = page.getByRole("textbox", { name: "Search assets" }).first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill(name).catch(() => {});
      await sleep(1200);
      option = optionFor();
    }
  }
  for (let i = 0; i < 20 && !(await option.isVisible().catch(() => false)); i++) {
    await list.hover().catch(() => {});
    await page.mouse.wheel(0, 600);
    await sleep(350);
  }
  if (!(await option.isVisible().catch(() => false))) {
    for (const tab of ["Characters", "Avatars", "Uploads", "Images"]) {
      const t = page.getByRole("tab", { name: tab, exact: true });
      if (!(await t.isVisible().catch(() => false))) continue;
      await t.click();
      await sleep(900);
      option = optionFor();
      if (await option.isVisible().catch(() => false)) break;
    }
  }
  if (!(await option.isVisible().catch(() => false))) {
    await escape(page);
    throw new Error(`"${name}" is not in Flow's media picker.`);
  }
  await option.click();
  // The ingredients picker only previews on click; "Add to prompt" attaches. Frame pickers attach on click.
  const add = page.getByRole("button", { name: "Add to prompt", exact: true });
  if (await visible(add, 1500)) await add.click().catch(() => {});
  await list.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
  await sleep(400);
}

export const plusButton = (page: Page) => page.getByRole("button", { name: "Add ingredients to the prompt box" });
export const frameButton = (page: Page, which: "Start" | "End") => page.getByRole("button", { name: which, exact: true });

export async function attachedCount(page: Page): Promise<number> {
  return promptBox(page).getByRole("button", { name: "Ingredient" }).count().catch(() => 0);
}

// ---------- prompt and start ----------

export async function clearPrompt(page: Page): Promise<void> {
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) {
    await clear.click().catch(() => {});
    await sleep(400);
  }
}

// Enter submits in Flow, so text goes in with insertText (no key presses). Line breaks are tried as Shift+Enter and
// flattened to spaces when keep_lines is false.
export async function writePrompt(page: Page, prompt: string, keepLines: boolean): Promise<void> {
  const box = page.locator(".ProseMirror").first();
  await box.click({ timeout: 5000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  const text = prompt.replace(/\r\n?/g, "\n").trim();
  if (!keepLines) {
    await page.keyboard.insertText(text.replace(/\s*\n+\s*/g, " "));
  } else {
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      if (i) await page.keyboard.press("Shift+Enter");
      if (line) await page.keyboard.insertText(line);
    }
  }
  await sleep(500);
}

// Presses Start generation and confirms that Flow took the job (the prompt box empties or a Stop button / progress shows).
export async function start(page: Page): Promise<void> {
  const button = startButton(page);
  if (!(await button.isEnabled().catch(() => false))) throw new Error("Flow's Start generation button is disabled: the prompt or inputs were not accepted. Nothing was started.");
  await button.click({ timeout: 5000 });
  await sleep(2500);
}

export async function promptText(page: Page): Promise<string> {
  return (await page.locator(".ProseMirror").first().innerText().catch(() => "")).trim();
}
