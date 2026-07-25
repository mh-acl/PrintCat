# Print Catalog — Architecture Overview

An Electron app for a makerspace's Prusa MK4S print catalog. Runs on
loaner MacBooks (older models, macOS Ventura via OpenCore Legacy
Patcher) with no single shared kiosk — every laptop runs its own copy.
Replaces an older static-site (Ruby-generated GitHub Pages) version of
the same catalog.

**Keep this file in sync with the code.** Whenever a change adds a
file, changes an IPC channel, or changes a data shape described below,
update the relevant section in the same pass. Upload this file at the
start of a new conversation alongside whatever specific files are
relevant to the task at hand — it's what lets a fresh instance figure
out which files it needs without re-reading everything.

## Process split

- **Main process**: `main.js`, `indexer.js`, `gcodeParser.js`,
  `bgcodeParser.js`, `bgcodeCli.js`, `gcodeCommandScan.js`, `folderName.js`,
  `thumbnailCache.js`, `thumbnailResolver.js`, `settings.js`, `drives.js`,
  `gitSync.js`, `gitPush.js`, `tokenStore.js`, `provisionTokenWindow.js`,
  `syncState.js`, `tools.js`, `usbWiperWindow.js`
- **Preload (bridge)**: `preload.js`, `usbWiperPreload.js`,
  `provisionTokenPreload.js`
- **Renderer (UI, no framework)**: `renderer.js`, `index.html`,
  `styles.css`, `usbWiperRenderer.js`, `usbWiperWindow.html`,
  `provisionTokenRenderer.js`, `provisionTokenWindow.html`

## File-by-file summary

**`main.js`** — Entry point. Sets `app.name` to "Print Catalog" (menu
bar / About panel only — see gotchas below), builds the macOS
application menu (Settings… lives here now, not a button, and a
**Tools** menu built from `tools.js`'s `TOOLS` registry — see
`tools.js` below), creates the
`BrowserWindow`, wires up `Indexer` / `ThumbnailCache` /
`ThumbnailResolver` / `SettingsStore` / `SyncStateStore`, and watches
`DATA_DIR` with `chokidar` to push background rescans to the renderer.
`DATA_DIR` is a module-level `let`, left unresolved until
`setupIndexer()` loads `settingsStore` (must happen first, since the
decision depends on it) and calls `resolveDataDir(settingsStore.get())`.
When `settings.gitRepoUrl` is set: `DATA_DIR` becomes
`userData/print-catalog-data`, that folder is created if missing so
the very first launch has something to scan, `setupIndexer()` indexes
and displays whatever's already on disk (usually already correct, and
instant), and only *then* is `gitSync.syncCatalogRepo()` kicked off —
deliberately not awaited — so startup never blocks on the network. Any
changes it pulls are picked up by the chokidar watcher already running
from `setupIndexer()`, which triggers its own debounced rescan +
`catalog:updated` push; no separate "sync finished" signal is needed
for the catalog data itself. Sync failures (or `gitRepoUrl` not being
set at all) just leave whatever's on disk as the catalog. A
module-level `syncInProgress` flag plus `SyncStateStore`'s persisted
`lastSuccessAt` back the `sync:getStatus` / `sync:statusChanged` status
shown in the renderer's footer (see `syncState.js` and `renderer.js`
below) — set true right before `syncCatalogRepo()` is kicked off and
false once it resolves, broadcasting `sync:statusChanged` on both
transitions and recording a success timestamp only when
`synced: true`. Because `DATA_DIR` is only ever resolved once at
startup, `settings:save` compares the git fields before/after saving
and returns `{ settings, needsRestart }`; the renderer prompts the
user to restart (via the new `app:relaunch` handler, which calls
`app.relaunch()` + `app.exit(0)`) rather than the app trying to
retarget an already-running indexer/watcher/thumbnail cache live.
Non-git settings (printer availability) still take effect immediately,
no restart involved. All `ipcMain.handle` calls live here:
`catalog:getTree`, `catalog:getItemThumbnail`, `catalog:getFileThumbnail`,
`drives:list`, `drives:saveFile`, `drives:eject`, `drives:isPresent`,
`settings:get`, `settings:save`, `sync:getStatus`, `app:relaunch`.
Also sends `catalog:updated`, `menu:openSettings`, and
`sync:statusChanged` to the renderer.

**`tools.js`** — Registry (`TOOLS` array) of macOS-menu-bar "Tools"
tasks: each entry has an `id`, menu `label`, confirmation-dialog copy
(`confirmTitle`/`confirmMessage`/`confirmDetail`), and an async `run()`.
`main.js`'s `buildMenu()` turns `TOOLS` into the Tools submenu
automatically, and `runTool()` (also in `main.js`) handles the
confirm-dialog → run → result-dialog flow generically, so adding a
future task (quitting apps, resetting settings to defaults, etc.)
means only adding an entry here — no menu-wiring changes needed.
Currently one task, **Cleanup profile**: deletes everything (including
dotfiles) inside `~/Downloads` and `~/Desktop`, leaving the folders
themselves in place. Because the loaner laptops' guest OS account's
home folder is always `/Users/user`, and guests sometimes leave
personally-identifiable files behind, `assertGuestAccount()` checks
`os.homedir() === '/Users/user'` before doing anything and throws
(surfaced to the volunteer as an error dialog, not a silent no-op) if
it doesn't match — a safeguard against this ever running against a
real user profile. Deletion is permanent (no Trash), matching the
"guest files are disposable, PII must actually be gone" intent;
`run()` returns `{ failures: [{ path, error }] }` for anything that
couldn't be removed rather than throwing, so partial failures are
reported distinctly from total failure.

The Tools menu also has two items that do **not** go through this
registry: **USB Wiper**, wired directly in `main.js`'s `buildMenu()` to
`usbWiperWindow.js`'s `openUsbWiperWindow()`. It doesn't fit the
confirm-dialog → `run()` → result-dialog shape because it opens a
persistent window with its own session state rather than running once and
reporting a result — see `usbWiperWindow.js` below.

**Add items to Print Catalog…**, also wired directly in `buildMenu()`,
to `runAddItemsToCatalog()` (also in `main.js`). This is the first,
bones-only slice of the co-admin import feature described in prior
design discussion (not yet reflected elsewhere in this file) — none of
the planned niceties (image/print-file reconciliation, `metadata.json`,
a multi-item staging queue) exist yet. It doesn't fit the `TOOLS`
registry shape either, since it needs a folder-picker result to feed
into the rest of the flow before any confirm/run step makes sense.
Current flow: native folder-picker dialog (`dialog.showOpenDialog`,
`openDirectory`) → the picked folder is copied as-is via `fsp.cp(...,
{ recursive: true })` into `DATA_DIR/<FALLBACK_CATEGORY>/<folderName>`,
where `FALLBACK_CATEGORY` is a hard-coded `"New Items"` placeholder
category (there's no category-assignment UI yet — everything lands in
one bucket for now) → a confirm dialog ("Push to GitHub?") → on
confirm, `tokenStore.js`'s `tokenExists()` check — if the laptop
hasn't been provisioned yet, `provisionTokenWindow.js`'s
`promptForToken()` collects a token inline and `writeSyncToken()` writes
it (one admin-auth prompt); otherwise `readSyncToken()` (a separate
admin-auth prompt, every time) — → on success, `gitPush.js`'s
`pushNewItem()` commits and pushes → a result dialog. If the co-admin
cancels the confirm dialog or the provisioning dialog, or the push
fails for any reason, the copied folder is removed from `DATA_DIR`
again (best effort) rather than left as an uncommitted stray — though a
failed *push* (as opposed to a cancel) would have self-healed on the
next launch's `syncCatalogRepo()` reset regardless, per `gitSync.js`'s
one-way-mirror behavior below. All metadata (name, category placement
aside) is still expected to come from `folderName.js`/filename parsing,
same as the existing hand-edited workflow — there's no `metadata.json`
support yet.

**`gitPush.js`** — `pushNewItem({ targetDir, repoUrl, branch, token,
commitMessage })`: commits whatever's currently uncommitted in
`targetDir` and pushes it, authenticating by embedding `token` directly
into the push URL (`https://x-access-token:<token>@...`) as a one-off
argument to `git push` — never written into `.git/config` or anywhere
else on disk. Reuses `gitSync.js`'s `run()` helper (now exported) for
the same spawn-with-process-group-timeout invocation style, rather than
introducing a second way of shelling out to git. Checks `git status
--porcelain` first and returns `{ pushed: false, reason:
'nothing-to-commit' }` as a normal non-error outcome if there's nothing
staged — e.g. a re-run after an item was already synced.

Pushes set `http.postBuffer` to 500 MiB for that one invocation (`git
-c http.postBuffer=... push ...`) rather than git's 1 MiB default,
since gcode + image data routinely exceeds that. If a push still fails,
the failure isn't trusted at face value: GitHub can disconnect
mid-transfer ("RPC failed; HTTP 400 ... unexpected disconnect while
reading sideband packet") *after* already accepting the pack, while
still streaming back its post-push status report — so
`remoteHeadMatchesLocal()` runs a `git ls-remote` against what was just
pushed, and if it already matches, the earlier error is treated as
spurious and this reports success. Only if that check also comes back
negative does it retry once with `http.version=HTTP/1.1` forced (the
documented fix for the HTTP/2-sideband-disconnect variant on networks
that mishandle it), checking `remoteHeadMatchesLocal()` again before
finally giving up and throwing.

Deliberately does not fetch/rebase/merge first: consistent with
`gitSync.js` treating the data directory as a one-way mirror with no
conflict-resolution UI, a push rejected because origin moved since the
last launch-time sync is a genuine failure surfaced as a plain error
(distinct from the spurious-disconnect case above, which this function
resolves on its own) — the expected recovery is restart (which
re-syncs from origin) and retry.

**`tokenStore.js`** — patches `util.isObject`/`isFunction`/`isString`
back onto Node's `util` module before requiring `sudo-prompt`, since
that package (unmaintained since 2021) still calls those long-removed
helpers and throws immediately otherwise; see the comment at the top
of the file for why `@vscode/sudo-prompt` isn't a reliable swap-in fix
either. `tokenExists()`: cheap unprivileged existence
check for the token file (checking existence only needs
search/execute permission on parent directories, not read permission
on the file itself, so this works without ever invoking `sudo-prompt`
just to find out whether provisioning has happened yet). `readSyncToken()`:
reads the GitHub push credential from a root-owned file
(`/Library/Application Support/PrintCatalog/sync-token`, mode 600) via
`sudo-prompt`, which pops the native macOS admin-authentication dialog
(a GUI password/Touch ID prompt, since there's no terminal here for an
interactive `sudo` to prompt into). `writeSyncToken(token)`: writes that
same file (creating the directory, `chown root:wheel`, `chmod 600`) via
a single privileged shell command, base64-encoding the token first so
an unusual token value can't break the command's quoting. A
standard-user co-admin session has no path to the token's contents (or
to writing a new one) other than completing the admin-auth prompt each
of these pops. The token itself should be a fine-grained GitHub
Personal Access Token scoped to just this one repo (Contents: Read and
write) rather than a classic token with broader access — so a
lost/wiped laptop can only compromise this one repo.

**`provisionTokenWindow.js`** — `promptForToken(parentWindow)`: a small
modal `BrowserWindow` (`provisionTokenWindow.html` /
`provisionTokenRenderer.js` / `provisionTokenPreload.js`) with a single
password-style text field, used the first time
`runAddItemsToCatalog()` attempts a push on a laptop where
`tokenStore.js`'s `tokenExists()` is false — folds first-time-per-laptop
setup into the push attempt itself rather than requiring a separate
command to be run first. Resolves with the entered token (trimmed,
non-empty) or `null` if cancelled/closed without submitting. This
window deliberately has no gating of its own beyond the text field —
the real gate is the OS admin-auth prompt `writeSyncToken()` pops
immediately after this resolves, so there's nothing this dialog itself
needs to protect against; anyone can open it and paste something in,
but only someone who can satisfy that OS prompt gets it actually
written to disk. `scripts/provision-sync-token.sh` still exists
alongside this — useful for scripting setup across many laptops at
once without opening the app on each one.

**`usbWiperWindow.js`** — Owns the singleton `BrowserWindow` for the USB
Wiper tool (`usbWiperWindow.html` / `usbWiperRenderer.js` /
`usbWiperPreload.js`) and the wiping session it drives. "Begin Wiping
USBs" starts a 2s poll of `drives.listUsbDrives()`, grouping results by
whole-disk `diskIdentifier` (not `mountPoint`) since a single physical
disk can report more than one mounted volume (a partitioned drive) and
`ejectDrive()` itself operates at the whole-disk level — diffing each
poll's disk-identifier set against the previous one is what detects a
newly-inserted disk. Every volume on a newly-seen disk gets
`drives.wipeDriveContents(mountPoint)` (permanent, no Trash — same
"disposable shared content" reasoning as Cleanup profile's deletion),
then the whole disk is ejected once via `ejectDrive(diskIdentifier)`,
with `usb-wiper:drive-status` IPC events (`wiping` → `done`/`error`)
driving the renderer's log; the disk is dropped from the "seen" set the
instant it's ejected so a quick unplug/replug of the *same* drive is
wiped again rather than ignored. No polling of `isDiskPresent()`
afterward (unlike the Print flow's "safe to unplug" poll) —
`ejectDrive()` resolving is itself treated as "safe to unplug." No
`assertGuestAccount()` check here either — that guard protects the
guest laptop's own home folder, not a plugged-in USB volume. As a
precaution, the window's `blur` event auto-stops the session (button
reverts to "Begin Wiping USBs", window stays open) any time it leaves
the foreground for any reason; the window disables minimize/fullscreen
so `blur` is the one case to handle. Clicking "Stop Wiping USBs" (a
user-initiated stop, distinct from an auto-stop) also closes the
window via `window.close()` in the renderer. Session state (interval
timer, "seen" disk-identifier set) is module-level in
`usbWiperWindow.js`, torn down on both explicit stop and window close.

**`syncState.js`** — `SyncStateStore`: persists just the
`{ lastSuccessAt }` timestamp of the last successful `gitSync` sync to
`userData/git-sync-state.json`, so the footer note has something
correct to show immediately on launch, before this session's own sync
attempt has even finished (or if it fails). Deliberately stored
*outside* the git-synced data folder — that folder gets `clean -fd`'d
on every sync, which would silently wipe a state file living inside
it.


**`preload.js`** — `contextBridge` exposing `window.catalogAPI` to the
renderer: `getTree`, `getItemThumbnail`, `getFileThumbnail`,
`onCatalogUpdated`, `listDrives`, `saveFileToDrive`, `ejectDrive`,
`isDrivePresent`, `getSettings`, `saveSettings`, `onOpenSettings`,
`getSyncStatus`, `onSyncStatusChanged`, `relaunch` (used after a git
repo/branch settings change — see `main.js` above).

**`gitSync.js`** — `syncCatalogRepo({ repoUrl, branch, targetDir,
timeoutMs })`: one-way mirror of a public HTTPS git repo into
`targetDir`, kicked off once per launch (fire-and-forget, from
`main.js`, after the initial index/display of whatever's already on
disk). Existing valid clone → `fetch` + `reset --hard origin/<branch>`
+ `clean -fd`, so any local drift is always discarded in favor of the
remote (not a two-way sync). No existing clone, or an existing one
that fails a local `git rev-parse --verify HEAD` check, or one whose
fetch/reset fails → falls back to wiping `targetDir`'s contents and
doing a fresh `git clone --depth 1`, so a clone interrupted by a
timeout or crash self-heals on the next launch instead of failing the
same way forever. Every git call runs under a timeout (default 5
minutes — real catalogs have gcode/thumbnail/photo weight, so this is
deliberately generous; override via `timeoutMs` /
`PRINTCAT_GIT_SYNC_TIMEOUT_MS`), enforced by `spawn({ detached: true
})` + killing the whole process group (`process.kill(-pid,
'SIGKILL')`) rather than execFile's built-in timeout, since killing
only git's own pid can leave its transport helper running and still
writing into `.git`. POSIX-only, consistent with the rest of the app.
Every failure (no internet, git not yet installed, bad branch, auth
failure, timeout) is caught and turned into `{ synced: false, reason,
error }` rather than thrown — the promise always resolves, never
rejects. No authentication is implemented (public repos only).

**`indexer.js`** — Walks `DATA_DIR` recursively. A folder containing
gcode/bgcode files directly *is* an item; the first-level subfolder
name under `DATA_DIR` becomes that item's `category` (flat tag, no
subcategory nesting — any deeper folder structure inside a category
just keeps flattening into it). Parses each print file via
`gcodeParser`, caching results to disk (`catalog-cache.json`) keyed by
path + mtime + size. `CACHE_VERSION` must be bumped whenever a parsing
logic change should invalidate already-cached entries.
Item shape: `{ type, name, displayName, path, explicitThumb, imageFiles, projectFiles, category, files[] }`.
File-entry shape: `{ path, mtimeMs, size, shortname, longname, tags, printerModel, printerVariant, printTime, hasEmbeddedThumbnail, colorChangeCount, copies, pauseCount, pauseMessages }`.
`colorChangeCount`/`copies`/`pauseCount` are auto-detected (M600 count / M486
batch-object count / M601 count, `copies` defaulting to 1 when no batch is
detected) — see `gcodeParser.js` / `bgcodeParser.js` below. `pauseMessages`
is an array the same length as `pauseCount`, one entry per pause holding
whatever M117 status message immediately preceded that M601 (`null` where
there wasn't one). For `.bgcode` files, `colorChangeCount`/`copies`/
`pauseCount` can each come back `null` (undetectable) rather than a number
(and `pauseMessages` `null` too, in that case); that's distinct from
0/1/none and should be treated as "unknown" in the UI, not "none". Bumping
`CACHE_VERSION` (currently 6) is required whenever a change like this alters
what gets cached per file, so already-cached entries get reparsed instead of
silently missing the new field.

**`gcodeParser.js`** — Two jobs: (1) filename parsing, supporting both
the legacy `Name (tags)[printer]_uniqueid.ext` convention and the newer
`name.printer.ext` convention, returning `{ shortname, longname, tags }`
either way; (2) `parseGcodeMetadata(filePath)`, which dispatches by
extension to either the streaming text-gcode `"; key = value"` comment
parser or to `bgcodeParser.js` for `.bgcode`. Both paths return the
same `{ values, thumbnailBase64, colorChangeCount, copies,
pauseCount, pauseMessages }` shape (the last four via
`gcodeCommandScan.js`, fed every non-comment line as it streams).
Printer identity always comes from embedded gcode metadata, never
from the filename.

**`bgcodeParser.js`** — Parses Prusa binary gcode (`.bgcode`) per the
[libbgcode spec](https://github.com/prusa3d/libbgcode/blob/main/doc/specifications.md):
file header + a sequence of typed blocks. Merges the File/Printer/Print/
Slicer metadata blocks into one flat `values` map (Deflate-compressed
blocks decompress with standard zlib, not raw deflate — confirmed
against a real file). Picks the largest browser-displayable (PNG/JPG)
thumbnail block, skipping QOI ones. GCode block bodies are
opportunistically decompressed and fed to `gcodeCommandScan.js`
in-process when they're plain-text-encoded (not MeatPack) and
compressed with none/Deflate (not Heatshrink) — real files often
Heatshrink-compress the toolpath specifically. When any GCode block
can't be read this way, color-change/batch/pause detection for the
whole file is redone via `bgcodeCli.js`'s CLI fallback instead of
trusting a partial in-process count; `colorChangeCount`/`copies`/
`pauseCount` only come back `null` (and `pauseMessages` `null` too) if
that fallback also fails (missing/broken binary).

**`bgcodeCli.js`** — Fallback for the one gap in `bgcodeParser.js`'s
own decoding: Heatshrink-compressed or MeatPack-encoded GCode blocks,
which it can't decompress in-process. Shells out to a bundled
reference `bgcode` CLI binary (`bin/bgcode` — dev-time path today;
packaged builds will need this bundled via `extraResources` once
packaging is set up) to convert the whole file to plain gcode, then
scans that output with the same `GcodeCommandScanner` used elsewhere.
The CLI only supports `bgcode <path>`, writing a sibling `<name>.gcode`
next to its input with no output-path or stdout option — each call
gets its own `mkdtemp` throwaway directory and a symlink to the real
file, so concurrent conversions during a background rescan never
collide on that fixed naming, and the temp dir (plus the converted
gcode) is removed afterward either way.

**`gcodeCommandScan.js`** — Shared incremental scanner used by both
parsers above: `feedLine()` per gcode line, `result()` once at the
end. Detects color changes by counting `M600` commands, detects
pauses by counting `M601` commands (pairing each with whatever `M117`
status message directly preceded it, via a "most recent M117, cleared
once consumed" tracker — a pause with no preceding message, or a bare
`M117` with none, records `null`), and detects batch print jobs by
collecting every `M486 A<object name>` declaration line (PrusaSlicer
emits one per object, near the top of the file) and checking whether
the names are identical, or identical but for a trailing
`" (Instance N)"` — if so, `copies` is the object count, otherwise
`copies` is 1.

**`folderName.js`** — `stripTrailingId()` strips the trailing
`" - <thingiverseId>[(n)]"` suffix from an item folder's name for
display. `indexer.js` keeps the raw folder name too, for a possible
future "view original" link.

**`thumbnailCache.js`** — Disk cache (app `userData/thumb-cache`) for
thumbnails extracted from embedded gcode, keyed by
`sha1(path:mtimeMs)` so a changed source file naturally invalidates
its old cached thumbnail.

**`thumbnailResolver.js`** — Fallback chain per print file: an
override image in the item folder matching the file's longname, then
shortname, then its own embedded gcode thumbnail (extracted + cached
on demand), then nothing. Item-level thumbnail: an explicit `thumb.*`
file, else the first print file that resolves to a real thumbnail.

**`settings.js`** — `SettingsStore`: persisted admin config
(`{ availablePrinters: [], hideUnavailable: bool, gitRepoUrl: '',
gitBranch: '' }`) in `userData/settings.json`. `gitRepoUrl`/`gitBranch`
replace the old `PRINTCAT_GIT_REPO_URL`/`PRINTCAT_GIT_BRANCH` env vars
and are set via the Settings dialog's "Git Repository:"/"Branch:"
fields; an empty `gitBranch` defaults to `'main'` wherever it's
consumed (`gitSync.js`, `main.js`), not stored as `'main'` here.
Distinct from the user's own per-session printer filter selection in
the renderer.

**`drives.js`** — macOS-only. Shells out to `diskutil`/`plutil` to
list, eject, and check presence of external physical USB drives,
deliberately avoiding a native Node module (`drivelist` etc.) to sidestep
an Electron-rebuild toolchain on the makerspace's older loaner laptops.
Also exports `wipeDriveContents(mountPoint)` (added for the USB Wiper
tool — see `usbWiperWindow.js`): deletes everything inside a mounted
volume, including dotfiles, leaving the volume itself mounted so it can
still be ejected afterward; returns `{ failures: [{ path, error }] }` for
anything that couldn't be removed instead of throwing, same
partial-failure shape as `tools.js`'s Cleanup profile.

**`renderer.js`** — All UI logic, no framework. Global state:
`allItems`, `selectedItem`, `selectedPrinters`, `selectedCategories`,
`keywordQuery`, `settings`. Flat browsing model — no navigation or
breadcrumbs. Three filters combine on a single flat item grid: Printer
pills (multi-select), Category pills (multi-select, from `item.category`),
and a live keyword search box (AND-match across item name + each file's
shortname/longname/tags — see `itemMatchesKeyword` /
`fileMatchesKeywordInItem`). Clicking an item shows its (filtered)
print files with a "Print This" button driving the USB flow: list
drives → alert/confirm/picker → copy → post-save keep-browsing/eject
dialog → auto-dismissing "safe to unplug" poll. The Settings dialog is
now opened via `onOpenSettings` (from the app menu), not an in-page
button. It also has "Git Repository:"/"Branch:" text fields
(`createSettingsTextField()`) alongside the printer checkboxes; saving
sends `gitRepoUrl`/`gitBranch` through `settings:save`, and if the
returned `needsRestart` flag is set, a `confirm()` prompt offers an
immediate restart via `relaunch()`. The search box and both pill rows are wrapped in `#top-filters`,
which `render()` hides outright while an item is open (see gotchas) —
independent of `#printer-filter`'s own display toggling for the
hideUnavailable case. A `#sync-status` footer note ("Last catalog
refresh: 2 minutes ago", plus "Refresh in progress…" while one's
running) is driven by `syncStatus`, pulled once via `getSyncStatus()`
on load and kept live via `onSyncStatusChanged`; `formatRelativeTime()`
renders the "X ago" phrasing, and a 30s interval re-renders it on its
own so the elapsed time keeps ticking forward between actual status
changes. Hidden entirely when git sync isn't configured at all. Each
print file's metadata (in `renderItemDetail()`) is shown as short
phrases rather than key/value pairs — "1 color change"/"2 color
changes", "6 copies" (only shown when >1), "1 pause"/"3 pauses" — with
`null` detection results (undetectable `.bgcode` toolpath) treated the
same as "nothing to report" and simply omitted. The pause line also
appends a `<i class="pause-tooltip-icon" title="...">` info icon
whenever at least one pause has a non-null message, built via DOM
methods (`textContent`/`title`, not `innerHTML`) so a message can't
inject markup; multiple messages are joined with `\n` in the tooltip.



**`index.html` / `styles.css`** — Minimal static shell: header, a
`#top-filters` wrapper containing a static keyword search `<input>`
(intentionally *not* regenerated by `render()`, so it keeps
focus/cursor while live-typing) and the `#printer-filter` /
`#category-filter` containers (fully regenerated on each relevant
state change), `#listing`, and a `#sync-status` footer note (see
`renderer.js` above; unstyled so far — `styles.css` doesn't have rules
for it yet). `.pause-tooltip-icon` (also from `renderer.js`, see
above) likewise still needs a `styles.css` rule to make it visually
read as "hover for more" (e.g. a rounded/underlined cursor-help
treatment) — not yet added.

## Data directory resolution

- `DATA_DIR` is resolved once, in `main.js`'s `setupIndexer()`, right
  after `settingsStore.load()` — it depends on `settings.gitRepoUrl`,
  which is admin-configured via the Settings dialog's "Git
  Repository:" field (persisted in `settings.json`, no longer an env
  var).
- If `settings.gitRepoUrl` is set, `DATA_DIR` is fixed to
  `userData/print-catalog-data`. That folder is created if missing,
  indexed and shown immediately (see below), and git-synced in the
  background on every launch. `settings.gitBranch` optionally
  overrides the tracked branch (default `main` when empty — the
  "Branch:" field in the Settings dialog), and
  `PRINTCAT_GIT_SYNC_TIMEOUT_MS` (still an env var — a dev-time knob,
  not exposed in the UI) optionally overrides the per-git-call timeout
  (default 5 minutes — see `gitSync.js`).
- If `settings.gitRepoUrl` is not set, `DATA_DIR` falls back to the
  existing `PRINTCAT_DATA_DIR` env var (or the dev-time default under
  the repo itself), unchanged from before — this keeps the
  manually-synced local-copy workflow available for development.
- Because `DATA_DIR` is only resolved once at startup, changing
  `gitRepoUrl`/`gitBranch` in the Settings dialog doesn't retarget the
  already-running indexer, thumbnail cache, or chokidar watcher.
  `settings:save` detects the change and reports `needsRestart: true`;
  the renderer then prompts the user to restart the app
  (`app:relaunch`) rather than attempting a live re-init.
- Sync is asynchronous and non-blocking by design: the app shows
  whatever's already on disk immediately, then syncs in the
  background. In the common case nothing has changed since last
  launch, so the immediate display is already correct and no rescan
  follows. When the sync does pull changes, the existing chokidar
  watcher (already running by that point) picks up the file
  adds/changes/removals itself and triggers its own debounced rescan
  — accepting a possible second scan in the rarer case something
  changed, in exchange for never delaying the first paint on the
  common case.

## Key conventions / gotchas

- Category is a flat tag (first-level folder name), not a tree.
- Two supported filename conventions; printer identity is never parsed
  from the filename.
- `CACHE_VERSION` (in `indexer.js`) must be bumped when parsing logic
  changes in a way that would produce different output for files
  already cached.
- `.bgcode` support is transparent at the `parseGcodeMetadata()`
  boundary — no caller needs to know or care which format it got.
- The keyword search `<input>` must stay static HTML, never rebuilt by
  a render function, or it loses focus on every keystroke.
- `app.setName()` in `main.js` only renames the macOS menu bar's
  application menu and About panel — **not** the Dock icon label,
  which is baked into Electron's own `Info.plist` and only changes
  once the app is packaged (electron-builder / Forge) with
  `productName` set. Packaging isn't set up yet.
- Practically macOS-only: `drives.js` shells out to `diskutil`, and the
  Settings-in-the-app-menu placement follows the macOS convention.
- An open item's file list is only ever narrowed by the printer filter
  and the keyword query (`fileMatchesKeywordInItem`) — category is a
  property of the item as a whole, already decided by the time you
  clicked into it, so it's never re-checked per file. Because of that,
  `#top-filters` (search + both pill rows) is hidden entirely whenever
  `selectedItem` is set, rather than left clickable with no visible
  effect on the current view.
- Git sync (`gitSync.js`) is a one-way mirror: on launch it resets the
  data folder to match the remote branch exactly, discarding any local
  drift (`reset --hard` + `clean -fd`). It is not a merge, and there is
  no conflict UI — this is deliberate, since the data folder isn't
  meant to be hand-edited on the laptops once git sync is in place.
- Git sync runs in the background and never blocks or fails startup:
  it's kicked off (not awaited) only after the app has already indexed
  and shown whatever's on disk, every git command runs under a
  timeout (default 5 minutes, overridable with
  `PRINTCAT_GIT_SYNC_TIMEOUT_MS`), and every error (no internet, git
  not yet installed — the macOS command-line-tools stub just pops the
  install dialog and returns an error rather than hanging — bad
  branch, etc.) is caught and logged, leaving the already-shown data
  as-is.
- A sync that gets interrupted (timeout, crash, quitting the app
  mid-clone) is expected and self-heals: `gitSync.js` verifies the
  existing clone with a local `git rev-parse --verify HEAD` before
  trusting it, and falls back to wiping the folder and re-cloning
  from scratch if that check fails or if `fetch`/`reset` itself
  fails, rather than getting stuck retrying the same broken clone on
  every future launch.
- On timeout, the whole process group is killed (not just git's own
  pid) so its smart-HTTP transport helper can't keep running and
  writing into `.git` after the parent looks like it's gone.
- Because `fetch` / `reset --hard` / `clean -fd` are separate git
  calls, the chokidar watcher can see (and rescan on) a
  briefly-inconsistent halfway state mid-sync; the existing 500ms
  debounce absorbs this in practice, but it's not a hard guarantee.
- Only public HTTPS repos are supported for now; no auth is wired up.
- Changing "Git Repository:"/"Branch:" in the Settings dialog requires
  an app restart to take effect (see "Data directory resolution"
  above) — this is the one settings change that isn't live, unlike
  `availablePrinters`/`hideUnavailable`.
- Destructive Tools-menu tasks (currently just Cleanup profile) must
  call `assertGuestAccount()` from `tools.js` before touching any
  files — it hard-codes the guest account's home folder
  (`/Users/user`) and refuses to run if `os.homedir()` doesn't match,
  since these laptops have no other signal distinguishing a guest
  session from a real one.
- "Add items to Print Catalog…" needs `scripts/provision-sync-token.sh`
  run once per laptop (by an actual admin, via `sudo`) before it can
  push anything — without that root-owned token file in place,
  `tokenStore.js`'s `readSyncToken()` will always fail (surfaced as an
  ordinary error dialog, same as any other push failure, not a crash).

## Not yet implemented

- Full GUI for adding new models: "Add items to Print Catalog…" exists
  now (see `gitPush.js`/`tokenStore.js` above) but only as a bones-only
  first slice — no category-assignment UI (everything lands under a
  hard-coded "New Items" placeholder), no image/print-file
  reconciliation, no `metadata.json`, no multi-item staging queue. Item
  folders are still copied in as-is and rely on filename parsing for
  everything.
- Tag-based filtering beyond the current category + keyword combo
  (category may eventually be replaced by tags entirely)
- App packaging (electron-builder / Forge) — needed for a real Dock
  icon name, among other things. Also needs to bundle `bin/bgcode`
  (see `bgcodeCli.js`) via `extraResources` — `bgcodeCliPath()`
  already branches on `app.isPackaged` for this, but it's untested
  until packaging actually exists.
- Auth for private git *repo reads* — `gitSync.js`'s clone/fetch is
  still public-HTTPS-only, unauthenticated. Push auth (a token, gated
  behind admin privilege escalation) now exists for the "Add items"
  flow specifically — see `tokenStore.js` above — but that's a
  separate, one-directional credential path, not general repo auth.
