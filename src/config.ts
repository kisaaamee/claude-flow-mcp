import { homedir } from "node:os";
import { join } from "node:path";

// Everything the server keeps for itself lives here: its Chrome profile, the download landing folder, the copies
// made for uploading under a new name, and the record of which Flow tiles have already been seen.
// "~" in a path from the environment means the user's home folder (MCP client configs do not expand variables).
const expand = (p: string | undefined) => (p ? p.replace(/^~(?=$|[\\/])/, homedir()) : undefined);

export const HOME = expand(process.env.CFM_HOME) ?? join(homedir(), ".claude-flow-mcp");

// Chrome profile the server drives. Point CFM_CHROME_PROFILE at an existing, already signed-in profile to skip the
// one-time Google sign-in.
export const PROFILE_DIR = expand(process.env.CFM_CHROME_PROFILE) ?? join(HOME, "chrome-profile");

// Remote-debugging port of that Chrome.
export const CDP_PORT = Number(process.env.CFM_CDP_PORT ?? 9333);

// Root of the client folders (one folder per brand, e.g. D:\hustle\acme_bakery). Relative paths in tool calls are
// resolved against it.
export const CLIENTS_ROOT = expand(process.env.CFM_CLIENTS_ROOT) ?? (process.platform === "win32" ? "D:\\hustle" : join(homedir(), "hustle"));

export const DOWNLOAD_DIR = join(HOME, "downloads");
export const STAGING_DIR = join(HOME, "staging");
export const STATE_FILE = join(HOME, "state.json");

export const FLOW_ORIGIN = "https://flow.google.com";

// A desktop MCP client gives up on a call after about a minute, so a longer job hands back a task id instead.
export const PATIENCE_MS = Number(process.env.CFM_PATIENCE_MS ?? 45_000);
