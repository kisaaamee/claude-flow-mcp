#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PATIENCE_MS } from "./config.js";
import { agent, exclusive, fetchNew, generate, inspect, list, markSeen, rename, status, upload } from "./ops.js";
import { openProject, projects } from "./projects.js";

const server = new McpServer(
  { name: "claude-flow-mcp", version: "0.2.0" },
  {
    instructions:
      "Every Flow tool works in one Google Flow project. If none is open, a tool fails with NO_PROJECT_OPEN. Then never choose a " +
      "project yourself: call cfm_projects and ask the user in the chat which project to work in. If your client has a tool for " +
      "multiple-choice questions (e.g. AskUserQuestion), use it: the last used and most recent projects as options plus " +
      "'Create a new project'; otherwise show a short numbered list (mark the open and the last used one) and ask. For a new " +
      "project, also ask its name. Wait for the answer; open it with " +
      "cfm_open_project (project: address, id or title; or create_new: true with name) and then repeat the call that failed. " +
      "When the user asks to switch to another project or start a new one, use the same two tools.",
  },
);

// ---- calls that outlive the client's patience keep running and are collected with cfm_result ----
type Task = { promise: Promise<unknown>; done: boolean; value?: unknown; error?: string; started: number };
const tasks = new Map<string, Task>();

function reply(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function patient(fn: () => Promise<unknown>) {
  const id = randomBytes(4).toString("hex");
  const task: Task = { promise: exclusive(fn), done: false, started: Date.now() };
  task.promise.then(
    (v) => Object.assign(task, { done: true, value: v }),
    (e) => Object.assign(task, { done: true, error: e instanceof Error ? e.message : String(e) }),
  );
  tasks.set(id, task);
  const timer = new Promise<"later">((r) => setTimeout(() => r("later"), PATIENCE_MS));
  const first = await Promise.race([task.promise.then(() => "now" as const, () => "now" as const), timer]);
  if (first === "later") return reply({ still_working: true, task_id: id, note: "Still going. Call cfm_result with this task_id to collect it." });
  tasks.delete(id);
  return task.error ? reply(task.error, true) : reply(task.value);
}

const projectUrl = z
  .string()
  .optional()
  .describe("Flow project address (https://flow.google.com/project/<id>). Default: the project open in the server's Chrome.");

server.registerTool(
  "cfm_projects",
  {
    description:
      "List the Google Flow projects on the signed-in account (title, address, any date Flow shows), plus the project open now and the " +
      "last one used. Read in a separate tab; nothing is opened or changed. Call it when a tool failed with NO_PROJECT_OPEN or the user " +
      "wants another project, then show the list in the chat and let the user choose one or ask for a new one.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50),
      debug: z.boolean().default(false).describe("Also return a sketch of the start page's HTML (for fixing the reader)."),
    },
  },
  (a) => patient(() => projects(a)),
);

server.registerTool(
  "cfm_open_project",
  {
    description:
      "Open the Flow project the user chose in the server's Chrome, so the other tools work in it. project: its address, id or title " +
      "(exact, or a unique beginning/part; several matches are refused, not guessed). Or create_new: true to make a new project, " +
      "named `name` if given (renaming is best effort; the reply says if it has to be done by hand). Only on the user's choice.",
    inputSchema: {
      project: z.string().optional().describe("Address (https://flow.google.com/project/<id>), id, or title."),
      create_new: z.boolean().default(false),
      name: z.string().min(1).max(100).optional().describe("Name for the new project."),
    },
  },
  (a) => patient(() => openProject(a)),
);

server.registerTool(
  "cfm_status",
  {
    description: "Check the server's Chrome and the open Flow project: whether a baseline exists and how many new tiles are ready, rendering or failed.",
    inputSchema: { project_url: projectUrl },
  },
  (a) => patient(() => status(a)),
);

server.registerTool(
  "cfm_list",
  {
    description: "List the tiles in the Flow project (title, image/video, rendering, failed, new). Use only_new to see what cfm_fetch would take.",
    inputSchema: { project_url: projectUrl, only_new: z.boolean().default(false) },
  },
  (a) => patient(() => list(a)),
);

server.registerTool(
  "cfm_mark_seen",
  {
    description: "Treat everything now in the Flow project as already seen, so the next cfm_fetch takes only what appears after this. cfm_upload does this by itself on a project it has not seen before.",
    inputSchema: { project_url: projectUrl },
  },
  (a) => patient(() => markSeen(a)),
);

server.registerTool(
  "cfm_upload",
  {
    description:
      "Upload local images or clips into the Flow project, each under a clear name (Flow titles an upload after its file name). " +
      "Paths can be absolute or relative to the clients root (e.g. 'acme_bakery/00_brand/products/A_sourdough.jpg'). " +
      "Without a name, a file gets '<brand>-<file name>'. Uploads are never fetched back as new work.",
    inputSchema: {
      project_url: projectUrl,
      files: z
        .array(z.object({ path: z.string().min(1), name: z.string().min(1).max(80).optional().describe("Name in Flow, without extension.") }))
        .max(40)
        .default([]),
      folder: z.string().optional().describe("Upload every image/video in this folder too (sorted by name)."),
      skip_existing: z.boolean().default(true).describe("Skip a file whose name is already a tile in the project."),
    },
  },
  (a) => patient(() => upload(a)),
);

server.registerTool(
  "cfm_fetch",
  {
    description:
      "Download the finished images and clips that appeared in the Flow project since the last upload or fetch into a local folder, " +
      "numbered <prefix>-01, -02 ... in generation order, never overwriting files already there. Quality 'best' takes Flow's free upscale " +
      "(2K image, 1080p video) and falls back to the original size. Each fetched tile is renamed in Flow to its file name, so it is never taken twice. " +
      "Tiles still rendering are left for the next call. No generation, no waiting for renders: call it when the user says the batch is done.",
    inputSchema: {
      project_url: projectUrl,
      folder: z.string().min(1).describe("Target folder, absolute or relative to the clients root, e.g. 'acme_bakery/03_photos_styled'."),
      kind: z.enum(["image", "video", "all"]).default("all"),
      quality: z.enum(["best", "original"]).default("best"),
      prefix: z.string().max(60).optional().describe("File name stem. Default: <brand>-<section>, e.g. acme_bakery-photos_styled."),
      limit: z.number().int().min(1).max(100).optional().describe("Take at most this many (the oldest new ones first)."),
      titles: z.array(z.string().min(1)).max(100).optional().describe("Take exactly these tiles by title instead of 'everything new'."),
      rename_in_flow: z.boolean().default(true),
    },
  },
  (a) => patient(() => fetchNew(a)),
);

server.registerTool(
  "cfm_rename",
  {
    description:
      "Rename tiles in the Flow project. Each entry names a tile by its current title (exact, or a unique beginning of it) and the new title. " +
      "A title shared by several tiles is refused rather than guessed.",
    inputSchema: {
      project_url: projectUrl,
      renames: z.array(z.object({ title: z.string().min(1), to: z.string().min(1).max(100) })).min(1).max(50),
    },
  },
  (a) => patient(() => rename(a)),
);

const reference = z.string().min(1);

server.registerTool(
  "cfm_generate",
  {
    description:
      "Start ONE generation in Flow's prompt box (Agent switched off): sets image/video, aspect, outputs, model, and for video the mode, " +
      "resolution and length; attaches references (local paths are uploaded first; 'asset:<title>' uses a tile already in the project) or " +
      "first/last frames; types the prompt; presses Start generation. Does NOT wait for the render. Flow's credit quote is read first: " +
      "anything priced above 0 starts only if max_credits >= the quote, so ask the user before passing max_credits for a paid video.",
    inputSchema: {
      project_url: projectUrl,
      prompt: z.string().min(1).max(8000),
      type: z.enum(["image", "video"]),
      aspect: z.enum(["16:9", "9:16", "4:3", "1:1", "3:4"]).optional().describe("Default: whatever Flow has selected. Video: 16:9 or 9:16."),
      count: z.number().int().min(1).max(4).default(1).describe("Outputs (x1-x4); multiplies the cost."),
      model: z.string().optional().describe("Part of the model name as Flow shows it (e.g. 'Omni', 'Veo 3.1 Fast'). Images default to the newest Nano Banana."),
      references: z.array(reference).max(10).default([]).describe("Ingredients: local paths (uploaded under '<brand>-<file>') or 'asset:<title>'."),
      first_frame: reference.optional().describe("Video only: first frame (path or asset:<title>). Not combinable with references."),
      last_frame: reference.optional().describe("Video only: last frame."),
      video_mode: z.enum(["ingredients", "frames"]).optional(),
      resolution: z.string().optional().describe("Video only, e.g. '360p', '720p'."),
      duration: z.number().int().min(1).max(30).optional().describe("Video only, seconds (radios or the Length slider)."),
      max_credits: z.number().int().min(0).max(1000).optional().describe("Spend ceiling for this one start. Required for anything Flow prices above 0."),
      keep_lines: z.boolean().default(true).describe("Keep line breaks (Shift+Enter); false sends one line."),
    },
  },
  (a) => patient(() => generate(a)),
);

server.registerTool(
  "cfm_agent",
  {
    description:
      "Send a multi-image prompt to Flow Agent: switches Agent on, sets its confirmation (default Never, so it does not stop to ask) and image " +
      "defaults, attaches references in order (Reference A, B, ...), types the prompt and starts it. Does NOT wait. By default a short first " +
      "line tells the agent: images only, no questions, and which attachment is which reference. Flow Agent shows no price up front, so " +
      "allow_video needs acknowledge_cost: true after the user agreed.",
    inputSchema: {
      project_url: projectUrl,
      prompt: z.string().min(1).max(20000),
      references: z.array(reference).max(10).default([]),
      aspect: z.enum(["16:9", "9:16", "4:3", "1:1", "3:4"]).optional().describe("Agent's image default."),
      count: z.number().int().min(1).max(4).default(1).describe("Agent's outputs per image."),
      confirm: z.enum(["never", "always"]).default("never"),
      allow_video: z.boolean().default(false),
      acknowledge_cost: z.boolean().default(false),
      guard_line: z.boolean().default(true),
      keep_lines: z.boolean().default(true),
    },
  },
  (a) => patient(() => agent(a)),
);

server.registerTool(
  "cfm_inspect",
  {
    description:
      "Development aid: returns the accessibility tree of Flow's prompt box and open menus/panels, optionally after opening one of them or " +
      "clicking one control. Never clicks Start generation, delete or account controls. Not needed for normal work.",
    inputSchema: {
      project_url: projectUrl,
      open: z.enum(["settings", "ingredients", "agent_settings", "model_menu"]).optional(),
      click: z.object({ role: z.string().min(1), name: z.string().min(1) }).optional(),
      selector: z.string().optional().describe("CSS selector to snapshot instead of the defaults."),
      escape_after: z.boolean().default(true),
      max_chars: z.number().int().min(500).max(30000).default(8000),
    },
  },
  (a) => patient(() => inspect(a)),
);

server.registerTool(
  "cfm_result",
  {
    description: "Collect the result of a call that answered still_working.",
    inputSchema: { task_id: z.string().min(1), wait_seconds: z.number().int().min(0).max(40).default(35) },
  },
  async ({ task_id, wait_seconds }) => {
    const task = tasks.get(task_id);
    if (!task) return reply(`No task "${task_id}" (already collected, or the server restarted).`, true);
    if (!task.done) await Promise.race([task.promise.catch(() => {}), new Promise((r) => setTimeout(r, wait_seconds * 1000))]);
    if (!task.done) return reply({ still_working: true, task_id, running_for_s: Math.round((Date.now() - task.started) / 1000) });
    tasks.delete(task_id);
    return task.error ? reply(task.error, true) : reply(task.value);
  },
);

await server.connect(new StdioServerTransport());
console.error("claude-flow-mcp ready");
