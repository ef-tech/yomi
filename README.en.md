# yomi (読み)

[日本語](README.md) | **English**

[![CI](https://github.com/ef-tech/yomi/actions/workflows/ci.yml/badge.svg)](https://github.com/ef-tech/yomi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local Markdown viewer. A command-line tool that recursively collects the `.md` files under the current directory and lets you read them in a two-pane browser UI (left: tree, right: preview).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dark-preview.png">
  <img alt="yomi preview screen" src="docs/screenshots/light-preview.png">
</picture>

## Features

- Launches with `cd <your docs> && yomi`
- Inline rendering of Mermaid diagrams
- Auto-reload on file save (live preview)
- GitHub-style CSS, follows the system dark/light setting
- Viewable from other devices on the same LAN (`--host 127.0.0.1` for local only)
- In-browser Markdown editing (save with Ctrl/Cmd+S)
- Table of contents (TOC) panel generated from headings (with scroll-following highlight)
- Link navigation inside the preview: relative md jumps within yomi, external URLs get a warning
- Browser back/forward support; reload restore and URL sharing via `?path=foo.md`
- Click GFM task lists `- [ ] xxx` in the preview to toggle ON/OFF; changes are written back to the md file
- Images in Markdown `![](foo.png)` are resolved by relative path and displayed (same dir, `../`, and subdirectories)
- UI language switch (Japanese / English, auto-follows the browser language, saved to `localStorage`)

## Screenshots

| Split view (Markdown + preview) | Inline Mermaid rendering (dark) |
|---|---|
| ![split view](docs/screenshots/light-split.png) | ![mermaid in dark](docs/screenshots/dark-mermaid.png) |

## Requirements

- [Bun](https://bun.sh) v1.0+

## Installation

```bash
bun install -g github:ef-tech/yomi
```

## Updating

To pull the latest `main`, run the same command again.
Reinstalling under the same package name makes Bun fetch and overwrite with the latest remote source.

```bash
bun install -g github:ef-tech/yomi
```

To use a specific tag, branch, or commit:

```bash
bun install -g github:ef-tech/yomi#v0.2.0    # tag
bun install -g github:ef-tech/yomi#main      # branch
bun install -g github:ef-tech/yomi#abc1234   # commit SHA
```

## Uninstall

```bash
bun remove -g yomi
```

To check the installed version:

```bash
bun pm ls -g | grep yomi
```

## Usage

```bash
cd /path/to/docs
yomi
```

The browser opens automatically.

### Options

```
yomi [options]
  --port <n>      Specify the port (default: auto-discovery from 3939)
  --no-open       Do not open the browser automatically
  --host <addr>   Bind address (default: 0.0.0.0, viewable from the same LAN)
                  For local only, use --host 127.0.0.1
  --depth <n>, -L <n>
                  Limit the scan depth (equivalent to tree -L; default: unlimited)
                  1 = root level only. Deeper md files are neither loaded nor watched
  --help, -h      Help
```

For large directory trees, `--depth` (short form `-L`) narrows the levels scanned/watched at startup. Just like `tree -L <level>`, the root level counts as depth 1. Markdown beyond the depth is not loaded and is also excluded from file watching (live reload), so startup is faster and the number of inotify watches is lower. To view deeper levels, restart with a higher depth.

### File tree

The toolbar at the top of the left tree lets you expand/collapse the whole tree at once.

- **⊞ Expand all**: expand every directory
- **⊟ Collapse all**: return to the initial state (root level only)

Directory open/closed state is saved to `localStorage` and preserved across reloads.

### UI language switch (Japanese / English)

The language toggle in the top bar (**Auto / EN / 日本語**, inside the ⋮ menu on mobile) switches the UI language.

- **Auto**: English if the browser language (`navigator.language`) is `en*`, otherwise Japanese
- **EN / 日本語**: pin explicitly
- The choice is saved to `localStorage` (`yomi:lang:v1`) and preserved across reloads
- `<html lang>` follows the selected language
- Markdown content, file names, and paths are not translated (only UI labels, status messages, and API error messages)

### Table of contents (TOC)

The "📖 TOC" button at the top-right (or `Ctrl/Cmd+Shift+O`) opens/closes a table-of-contents panel on the right, generated from the Markdown headings.

- **Scroll-following highlight**: the current section is highlighted automatically as you scroll
- **Click to jump**: clicking an entry smooth-scrolls to that heading
- **Level switch**: "▾ Show H4-" at the bottom of the panel toggles `H1-H3` only ↔ all of `H1-H6`
- **Mode coordination**:
  - Pressing the button in `MD` mode temporarily switches to `Preview` (reverts when the TOC is closed; `localStorage` is not changed)
  - During edit mode the TOC is temporarily hidden and restored when editing ends
- Persistence: open/closed state and level are saved to `localStorage`

For documents with 0 headings it shows "No headings".

### Link navigation

Behavior when clicking `<a href>` links inside the preview:

| Type | Example | Behavior |
|---|---|---|
| Relative md path | `[X](other.md)` `[Y](../bar.md)` | Navigate to that file within yomi (same as selecting it in the left tree) |
| Extensionless relative | `[X](foo)` | Search in the order `foo.md` → `.markdown` → `.mdx` and navigate |
| Relative PDF path | `[X](return_voucher.pdf)` | Open `/api/asset?path=...` in a new tab and show it in the browser's built-in PDF viewer (Issue #37) |
| Anchor | `[B](#usage)` | Keep the existing heading-jump behavior |
| External URL | `[G](https://...)` `[M](mailto:...)` | Warning banner → "Open" opens a new tab, "Close" cancels |
| `javascript:` scheme | `[X](javascript:...)` | **Blocked unconditionally** |
| Non-existent relative path | `[X](missing.md)` | Shows "File not found", no navigation |

The external-URL warning banner can be dismissed with the Esc key, and new tabs open with `noopener,noreferrer` (tabnabbing prevention). Clicking an internal link during edit mode prompts a confirmation dialog if there are unsaved changes.

### Image preview

Relative paths in Markdown `![alt](foo.png)` are served by yomi via `GET /api/asset?path=...` and shown in the preview. References like a `screenshot.png` next to the md or `../images/logo.svg` display as-is.

| Type | Example | Behavior |
|---|---|---|
| Relative-path image | `![X](foo.png)` `![Y](../img/logo.svg)` | Resolved from the current md's directory and displayed |
| External URL | `![X](https://example.com/x.png)` `![Y](data:image/png;base64,...)` | Passed straight to `<img src>` |
| `javascript:` scheme | `![X](javascript:...)` | **Blocked unconditionally** (rewritten to empty src) |
| Non-image extension | `![X](note.md)` | 400 on the `/api/asset` side (read rejected) |
| `..` outside root / absolute path | `![X](/etc/passwd)` `![X](../../../etc/passwd)` | 400 via `resolveSafe` |
| Over size (>50 MB) | Large image | 413 |

Supported extensions: `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.svg` / `.avif` / `.bmp` / `.ico`. SVG is served with `X-Content-Type-Options: nosniff` + `Content-Disposition: inline` to suppress XSS via MIME sniffing. A strong ETag (`"<sha256-prefix>"`) + `Cache-Control: no-cache` is returned, so the browser uses `If-None-Match` 304 caching while re-fetching on the next request whenever the image is edited (Issue #22 switched to content-based ETag, so even rewrites that preserve mtime + size via `cp -a` are reliably detected). The file is read via an fd obtained with `fs.open`, doing stat + read through that same fd, so even a symlink swap after resolveSafe (TOCTOU) cannot cause an unintended file to be served.

Clicking an image in the preview opens that image URL in a new tab (the `<img>` is wrapped in `<a target="_blank" rel="noopener noreferrer">`). The browser's native image view provides full-size / zoom / save. A `cursor: zoom-in` shows on hover. An image wrapped in a link in markdown like `[![](foo.png)](url)` prioritizes the link target and does not trigger the image jump.

### Scroll sync in split mode (Issue #9)

In **Split** mode (two panes: md source + preview), the scroll positions sync left/right based on headings. Absolute source line numbers are embedded on `<h1>`–`<h6>` via a `data-line` attribute, and a pure function linearly interpolates between the line-based Y coordinate on the source side and `offsetTop` on the preview side.

| Mode | Sync |
|---|---|
| `preview` (single) | N/A |
| `Split` | Enabled (default ON) |
| `MD` (single) | N/A |
| Edit mode (textarea + preview) | Disabled (to avoid disturbing the textarea caret) |

For md with 0 headings, no pairs can be built, so the two panes scroll independently. Pairs are rebuilt after Mermaid diagrams finish async rendering, so sync stays correct even for md with diagrams. The setting is saved to `localStorage` (`yomi:scrollSync:v1`, default ON).

### Navigation / history

- The "currently open file" is reflected in the URL query `?path=foo.md`
- Opening a URL that includes a heading `?path=foo.md#heading` scrolls to that heading (deep link)
- Browser **back / forward** works naturally per file switch (both preview-link clicks and left-tree selections are pushed to history)
- Reloading restores the current file + heading position from the URL
- Copy-pasting the URL reproduces the same screen (openable on another machine / tab started in the same directory)
- Live reload (re-render on file-save detection) and anchor jumps (`#heading`) do not push history
- Pressing "Back" during edit mode prompts a confirmation dialog if there are unsaved changes; canceling jumps back to the file being edited

### Interactive task lists

GFM task lists `- [ ] xxx` / `- [x] xxx` can be clicked directly in the preview to toggle ON/OFF. The checked state is written back to the md file, so you can "track progress while reading" TODO lists or procedures.

- Click a checkbox in the preview → that line flips between `- [ ]` ⇄ `- [x]` and is saved via `POST /api/file`
- Reuses the existing optimistic lock (`baseSha`); a conflict banner appears if it was updated elsewhere
- Not clickable during edit mode (edit mode takes priority, avoiding dual state management)
- Indented (nested) `  - [ ] subtask` and `*` / `+` bullets are supported
- Task-like strings inside code fences (```...``` / `~~~...~~~`) are ignored

### Customizing exclude patterns (`.yomiignore`)

Placing a `.yomiignore` directly under the current directory lets you add to the default exclude patterns (`node_modules`, `.git`, `dist`, etc.). One directory/file name per line; lines starting with `#` are comments.

```
# .yomiignore
# Exclude personal notes
private
backup
.archive
```

Currently only exact directory/file name matches are supported. Globs (`*`, `**`) are not.

### Editing

Pressing the "Edit" button in the right pane's header switches to a `<textarea>` where you can rewrite the Markdown in place.

- **Save**: the "Save and close" button (save → end editing), or `Ctrl/Cmd+S` (save only, keep editing)
- **Discard**: the "Discard" button drops unsaved changes and exits edit mode
- **Unsaved indicator**: `● Unsaved` lights up in the header. Closing the tab prompts a warning
- **Concurrent edit (Lost Update) detection**: if another process rewrites the same file while editing, a conflict banner appears on save. Choose from "Load server version", "Force overwrite", or "Close"

#### Creating new files

You can create a new Markdown file in place from the left tree.

- **The "＋" in the toolbar**: create at the root level
- **The "＋" on a directory row**: create as a child of that directory (shown on hover with the mouse; shown via `Tab` focus for keyboard, and reachable from screen readers)
- An inline input opens; type the file name and confirm with `Enter`, or cancel with `Esc` or by clicking outside the input (losing focus)
- The extension is optional. Names ending in an allowed extension (`.md` / `.markdown` / `.mdx`, case-insensitive) are used as-is; otherwise `.md` is appended (`foo` → `foo.md`, `foo.txt` → `foo.txt.md`)
- On success the new file is selected and opened directly in edit mode (if you cancel the discard confirmation while editing another file with unsaved changes, only the file is created and the editor does not switch)
- A name collision (existing file) is rejected with 409, and the error is shown in the header
- Path traversal, disallowed extensions, and creation under excluded directories (`node_modules` etc., including `.yomiignore`) are rejected server-side

#### Security when editing over the LAN

Adding editing means yomi now has an **endpoint writable by anyone on the LAN**. As a CSRF defense, yomi performs **`Origin` header validation** and accepts only requests from the same origin as yomi itself. This rejects POSTs from attacker pages via the browser with 403. However, note the following:

- Starting with `0.0.0.0` binding on an **untrusted network** (public Wi-Fi, etc.) is not recommended. Use `--host 127.0.0.1` for local only
- Clients that do not send an `Origin` header (curl, Postman, etc.) are allowed. This is intended for API use and is outside the browser CSRF threat model
- yomi has no authentication. LAN editing is only valid on the assumption that "everyone on the LAN is trusted"

### Viewing from the LAN

By default it binds to `0.0.0.0`, so you can access it from smartphones or other devices on the same network via the LAN IP URL shown at startup.

```
yomi has started
  Local   http://127.0.0.1:3939
  LAN     http://192.168.0.100:3939
```

**Note**: since there is no authentication, restrict to your own device with `--host 127.0.0.1` on untrusted networks.

> The startup banner and other terminal output are shown in Japanese. Only the browser UI is bilingual.

## Development

- Design starting point: [`docs/design-yomi-20260430.md`](docs/design-yomi-20260430.md)
- Change log / diffs from the design doc: [`CHANGELOG.md`](CHANGELOG.md)

### Tests

Run all tests with `bun test`.

```bash
bun test
```

They live under `tests/` as `*.test.ts`. In addition to server-side pure functions, security-related code, the parser, and the file scanner, they cover DOM-independent client pure functions (`public/new-file.js`, etc.) — the DOM-coupled `app.js` itself is out of scope.

```bash
bun test tests/util/        # just the util directory
bun test tests/safepath     # filter by file name
```

### Type check

```bash
bun run typecheck
```

## Troubleshooting

### Live reload and the watch limit (Linux)

yomi does not set watches on excluded directories such as `node_modules` or `.git`, so it usually does not hit the watch limit. Even so, opening a huge tree can reach the Linux inotify watch limit (`fs.inotify.max_user_watches`) and produce this warning:

```
The file watch limit has been reached (ENOSPC). …
```

`ENOSPC` here does not mean out of disk space; it means the **inotify watch limit is exhausted**. To raise the limit:

```bash
# Temporary change
sudo sysctl fs.inotify.max_user_watches=524288

# Persist
echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/99-inotify.conf
sudo sysctl -p /etc/sysctl.d/99-inotify.conf
```

If you cannot raise the limit (e.g., no `sudo`), you can also narrow the watched levels with [`--depth`](#options). For example, `yomi --depth 2` watches only two levels, keeping the watch count low.

## License

MIT — see [`LICENSE`](LICENSE) for details.
