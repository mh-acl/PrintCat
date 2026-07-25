'use strict';

// Flat filtering UI: no navigation, no breadcrumbs. Two independent
// multi-select filter rows (Printers, Categories) narrow down a single
// flat grid of items; clicking an item shows its print files. Category
// is just a tag derived from an item's top-level data folder -- there's
// no subcategory nesting anymore (see indexer.js), which is what makes
// multi-select category filtering simple instead of a tree problem.

const UNCATEGORIZED = 'Uncategorized';

let allItems = [];
let selectedItem = null; // the item currently shown in detail view, or null
let selectedPrinters = new Set(); // empty = no restriction chosen ("All Printers")
let selectedCategories = new Set(); // empty = no restriction chosen ("All Categories")
let keywordQuery = ''; // raw text from the search box; '' = no restriction
let settings = { availablePrinters: [], hideUnavailable: false, gitRepoUrl: '', gitBranch: '' };
let syncStatus = { configured: false, lastSuccessAt: null, inProgress: false };

async function init() {
  // Registered before any await so this is listening synchronously
  // during initial script execution -- main.js sends 'menu:openSettings'
  // once the window's did-finish-load fires, which can't happen until
  // after this script has finished evaluating, but an await here would
  // leave a window where the message could arrive before we're
  // listening for it.
  window.catalogAPI.onOpenSettings((payload) => openSettingsDialog(payload || {}));

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

  window.catalogAPI.onCatalogUpdated((newItems) => {
    allItems = newItems;
    renderPrinterFilter();
    renderCategoryFilter();
    render();
  });

  // The search box is a static element (see index.html), never
  // recreated by render() -- unlike the filter pills, it holds live
  // text-input focus and a cursor position that rebuilding the node
  // every keystroke would destroy.
  document.getElementById('keyword-filter').addEventListener('input', onKeywordInput);

  renderPrinterFilter();
  renderCategoryFilter();
  render();
}

function onKeywordInput(e) {
  keywordQuery = e.target.value;
  // Category pill counts fold in the keyword filter too (see
  // countFilesForCategory), so they need a re-render on every
  // keystroke same as the listing does. The printer pills don't show
  // counts, so they don't need to be touched here.
  renderCategoryFilter();
  render();
}

// Starting filter selection is whatever the admin configured as this
// makerspace's available printers -- if nothing's configured yet,
// that's an empty set, meaning no restriction ("All Printers").
function applyDefaultPrinterFilter() {
  selectedPrinters = new Set(settings.availablePrinters || []);
}

// A file's printer identity for filtering purposes -- same
// model+variant combination the old site displayed, but now derived
// fresh from whatever's actually in the data instead of a hardcoded
// checkbox list.
function printerLabel(file) {
  return [file.printerModel, file.printerVariant].filter(Boolean).join(' ') || 'Unknown printer';
}

function collectPrinters(items) {
  const set = new Set();
  for (const item of items) {
    for (const file of item.files) set.add(printerLabel(file));
  }
  return set;
}

function collectCategories(items) {
  const set = new Set();
  for (const item of items) {
    set.add(item.category || UNCATEGORIZED);
  }
  return set;
}

function itemMatchesPrinter(item, printerSet) {
  if (!printerSet || printerSet.size === 0) return true;
  return item.files.some((f) => printerSet.has(printerLabel(f)));
}

function itemMatchesCategory(item, categorySet) {
  if (!categorySet || categorySet.size === 0) return true;
  return categorySet.has(item.category || UNCATEGORIZED);
}

// Keyword search: splits the query into words and requires all of
// them to appear (in any order, across any of the searched fields) --
// an AND match, not a single-substring match, so "faceted large"
// narrows rather than requiring that exact phrase.
function keywordWords(query) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function textIncludesAllWords(text, words) {
  return words.every((w) => text.includes(w));
}

// Only the item's own display name -- not its files -- so this can be
// used to decide "does the item name itself justify showing every
// file underneath it" separately from "does this one file match".
function itemNameText(item) {
  return (item.displayName || item.name || '').toLowerCase();
}

function fileSearchText(file) {
  return [file.shortname, file.longname, ...(file.tags || [])]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
}

// True if this item belongs in the browsing grid for the current
// search: either its own name matches, or at least one of its print
// files (by name or tag) does.
function itemMatchesKeyword(item, query) {
  const words = keywordWords(query);
  if (words.length === 0) return true;
  if (textIncludesAllWords(itemNameText(item), words)) return true;
  return item.files.some((f) => textIncludesAllWords(fileSearchText(f), words));
}

// True if this specific file should be shown once its item is open.
// An item-name match (e.g. searching "vase" finding the item
// "Faceted Vase") counts for all of that item's files, since the
// match didn't come from anything file-specific; otherwise it falls
// back to the file's own name/tags.
function fileMatchesKeywordInItem(item, file, query) {
  const words = keywordWords(query);
  if (words.length === 0) return true;
  if (textIncludesAllWords(itemNameText(item), words)) return true;
  return textIncludesAllWords(fileSearchText(file), words);
}

// Total matching print files for one category pill's count -- same
// "how many files you'd narrow down to" semantics as before, now also
// narrowed by whatever's in the search box.
function countFilesForCategory(items, printerSet, categoryValue, query) {
  let total = 0;
  for (const item of items) {
    if ((item.category || UNCATEGORIZED) !== categoryValue) continue;
    for (const file of item.files) {
      if (printerSet && printerSet.size > 0 && !printerSet.has(printerLabel(file))) continue;
      if (!fileMatchesKeywordInItem(item, file, query)) continue;
      total++;
    }
  }
  return total;
}

// The filter actually in effect, folding the admin's hideUnavailable
// setting in on top of the user's own selection. When hideUnavailable
// is on, "All Printers" (an empty selection) really means "all
// *available* printers" -- browsing can never reach beyond what this
// makerspace actually has, regardless of what's selected.
function effectivePrinterFilter() {
  const available = settings.availablePrinters || [];
  if (settings.hideUnavailable && available.length > 0) {
    const allowed = new Set(available);
    if (selectedPrinters.size === 0) return allowed;
    return new Set([...selectedPrinters].filter((p) => allowed.has(p)));
  }
  return selectedPrinters;
}

// Which printers should even be offered as choices, given the
// hideUnavailable setting: everything, or only what's marked
// available for this makerspace.
function getVisiblePrinterOptions(allPrinters) {
  const available = settings.availablePrinters || [];
  if (!settings.hideUnavailable || available.length === 0) {
    return allPrinters;
  }
  return allPrinters.filter((p) => available.includes(p));
}

function renderPrinterFilter() {
  const el = document.getElementById('printer-filter');
  el.innerHTML = '';

  const allPrinters = Array.from(collectPrinters(allItems)).sort();
  const visiblePrinters = getVisiblePrinterOptions(allPrinters);

  // Nothing to actually choose between -- hide the whole filter bar
  // and just show that one printer's items directly.
  if (settings.hideUnavailable && visiblePrinters.length <= 1) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';

  // Drop any selected printer that's no longer a valid choice (e.g.
  // its last file was removed, or an admin setting hid it).
  selectedPrinters = new Set([...selectedPrinters].filter((p) => visiblePrinters.includes(p)));

  const allBtn = document.createElement('button');
  allBtn.textContent = 'All Printers';
  allBtn.className = 'filter-pill' + (selectedPrinters.size === 0 ? ' active' : '');
  allBtn.onclick = () => {
    selectedPrinters = new Set();
    renderPrinterFilter();
    render();
  };
  el.appendChild(allBtn);

  for (const printer of visiblePrinters) {
    const btn = document.createElement('button');
    btn.textContent = printer;
    btn.className = 'filter-pill' + (selectedPrinters.has(printer) ? ' active' : '');
    btn.onclick = () => {
      if (selectedPrinters.has(printer)) {
        selectedPrinters.delete(printer);
      } else {
        selectedPrinters.add(printer);
      }
      renderPrinterFilter();
      render();
    };
    el.appendChild(btn);
  }
}

function renderCategoryFilter() {
  const el = document.getElementById('category-filter');
  el.innerHTML = '';

  const categories = Array.from(collectCategories(allItems)).sort();
  if (categories.length === 0) return; // nothing to filter by yet

  // Drop any selected category that's no longer valid (e.g. its last
  // item was removed).
  selectedCategories = new Set([...selectedCategories].filter((c) => categories.includes(c)));

  const effective = effectivePrinterFilter();

  const allBtn = document.createElement('button');
  allBtn.textContent = 'All Categories';
  allBtn.className = 'filter-pill' + (selectedCategories.size === 0 ? ' active' : '');
  allBtn.onclick = () => {
    selectedCategories = new Set();
    renderCategoryFilter();
    render();
  };
  el.appendChild(allBtn);

  for (const category of categories) {
    const count = countFilesForCategory(allItems, effective, category, keywordQuery);
    const btn = document.createElement('button');
    btn.textContent = `${category} (${count})`;
    btn.className = 'filter-pill' + (selectedCategories.has(category) ? ' active' : '');
    btn.onclick = () => {
      if (selectedCategories.has(category)) {
        selectedCategories.delete(category);
      } else {
        selectedCategories.add(category);
      }
      renderCategoryFilter();
      render();
    };
    el.appendChild(btn);
  }
}

// Coarse "how long ago" phrasing for the sync-status footer -- doesn't
// need to be precise to the second, just legible at a glance.
function formatRelativeTime(isoString) {
  const diffMs = Math.max(0, Date.now() - new Date(isoString).getTime());
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) {
    const n = Math.floor(diffMs / minute);
    return `${n} minute${n === 1 ? '' : 's'} ago`;
  }
  if (diffMs < day) {
    const n = Math.floor(diffMs / hour);
    return `${n} hour${n === 1 ? '' : 's'} ago`;
  }
  const n = Math.floor(diffMs / day);
  return `${n} day${n === 1 ? '' : 's'} ago`;
}

// Footer note showing how fresh the catalog data is. Hidden entirely
// when git sync isn't configured at all (a plain local DATA_DIR has no
// "refresh" concept to report on); otherwise shows the last successful
// sync, plus "Refresh in progress..." while one's actively running.
function renderSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!el) return;

  if (!syncStatus.configured) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = '';

  if (!syncStatus.lastSuccessAt) {
    el.textContent = syncStatus.inProgress
      ? 'Refreshing catalog for the first time\u2026'
      : 'Catalog refresh: not yet synced';
    return;
  }

  el.textContent = syncStatus.inProgress
    ? `Last catalog refresh: ${formatRelativeTime(syncStatus.lastSuccessAt)}. Refresh in progress\u2026`
    : `Last catalog refresh: ${formatRelativeTime(syncStatus.lastSuccessAt)}`;
}

function render() {
  const effective = effectivePrinterFilter();
  const listing = document.getElementById('listing');
  listing.innerHTML = '';

  // The search box and pill rows only affect the flat browsing grid,
  // never the currently-open item's file list (category isn't even
  // checked there -- see below), so leave them interactable and
  // they'll just silently narrow/broaden a view you can't see. Hiding
  // the whole block while an item is open avoids that: nothing to
  // click, so nothing to mutate out from under the current view. This
  // is on top of, not instead of, printer-filter's own display logic
  // (e.g. hiding itself entirely when hideUnavailable leaves only one
  // printer) -- #top-filters is a separate wrapper, so toggling it
  // here never overwrites that.
  document.getElementById('top-filters').style.display = selectedItem ? 'none' : '';

  if (selectedItem) {
    const backLink = document.createElement('a');
    backLink.href = '#';
    backLink.className = 'back-link';
    backLink.textContent = '\u2039 Back to browsing';
    backLink.onclick = (e) => {
      e.preventDefault();
      selectedItem = null;
      render();
    };
    listing.appendChild(backLink);

    let matchingFiles =
      effective && effective.size > 0
        ? selectedItem.files.filter((f) => effective.has(printerLabel(f)))
        : selectedItem.files;
    matchingFiles = matchingFiles.filter((f) => fileMatchesKeywordInItem(selectedItem, f, keywordQuery));

    if (matchingFiles.length === 0) {
      listing.appendChild(
        renderEmptyState(
          keywordQuery
            ? 'No print files here match your search. Try a different keyword, or clear the search box.'
            : 'This isn\'t sliced for the selected printer(s). Try picking a different printer, or choose "All Printers" to see every version.'
        )
      );
    } else {
      listing.appendChild(renderItemDetail({ ...selectedItem, files: matchingFiles }));
    }
    return;
  }

  const visibleItems = allItems.filter(
    (item) =>
      itemMatchesPrinter(item, effective) &&
      itemMatchesCategory(item, selectedCategories) &&
      itemMatchesKeyword(item, keywordQuery)
  );

  if (visibleItems.length === 0) {
    listing.appendChild(
      renderEmptyState(
        keywordQuery
          ? 'Nothing matches your search. Try a different keyword, or clear the search box.'
          : 'Nothing matches the selected filters. Try different printers or categories, or choose "All" for each.'
      )
    );
    return;
  }

  const itemGrid = document.createElement('div');
  itemGrid.className = 'item-grid';
  for (const item of visibleItems) {
    itemGrid.appendChild(renderItemCard(item));
  }
  listing.appendChild(itemGrid);
}

// A friendly "nothing matches" screen -- kept generic so it can also
// be reused once tag/search filtering exists, not just these filters.
function renderEmptyState(message) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  const icon = document.createElement('div');
  icon.className = 'empty-state-icon';
  icon.textContent = '🔍';
  wrap.appendChild(icon);

  const title = document.createElement('p');
  title.className = 'empty-state-title';
  title.textContent = 'Nothing to see here!';
  wrap.appendChild(title);

  const sub = document.createElement('p');
  sub.className = 'empty-state-sub';
  sub.textContent = message;
  wrap.appendChild(sub);

  return wrap;
}

function renderItemCard(item) {
  const card = document.createElement('a');
  card.className = 'listing';
  card.href = '#';
  card.title = item.displayName || item.name;
  card.onclick = (e) => {
    e.preventDefault();
    selectedItem = item;
    render();
  };

  const mediaSlot = document.createElement('div');
  mediaSlot.className = 'thumb-slot';
  card.appendChild(mediaSlot);

  window.catalogAPI.getItemThumbnail(item).then((thumb) => {
    const img = document.createElement('img');
    img.alt = item.displayName || item.name;
    img.src = thumb ? `file://${thumb}` : 'nothumb.png';
    mediaSlot.appendChild(img);
  });

  const label = document.createElement('span');
  label.textContent = item.displayName || item.name;
  card.appendChild(label);

  return card;
}

function renderItemDetail(item) {
  const wrap = document.createElement('div');
  wrap.className = 'item-detail';

  for (const file of item.files) {
    const row = document.createElement('div');
    row.className = 'file-row';

    const img = document.createElement('img');
    img.alt = file.shortname;
    window.catalogAPI.getFileThumbnail(file, item.imageFiles).then((thumbPath) => {
      img.src = thumbPath ? `file://${thumbPath}` : 'nothumb.png';
    });
    row.appendChild(img);

    const name = document.createElement('strong');
    name.textContent = file.shortname;
    row.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const metaLines = [
      file.printerModel ? `Printer: ${file.printerModel}` : null,
      file.printTime ? `Print time: ${file.printTime}` : null,
      // colorChangeCount/copies/pauseCount are auto-detected (see
      // gcodeCommandScan.js) and can be `null` for a .bgcode file
      // whose toolpath couldn't be scanned -- that's "unknown", so it
      // gets the same treatment as "nothing to report" (0 changes, 1
      // copy, 0 pauses) and is simply left off rather than shown as a
      // count.
      file.colorChangeCount
        ? `${file.colorChangeCount} color change${file.colorChangeCount === 1 ? '' : 's'}`
        : null,
      file.copies && file.copies > 1 ? `${file.copies} copies` : null,
      // Rendered specially below (needs a tooltip icon for pause
      // messages, not just plain text) -- see the loop.
      file.pauseCount ? { pause: true, count: file.pauseCount, messages: file.pauseMessages || [] } : null,
      file.tags.length ? `Tags: ${file.tags.join(', ')}` : null,
    ].filter(Boolean);
    for (const line of metaLines) {
      const lineEl = document.createElement('div');
      if (typeof line === 'string') {
        lineEl.textContent = line;
      } else {
        // Pause line: "N pause(s)" as text, plus a tooltip icon
        // carrying the M117 message(s) that preceded each M601 --
        // only when at least one pause actually had one. Built with
        // DOM methods (textContent/title), not innerHTML, so a
        // message containing HTML-ish characters can't break the
        // markup.
        lineEl.appendChild(
          document.createTextNode(`${line.count} pause${line.count === 1 ? '' : 's'} `)
        );
        const messages = line.messages.filter(Boolean);
        if (messages.length) {
          const icon = document.createElement('i');
          icon.className = 'pause-tooltip-icon';
          icon.title = messages.join('\n');
          icon.textContent = '\u24d8'; // ⓘ
          lineEl.appendChild(icon);
        }
      }
      meta.appendChild(lineEl);
    }
    row.appendChild(meta);

    const printButton = document.createElement('button');
    printButton.className = 'print-button';
    printButton.textContent = 'Print This';
    printButton.onclick = () => handlePrintClick(file);
    row.appendChild(printButton);

    wrap.appendChild(row);
  }

  return wrap;
}

async function handlePrintClick(file) {
  const drives = await window.catalogAPI.listDrives();

  if (drives.length === 0) {
    alert('No USB drive detected. Plug one in and try again.');
    return;
  }

  const drive = drives.length === 1 ? drives[0] : await pickDrive(drives);
  if (!drive) return; // cancelled the picker

  const confirmed = confirm(`Save "${file.shortname}" to "${drive.name}"?`);
  if (!confirmed) return;

  try {
    await window.catalogAPI.saveFileToDrive(file.path, drive.mountPoint);
    const choice = await showActionDialog(`Saved "${file.shortname}" to "${drive.name}".`, [
      { label: 'Keep Browsing', value: 'continue' },
      { label: 'Eject Drive', value: 'eject', className: 'eject' },
    ]);

    if (choice === 'eject') {
      try {
        await window.catalogAPI.ejectDrive(drive.diskIdentifier);
        await showEjectSafeDialog(
          `"${drive.name}" has been ejected -- it's safe to unplug now.`,
          drive.diskIdentifier
        );
      } catch (err) {
        alert(`Couldn't eject the drive: ${err.message}`);
      }
    }
  } catch (err) {
    alert(`Couldn't save the file: ${err.message}`);
  }
}

// Shown only when more than one USB drive is plugged in at once.
// Resolves to the chosen drive, or null if the user cancels.
function pickDrive(drives) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'drive-picker-overlay';

    const box = document.createElement('div');
    box.className = 'drive-picker-box';

    const title = document.createElement('h3');
    title.textContent = 'Choose a USB drive';
    box.appendChild(title);

    const finish = (result) => {
      document.body.removeChild(overlay);
      resolve(result);
    };

    for (const drive of drives) {
      const btn = document.createElement('button');
      btn.textContent = `${drive.name} (${drive.mountPoint})`;
      btn.onclick = () => finish(drive);
      box.appendChild(btn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => finish(null);
    box.appendChild(cancelBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// A generic "message + a few buttons" modal -- used for the
// continue-browsing-or-eject choice after a save completes. Resolves
// to whichever action's `value` was clicked.
function showActionDialog(message, actions) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'drive-picker-overlay';

    const box = document.createElement('div');
    box.className = 'drive-picker-box';

    const text = document.createElement('p');
    text.textContent = message;
    box.appendChild(text);

    const finish = (value) => {
      document.body.removeChild(overlay);
      resolve(value);
    };

    for (const action of actions) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      if (action.className) btn.className = action.className;
      btn.onclick = () => finish(action.value);
      box.appendChild(btn);
    }

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// Shown after a successful eject. Auto-closes once the drive is
// physically removed (polling, since diskutil eject already unmounted
// the volume -- we're watching for the whole disk to vanish from the
// external-disk list). A manual Dismiss button stays available in
// case detection ever misses for some reason.
function showEjectSafeDialog(message, diskIdentifier) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'drive-picker-overlay';

    const box = document.createElement('div');
    box.className = 'drive-picker-box';

    const text = document.createElement('p');
    text.textContent = message;
    box.appendChild(text);

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    box.appendChild(dismissBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let pollTimer = null;
    const close = () => {
      clearInterval(pollTimer);
      if (overlay.parentNode) document.body.removeChild(overlay);
      resolve();
    };

    dismissBtn.onclick = close;

    pollTimer = setInterval(async () => {
      const stillPresent = await window.catalogAPI.isDrivePresent(diskIdentifier);
      if (!stillPresent) close();
    }, 1000);
  });
}

// A labeled single-line text input for the settings dialog. Returns
// the wrapping element (to append) and the input itself (to read back
// on Save).
function createSettingsTextField(labelText, value, placeholder) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-field';

  const label = document.createElement('label');
  label.className = 'settings-field-label';
  label.textContent = labelText;
  wrap.appendChild(label);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'settings-text-input';
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  wrap.appendChild(input);

  return { wrap, input };
}

// Lets the admin pick which printers this makerspace actually has, and
// whether to hide anything else entirely, plus the git repo/branch to
// sync catalog data from. Saves via IPC (persisted across launches),
// then re-derives the active filter from the new settings so printer
// changes take effect immediately. Git repo/branch changes require a
// restart (see main.js's settings:save handler), since DATA_DIR itself
// is only resolved once at startup.
function openSettingsDialog(opts = {}) {
  const required = Boolean(opts.required);
  // In required mode allItems is always [] (init() skips getTree()
  // when there's no repo configured), so there'd be nothing to derive
  // a printer list from anyway -- skip that section of the dialog
  // entirely rather than showing an empty/misleading printer list.
  const allPrinters = required ? [] : Array.from(collectPrinters(allItems)).sort();

  const overlay = document.createElement('div');
  overlay.className = 'drive-picker-overlay';

  const box = document.createElement('div');
  box.className = 'drive-picker-box settings-box';

  const title = document.createElement('h3');
  title.textContent = required ? 'Set Up Print Catalog' : 'Printer Settings';
  box.appendChild(title);

  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = required
    ? "Enter the git repository this makerspace's catalog data lives in to get started."
    : 'Choose which printers this makerspace actually has.';
  box.appendChild(intro);

  const checkboxEls = new Map();
  let hideCb = null;

  if (!required) {
    if (allPrinters.length === 0) {
      const none = document.createElement('p');
      none.className = 'settings-intro';
      none.textContent = 'No printers found in the catalog yet.';
      box.appendChild(none);
    } else {
      for (const printer of allPrinters) {
        const row = document.createElement('label');
        row.className = 'settings-checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = settings.availablePrinters.includes(printer);
        row.appendChild(cb);
        row.appendChild(document.createTextNode(' ' + printer));
        box.appendChild(row);
        checkboxEls.set(printer, cb);
      }
    }

    box.appendChild(document.createElement('hr'));

    const hideRow = document.createElement('label');
    hideRow.className = 'settings-checkbox-row';
    hideCb = document.createElement('input');
    hideCb.type = 'checkbox';
    hideCb.checked = settings.hideUnavailable;
    hideRow.appendChild(hideCb);
    hideRow.appendChild(document.createTextNode(' Hide unavailable printers'));
    box.appendChild(hideRow);

    box.appendChild(document.createElement('hr'));
  }

  const repoField = createSettingsTextField(
    'Git Repository:',
    settings.gitRepoUrl,
    'https://github.com/example/catalog-data.git'
  );
  box.appendChild(repoField.wrap);

  const branchField = createSettingsTextField('Branch:', settings.gitBranch, 'main');
  box.appendChild(branchField.wrap);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'settings-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.onclick = async () => {
    const gitRepoUrl = repoField.input.value.trim();

    // Required mode exists only because there's no repo configured --
    // saving without one would just land back in this same dialog on
    // next launch, so refuse instead of silently closing.
    if (required && !gitRepoUrl) {
      alert('Enter a git repository URL to continue.');
      return;
    }

    const availablePrinters = required
      ? settings.availablePrinters || []
      : allPrinters.filter((p) => checkboxEls.get(p).checked);
    const { settings: saved, needsRestart } = await window.catalogAPI.saveSettings({
      availablePrinters,
      hideUnavailable: required ? settings.hideUnavailable : hideCb.checked,
      gitRepoUrl,
      gitBranch: branchField.input.value.trim(),
    });
    settings = saved;

    if (required) {
      // Nothing to show until the app relaunches with an indexer set
      // up against the new repo -- no "keep browsing" option makes
      // sense here the way it does for the normal settings dialog, so
      // just relaunch directly rather than asking.
      window.catalogAPI.relaunch();
      return;
    }

    applyDefaultPrinterFilter();
    document.body.removeChild(overlay);
    renderPrinterFilter();
    renderCategoryFilter();
    render();

    // The git repo/branch feed into DATA_DIR, which is only resolved
    // once at startup (see main.js) -- changing either here can't take
    // effect on a running indexer/watcher, so ask before relaunching.
    if (needsRestart) {
      const restartNow = confirm(
        'Git repository settings changed. Print Catalog needs to restart for this to take effect.\n\nRestart now?'
      );
      if (restartNow) window.catalogAPI.relaunch();
    }
  };
  buttonsRow.appendChild(saveBtn);

  // No Cancel in required mode -- there's nothing to fall back to
  // (canceling out of an unconfigured, empty catalog isn't a real
  // option), so this dialog can only be dismissed by saving.
  if (!required) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
      document.body.removeChild(overlay);
    };
    buttonsRow.appendChild(cancelBtn);
  }

  box.appendChild(buttonsRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

init();
