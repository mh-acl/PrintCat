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
  `editSession.js`, `itemMetadata.js`, `originLocation.js`, `syncState.js`,
  `tools.js`, `usbWiperWindow.js`
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
`createWindow()` also installs a `setWindowOpenHandler()` (denies any
`target="_blank"`/`window.open()` request from the renderer -- the
item detail view's "View original"/creator links (see renderer.js's
`renderOriginInfo()`) are the only current user of that -- and hands
the URL to `shell.openExternal()` instead, so it opens in the
co-admin's actual default browser rather than either being silently
blocked or opening a bare in-app `BrowserWindow`, which is Electron's
default behavior for `target="_blank"` otherwise) plus a
`will-navigate` guard doing the same for the main window itself,
skipping `file://` URLs so normal in-app loads/reloads aren't affected.
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
`usbWiperWindow.js`'s `openUsbWiperWindow(settingsStore)`. It doesn't fit the
confirm-dialog → `run()` → result-dialog shape because it opens a
persistent window with its own session state rather than running once and
reporting a result — see `usbWiperWindow.js` below.

**Edit Print Catalog…**, also wired directly in `buildMenu()`, to
`enterEditSession()` (also in `main.js`). This supersedes the earlier
bones-only "Add items to Print Catalog…" — rather than one folder in,
one push out, the *main catalog screen itself* doubles as an editing
UI (see `renderer.js`'s `editModeActive` below): a co-admin can add,
edit, and delete any number of items, reviewed together, before a
single push covers everything. `enterEditSession()` just checks
`gitRepoUrl` is configured, creates an `EditSession` (`editSession.js`)
if one doesn't already exist, and tells the renderer to flip into
edit mode (`'editSession:entered'`) — the actual folder-picking,
staging, and confirm/cancel push all happen through the
`editSession:*` IPC handlers below, driven from that UI.

**`editSession.js`** — `EditSession` tracks one co-admin's in-progress
changes, keyed by item folder path: `{ type: 'add'|'edit'|'delete', name }`,
used purely for the UI's badges/borders/bottom-bar counts. `addItem()`
copies a folder in directly under `DATA_DIR` and writes its
`metadata.json` (`itemMetadata.js`) with the entered name/tags/image
assignments; `editItem()` only rewrites `metadata.json` — categories
are gone (see "Category elimination" below), so an edit never moves
the item's folder anymore, `itemPath` in equals `itemPath` out.
`deleteItem()` only *marks* an
item for deletion — the real removal is deferred to `confirm()`, so a
trashed item stays visible (greyed out) and undoable via
`undoDelete()` right up until the session is pushed. An item added
earlier in the same session that's then edited or deleted stays tagged
`'add'`/gets removed outright rather than ever showing as `'edit'`/a
separate delete entry, since it doesn't exist in the last pushed
commit either way.

`scanSourceFolder(sourceDir)` supports the 'add' editor before
anything's copied into `DATA_DIR` yet: lists the picked folder's print
files (with `colorChangeCount`, reusing `gcodeParser.js`'s
`parseFilename()`/`parseGcodeMetadata()` directly rather than going
through `indexer.js`'s cache, since these files aren't part of the
catalog tree yet) and images, so the editor has real data to show
instead of nothing.

`addItem()`/`editItem()` both accept an optional `printFileImages`
(`{ [printFileBasename]: ImageRef[] }`) and pass it to
`_resolveImages()`, which is where images actually get assigned: each
`ImageRef` is either `{ kind: 'existing', name }` (already a file in
the item's folder) or `{ kind: 'external', path }` (picked via the
editor's "Browse for images" button, sitting anywhere on disk).
External refs get copied into the destination folder here — exactly
once per distinct source path even if the same image is shared across
several print files (the many-to-many case from prior design
discussion), with `uniqueDestName()` resolving any filename collision
— and the result becomes `metadata.json`'s `printFiles` block via
`writeItemMetadata()`. Nothing is copied or written until `Save` in
the editor is clicked; browsing for images only stages picked paths in
the renderer's local state (see `renderer.js`'s `openItemEditor()`
below), so canceling the editor still means nothing touched disk.

`cancel()` doesn't need to manually reverse each operation: nothing
gets committed to git during a session, so every add/edit so far is
just uncommitted working-tree state in `DATA_DIR` — `git checkout --
.` + `git clean -fd` (reusing `gitSync.js`'s `run()`) restores
everything to the last push in one step, regardless of how many
operations led up to it. `confirm()` performs the real deletes for
anything marked, then builds a commit message listing every
added/edited/deleted item by name; `main.js`'s
`editSession:confirmSession` handler takes that message, gets a token
(`getOrProvisionToken()`, the same inline-provisioning path the old
flow used), and calls `gitPush.js`'s `pushNewItem()` — unchanged from
before, since its resilience (postBuffer, spurious-disconnect
verification, HTTP/1.1 retry) applies just as well to a multi-item
commit as a single-item one. On push failure the session is left
active (nothing's cleared) so a retry after fixing the underlying
issue just works, the same way retrying `pushNewItem()` always has.

**`itemMetadata.js`** — `readItemMetadata()`/`writeItemMetadata()` for
an item's sibling `metadata.json` (schema per prior design
discussion). `indexer.js`'s `_buildItem()` calls `readItemMetadata()`
and uses its `displayName`/`tags` when present, falling back to
`folderName.js`'s filename-derived name (and empty tags) exactly as
before when a folder has no `metadata.json` yet — and now also merges
each print file's `printFiles[name].images` onto that file's entry as
`metadataImages` (a shallow copy, not mutating the gcode-parse cache —
that cache is keyed off the gcode file's own mtime/size and has no
idea `metadata.json` even exists, so baking this in directly would
freeze a stale snapshot into the persisted cache instead of reflecting
`metadata.json`'s actual current content on every scan).
`writeItemMetadata()` now accepts an optional `printFiles` map and
merges each entry onto whatever that print file's block already held,
rather than replacing it outright — so a future per-file
`displayName`/`tags` override (still not produced by this app) won't
get clobbered by an images-only write. `item.tags` is now the sole
pill-based grouping/filtering concept in `renderer.js` — see "Category
elimination" below.

**`renderer.js`'s `openItemEditor()`** (image reconciliation) — per
print file: a checkbox (bulk-assign target), a `printFileLabel()` note
(color-change count and batch size — see below — help tell similar
prints, especially batch variants, apart at a glance), and chips for
its currently assigned images (each removable).
Below that, an "Available images" pool — every image usable by this
item, existing-in-folder or freshly browsed-in/dropped-in, deliberately
*not* filtered down as things get assigned, since one image assigned to
several print files (the many-to-many case) is the point.

Assigning works two ways: click a pool image to select it, check one
or more print files, "Assign selected image to checked files" — or
drag a pool thumbnail (`draggable`, `dragstart` sets its index as
`text/plain`) directly onto a print file row, which reads that index
back on `drop` and assigns it (scenario 3 from prior design
discussion). Dropping an image file from the OS directly onto a print
file row instead (no `dataTransfer.files` vs. the in-app case is how
`ondrop` tells these two apart) both adds it to the pool *and* assigns
it to that row in one gesture (the "perhaps" from that same
discussion, now real); dropping onto the pool area itself just adds it
without assigning anywhere. `assignRefToFile()`/`addExternalToPool()`
are the shared helpers behind all of these paths (button, drag, and
drop) so they behave identically regardless of which gesture triggered
them. "Browse for images…" (`editSessionBrowseImages()`, a native
multi-select file dialog) is the fourth, non-drag path to the same
`addExternalToPool()`. None of these copy anything yet — pool entries
for anything not already in the folder are `{ kind: 'external', path }`
refs, and only become real files in the item's folder if `Save` is
clicked (see `editSession.js`'s `_resolveImages()` above).

`printFileLabel()` builds that per-row note: `"0 color changes"` (the
common case) and `"1 in batch"` (not actually a batch) are both
suppressed as noise, so a count only shows up when it's actually
informative — which is exactly the same signal `suggestBatchShare()`
below uses to spot variants.

Assigning an image (any of the four ways above) also runs
`suggestBatchShare()`: if another print file in the same item has the
same `colorChangeCount` and its name matches after `strippedBatchName()`
strips the `.printer.gcode`/`.bgcode` segment and a trailing batch/
quantity suffix (`-batch6`, `x6`, etc.) — the exact heuristic from
prior design discussion — a plain `confirm()` offers to share the same
image with it too, rather than auto-assigning silently. 'add' mode
shows all of this only once the source folder is known — either
`editSessionPickAddFolder()` (the "Add item" button) or
`editSessionPrepareAddFolder()` (a folder dropped on the main window,
see below) — via `EditSession.scanSourceFolder()`, same as the rest of
the form.

A folder dropped directly onto the main window while `editModeActive`
is a fourth drag-and-drop scenario, separate from the three above and
handled at the document level rather than inside the editor:
`renderer.js` registers one `dragover`/`drop` pair on `document` itself
(prevents Chromium's default "navigate to the dropped file" behavior
unconditionally, everywhere, then — only in edit mode, and only when
no editor/dialog overlay is already open — treats the drop as
`openItemEditor('add', null, sourceDir)`, using
`webUtils.getPathForFile()` via `preload.js`'s `getPathForFile()` to
get a real path from the dropped `File`). `main.js`'s
`prepareAddFolder()` (used by both `editSession:pickAddFolder` and the
new `editSession:prepareAddFolder`) checks the dropped path is actually
a directory before scanning it, surfacing a plain error otherwise
rather than trying to treat a stray dropped file as an item folder.
The editor's own row/pool drop handlers `stopPropagation()` so a drop
that lands on one of them never also reaches this document-level
handler.

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
staged — e.g. a re-run after an item was already synced. Used
identically by `editSession.js`'s multi-change commits as it was by
the old single-item flow — nothing about this function changed.

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
re-syncs from origin) and retry. (Multi-laptop conflicts from two
co-admins editing at once are handled socially, not technically — only
four people have edit access and they coordinate directly, so no
merge/rebase UI is planned here.)

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
lost/wiped laptop can only compromise this one repo. `main.js`'s
`getOrProvisionToken()` wraps `tokenExists()`/`readSyncToken()`/
`writeSyncToken()` into the single "get me a usable token, provisioning
inline if needed" call both the old and new push flows use.

**`provisionTokenWindow.js`** — `promptForToken(parentWindow)`: a small
modal `BrowserWindow` (`provisionTokenWindow.html` /
`provisionTokenRenderer.js` / `provisionTokenPreload.js`) with a single
password-style text field, used the first time a push is attempted on
a laptop where `tokenStore.js`'s `tokenExists()` is false — folds
first-time-per-laptop setup into the push attempt itself rather than
requiring a separate command to be run first. Resolves with the entered
token (trimmed, non-empty) or `null` if cancelled/closed without
submitting. This window deliberately has no gating of its own beyond
the text field — the real gate is the OS admin-auth prompt
`writeSyncToken()` pops immediately after this resolves, so there's
nothing this dialog itself needs to protect against; anyone can open
it and paste something in, but only someone who can satisfy that OS
prompt gets it actually written to disk. `scripts/provision-sync-token.sh`
still exists alongside this — useful for scripting setup across many
laptops at once without opening the app on each one.

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
`openUsbWiperWindow(settingsStore)` takes the same `SettingsStore`
instance `main.js` owns (passed from its `buildMenu()` click handler)
and keeps a module-level reference to it, backing this window's own
`usb-wiper:get-rename-settings` / `usb-wiper:save-rename-settings`
IPC handlers as well as the wipe cycle itself: if `renameDrives` is
on, each volume is renamed via `drives.renameVolume(mountPoint,
driveRenameName)` right after wiping and before eject (while
`mountPoint` is still valid); a rename failure is logged and
swallowed rather than surfaced as a cycle error, since renaming is a
bonus on top of the wipe, not part of what makes the drive safe to
hand off.

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
repo/branch settings change — see `main.js` above), plus the
`editSession*` methods described with `editSession.js` below.
`getPathForFile(file)` wraps Electron's `webUtils.getPathForFile` —
the only supported way to get a real filesystem path back from a
dropped `File` object with `contextIsolation: true`, so it has to be
called from here rather than directly in `renderer.js`.

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
gcode/bgcode files directly *is* an item — no category concept exists
anymore (see "Category elimination" below); the recursion is only
there to tolerate not-yet-flattened leftover folders, not to derive
anything from them. Parses each print file via `gcodeParser`, caching
results to disk (`catalog-cache.json`) keyed by path + mtime + size.
`CACHE_VERSION` must be bumped whenever a parsing logic change should
invalidate already-cached entries, or whenever file paths are about to
shift wholesale (e.g. the category-elimination flatten), since cache
entries are keyed by absolute path.
Item shape: `{ type, name, displayName, path, explicitThumb, imageFiles, projectFiles, tags, files[] }`.
File-entry shape: `{ path, mtimeMs, size, shortname, longname, tags, printerModel, printerVariant, printTime, filamentType, filamentUsedG, hasEmbeddedThumbnail, colorChangeCount, copies, pauseCount, pauseMessages }`.
`filamentType` is the raw `filament_type` value straight from the gcode's
own metadata (`values`, populated identically by both `gcodeParser.js` and
`bgcodeParser.js` -- confirmed against a real `.bgcode` file, no
format-specific translation needed) -- a single-material print gets a bare
string like `"PLA"`, a multi-material one gets a comma-separated list like
`"PLA,PETG"` (one entry per tool). Collapsing/deduping for display (so
`"PLA,PLA"` shows as `"PLA"` and `"PLA,PETG"` shows as `"PLA/PETG"`) is a
renderer-only concern -- see `renderer.js`'s `formatFilamentTypes()` below
-- so the cached value stays raw and display formatting can change later
without a re-scan. `filamentUsedG` comes from the `"total filament used
[g]"` key specifically (the whole-print total across every copy/tool), not
the per-object `"filament used [g]"` key that also exists in the same
metadata; there's no equivalent `"total ... [mm]"` figure, so filament
length isn't tracked, only weight.
`colorChangeCount`/`copies`/`pauseCount` are auto-detected (M600 count / M486
batch-object count / M601 count, `copies` defaulting to 1 when no batch is
detected) — see `gcodeParser.js` / `bgcodeParser.js` below. `pauseMessages`
is an array the same length as `pauseCount`, one entry per pause holding
whatever M117 status message immediately preceded that M601 (`null` where
there wasn't one). For `.bgcode` files, `colorChangeCount`/`copies`/
`pauseCount` can each come back `null` (undetectable) rather than a number
(and `pauseMessages` `null` too, in that case); that's distinct from
0/1/none and should be treated as "unknown" in the UI, not "none". Bumping
`CACHE_VERSION` (currently 9, bumped from 8 when `filamentType`/
`filamentUsedG` were added to the cached entry shape) is
required whenever a change like this alters
what gets cached per file, so already-cached entries get reparsed instead of
silently missing the new field.

**`gcodeParser.js`** — Two jobs: (1) filename parsing, supporting both
the legacy `Name (tags)[printer]_uniqueid.ext` convention and the newer
`name.printer.ext` convention, returning `{ shortname, longname, tags }`
either way; (2) `parseGcodeMetadata(filePath)`, which dispatches by
extension to either the streaming text-gcode `"; key = value"` comment
parser or to `bgcodeParser.js` for `.bgcode`. Both paths return the
same `{ values, thumbnailBase64, thumbnailMimeType, colorChangeCount,
copies, pauseCount, pauseMessages }` shape (the last four via
`gcodeCommandScan.js`, fed every non-comment line as it streams).
`thumbnailMimeType` is `'image/png'` whenever `thumbnailBase64` is set
for text-gcode (the `thumbnail begin/end` convention is PNG-only) and
either `'image/png'`/`'image/jpeg'` for `.bgcode` (see below); `null`
when there's no thumbnail. `thumbnailResolver.js` uses it to pick a
matching cache-file extension rather than assuming PNG. Printer
identity always comes from embedded gcode metadata, never from the
filename.

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
explicit `metadata.json` image assignment (`fileEntry.metadataImages[0]`,
set via the item editor — see `editSession.js`/`itemMetadata.js`) wins
first, since it's what the co-admin actually chose and should behave
predictably regardless of filenames; only when that's empty does it
fall through to the old filename-convention chain (an override image
in the item folder matching the file's longname, then shortname), then
its own embedded gcode thumbnail (extracted + cached on demand), then
nothing. An item with no `metadata.json` image assignments yet behaves
exactly as before this existed. Item-level thumbnail: an explicit
`thumb.*` file, else the first print file that resolves to a real
thumbnail.
When extracting an embedded gcode thumbnail, the cache file's
extension (`.png`/`.jpg`) is picked from `parseGcodeMetadata()`'s
`thumbnailMimeType`, via an `EXT_BY_MIME` map, rather than assumed to
always be `.png` — a `.bgcode` file's largest embedded thumbnail can
be either PNG or JPG (see `bgcodeParser.js`'s
`THUMBNAIL_MIME_BY_FORMAT`). Since the cache key alone (path+mtime)
doesn't record which extension a prior write used, a cache lookup
checks both possible extensions before falling back to re-parsing the
source file.

**`settings.js`** — `SettingsStore`: persisted admin config
(`{ availablePrinters: [], hideUnavailable: bool, gitRepoUrl: '',
gitBranch: '', renameDrives: bool, driveRenameName: '' }`) in
`userData/settings.json`. `gitRepoUrl`/`gitBranch`
replace the old `PRINTCAT_GIT_REPO_URL`/`PRINTCAT_GIT_BRANCH` env vars
and are set via the Settings dialog's "Git Repository:"/"Branch:"
fields; an empty `gitBranch` defaults to `'main'` wherever it's
consumed (`gitSync.js`, `main.js`), not stored as `'main'` here.
`renameDrives`/`driveRenameName` back the USB Wiper's "Rename drive
to:" checkbox + text field (see `usbWiperWindow.js`) — set/read via
that window's own `usb-wiper:get-rename-settings` /
`usb-wiper:save-rename-settings` IPC handlers rather than the general
`settings:get`/`settings:save` ones, since those live in a separate
preload/renderer context (`usbWiperPreload.js`/`usbWiperRenderer.js`)
from the main window's Settings dialog; both handlers merge onto
`settingsStore.get()` before saving, since `SettingsStore.save()`
itself replaces wholesale rather than patching. Distinct from the
user's own per-session printer filter selection in the renderer.

**`drives.js`** — macOS-only. Shells out to `diskutil`/`plutil` to
list, eject, and check presence of external physical USB drives,
deliberately avoiding a native Node module (`drivelist` etc.) to sidestep
an Electron-rebuild toolchain on the makerspace's older loaner laptops.
Also exports `wipeDriveContents(mountPoint)` (added for the USB Wiper
tool — see `usbWiperWindow.js`): deletes everything inside a mounted
volume, including dotfiles, leaving the volume itself mounted so it can
still be ejected afterward; returns `{ failures: [{ path, error }] }` for
anything that couldn't be removed instead of throwing, same
partial-failure shape as `tools.js`'s Cleanup profile. As its last step
(after the delete loop, so it survives it), it also writes an empty
regular file named `.Trashes` at the volume root — this blocks macOS
from creating its own `.Trashes/<uid>` folder there, so Finder can't
silently move later deletions into a hidden trash on the drive and
instead prompts to delete immediately. Also exports
`renameVolume(mountPoint, name)` (also for the USB Wiper tool, its
"Rename drive to:" option): a thin wrapper over `diskutil rename`,
which accepts a mount point in place of a volume's current name, so
`usbWiperWindow.js` doesn't need to separately track each volume's
(possibly-just-wiped) display name. First checks the volume's
filesystem via `diskutil info` (`FilesystemType`); for FAT12/16/32
(`"msdos"` — `FilesystemType` doesn't distinguish the three, only
`FilesystemName` does) the requested name is adapted to that
filesystem's 11-character, uppercase-only, letters/digits/spaces-only
label space (`sanitizeFatLabel`) before being applied — exFAT and macOS's
own filesystems aren't touched.

**`renderer.js`** — All UI logic, no framework. Global state:
`allItems`, `selectedItem`, `selectedPrinters`, `selectedTags`,
`keywordQuery`, `settings`. Flat browsing model — no navigation or
breadcrumbs, no categories. Three filters combine on a single flat item grid: Printer
pills (multi-select), Tag pills (**single-select**, from `item.tags`
— clicking a tag pill replaces `selectedTags` with just that one tag
rather than adding to it; clicking the already-active tag clears back
to "All Tags". Changed from multi-select OR after user testing showed
people expected a tag click to switch categories, not narrow further.
`selectedTags` is still a `Set` under the hood so `itemMatchesTags()`'s
OR-match logic needed no change — it just never holds more than one
entry now), and a live keyword search box (AND-match across item name + each file's
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
`#tag-filter` containers (fully regenerated on each relevant
state change), `#listing`, and a `#sync-status` footer note (see
`renderer.js` above; styled via a `.sync-status` rule). `.pause-tooltip-icon`
(also from `renderer.js`, see above) is likewise styled (cursor-help
treatment).
**Known leftover:** `styles.css` still has a `#printer-filter,
#category-filter { ... }` rule (plus a standalone `#category-filter`
margin override) from before the category-elimination rename —
`index.html`/`renderer.js` both use `#tag-filter` now, so the tag pill
row currently gets none of that layout (no flex-wrap/gap/centering).
Needs `#category-filter` renamed to `#tag-filter` in `styles.css`.

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
- If `settings.gitRepoUrl` is not set, `resolveDataDir()` is never
  reached at all: `main.js`'s `whenReady()` skips `setupIndexer()`
  entirely and instead opens the Settings dialog in "required" mode
  (see "First-launch required setup" below) — there is currently no
  supported no-git / local-copy dev workflow. (`resolveDataDir()`
  itself still has an unreachable fallback to the old
  `PRINTCAT_DATA_DIR` env var / dev-time default path, left over from
  before required-setup gating existed — flagged as dead code, not yet
  removed.)
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

## First-launch required setup

- When `settings.gitRepoUrl` is empty (a laptop that's never been
  pointed at a catalog repo), `main.js`'s `whenReady()` skips
  `setupIndexer()` entirely — no indexer, tree, or sync status to
  fetch — and instead sends `menu:openSettings` with `{ required: true }`.
- `renderer.js`'s `openSettingsDialog(opts)` has a parallel `required`
  branch for this: different title/intro copy ("Set Up Print
  Catalog…"), the printer checkboxes and Hide-unavailable row are
  skipped (`allItems` is always `[]` at this point, so there's nothing
  to derive a printer list from), and there's no Cancel button — the
  dialog can only be dismissed by entering a repo URL and saving.
  Saving without one is rejected with an alert rather than silently
  closing, since that would just land back on the same dialog next
  launch.
- On a successful save in required mode, the renderer calls
  `relaunch()` directly (no "restart now?" confirm — there's nothing
  else to show until the app comes back up with an indexer against the
  new repo).
- `init()` in `renderer.js` registers the `onOpenSettings` listener
  before doing anything else (see its own comment on load-order), and
  short-circuits its own startup (`getTree()`/`getSyncStatus()` etc.)
  when `settings.gitRepoUrl` is empty, relying on that listener to
  eventually show the required-setup dialog once `main.js`'s push
  arrives.

## Key conventions / gotchas

- Categories are gone entirely (see "Category elimination" below) —
  `item.tags` (from `metadata.json`) is the only pill-based
  grouping/filtering concept left, and it's multi-valued per item.
- Two supported filename conventions; printer identity is never parsed
  from the filename.
- `CACHE_VERSION` (in `indexer.js`) must be bumped when parsing logic
  changes in a way that would produce different output for files
  already cached, or when file paths are about to shift wholesale
  (e.g. a data-repo restructure) since cache entries are keyed by path.
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
  and the keyword query (`fileMatchesKeywordInItem`) — tags are a
  property of the item as a whole, already decided by the time you
  clicked into it, so they're never re-checked per file. Because of that,
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
- "Edit Print Catalog…" needs `scripts/provision-sync-token.sh`
  run once per laptop (by an actual admin, via `sudo`) before it can
  push anything — without that root-owned token file in place,
  `tokenStore.js`'s `readSyncToken()` will always fail (surfaced as an
  ordinary error dialog, same as any other push failure, not a crash).

## Category elimination

Categories (folder-placement-derived, one per item) have been removed
from the app in favor of `item.tags` (multi-valued, from
`metadata.json`) as the sole pill-based grouping/filtering concept —
`indexer.js` no longer derives or returns a `category` field,
`editSession.js` no longer moves an item's folder on edit, and
`renderer.js`'s filter row and item editor are tag-only now.

This is a two-part migration, done deliberately out of order:

1. **App code** (this pass) — category logic removed entirely.
   `indexer.js`'s directory walk stays recursive rather than requiring
   a strict single level, so it tolerates a data folder that hasn't
   been physically flattened yet (any leftover grouping folder is just
   walked through, contributing no category/grouping information).
2. **Data repo** (separate, manual step, on its own branch of the
   catalog data repo so other installs still on category-based data
   aren't affected until cutover) — physically move every item folder
   up to the data root and delete the now-empty former category
   folders. Because category was never stored in `metadata.json`
   itself, this is a pure filesystem restructure — no metadata schema
   change, no data transformation.

Still open, deliberately deferred past this pass:

- **Folder-name uniqueness.** Item folder names are still preserved
  verbatim from the Thingiverse/Printables download (no uniqueness
  suffix added by `addItem()` yet). Fine at the current catalog size;
  flagged as a future need once categories stop namespacing folder
  names from each other. Each item's README.txt (from the original
  download) carries the source ID in an easily-parsed format, so
  there's no need to keep parsing it out of the folder name itself —
  a future "view original" link and any folder-renaming-for-uniqueness
  work are both unblocked by that.
- **App/data-branch pairing during rollout.** Still in beta, installed
  on only a couple of machines, with one person (not yet co-admins)
  making edits — so this is being handled by upgrading and starting
  fresh on those few machines rather than needing an automated
  version/format check.

## Original item location

Item folders are preserved as-is from their original Thingiverse/
Printables download specifically so files like these could be parsed
later for a "view original" link (see "Category elimination" above) --
this is that pass.

**`originLocation.js`** — `detectOrigin(folderPath, entries?)`:
best-effort, fully offline (no network requests) detection of the
source page, returning `null` when nothing can be determined, or
`{ url, creatorName, creatorUrl }` when something is (creator fields
are `undefined` where not extracted). Two schemas: a top-level
`README.txt` containing Thingiverse's exact line `"{name} by
{username} on Thingiverse: {url}"` (`THINGIVERSE_LINE_RE`) — captures
`url` and the username together in one regex, anchored on the fixed
` on Thingiverse:` text; the username capture is greedy so that if the
item name itself happens to contain " by " (e.g. "Standby Bracket"),
the match still lands on the *last* " by " before " on Thingiverse:",
which is always the right split. `creatorUrl` is then constructed
directly from the username (`https://www.thingiverse.com/{username}`)
rather than needing a second parse. If a README doesn't match that
exact shape (hand-edited, or an older export format), falls back to
the old URL-only regex so the folder still gets `url` detected, just
without creator info. Or a top-level PDF named like
`{model-slug}-{digits}-{hex groups}.pdf` (a browser print-to-PDF of a
Printables model page) — read via `pdf-lib` for its link annotations.
There can be more than one top-level PDF (e.g. a user-added
instructions sheet); each candidate matching the naming pattern is
tried until one yields a link matching
`https://www.printables.com/model/...` specifically
(`PRINTABLES_MODEL_URL_RE`) — confirmed against a real sample PDF that
a bare "contains printables.com" check isn't enough: these PDFs' link
annotations list the creator's profile link (from the byline) *before*
the actual model link, and also carry `.../model?categoryId=N` links
further down, both of which need excluding. That creator-profile link
(matched by `PRINTABLES_CREATOR_URL_RE`, path `/@{username}`) is
captured in the same annotation walk rather than just skipped past —
`detectPrintablesOrigin()` remembers the first one seen and, once it
also finds the `/model/` link, returns both together as
`creatorUrl`/`creatorName` alongside `url`. If no candidate yields a
`/model/` link at all, falls back to reconstructing
`https://www.printables.com/model/{model-slug}` from the first
candidate's filename — an unverified guess with no creator info
(the PDF was never actually parsed successfully). New dependency:
`pdf-lib` (`npm install pdf-lib`) — its exact call sequence
(`PDFArray`/`PDFDict.lookup()`, `PDFName`, `.decodeText()`) still
hasn't been run end-to-end in Node (no network access to install the
package in this environment), though the annotation structure it reads
has been confirmed correct by inspecting a real sample's link
annotations directly.

Detection is deliberately *not* run by `indexer.js` on every catalog
scan (that would mean re-parsing a PDF on every background rescan for
any item without a stored origin yet) — it only runs on-demand, from
`editSession.js`:
- `scanSourceFolder(sourceDir)` (used by the 'add' editor) now also
  returns `origin` (the whole detected object, not just a URL string),
  reusing the same `readdir` it already does for print files/images.
- A `detectOrigin(itemPath)` method (used by the 'edit' editor,
  whenever the item's `metadata.json` doesn't already have
  `creatorName` — including items that already have an `origin.url`
  but were catalogued before creator extraction existed) wraps the
  module's `detectOrigin()` directly (imported under the alias
  `detectOriginInFolder` to avoid shadowing the method's own name).

**Schema** — `metadata.json` gains an optional `origin` object:
`{ url, creatorName, creatorUrl }`. `url`, `creatorName`, and
`creatorUrl` are now all populated by detection for both known
schemas (Thingiverse and Printables). `itemMetadata.js`'s
`writeItemMetadata()` shallow-merges `origin` onto whatever's already
stored (same reasoning as its `printFiles` merge) rather than
replacing it outright, so a plain "edit the URL field, leave
everything else alone" save can't wipe out creator info from an
earlier detection. The whole `origin` key is omitted from the written
file when none of its three fields hold a truthy value. `indexer.js`'s
`_buildItem()` exposes it as `item.origin` (`null` if absent),
read-only from `metadata.json` (never auto-detected at scan time — see
above).

**Editor UI** (`renderer.js`'s `openItemEditor()`) — a new "Original
Location" text field, right after Tags: plain, editable, clearable,
same as Name/Tags. 'add' mode prefills it from `scanSourceFolder()`'s
`origin.url`; 'edit' mode prefills from the item's stored `origin.url`
if present, and separately fires `detectItemOrigin(item.path)` (async,
best-effort) whenever the item's stored origin lacks `creatorName` —
regardless of whether `origin.url` is already present — so items
catalogued before creator extraction existed get picked back up rather
than staying permanently stuck. That re-detect only overwrites the
visible field if it was empty to begin with (an item with its own
stored `url` keeps showing that value even if re-detection returns a
differently-formatted one). Either path also stashes the detected
`{ url, creatorName, creatorUrl }` object in a closure-local
`detectedOrigin` (`null` if nothing was ever (re-)detected this
session). On Save, the field's current value is compared against
`detectedOrigin.url`: if they still match, `creatorName`/`creatorUrl`
(whichever are present) are included alongside `url` in the payload; if
the co-admin has typed
over the auto-filled/guessed link, only `{ url }` is sent, so a
now-unrelated URL doesn't get paired with a stale creator credit — the
shallow merge on the `itemMetadata.js` side then leaves any
previously-stored creator info untouched rather than overwriting it
with nothing.

**Detail view** (`renderer.js`'s `renderItemDetail()`) — item detail
previously had no item-level heading at all (just the file rows); this
adds one (`item-detail-header`, an `<h2>` of the item's display name)
specifically to give the new "View original on {Thingiverse|
Printables} ↗" link (`renderOriginInfo()`) somewhere to live, shown
only when `item.origin.url` is set. The platform label is derived from
the URL's hostname (`originPlatformLabel()`) rather than stored
separately, so a manually-entered URL from some other site still gets
a sensible label (falls back to the bare hostname). Also renders
`creatorName`/`creatorUrl` when present — this was written ahead of
the data existing, and now that both Thingiverse and Printables
detection populate these fields, they show up here with no
display-side changes needed. `styles.css` doesn't have rules for
`.item-detail-header`/`.item-origin-info` yet.

**`main.js`/`preload.js`** — `prepareAddFolder()` now also forwards
`scanSourceFolder()`'s `origin` object through to the 'add' editor
(alongside `printFiles`/`imageFiles`, unchanged otherwise). A new
`editSession:detectOrigin` handler wraps `editSession.detectOrigin(itemPath)`
for 'edit' mode. `editSession:commitAdd`/`commitEdit` needed no change --
they already forward their whole `fields` object straight through to
`editSession.addItem()`/`editItem()`, so the new `origin` field riding
along in that object just works. `preload.js` exposes the new handler as
`detectItemOrigin(itemPath)`.

**Bulk backfill** — the on-demand re-detect above only catches an
existing item up when it's individually opened in the editor *and*
saved, which doesn't help a whole catalog of items added before
creator extraction existed. `editSession.js`'s `backfillOrigins(items)`
loops over the item array `indexer.scan()` already produces (passed in
by the caller, so this method stays ignorant of the folder-walk logic
that lives in `indexer.js`) and, for each item missing
`origin.creatorName`, runs the same `detectOrigin()` the single-item
path uses and writes the result straight to `metadata.json` via
`writeItemMetadata()` -- passing the item's own current
`displayName`/`tags` through explicitly, since those fields replace
rather than merge on write (see `itemMetadata.js`), so omitting them
would blank out any custom name/tags a co-admin had already set.
Three outcomes per item, none of them thrown as errors (one bad folder
shouldn't abort the whole batch): `updated` (written), `notFound`
(detection found nothing usable), and `mismatched` (the item already
has an `origin.url` on file that disagrees with what a fresh detection
finds -- left untouched rather than silently swapped, same caution the
single-item editor's save-time check applies, just surfaced as
"review manually" instead of quietly dropping the creator fields).
Each successful update is marked in `this.changes` exactly like a
normal `editItem()` edit, so it shows up in the edit-session bar's
counts and rides along in the eventual commit message when the session
is confirmed and pushed -- this is just a batched version of editing
each item by hand, not a separate mutation path.

A new `editSession:backfillOrigins` handler in `main.js` requires an
active edit session (guards with a clear error rather than throwing on
`editSession` being null, though in practice the renderer only shows
the button while one is active), fetches the current item list via
`indexer.scan()`, and returns `{ result, changes, tree }` -- `changes`
and `tree` refreshed the same way `commitAdd`/`commitEdit` already do,
so the renderer's `pendingChanges`/`allItems` state stays in sync
without a separate re-fetch. `preload.js` exposes it as
`backfillOrigins()`.

**Editor UI** — a "Backfill creator info" button next to "Add item" in
`renderEditBar()` (`.backfill-origins-button` in `styles.css`, styled
as a secondary/quieter action next to Add item's more prominent one).
Disables itself and shows "Backfilling…" while the (potentially
PDF-parsing-heavy) request is in flight, then reports counts via a
plain `alert()` -- including the mismatched items' names, so the
co-admin knows exactly which ones need a manual look in the item
editor. Safe to click repeatedly: items that already have
`creatorName` are skipped every time, so a second run is a no-op for
anything already caught up.

## Filament type + amount display

Print files now carry `filamentType` and `filamentUsedG` (see `indexer.js`
above for exactly which raw metadata keys these come from and why
`filamentUsedG` uses the "total" key rather than the per-object one).
`renderer.js`'s `renderItemDetail()` shows both as new lines in each print
file's metadata block, alongside the existing printer/print-time/color-
change/copies/pause lines: `Filament: <types>` and `<N>g filament used`,
both simply omitted when the underlying value is `null`.

`renderer.js`'s `formatFilamentTypes(raw)` (next to `printFileLabel()`)
collapses the raw comma-separated `filamentType` string for display:
splits on `,`, dedupes while preserving first-seen order, and joins with
`/` — so a multi-material print with two of the same filament reads as
`"PLA"` rather than `"PLA,PLA"`, while a genuine two-material print reads
as `"PLA/PETG"`. This is purely a display transform; the cached
`filamentType` field itself stays the raw, uncollapsed string.

## Thumbnail zoom (magnifying-glass lightbox)

Both catalog thumbnail spots — the item-grid card (`renderItemCard()`'s
`.thumb-slot`) and the item-detail print-file row (`renderItemDetail()`'s
new `.file-thumb-wrap`, which now wraps the `<img>` that used to sit
directly in `.file-row`) — get a small circular magnifying-glass button
overlaid via `renderer.js`'s `makeZoomButton(getSrc, altText)`, hidden by
default and faded in on hover (`.thumb-zoom-btn`, shown via
`:hover .thumb-zoom-btn` CSS rules). The button is only appended once the
thumbnail promise (`getItemThumbnail`/`getFileThumbnail`) resolves to a
real path — never for the `nothumb.svg` placeholder. `getSrc` is a
closure reading the `<img>`'s current `src` at click time (the button
itself is created before the thumbnail promise resolves), so clicking it
always opens whatever image is actually showing.

Clicking the button calls `renderer.js`'s `openImageLightbox(src, altText)`,
a generic full-size viewer: a `.image-lightbox-overlay` fullscreen dimmed
backdrop centering a `.image-lightbox-box` containing the image (capped to
90vw/90vh, `object-fit: contain`) and a circular `.image-lightbox-close`
(×) button. Dismissed via the close button, clicking the backdrop outside
the image, or Escape (a one-off `keydown` listener added on open and
removed on close). This is a new, separate modal pattern from the
existing `.drive-picker-overlay` ones — those all require an explicit
button click to dismiss, but a lightbox reads better with backdrop-click
and Escape support, so it got its own overlay/box CSS classes rather than
reusing `.drive-picker-overlay`.

## Not yet implemented

- GUI for adding/editing/deleting catalog items: "Edit Print Catalog…"
  and `editSession.js` (see above) now cover add, edit, delete, image
  reconciliation (assigning images to print files, including the
  many-to-many sharing case and the batch-variant suggestion), and drag-
  and-drop for all three scenarios from prior design discussion (a
  folder dropped on the main window in edit mode, images dropped onto
  the item editor, an image dropped directly onto a print file to
  pre-assign it) — see `renderer.js`'s document-level drop handler and
  `openItemEditor()`'s row/pool drop handlers, both described above.
  Still missing: per-print-file `displayName`/`tags` overrides (only
  item-level ones, plus per-file `images`, are read/written so far —
  see `itemMetadata.js`); a gallery view for a print file with more
  than one assigned image (only the first, `images[0]`, is used as the
  thumbnail today — see `thumbnailResolver.js`); tag-autocomplete
  against existing tags (plain comma-separated text for now, by
  design, for this pass); and any session-recovery story if the app
  closes mid-session (accepted as a real gap for now, not a bug — an
  abandoned session's uncommitted changes are simply discarded by the
  next launch's `syncCatalogRepo()` reset, and that's considered fine
  for four co-admins working in one space).
- App packaging (electron-builder / Forge) — needed for a real Dock
  icon name, among other things. Also needs to bundle `bin/bgcode`
  (see `bgcodeCli.js`) via `extraResources` — `bgcodeCliPath()`
  already branches on `app.isPackaged` for this, but it's untested
  until packaging actually exists.
- Auth for private git *repo reads* — `gitSync.js`'s clone/fetch is
  still public-HTTPS-only, unauthenticated. Push auth (a token, gated
  behind admin privilege escalation) exists for the editing flow
  specifically — see `tokenStore.js` above — but that's a separate,
  one-directional credential path, not general repo auth.
