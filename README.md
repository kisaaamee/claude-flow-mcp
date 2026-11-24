# claude-flow-mcp

An MCP server that takes the file shuffling out of working with [Google Flow](https://flow.google.com).

You generate in Flow by hand. The assistant (Claude or any MCP client) does the rest on your word:

- **upload**: puts reference photos and clips from a client folder into the Flow project, each under a clear name;
- **fetch**: when you say the batch is done, downloads everything new from the project into the right folder,
  numbered in generation order, in the best free resolution (2K images, 1080p clips; original size as the fallback),
  and renames each tile in Flow to match its file, so nothing is taken twice;
- **rename**: renames tiles in Flow on request.

There is deliberately no generation, no prompt writing, no polling and no waiting for renders.

Built for the Kinowo Studio workflow (AI visuals and short films for small businesses), where every client has its
own folder and every batch of pictures has its own sub-folder.

## A typical session

```
You:    Put the product photos from acme_bakery/00_brand/products into Flow.
Claude: cfm_upload → acme_bakery-A_sourdough.jpg, acme_bakery-B_croissant.jpg uploaded
        (everything that was already in the project now counts as old)

        … you generate seven styled images in Flow …

You:    Done, take them into 03_photos_styled.
Claude: cfm_fetch → acme_bakery-photos_styled-01.jpg … -07.jpg (2K), tiles renamed in Flow
```

## Tools

| Tool | What it does |
| --- | --- |
| `cfm_status` | Chrome, open project, baseline, how many new tiles are ready / rendering / failed |
| `cfm_list` | Tiles in the project (`only_new: true` shows what a fetch would take) |
| `cfm_mark_seen` | Count everything now in the project as old |
| `cfm_upload` | Upload `files` (`[{path, name?}]`) and/or a whole `folder`; default name `<brand>-<file name>` |
| `cfm_fetch` | Download new tiles into `folder`; options `kind`, `quality` (`best` / `original`), `prefix`, `limit`, `titles`, `rename_in_flow` |
| `cfm_rename` | Rename tiles in Flow: `[{title, to}]` (a title shared by several tiles is refused, not guessed) |
| `cfm_result` | Collect a call that answered `still_working` (desktop clients give up on a call after ~60 s) |

Every tool takes an optional `project_url` (`https://flow.google.com/project/<id>`); without it, the project open in
the server's Chrome is used.

Paths may be absolute or relative to the clients root: `acme_bakery/00_brand/products`,
`acme_bakery/03_photos_styled`. A folder's brand is its first level under the root, so files fetched into
`acme_bakery/03_photos_styled` are named `acme_bakery-photos_styled-01.jpg`, `-02` …, continuing after the highest
number already in the folder.

## How it works

The server drives a dedicated Chrome profile over the Chrome DevTools Protocol (`playwright-core`, `connectOverCDP`),
clicking through Flow's own interface at a human pace. It never enters passwords and never touches your everyday
Chrome profile. Flow is kept in English (`?hl=en`) because buttons are found by their English names.

What counts as "new" is tracked per Flow project in `~/.claude-flow-mcp/state.json`:

1. The first `cfm_upload`, `cfm_mark_seen` or `cfm_fetch` on a project takes a baseline: everything already there is old.
2. Uploads are recorded as old as well, so references never come back as results.
3. `cfm_fetch` takes every finished tile not recorded yet, oldest first, and records it. Tiles still rendering are
   left for the next call; failed tiles are listed and skipped.

Downloads are routed into the server's own folder with `Browser.setDownloadBehavior` (re-set before every download,
with `~/Downloads` watched as a fallback), the real file type is read from the first bytes, and a ZIP of several takes
is unpacked into `-01`, `-01-v2` ….

## Setup

Requirements: Node.js 20+, Google Chrome.

```
git clone https://github.com/kisaaamee/claude-flow-mcp.git
cd claude-flow-mcp
npm install
npm run build
npm run login      # opens the server's Chrome: sign in to Google and open flow.google.com once
```

Register it with your MCP client. For Claude Desktop, add to `claude_desktop_config.json`
(a Windows Store install keeps it under `%LOCALAPPDATA%\Claude-Data\…` or
`%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude`):

```json
{
  "mcpServers": {
    "claude-flow-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\claude-flow-mcp\\dist\\index.js"],
      "env": {
        "CFM_CLIENTS_ROOT": "D:\\clients"
      }
    }
  }
}
```

Quit the client completely (tray icon → Quit) and start it again.

Only one program may drive that Chrome at a time: do not run another Flow automation on the same debugging port.

## Settings

| Variable | Default |
| --- | --- |
| `CFM_CLIENTS_ROOT` | `D:\hustle` on Windows, `~/hustle` elsewhere |
| `CFM_CHROME_PROFILE` | `~/.claude-flow-mcp/chrome-profile` (point it at an existing signed-in profile to skip the login) |
| `CFM_CDP_PORT` | `9333` |
| `CFM_CHROME` | Chrome from the usual install folders |
| `CFM_HOME` | `~/.claude-flow-mcp` (state, downloads, staging copies) |
| `CFM_PATIENCE_MS` | `45000` |

`~` at the start of a path means your home folder.

## Known limits

- A video tile at rest carries no id, so clips are tracked by title. Flow sometimes reuses titles; that is one reason
  every fetched tile is renamed. A new clip whose title matches one from before the baseline would be missed: take it
  with `titles`.
- The free upscale can be slow or never arrive; after 2 min (images) / 4 min (clips) the original size is taken.
- Flow's interface changes from time to time. When a step stops working, the error says which menu item was missing
  and what the menu offered instead.

## License

MIT © 2026 Mikita Valadzko
