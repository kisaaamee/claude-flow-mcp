#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PATIENCE_MS } from "./config.js";
import { exclusive, fetchNew, list, markSeen, rename, status, upload } from "./ops.js";

const server = new McpServer({ name: "claude-flow-mcp", version: "0.1.0" });

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
