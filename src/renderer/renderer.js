'use strict';

// Flat filtering UI: no navigation, no breadcrumbs, no categories. Two
// independent multi-select filter rows (Printers, Tags) narrow down a
// single flat grid of items; clicking an item shows its print files.
// Tags come from each item's metadata.json (see itemMetadata.js) --
// an item can carry any number of them, so the tag filter is an OR
// match (an item matching if it has *any* selected tag), same as the
// printer filter's OR-across-a-file's-printer semantics.

let allItems = [];
let selectedItem = null; // the item currently shown in detail view, or null
let selectedPrinters = new Set(); // empty = no restriction chosen ("All Printers")
let selectedTags = new Set(); // empty = no restriction chosen ("All Tags")
let keywordQuery = ''; // raw text from the search box; '' = no restriction
let settings = { availablePrinters: [], hideUnavailable: false, gitRepoUrl: '', gitBranch: '' };
let syncStatus = { configured: false, lastSuccessAt: null, inProgress: false };

// Edit mode: the main screen doubles as the editing UI (see
// ARCHITECTURE.md) rather than being a separate mode/window. pendingChanges
// mirrors editSession.js's changes map (itemPath -> {type, name}) purely
// for display -- badges, borders, the bottom bar's counts, and the smart
// tag pills below. selectedSmartTags holds which of 'add'/'edit'/'delete'
// are currently filtered on, same shape as selectedTags.
let editModeActive = false;
let pendingChanges = {};
let selectedSmartTags = new Set();

const SMART_TAGS = [
  { type: 'add', label: 'Pending', className: 'smart-tag-add' },
  { type: 'edit', label: 'Edited', className: 'smart-tag-edit' },
  { type: 'delete', label: 'Trashed', className: 'smart-tag-delete' },
];

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
    selectedItem = null; // editing works at the grid level, not inside item detail
    renderTagFilter();
    render();
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

function onKeywordInput(e) {
  keywordQuery = e.target.value;
  // Tag pill counts fold in the keyword filter too (see
  // countFilesForTag), so they need a re-render on every
  // keystroke same as the listing does. The printer pills don't show
  // counts, so they don't need to be touched here.
  renderTagFilter();
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

function collectTags(items) {
  const set = new Set();
  for (const item of items) {
    for (const tag of item.tags || []) set.add(tag);
  }
  return set;
}

function itemMatchesPrinter(item, printerSet) {
  if (!printerSet || printerSet.size === 0) return true;
  return item.files.some((f) => printerSet.has(printerLabel(f)));
}

function itemMatchesTags(item, tagSet) {
  if (!tagSet || tagSet.size === 0) return true;
  return (item.tags || []).some((t) => tagSet.has(t));
}

// Only applies in edit mode -- pendingChanges is always empty otherwise,
// so this is a no-op filter outside a session.
function itemMatchesSmartTags(item, smartSet) {
  if (!smartSet || smartSet.size === 0) return true;
  const change = pendingChanges[item.path];
  return Boolean(change && smartSet.has(change.type));
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

// Total matching print files for one tag pill's count -- same "how
// many files you'd narrow down to" semantics category pills used to
// have, now also narrowed by whatever's in the search box. An item
// can carry the tag alongside others, so this checks membership
// rather than equality.
function countFilesForTag(items, printerSet, tagValue, query) {
  let total = 0;
  for (const item of items) {
    if (!(item.tags || []).includes(tagValue)) continue;
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

function renderTagFilter() {
  const el = document.getElementById('tag-filter');
  el.innerHTML = '';

  const tags = Array.from(collectTags(allItems)).sort();
  // Bail out on the tag-pill portion alone when there are no tags yet
  // -- the smart tag pills (edit mode) still need to render either way.
  if (tags.length > 0) {
    // Drop any selected tag that's no longer valid (e.g. its last item
    // was removed or untagged).
    selectedTags = new Set([...selectedTags].filter((t) => tags.includes(t)));

    const effective = effectivePrinterFilter();

    const allBtn = document.createElement('button');
    allBtn.textContent = 'All Tags';
    allBtn.className = 'filter-pill' + (selectedTags.size === 0 ? ' active' : '');
    allBtn.onclick = () => {
      selectedTags = new Set();
      renderTagFilter();
      render();
    };
    el.appendChild(allBtn);

    for (const tag of tags) {
      const count = countFilesForTag(allItems, effective, tag, keywordQuery);
      const btn = document.createElement('button');
      btn.textContent = `${tag} (${count})`;
      btn.className = 'filter-pill' + (selectedTags.has(tag) ? ' active' : '');
      btn.onclick = () => {
        if (selectedTags.has(tag)) {
          selectedTags.delete(tag);
        } else {
          selectedTags.add(tag);
        }
        renderTagFilter();
        render();
      };
      el.appendChild(btn);
    }
  }

  if (editModeActive) {
    for (const tag of SMART_TAGS) {
      const count = Object.values(pendingChanges).filter((c) => c.type === tag.type).length;
      // A tag with nothing currently in that state would just filter
      // the grid down to nothing if clicked -- skip showing it rather
      // than offer a pill that's guaranteed to look "broken".
      if (count === 0 && !selectedSmartTags.has(tag.type)) continue;

      const btn = document.createElement('button');
      btn.textContent = `${tag.label} (${count})`;
      btn.className = `filter-pill smart-tag ${tag.className}` + (selectedSmartTags.has(tag.type) ? ' active' : '');
      btn.onclick = () => {
        if (selectedSmartTags.has(tag.type)) {
          selectedSmartTags.delete(tag.type);
        } else {
          selectedSmartTags.add(tag.type);
        }
        renderTagFilter();
        render();
      };
      el.appendChild(btn);
    }
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
  // never the currently-open item's file list (tags aren't even
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
      itemMatchesTags(item, selectedTags) &&
      itemMatchesSmartTags(item, selectedSmartTags) &&
      itemMatchesKeyword(item, keywordQuery)
  );

  if (visibleItems.length === 0) {
    listing.appendChild(
      renderEmptyState(
        keywordQuery
          ? 'Nothing matches your search. Try a different keyword, or clear the search box.'
          : 'Nothing matches the selected filters. Try different printers or tags, or choose "All" for each.'
      )
    );
    renderEditBar();
    return;
  }

  const itemGrid = document.createElement('div');
  itemGrid.className = 'item-grid';
  for (const item of visibleItems) {
    itemGrid.appendChild(renderItemCard(item));
  }
  listing.appendChild(itemGrid);
  renderEditBar();
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
  const change = pendingChanges[item.path];

  const card = document.createElement('a');
  card.className = 'listing' + (change ? ` pending-${change.type}` : '');
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
    img.src = thumb ? `file://${thumb}` : 'nothumb.svg';
    mediaSlot.appendChild(img);
  });

  const label = document.createElement('span');
  label.textContent = item.displayName || item.name;
  if (change) {
    const badge = document.createElement('span');
    badge.className = `pending-badge pending-badge-${change.type}`;
    badge.textContent = SMART_TAGS.find((t) => t.type === change.type).label;
    label.appendChild(document.createTextNode(' '));
    label.appendChild(badge);
  }
  card.appendChild(label);

  if (editModeActive) {
    const controls = document.createElement('div');
    controls.className = 'item-edit-controls';

    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openItemEditor('edit', item);
    };
    controls.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    const isTrashed = change && change.type === 'delete';
    deleteBtn.textContent = isTrashed ? 'Undo' : 'Delete';
    deleteBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingChanges = isTrashed
        ? await window.catalogAPI.editSessionUndoDelete(item.path)
        : await window.catalogAPI.editSessionDeleteItem(item.path);
      renderTagFilter();
      render();
    };
    controls.appendChild(deleteBtn);

    card.appendChild(controls);
  }

  return card;
}

// Derives a human platform label from an origin URL's hostname, so
// the badge doesn't need a separately-stored "platform" field --
// works for a manually-typed URL on some other site too (falls back
// to the bare hostname rather than nothing).
function originPlatformLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    if (/thingiverse/i.test(host)) return 'Thingiverse';
    if (/printables/i.test(host)) return 'Printables';
    return host;
  } catch (err) {
    return null;
  }
}

// Item-level "where this came from" line, shown above the file list
// only when an origin URL is known (metadata.json's origin.url --
// see itemMetadata.js/originLocation.js). Also displays
// creatorName/creatorUrl when present, even though nothing in this
// app populates them yet (planned: a future pass scrapes the origin
// page for the creator's username + profile URL) -- built this way
// now so that once that data exists, it shows up here with no further
// display-side changes needed.
function renderOriginInfo(origin) {
  const label = originPlatformLabel(origin.url);
  const line = document.createElement('div');
  line.className = 'item-origin-info';

  const link = document.createElement('a');
  link.href = origin.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label ? `View original on ${label} \u2197` : `View original \u2197`;
  line.appendChild(link);

  if (origin.creatorName) {
    line.appendChild(document.createTextNode(' by '));
    if (origin.creatorUrl) {
      const creatorLink = document.createElement('a');
      creatorLink.href = origin.creatorUrl;
      creatorLink.target = '_blank';
      creatorLink.rel = 'noopener noreferrer';
      creatorLink.textContent = origin.creatorName;
      line.appendChild(creatorLink);
    } else {
      line.appendChild(document.createTextNode(origin.creatorName));
    }
  }

  return line;
}

function renderItemDetail(item) {
  const wrap = document.createElement('div');
  wrap.className = 'item-detail';

  const header = document.createElement('div');
  header.className = 'item-detail-header';
  const heading = document.createElement('h2');
  heading.textContent = item.displayName || item.name;
  header.appendChild(heading);
  if (item.origin && item.origin.url) {
    header.appendChild(renderOriginInfo(item.origin));
  }
  wrap.appendChild(header);

  for (const file of item.files) {
    const row = document.createElement('div');
    row.className = 'file-row';

    const img = document.createElement('img');
    img.alt = file.shortname;
    window.catalogAPI.getFileThumbnail(file, item.imageFiles).then((thumbPath) => {
      img.src = thumbPath ? `file://${thumbPath}` : 'nothumb.svg';
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
    renderTagFilter();
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

// The "Add item" button plus the persistent bottom bar showing
// pending-change counts and Confirm/Cancel actions. Rendered fresh
// into #listing on every render() call (append-only, listing.innerHTML
// was already cleared at the top of render()) -- cheap enough given
// how small this is, and keeps it in sync with pendingChanges without
// a separate update path to maintain.
function renderEditBar() {
  const listing = document.getElementById('listing');
  if (!editModeActive) return;

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add item';
  addBtn.className = 'add-item-button';
  addBtn.onclick = () => openItemEditor('add', null);
  listing.appendChild(addBtn);

  const counts = { add: 0, edit: 0, delete: 0 };
  for (const change of Object.values(pendingChanges)) counts[change.type]++;
  const total = counts.add + counts.edit + counts.delete;

  const bar = document.createElement('div');
  bar.className = 'edit-session-bar';

  const stats = document.createElement('span');
  stats.textContent = `${counts.add} added \u00b7 ${counts.edit} edited \u00b7 ${counts.delete} deleted`;
  bar.appendChild(stats);

  const buttons = document.createElement('div');

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel changes';
  cancelBtn.onclick = async () => {
    if (total > 0 && !confirm('Discard all pending changes?')) return;
    allItems = await window.catalogAPI.editSessionCancel();
    editModeActive = false;
    pendingChanges = {};
    selectedSmartTags = new Set();
    renderPrinterFilter();
    renderTagFilter();
    render();
  };
  buttons.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = `Confirm ${total} change${total === 1 ? '' : 's'}`;
  confirmBtn.disabled = total === 0;
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Pushing\u2026';
    try {
      const result = await window.catalogAPI.editSessionConfirm();
      if (result.cancelled) {
        // Admin backed out of the token/provisioning prompt -- changes
        // are untouched, just re-enable the button.
        confirmBtn.disabled = false;
        confirmBtn.textContent = `Confirm ${total} change${total === 1 ? '' : 's'}`;
        return;
      }
      allItems = result.tree;
      editModeActive = false;
      pendingChanges = {};
      selectedSmartTags = new Set();
      renderPrinterFilter();
      renderTagFilter();
      render();
    } catch (err) {
      // Session stays active on the main-process side (see
      // editSession:confirmSession) so a retry after fixing whatever
      // went wrong (network, auth) just works.
      alert(`Push failed: ${err.message}\n\nYour changes are still staged -- fix the issue and try again.`);
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Confirm ${total} change${total === 1 ? '' : 's'}`;
    }
  };
  buttons.appendChild(confirmBtn);

  bar.appendChild(buttons);
  listing.appendChild(bar);
}

// Shared editor for both adding a new item and editing an existing
// one -- see prior design discussion for why these share one form.
// mode is 'add' or 'edit'; item is null for 'add'.
// Strips a print file's printer+extension segment (see the
// name.printer.gcode/.bgcode convention) and then a trailing batch/
// quantity suffix, so "widget.MK4S.bgcode" and
// "widget-batch6.MK4S.bgcode" compare equal for the batch-sharing
// suggestion below.
function strippedBatchName(name) {
  const withoutExt = name.replace(/\.[^.]+\.(gcode|bgcode)$/i, '');
  return withoutExt.replace(/[-_]?(batch\d+|x\d+)$/i, '').toLowerCase();
}

function isImageFileName(name) {
  return /\.(jpe?g|png|gif|svg)$/i.test(name);
}

// A "0 color changes" (the common case) or "1 in batch" (i.e. not
// actually a batch) note adds noise rather than helping tell similar
// prints apart -- only the informative cases show up here.
function printFileLabel(pf) {
  const parts = [];
  if (pf.colorChangeCount !== null && pf.colorChangeCount > 0) {
    parts.push(`${pf.colorChangeCount} color change${pf.colorChangeCount === 1 ? '' : 's'}`);
  }
  if (pf.copies !== null && pf.copies > 1) {
    parts.push(`batch of ${pf.copies}`);
  }
  return parts.length > 0 ? `${pf.shortname} (${parts.join(', ')})` : pf.shortname;
}

function imageRefSrc(ref, folderUrl) {
  return ref.kind === 'existing' ? `${folderUrl}/${ref.name}` : `file://${ref.path}`;
}

function imageRefEquals(a, b) {
  return a.kind === b.kind && (a.kind === 'existing' ? a.name === b.name : a.path === b.path);
}

// Shared editor for both adding a new item and editing an existing
// one -- see prior design discussion for why these share one form.
// mode is 'add' or 'edit'; item is null for 'add'.
function openItemEditor(mode, item, prefilledSourceDir) {
  const overlay = document.createElement('div');
  overlay.className = 'drive-picker-overlay';

  const box = document.createElement('div');
  box.className = 'drive-picker-box settings-box editor-box';

  const title = document.createElement('h3');
  title.textContent = mode === 'add' ? 'Add item' : 'Edit item';
  box.appendChild(title);

  const nameField = createSettingsTextField('Name', mode === 'edit' ? item.displayName || item.name : '', 'Widget holder');
  box.appendChild(nameField.wrap);

  const tagsField = createSettingsTextField(
    'Tags (comma separated)',
    mode === 'edit' ? (item.tags || []).join(', ') : '',
    'organizers, desk'
  );
  box.appendChild(tagsField.wrap);

  // Auto-detected from the item's folder when possible (see
  // originLocation.js) -- Thingiverse's README.txt or a Printables
  // page-printout PDF -- but always just a plain editable/clearable
  // text field otherwise, same as name/tags. 'add' mode gets its
  // prefill from scanSourceFolder()'s originUrl below; 'edit' mode
  // prefills from the item's already-stored metadata.json origin, and
  // only bothers re-detecting (async, below) when that's empty, so an
  // item already tagged with an origin doesn't get its folder
  // re-scanned/re-parsed every time it's opened for editing.
  const originField = createSettingsTextField(
    'Original Location',
    mode === 'edit' ? (item.origin && item.origin.url) || '' : '',
    'https://www.thingiverse.com/thing/...'
  );
  box.appendChild(originField.wrap);

  if (mode === 'edit' && !(item.origin && item.origin.url)) {
    window.catalogAPI
      .detectItemOrigin(item.path)
      .then((url) => {
        if (url) originField.input.value = url;
      })
      .catch(() => {}); // best-effort -- leave the field empty on failure
  }

  // Image reconciliation state. printFiles/poolImages/folderUrl are
  // filled in once we know what folder we're working with (immediately
  // for 'edit', after the folder dialog resolves for 'add' -- see
  // below). imageAssignments is keyed by print-file basename (the same
  // key indexer.js's metadataImages lookup uses) -> ordered array of
  // ImageRef ({kind:'existing', name} or {kind:'external', path,
  // name}). Many-to-many is the point (see prior design discussion),
  // so poolImages is just "every image available to this item" --
  // assigning one to a print file doesn't remove it from the pool.
  let printFiles = [];
  let poolImages = [];
  let imageAssignments = {};
  let folderUrl = null; // `file://<item folder>` once known
  let selectedPoolIndex = null;
  const checkedFiles = new Set();

  const imagesSection = document.createElement('div');
  box.appendChild(imagesSection);

  function assignRefToFile(key, ref) {
    const current = imageAssignments[key] || (imageAssignments[key] = []);
    if (current.some((r) => imageRefEquals(r, ref))) return;
    current.push(ref);
    suggestBatchShare(key, ref);
  }

  // Adds an OS file dropped or browsed in as a pool entry, deduping by
  // path -- returns the ref (existing or newly added) so callers can
  // also assign it to a specific print file in the same gesture (see
  // the per-row drop handler in renderImagesSection below).
  function addExternalToPool(path, name) {
    const existing = poolImages.find((r) => r.kind === 'external' && r.path === path);
    if (existing) return existing;
    const ref = { kind: 'external', path, name };
    poolImages.push(ref);
    return ref;
  }

  function suggestBatchShare(justAssignedKey, ref) {
    const source = printFiles.find((f) => f.key === justAssignedKey);
    if (!source || source.colorChangeCount === null) return;
    for (const target of printFiles) {
      if (target.key === justAssignedKey) continue;
      if (target.colorChangeCount !== source.colorChangeCount) continue;
      if (strippedBatchName(target.key) !== strippedBatchName(source.key)) continue;
      const already = (imageAssignments[target.key] || []).some((r) => imageRefEquals(r, ref));
      if (already) continue;
      const share = confirm(
        `"${target.shortname}" looks like a variant of "${source.shortname}" (same color changes) -- share this image with it too?`
      );
      if (share) {
        imageAssignments[target.key] = [...(imageAssignments[target.key] || []), ref];
      }
    }
  }

  function renderImagesSection() {
    imagesSection.innerHTML = '';
    if (!folderUrl) return; // 'add' mode before a folder's been picked

    const heading = document.createElement('p');
    heading.style.fontWeight = 'bold';
    heading.textContent = 'Print files';
    imagesSection.appendChild(heading);

    for (const pf of printFiles) {
      const row = document.createElement('div');
      row.className = 'editor-file-row';
      row.ondragover = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      row.ondragenter = () => row.classList.add('drop-target-active');
      row.ondragleave = () => row.classList.remove('drop-target-active');
      row.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop-target-active');
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          // OS image file(s) dropped directly onto this print file --
          // per prior discussion, this both adds them to the pool
          // (they weren't there before) and assigns them to this row
          // in one gesture, rather than requiring a separate step.
          for (const file of files) {
            if (!isImageFileName(file.name)) continue;
            const filePath = window.catalogAPI.getPathForFile(file);
            assignRefToFile(pf.key, addExternalToPool(filePath, file.name));
          }
        } else {
          // An in-app drag of an existing pool thumbnail (see its
          // dragstart below) -- just assign it, nothing new to add.
          const idx = Number(e.dataTransfer.getData('text/plain'));
          if (!Number.isNaN(idx) && poolImages[idx]) assignRefToFile(pf.key, poolImages[idx]);
        }
        renderImagesSection();
      };

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = checkedFiles.has(pf.key);
      checkbox.onchange = () => {
        if (checkbox.checked) checkedFiles.add(pf.key);
        else checkedFiles.delete(pf.key);
      };
      row.appendChild(checkbox);

      const label = document.createElement('span');
      label.className = 'editor-file-label';
      label.textContent = printFileLabel(pf);
      row.appendChild(label);

      const chips = document.createElement('div');
      chips.className = 'editor-image-chips';
      (imageAssignments[pf.key] || []).forEach((ref, idx) => {
        const chip = document.createElement('span');
        chip.className = 'editor-image-chip';
        const img = document.createElement('img');
        img.src = imageRefSrc(ref, folderUrl);
        chip.appendChild(img);
        const removeBtn = document.createElement('button');
        removeBtn.textContent = '\u00d7';
        removeBtn.title = 'Remove';
        removeBtn.onclick = () => {
          imageAssignments[pf.key].splice(idx, 1);
          renderImagesSection();
        };
        chip.appendChild(removeBtn);
        chips.appendChild(chip);
      });
      row.appendChild(chips);

      imagesSection.appendChild(row);
    }

    const poolHeading = document.createElement('p');
    poolHeading.style.fontWeight = 'bold';
    poolHeading.textContent = 'Available images';
    imagesSection.appendChild(poolHeading);

    const pool = document.createElement('div');
    pool.className = 'editor-image-pool';
    pool.ondragover = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    pool.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return; // in-app drags only make sense onto a print file row, not back onto the pool
      for (const file of files) {
        if (!isImageFileName(file.name)) continue;
        addExternalToPool(window.catalogAPI.getPathForFile(file), file.name);
      }
      renderImagesSection();
    };
    if (poolImages.length === 0) {
      const none = document.createElement('p');
      none.className = 'settings-intro';
      none.textContent = 'No images yet -- use "Browse for images" below, or drag images in.';
      pool.appendChild(none);
    }
    poolImages.forEach((ref, idx) => {
      const thumb = document.createElement('img');
      thumb.className = 'editor-pool-thumb' + (selectedPoolIndex === idx ? ' selected' : '');
      thumb.src = imageRefSrc(ref, folderUrl);
      thumb.title = ref.name;
      thumb.draggable = true;
      thumb.ondragstart = (e) => e.dataTransfer.setData('text/plain', String(idx));
      thumb.onclick = () => {
        selectedPoolIndex = selectedPoolIndex === idx ? null : idx;
        renderImagesSection();
      };
      pool.appendChild(thumb);
    });
    imagesSection.appendChild(pool);

    const poolButtons = document.createElement('div');
    poolButtons.className = 'settings-buttons';

    const browseBtn = document.createElement('button');
    browseBtn.textContent = 'Browse for images\u2026';
    browseBtn.onclick = async () => {
      const picked = await window.catalogAPI.editSessionBrowseImages();
      for (const p of picked) addExternalToPool(p.path, p.name);
      renderImagesSection();
    };
    poolButtons.appendChild(browseBtn);

    const assignBtn = document.createElement('button');
    assignBtn.textContent = 'Assign selected image to checked files';
    assignBtn.disabled = selectedPoolIndex === null || checkedFiles.size === 0;
    assignBtn.onclick = () => {
      const ref = poolImages[selectedPoolIndex];
      for (const key of checkedFiles) assignRefToFile(key, ref);
      renderImagesSection();
    };
    poolButtons.appendChild(assignBtn);

    imagesSection.appendChild(poolButtons);
  }

  if (mode === 'edit') {
    folderUrl = `file://${item.path}`;
    printFiles = item.files.map((f) => {
      const key = f.path.split(/[\\/]/).pop();
      imageAssignments[key] = (f.metadataImages || []).map((name) => ({ kind: 'existing', name }));
      return { key, shortname: f.shortname, colorChangeCount: f.colorChangeCount, copies: f.copies };
    });
    poolImages = (item.imageFiles || []).map((name) => ({ kind: 'existing', name }));
    renderImagesSection();
  }

  // 'add' needs a source folder before there's anything to name/tag in
  // the first place -- pick it right away, and back out of the whole
  // editor if the co-admin cancels the folder dialog rather than
  // showing an empty form with nothing to attach it to.
  let sourceDir = null;

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'settings-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save to pending';
  saveBtn.onclick = async () => {
    const name = nameField.input.value.trim();
    const tags = tagsField.input.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const printFileImages = {};
    for (const [key, refs] of Object.entries(imageAssignments)) {
      if (refs.length > 0) printFileImages[key] = refs;
    }
    // { url } only -- writeItemMetadata merges this onto whatever
    // origin block already exists (see itemMetadata.js), so this
    // can't clobber a creatorName/creatorUrl a future scrape pass adds,
    // and an emptied field still overwrites url specifically (co-admin
    // clearing a wrong auto-detected/guessed link).
    const origin = { url: originField.input.value.trim() };

    try {
      const result =
        mode === 'add'
          ? await window.catalogAPI.editSessionCommitAdd(sourceDir, { name, tags, printFileImages, origin })
          : await window.catalogAPI.editSessionCommitEdit(item.path, { name, tags, printFileImages, origin });
      pendingChanges = result.changes;
      allItems = result.tree;
      document.body.removeChild(overlay);
      renderPrinterFilter();
      renderTagFilter();
      render();
    } catch (err) {
      alert(err.message);
    }
  };
  buttonsRow.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => document.body.removeChild(overlay);
  buttonsRow.appendChild(cancelBtn);

  box.appendChild(buttonsRow);
  overlay.appendChild(box);

  if (mode === 'add') {
    const preparePromise = prefilledSourceDir
      ? window.catalogAPI.editSessionPrepareAddFolder(prefilledSourceDir)
      : window.catalogAPI.editSessionPickAddFolder();
    preparePromise
      .then((picked) => {
        if (!picked) return; // cancelled the folder dialog -- never show the form
        sourceDir = picked.sourceDir;
        nameField.input.value = picked.suggestedName;
        originField.input.value = picked.originUrl || '';
        folderUrl = `file://${sourceDir}`;
        printFiles = picked.printFiles.map((f) => ({
          key: f.name,
          shortname: f.shortname,
          colorChangeCount: f.colorChangeCount,
          copies: f.copies,
        }));
        poolImages = picked.imageFiles.map((name) => ({ kind: 'existing', name }));
        renderImagesSection();
        document.body.appendChild(overlay);
      })
      .catch((err) => alert(err.message)); // e.g. a dropped path that wasn't actually a folder
  } else {
    document.body.appendChild(overlay);
  }
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
  openItemEditor('add', null, sourceDir);
});

init();
