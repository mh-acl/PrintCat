'use strict';

// Entry point: init() (registers IPC listeners, kicks off first catalog
// load) plus top-level wiring (whole-window drag/drop for folder-based
// add-item). Loads LAST of all renderer scripts -- it's the only file
// with top-level code that runs immediately (the drag/drop listener
// registration and the init() call at the bottom), so every function it
// references must already be defined as a global by the time this runs.

async function init() {
  // Registered before any await so this is listening synchronously
  // during initial script execution -- main.js sends 'menu:openSettings'
  // once the window's did-finish-load fires, which can't happen until
  // after this script has finished evaluating, but an await here would
  // leave a window where the message could arrive before we're
  // listening for it.
  window.catalogAPI.onOpenSettings((payload) => openSettingsDialog(payload || {}));
  window.catalogAPI.onEditSessionEntered(() => {
    editModeActive = true;
    pendingChanges = {};
    selectedSmartTags = new Set();
    renderTagFilter();
    render();
    // If an item's view-mode modal is currently open, flip it to edit
    // mode in place rather than leaving it stranded in view mode --
    // per prior design discussion, entering edit mode while viewing an
    // item should behave the same as entering edit mode from the main
    // grid and then clicking that item to edit it.
    if (openModalHandle) openModalHandle.switchToEdit();
  });

  settings = await window.catalogAPI.getSettings();

  if (!settings.gitRepoUrl) {
    // main.js skips setupIndexer entirely when no repo is configured
    // yet (see resolveDataDir()) -- there's no indexer/tree/sync state
    // to fetch, so don't call those APIs. The listener above will pick
    // up main.js's required-setup push once it arrives.
    return;
  }

  allItems = await window.catalogAPI.getTree();
  applyDefaultPrinterFilter();

  syncStatus = await window.catalogAPI.getSyncStatus();
  renderSyncStatus();
  window.catalogAPI.onSyncStatusChanged((status) => {
    syncStatus = status;
    renderSyncStatus();
  });
  // syncStatus itself only changes when main.js pushes an update (sync
  // started/finished), but the "X minutes ago" text it displays goes
  // stale on its own -- re-render periodically just to tick that
  // forward even when nothing else has changed.
  setInterval(renderSyncStatus, 30 * 1000);

  // Manual refresh -- main.js's handler already no-ops if a sync is
  // already in flight and broadcasts sync:statusChanged as it
  // starts/finishes, so this button doesn't need to track its own
  // pending state; renderSyncStatus() (driven by that broadcast)
  // already disables it and shows the spin while one's running.
  document.getElementById('refresh-now-btn').addEventListener('click', () => {
    window.catalogAPI.refreshCatalogNow();
  });

  window.catalogAPI.onCatalogUpdated((newItems) => {
    allItems = newItems;
    renderPrinterFilter();
    renderTagFilter();
    render();
  });

  // The search box is a static element (see index.html), never
  // recreated by render() -- unlike the filter pills, it holds live
  // text-input focus and a cursor position that rebuilding the node
  // every keystroke would destroy.
  document.getElementById('keyword-filter').addEventListener('input', onKeywordInput);

  renderPrinterFilter();
  renderTagFilter();
  render();
}

// Chromium's default behavior for an unhandled drop is to navigate the
// window to the dropped file, which would break the app -- prevent
// that unconditionally, everywhere, then separately opt in to the one
// drop behavior the main window itself cares about (see below). The
// item editor's own pool/row drop handlers stopPropagation() so this
// never double-handles a drop that already landed on one of those.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!editModeActive) return;
  if (document.querySelector('.drive-picker-overlay')) return; // editor/settings open -- its own handlers own this drop
  const files = e.dataTransfer.files;
  if (!files || files.length === 0) return;
  const sourceDir = window.catalogAPI.getPathForFile(files[0]);
  openItemModal(null, 'add', sourceDir);
});

init();