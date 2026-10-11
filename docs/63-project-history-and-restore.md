# 63 — Project history & last-project restore

Status: implemented; tests 922/922 (×2), typecheck and build pass, real-Electron restore check
6/6 (provider-free). No Claude/Codex call. (Requested as `docs/62-…`; 62 was already taken by
the Claude model-selection doc, so this follows the repo's next-free-number convention.)

## 1. Problem

AI Bridge only reopened a project at startup when the user had explicitly set a *default
project* in Settings. Otherwise every launch started with "Chọn project…" and the native folder
picker — unlike Codex or Claude Code, which remember where you were.

## 2. UX behaviour

- **Startup:** the explicit default project (existing Settings feature) if one is set, otherwise
  the most recently opened project, is opened automatically — straight into the normal Run /
  Workflows views. No picker.
- **Last project missing:** nothing crashes and no *other* project is opened in its place. The
  start screen shows *"Không mở lại được project gần nhất … "* and **Dự án gần đây** with the entry
  marked **Status: Missing**.
- **Dự án gần đây** (start screen when no project is open, and Settings → Project): name, path,
  last-opened time, badges (Đã ghim / Đang mở / Status: Missing) and actions:
  - **Mở** (available entries; disabled for the active one and while a run is active),
  - **Tìm lại…** (missing entries — native folder picker, starting at the old location),
  - **Ghim / Bỏ ghim**,
  - **Xoá khỏi lịch sử** (with a confirmation that the folder is *not* deleted).
- **Đổi project… / Chọn project…** are unchanged (native picker in Main); a project opened that way
  is added to the history like any other.

## 3. Persistence location

The existing app-level settings file — Electron `userData/settings.json`
(`%APPDATA%\AI Bridge\settings.json` on Windows), written atomically by `AtomicJsonWriter`. Never
inside a project, never in `.ai-bridge/`. No database.

```json
{
  "defaultProjectPath": null,
  "recentProjects": [
    { "id": "3f9a0c1d2e4b5a69", "name": "demo", "path": "D:\\work\\demo", "lastOpenedAt": "2026-10-02T09:00:00.000Z", "pinned": false }
  ]
}
```

`ProjectHistoryService` (Main) is the single writer of this file, so history updates and the
default-project setting never overwrite each other. On save exactly these two top-level fields,
and exactly these five entry fields, are written; anything else found in the file is dropped.

## 4. Project identity

There was no existing project-identity mechanism (BridgeEngine/workflows key everything by the
project path). Identity is therefore **deterministic from the canonical path**:
`id = first 16 hex of SHA-256(pathKey)`, where `pathKey` is the resolved path without trailing
separators and, on Windows, with `/`→`\` and case folded. So `D:\Work\App`, `d:/work/app/` and
`D:\WORK\APP` are one entry; on case-sensitive file systems case is kept. Paths are canonicalised
by `validateProjectPath` (realpath) before they are recorded. Nothing in the project is read or
written to compute the id (no repository scan, no marker file). Consequence: a moved/renamed
folder is a *new* identity — "Tìm lại…" replaces the old entry and keeps its pin.

## 5. Startup restore

`main.ts` → `ProjectHistoryService.load()` → `restoreAtStartup()` → `createWindow()`:

1. candidate = `defaultProjectPath` ?? most recent `lastOpenedAt` entry ?? none (`NONE`);
2. `validateProjectPath(candidate)` (absolute, local, existing directory, not a drive root);
3. open in the run + workflow controllers (the same path as before — Core then reports
   status/recovery; nothing is resumed automatically);
4. success → `RESTORED` and `lastOpenedAt` updated; any failure → `MISSING` with the reason.
   Exceptions are caught; startup always continues to the window.

## 6. Missing projects

Status is computed in Main each time the list is requested (`validateProjectPath` per entry), so an
entry is never removed automatically and becomes usable again as soon as its folder is back.
Missing entries offer **Tìm lại…** and **Xoá khỏi lịch sử**.

## 7. Pinning & limits

Ordering: pinned first, then unpinned; most recently opened first within each group. At most
**20 unpinned** entries are kept (oldest dropped); pinned entries are never dropped by the limit. A
hand-edited/corrupt file is read defensively (at most 200 rows considered; malformed, relative or
duplicate rows are dropped/merged — newest wins, pinned if any copy was).

## 8. Security / privacy

- Stored: project name, absolute path, last-opened time, pin flag. Nothing else — no API keys,
  credentials, cookies, provider auth, secrets or project contents (tested with a seeded file
  containing `apiKey`/`token`/`cookie` fields: all dropped on the next save).
- "Xoá khỏi lịch sử" only edits this list; no project directory is ever touched.
- The renderer never sends or receives a path for an action: entries are addressed by their opaque
  16-hex id; Main resolves and re-validates the path; the folder picker runs in Main.

## 9. IPC design

Five channels appended to the typed allowlist (`INVOKE_CHANNELS`, now 34), each validated in Main:

| Channel | Payload | Notes |
|---|---|---|
| `project:getHistory` | none | entries (+ status, active) and the startup restore outcome |
| `project:openRecent` | `{ id }` | validated → opened → recorded |
| `project:setPinned` | `{ id, pinned: boolean }` | |
| `project:removeRecent` | `{ id }` | history only |
| `project:locate` | `{ id }` | native picker in Main; replaces the moved entry |

`id` must match `/^[0-9a-f]{16}$/`; extra fields, paths, or wrong types are rejected before any
handler runs. Preload exposes five matching fixed functions (38 total); no generic invoke.

## 10. Tests

- `tests/desktop/project-history.test.ts` (11): empty history; first open; no duplicate on reopen;
  move-to-top; restore on next start; missing last project (no crash, nothing else opened, listed
  as Missing, removable); locate (moved folder, pin kept, cancel) and a folder that comes back;
  pin/unpin ordering; limit with pinned survivors; Windows path normalisation; no secrets
  persisted; IPC rejects paths/extra fields; default-project precedence and refused opens.
- `tests/desktop/renderer/recent-projects.test.tsx` (3): list on the start screen, Missing +
  restore notice, id-only actions incl. confirmed removal, empty state + "Chọn project…".
- Updated: IPC channel count, preload key list, app-settings persistence test, smoke count.
- Real Electron (one-off, provider-free, `sandbox/project-history-check/check.ts`, not tracked):
  launch 1 restores the last project; launch 2 after deleting it starts cleanly with it shown as
  Missing — 6/6.

## 11. Future extension points

- "Clear history" in Settings (not added — only per-entry removal exists today).
- A project switcher in the top bar fed by the same `project:getHistory`.
- Showing per-project status (last run status, open workflows) in the list.
- A stable identity that survives moves (e.g. a marker in `.ai-bridge/`) if needed later — the id
  scheme is internal and can change without migrating anything but this list.
