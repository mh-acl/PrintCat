'use strict';

// Flat filtering UI: no navigation, no breadcrumbs, no categories. Two
// independent filter rows (Printers, Tags) narrow down a single flat
// grid of items; clicking an item shows its print files.
// Tags come from each item's metadata.json (see itemMetadata.js) --
// an item can carry any number of them, but the tag filter itself is
// single-select: clicking a tag pill switches the filter to just that
// tag (replacing whatever was selected before) rather than adding it
// to a set, and clicking the active tag again clears back to "All
// Tags". selectedTags is still a Set under the hood (0 or 1 entries)
// so itemMatchesTags()'s OR-match logic didn't need to change. The
// printer filter is unaffected and remains multi-select OR.

let allItems = [];
let selectedPrinters = new Set(); // empty = no restriction chosen ("All Printers")
let selectedTags = new Set(); // empty = no restriction chosen ("All Tags")
let keywordQuery = ''; // raw text from the search box; '' = no restriction
let settings = { availablePrinters: [], hideUnavailable: false, gitRepoUrl: '', gitBranch: '' };
let syncStatus = { configured: false, lastSuccessAt: null, inProgress: false, pausedForEdit: false };

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

function onKeywordInput(e) {
  keywordQuery = e.target.value;
  // Tag pill counts fold in the keyword filter too (see
  // countItemsForTag), so they need a re-render on every
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

// Total matching *items* for one tag pill's count -- deliberately
// mirrors the exact predicate render() uses to build visibleItems
// (itemMatchesPrinter + itemMatchesKeyword), so this number matches
// what you'd actually see in the grid after clicking the tag. Items
// have multiple print files each, so counting files here (the
// previous behavior) could show a much bigger number than the item
// count you'd actually land on. Not folded through itemMatchesTags
// itself since the tag being counted is the one being tested, and not
// itemMatchesSmartTags since that's edit-session-only and unrelated to
// what a tag pill represents.
function countItemsForTag(items, printerSet, tagValue, query) {
  let total = 0;
  for (const item of items) {
    if (!(item.tags || []).includes(tagValue)) continue;
    if (!itemMatchesPrinter(item, printerSet)) continue;
    if (!itemMatchesKeyword(item, query)) continue;
    total++;
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
      const count = countItemsForTag(allItems, effective, tag, keywordQuery);
      const btn = document.createElement('button');
      btn.textContent = `${tag} (${count})`;
      btn.className = 'filter-pill' + (selectedTags.has(tag) ? ' active' : '');
      btn.onclick = () => {
        // Single-select: clicking a tag switches the filter to just that
        // tag, replacing whatever was selected before. Clicking the
        // already-active tag clears back to "All Tags". (Previously this
        // toggled the tag in/out of a multi-select OR set -- see
        // ARCHITECTURE.md's "Tag filter: single-select" note.)
        if (selectedTags.has(tag)) {
          selectedTags = new Set();
        } else {
          selectedTags = new Set([tag]);
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

// Footer note (plus the refresh-now button next to it) showing how
// fresh the catalog data is. The whole footer is hidden entirely when
// git sync isn't configured at all (a plain local DATA_DIR has no
// "refresh" concept to report on, and nothing for the button to
// trigger); otherwise shows the last successful sync, plus "Refresh in
// progress..." while one's actively running -- whether that run was
// kicked off by this button, the timed auto-refresh, or the
// launch-time sync.
function renderSyncStatus() {
  const footer = document.getElementById('sync-footer');
  const el = document.getElementById('sync-status');
  const refreshBtn = document.getElementById('refresh-now-btn');
  if (!footer || !el) return;

  if (!syncStatus.configured) {
    footer.style.display = 'none';
    el.textContent = '';
    return;
  }
  footer.style.display = 'flex';

  if (refreshBtn) {
    refreshBtn.disabled = syncStatus.inProgress || syncStatus.pausedForEdit;
    refreshBtn.classList.toggle('spinning', syncStatus.inProgress);
  }

  // Sync is skipped entirely (see main.js's runCatalogSync) while a
  // co-admin has an edit session open -- a git reset --hard/clean -fd
  // mid-session would silently wipe their staged adds/edits. Say so
  // explicitly rather than leaving the button greyed out with no
  // explanation.
  if (syncStatus.pausedForEdit) {
    el.textContent = 'Catalog refresh paused while editing';
    return;
  }

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

// A small magnifying-glass button that sits over a thumbnail (see
// CSS .thumb-zoom-btn -- hidden until the containing .thumb-slot /
// .file-thumb-wrap is hovered). getSrc is a function rather than a
// plain string so the click handler always reads whatever src the
// <img> currently has, even though the button is created before the
// thumbnail promise resolves.
function makeZoomButton(getSrc, altText) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb-zoom-btn';
  btn.title = 'View full size';
  btn.setAttribute('aria-label', 'View full size image');
  btn.textContent = '🔍';
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openImageLightbox(getSrc(), altText);
  };
  return btn;
}

// Full-size image viewer opened by the zoom button. Dismissed via its
// close button, clicking the dimmed backdrop, or Escape.
function openImageLightbox(src, altText) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox-overlay';

  const box = document.createElement('div');
  box.className = 'image-lightbox-box';

  const img = document.createElement('img');
  img.src = src;
  img.alt = altText || '';
  box.appendChild(img);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-lightbox-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u00d7';
  box.appendChild(closeBtn);

  const close = () => {
    if (overlay.parentNode) document.body.removeChild(overlay);
    document.removeEventListener('keydown', onKeydown);
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') close();
  };

  closeBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.addEventListener('keydown', onKeydown);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function renderItemCard(item) {
  const change = pendingChanges[item.path];
  const isTrashed = change && change.type === 'delete';

  const card = document.createElement('a');
  card.className = 'listing' + (change ? ` pending-${change.type}` : '');
  card.href = '#';
  card.title = item.displayName || item.name;
  card.onclick = (e) => {
    e.preventDefault();
    // In edit mode, display mode isn't a separate thing -- a card only
    // ever opens for editing (see prior design discussion re: unifying
    // "click a card in edit mode" with "click a card, then hit Edit").
    openItemModal(item, editModeActive ? 'edit' : 'view');
  };

  if (editModeActive) {
    const trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    trashBtn.className = 'item-trash-btn';
    trashBtn.title = isTrashed ? 'Restore this item' : 'Delete this item';
    trashBtn.setAttribute('aria-label', isTrashed ? 'Restore this item' : 'Delete this item');
    trashBtn.textContent = isTrashed ? '\u21a9\ufe0f' : '\ud83d\uddd1\ufe0f'; // \u21a9\ufe0f = Restore, \ud83d\uddd1\ufe0f = 🗑️
    trashBtn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      pendingChanges = isTrashed
        ? await window.catalogAPI.editSessionUndoDelete(item.path)
        : await window.catalogAPI.editSessionDeleteItem(item.path);
      renderTagFilter();
      render();
    };
    card.appendChild(trashBtn);
  }

  const mediaSlot = document.createElement('div');
  mediaSlot.className = 'thumb-slot';
  card.appendChild(mediaSlot);

  const img = document.createElement('img');
  img.alt = item.displayName || item.name;
  mediaSlot.appendChild(img);

  window.catalogAPI.getItemThumbnail(item).then((thumb) => {
    img.src = thumb ? `file://${thumb}` : 'nothumb.svg';
    // Only offer zoom when there's a real image -- not for the
    // generic "no thumbnail" placeholder graphic.
    if (thumb) {
      mediaSlot.appendChild(makeZoomButton(() => img.src, img.alt));
    }
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
  const line = document.createElement('small');
  line.className = 'item-origin-info';


  if (origin.creatorName) {
    line.appendChild(document.createTextNode('Created by '));
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
    line.appendChild(document.createTextNode(', from '));
  }
  // When there's no creator to credit, this stands alone as the whole
  // line rather than a trailing clause -- still needs its own lead-in.
  if (!origin.creatorName) {
    line.appendChild(document.createTextNode('From '));
  }

  const siteLink = document.createElement('a');
  siteLink.href = origin.url;
  siteLink.target = '_blank';
  siteLink.rel = 'noopener noreferrer';
  siteLink.textContent = label || 'the original site';
  line.appendChild(siteLink);

  return line;
}

// Tracks the currently open item modal (see openItemModal below), so
// the global "enter edit mode" listener (see init()) can transition an
// already-open view-mode modal into edit mode in place, rather than
// requiring the co-admin to close and reopen it -- per prior design
// discussion, entering edit mode while viewing an item should behave
// exactly as if they'd been in the main view and clicked to edit it.
let openModalHandle = null; // { itemPath, switchToEdit() } or null while nothing's open

// Builds the in-memory edit draft for an existing catalog item -- the
// shape mirrors what editSessionCommitEdit/editItem() already expect
// (see editSession.js), so saving is close to a direct passthrough.
// Pulled out to module scope (not nested in openItemModal) since
// add-mode's editor will need the equivalent construction later too.
function createDraftFromItem(item) {
  const imageFiles = item.imageFiles || [];
  return {
    displayName: item.displayName || item.name,
    tags: item.tags ? [...item.tags] : [],
    origin: item.origin ? { ...item.origin } : {},
    // Explicit metadata.json assignment wins, same as the main
    // process's resolveItemThumbnail -- but fall back to the
    // thumb.* filename convention (item.explicitThumb) before
    // giving up, so legacy items assigned that way don't lose their
    // image just because edit mode never used to look for it.
    itemImageRef: item.metadataItemImage
      ? { kind: 'existing', name: item.metadataItemImage }
      : item.explicitThumb
        ? { kind: 'existing', name: item.explicitThumb }
        : null,
    printFiles: item.files.map((f) => {
      const key = f.path.split(/[\\/]/).pop();
      const explicitImages = (f.metadataImages || []).map((name) => ({ kind: 'existing', name }));
      // Mirrors thumbnailResolver.js's resolveFileThumbnail
      // longname/shortname filename-matching fallback -- without it,
      // a legacy image that was only ever matched by filename (never
      // written into metadataImages) shows up as a broken image in
      // edit mode even though view mode resolves it fine via
      // getFileThumbnail. Everything this needs (longname/shortname,
      // the item's imageFiles) is already on the renderer's item
      // object, so no extra IPC round-trip is needed.
      const images =
        explicitImages.length > 0
          ? explicitImages
          : (() => {
              const matched = matchImageByFilename(f, imageFiles);
              return matched ? [{ kind: 'existing', name: matched }] : [];
            })();
      return {
        key,
        shortname: f.shortname,
        displayName: f.metadataDisplayName || null,
        printerModel: f.printerModel,
        printerVariant: f.printerVariant,
        colorChangeCount: f.colorChangeCount,
        copies: f.copies,
        images,
      };
    }),
    poolImages: imageFiles.map((name) => ({ kind: 'existing', name })),
  };
}

// Case-insensitive basename-without-extension match against a file
// entry's longname then shortname -- same precedence as
// thumbnailResolver.js's byBaseName lookup. Kept local to renderer.js
// (rather than shared with the main process) since it operates on
// plain strings already available client-side and the renderer has
// no access to Node's `path` module (contextIsolation/no
// nodeIntegration).
function matchImageByFilename(fileEntry, imageFiles) {
  const byBaseName = new Map(imageFiles.map((name) => [baseNameNoExt(name).toLowerCase(), name]));
  return (
    byBaseName.get(fileEntry.longname.toLowerCase()) ||
    byBaseName.get(fileEntry.shortname.toLowerCase()) ||
    null
  );
}

function baseNameNoExt(filename) {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? filename : filename.slice(0, idx);
}

// Builds the in-memory edit draft for a brand-new item, from the
// result of editSessionPrepareAddFolder/editSessionPickAddFolder (see
// main.js) -- same draft shape as createDraftFromItem above, just
// starting from a freshly-scanned folder instead of an existing
// catalog entry (no tags, no display-name overrides, no image
// assignments yet).
function createDraftFromPicked(picked) {
  const imageFiles = picked.imageFiles || [];
  return {
    displayName: picked.suggestedName,
    tags: [],
    origin: picked.origin ? { ...picked.origin } : {},
    // Same explicit-metadata-first, thumb.*-convention-fallback
    // precedence as createDraftFromItem above -- there's no
    // metadata.json yet for a freshly-scanned folder, so this only
    // ever resolves via picked.explicitThumb.
    itemImageRef: picked.explicitThumb ? { kind: 'existing', name: picked.explicitThumb } : null,
    printFiles: picked.printFiles.map((f) => {
      // Same longname/shortname filename-matching fallback as
      // createDraftFromItem above -- a freshly-scanned folder can
      // already contain legacy filename-matched images (e.g. an old
      // folder being (re)added that predates metadata.json), and
      // without this they'd show up broken in the add-mode editor
      // exactly like the edit-mode bug this mirrors.
      const matched = matchImageByFilename(f, imageFiles);
      return {
        key: f.name,
        shortname: f.shortname,
        displayName: null,
        printerModel: f.printerModel,
        printerVariant: f.printerVariant,
        colorChangeCount: f.colorChangeCount,
        copies: f.copies,
        images: matched ? [{ kind: 'existing', name: matched }] : [],
      };
    }),
    poolImages: imageFiles.map((name) => ({ kind: 'existing', name })),
  };
}

// Small standalone popup for hand-editing/reviewing origin info --
// used identically by both the pencil icon (prefilled with the
// draft's current url/creatorName/creatorUrl) and the reparse icon
// (prefilled with freshly detected values for review). Nothing writes
// back to the caller's draft except via an explicit Save here -- see
// prior design discussion for why this replaced the old "does the URL
// still match what was last detected" heuristic.
function openOriginEditPopup(prefill, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'drive-picker-overlay origin-popup-overlay';

  const box = document.createElement('div');
  box.className = 'drive-picker-box settings-box';

  const title = document.createElement('h3');
  title.textContent = 'Original location & creator';
  box.appendChild(title);

  const urlField = createSettingsTextField(
    'Original Location URL',
    prefill.url,
    'https://www.thingiverse.com/thing/...'
  );
  box.appendChild(urlField.wrap);

  const nameField = createSettingsTextField('Creator name', prefill.creatorName, 'jane_maker');
  box.appendChild(nameField.wrap);

  const creatorUrlField = createSettingsTextField(
    'Creator profile URL',
    prefill.creatorUrl,
    'https://www.thingiverse.com/jane_maker'
  );
  box.appendChild(creatorUrlField.wrap);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'settings-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.onclick = () => {
    onSave({
      url: urlField.input.value.trim(),
      creatorName: nameField.input.value.trim(),
      creatorUrl: creatorUrlField.input.value.trim(),
    });
    document.body.removeChild(overlay);
  };
  buttonsRow.appendChild(saveBtn);

  const discardBtn = document.createElement('button');
  discardBtn.className = 'cancel';
  discardBtn.textContent = 'Discard';
  discardBtn.onclick = () => document.body.removeChild(overlay);
  buttonsRow.appendChild(discardBtn);

  box.appendChild(buttonsRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// Opens an item modal, replacing both the old selectedItem/"back to
// browsing" in-place navigation (stage 1) and openItemEditor entirely
// (stage 2 folded in 'edit', this pass folds in 'add' -- the
// standalone openItemEditor function is removed below). The main grid
// behind it is never touched -- closing the modal just removes the
// overlay, so there's nothing to restore.
//
// item is null for 'add' (mirroring openItemEditor's old signature);
// prefilledSourceDir carries a dropped folder path straight through to
// the same editSessionPrepareAddFolder IPC as before, skipping the
// folder-picker dialog.
function openItemModal(item, initialMode, prefilledSourceDir) {
  let mode = initialMode;
  let draft = null; // built once the item (or, for 'add', the picked folder) is known
  let selectedTargets = new Set(); // 'item', or a print-file key -- edit/add mode only
  let editTagsField = null; // the edit-mode tag chip input, so Save can read its current tags
  let refreshEditFilesArea = () => {}; // rebuilds just the file cards + gallery, set by buildEditRoot()
  let sourceDir = item ? item.path : null; // becomes known for 'add' once the folder's picked, below
  let folderUrl = item ? `file://${item.path}` : null;

  const overlay = document.createElement('div');
  overlay.className = 'drive-picker-overlay item-modal-overlay';

  const box = document.createElement('div');
  box.className = 'drive-picker-box settings-box item-modal-box';
  overlay.appendChild(box);

  const topBar = document.createElement('div');
  topBar.className = 'item-modal-topbar';
  box.appendChild(topBar);

  const content = document.createElement('div');
  box.appendChild(content);

  function close() {
    if (overlay.parentNode) document.body.removeChild(overlay);
    document.removeEventListener('keydown', onKeydown);
    if (item && openModalHandle && openModalHandle.itemPath === item.path) openModalHandle = null;
  }
  // Escape only dismisses in view mode -- in edit/add mode it would
  // silently discard an in-progress draft with no confirmation, unlike
  // the explicit Cancel button.
  function onKeydown(e) {
    if (e.key === 'Escape' && mode === 'view') close();
  }
  document.addEventListener('keydown', onKeydown);
  overlay.onclick = (e) => {
    if (e.target === overlay && mode === 'view') close();
  };

  function renderTopBar() {
    topBar.innerHTML = '';
    if (mode === 'view') {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'item-modal-close';
      closeBtn.textContent = '\u2039 Close';
      closeBtn.onclick = close;
      topBar.appendChild(closeBtn);
    } else {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'item-modal-close cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = close;
      topBar.appendChild(cancelBtn);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'item-modal-close save';
      saveBtn.textContent = 'Save to pending';
      saveBtn.onclick = saveDraft;
      topBar.appendChild(saveBtn);
    }
  }

  function renderContent() {
    content.innerHTML = '';
    if (mode === 'view') {
      const effective = effectivePrinterFilter();
      let matchingFiles =
        effective && effective.size > 0 ? item.files.filter((f) => effective.has(printerLabel(f))) : item.files;
      matchingFiles = matchingFiles.filter((f) => fileMatchesKeywordInItem(item, f, keywordQuery));
      if (matchingFiles.length === 0) {
        content.appendChild(
          renderEmptyState(
            keywordQuery
              ? 'No print files here match your search. Try a different keyword, or clear the search box.'
              : 'This isn\'t sliced for the selected printer(s). Try picking a different printer, or choose "All Printers" to see every version.'
          )
        );
      } else {
        content.appendChild(renderItemDetail({ ...item, files: matchingFiles }));
      }
    } else {
      content.appendChild(buildEditRoot());
    }
  }

  // --- Edit-mode image-assignment helpers -------------------------------
  // Mirror openItemEditor's assignRefToFile/addExternalToPool/
  // suggestBatchShare, adapted for the draft object and for
  // multi-target assignment (assignImageToTargets) alongside the
  // existing single-target drag-and-drop path (assignSingleTargetImage).

  function suggestBatchShareForDraft(justAssignedKey, ref) {
    const source = draft.printFiles.find((f) => f.key === justAssignedKey);
    if (!source || source.colorChangeCount === null) return;
    for (const target of draft.printFiles) {
      if (target.key === justAssignedKey) continue;
      if (target.colorChangeCount !== source.colorChangeCount) continue;
      if (strippedBatchName(target.key) !== strippedBatchName(source.key)) continue;
      if (target.images.some((r) => imageRefEquals(r, ref))) continue;
      const share = confirm(
        `"${target.shortname}" looks like a variant of "${source.shortname}" (same color changes) -- share this image with it too?`
      );
      if (share) target.images.push(ref);
    }
  }

  function assignSingleTargetImage(targetId, ref) {
    if (targetId === 'item') {
      draft.itemImageRef = ref;
    } else {
      const pf = draft.printFiles.find((f) => f.key === targetId);
      if (!pf || pf.images.some((r) => imageRefEquals(r, ref))) return;
      pf.images.push(ref);
      suggestBatchShareForDraft(targetId, ref);
    }
    refreshEditFilesArea();
  }

  // The arrow-button path: assigns one image to every currently
  // selected target at once (item thumbnail chip and/or print-file
  // cards) -- see prior design discussion for why this stays
  // multi-target rather than one-at-a-time (preserves the
  // batch-photo-sharing workflow).
  function assignImageToTargets(ref) {
    for (const targetId of selectedTargets) assignSingleTargetImage(targetId, ref);
  }

  function addExternalToPoolDraft(extPath, name) {
    const existing = draft.poolImages.find((r) => r.kind === 'external' && r.path === extPath);
    if (existing) return existing;
    const ref = { kind: 'external', path: extPath, name };
    draft.poolImages.push(ref);
    return ref;
  }

  // --- Edit-mode DOM builders ---------------------------------------------

  function buildItemThumbChip() {
    const chip = document.createElement('div');
    chip.className = 'item-modal-thumb-chip' + (selectedTargets.has('item') ? ' selected' : '');
    chip.ondragover = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    chip.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        const f = files[0];
        if (isImageFileName(f.name)) {
          assignSingleTargetImage('item', addExternalToPoolDraft(window.catalogAPI.getPathForFile(f), f.name));
        }
      } else {
        const idx = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isNaN(idx) && draft.poolImages[idx]) assignSingleTargetImage('item', draft.poolImages[idx]);
      }
    };

    const selectToggle = document.createElement('input');
    selectToggle.type = 'checkbox';
    selectToggle.className = 'item-modal-target-select';
    selectToggle.title = 'Select as an image-assignment target';
    selectToggle.checked = selectedTargets.has('item');
    selectToggle.onchange = () => {
      if (selectToggle.checked) selectedTargets.add('item');
      else selectedTargets.delete('item');
      refreshEditFilesArea();
    };
    chip.appendChild(selectToggle);

    const img = document.createElement('img');
    img.src = draft.itemImageRef ? imageRefSrc(draft.itemImageRef, folderUrl) : 'nothumb.svg';
    img.alt = 'Item image';
    chip.appendChild(img);

    if (draft.itemImageRef) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'item-modal-chip-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove item image';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        draft.itemImageRef = null;
        refreshEditFilesArea();
      };
      chip.appendChild(removeBtn);
    }

    return chip;
  }

  function buildPrintFileCard(pf) {
    const card = document.createElement('div');
    card.className = 'item-modal-file-card' + (selectedTargets.has(pf.key) ? ' selected' : '');
    card.ondragover = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    card.ondragenter = () => card.classList.add('drop-target-active');
    card.ondragleave = (e) => {
      if (!card.contains(e.relatedTarget)) card.classList.remove('drop-target-active');
    };
    card.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drop-target-active');
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        for (const f of files) {
          if (!isImageFileName(f.name)) continue;
          assignSingleTargetImage(pf.key, addExternalToPoolDraft(window.catalogAPI.getPathForFile(f), f.name));
        }
      } else {
        const idx = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isNaN(idx) && draft.poolImages[idx]) assignSingleTargetImage(pf.key, draft.poolImages[idx]);
      }
    };

    const selectToggle = document.createElement('input');
    selectToggle.type = 'checkbox';
    selectToggle.className = 'item-modal-target-select';
    selectToggle.title = 'Select as an image-assignment target';
    selectToggle.checked = selectedTargets.has(pf.key);
    selectToggle.onchange = () => {
      if (selectToggle.checked) selectedTargets.add(pf.key);
      else selectedTargets.delete(pf.key);
      refreshEditFilesArea();
    };
    card.appendChild(selectToggle);

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'file-thumb-wrap';
    const img = document.createElement('img');
    img.alt = pf.displayName || pf.shortname;
    img.src = pf.images.length > 0 ? imageRefSrc(pf.images[0], folderUrl) : 'nothumb.svg';
    thumbWrap.appendChild(img);
    card.appendChild(thumbWrap);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'item-modal-file-name-input';
    nameInput.value = pf.displayName || pf.shortname;
    nameInput.title = pf.key;
    nameInput.oninput = () => {
      pf.displayName = nameInput.value;
    };
    card.appendChild(nameInput);

    const subtitleParts = [
      pf.copies && pf.copies > 1 ? `batch of ${pf.copies}` : null,
      pf.colorChangeCount
        ? `${pf.colorChangeCount} color change${pf.colorChangeCount === 1 ? '' : 's'}`
        : null,
      pf.printerModel ? [pf.printerModel, pf.printerVariant].filter(Boolean).join(' ') : null,
    ].filter(Boolean);
    if (subtitleParts.length) {
      const subtitle = document.createElement('p');
      subtitle.className = 'file-subtitle';
      subtitle.textContent = subtitleParts.join(', ');
      card.appendChild(subtitle);
    }

    const chips = document.createElement('div');
    chips.className = 'editor-image-chips';
    pf.images.forEach((ref, idx) => {
      const chip = document.createElement('span');
      chip.className = 'editor-image-chip';
      const chipImg = document.createElement('img');
      chipImg.src = imageRefSrc(ref, folderUrl);
      chip.appendChild(chipImg);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        pf.images.splice(idx, 1);
        refreshEditFilesArea();
      };
      chip.appendChild(removeBtn);
      chips.appendChild(chip);
    });
    card.appendChild(chips);

    return card;
  }

  function buildGalleryColumn() {
    const col = document.createElement('div');
    col.className = 'item-modal-edit-gallery';
    col.ondragover = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    col.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return; // in-app drags only make sense onto a target, not back onto the gallery
      for (const f of files) {
        if (!isImageFileName(f.name)) continue;
        addExternalToPoolDraft(window.catalogAPI.getPathForFile(f), f.name);
      }
      refreshEditFilesArea();
    };

    const heading = document.createElement('p');
    heading.className = 'item-modal-gallery-heading';
    heading.textContent = 'Available images';
    col.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'settings-intro';
    hint.textContent =
      selectedTargets.size > 0
        ? `Click \u2190 on an image to assign it to ${selectedTargets.size} selected target${
            selectedTargets.size === 1 ? '' : 's'
          }.`
        : 'Select the item image and/or one or more print files, then click \u2190 on an image to assign it. Drag-and-drop also works.';
    col.appendChild(hint);

    const grid = document.createElement('div');
    grid.className = 'item-modal-gallery-grid';
    if (draft.poolImages.length === 0) {
      const none = document.createElement('p');
      none.className = 'settings-intro';
      none.textContent = 'No images yet -- use "Add image" below, or drag images in.';
      grid.appendChild(none);
    }
    draft.poolImages.forEach((ref, idx) => {
      const cell = document.createElement('div');
      cell.className = 'item-modal-gallery-item';

      const thumb = document.createElement('img');
      thumb.className = 'item-modal-gallery-thumb';
      thumb.src = imageRefSrc(ref, folderUrl);
      thumb.title = ref.name;
      thumb.draggable = true;
      thumb.ondragstart = (e) => e.dataTransfer.setData('text/plain', String(idx));
      cell.appendChild(thumb);

      const assignBtn = document.createElement('button');
      assignBtn.type = 'button';
      assignBtn.className = 'item-modal-assign-btn';
      assignBtn.title = 'Assign to selected target(s)';
      assignBtn.setAttribute('aria-label', 'Assign to selected targets');
      assignBtn.textContent = '\u2190';
      assignBtn.disabled = selectedTargets.size === 0;
      assignBtn.onclick = () => assignImageToTargets(ref);
      cell.appendChild(assignBtn);

      grid.appendChild(cell);
    });
    col.appendChild(grid);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'settings-action-button';
    addBtn.textContent = 'Add image\u2026';
    addBtn.onclick = async () => {
      const picked = await window.catalogAPI.editSessionBrowseImages();
      for (const p of picked) addExternalToPoolDraft(p.path, p.name);
      refreshEditFilesArea();
    };
    col.appendChild(addBtn);

    return col;
  }

  // Origin row is refreshed in place (not via the outer renderContent)
  // so hand-editing/reparsing origin info doesn't rebuild the name
  // field or tag input and lose their focus/in-progress text.
  function renderOriginRow(container) {
    container.innerHTML = '';

    const info = document.createElement('span');
    info.className = 'item-modal-origin-summary';
    info.textContent = draft.origin.url
      ? draft.origin.creatorName
        ? `By ${draft.origin.creatorName} \u2014 ${draft.origin.url}`
        : draft.origin.url
      : 'No original location set.';
    container.appendChild(info);

    const pencilBtn = document.createElement('button');
    pencilBtn.type = 'button';
    pencilBtn.className = 'item-modal-origin-btn';
    pencilBtn.title = 'Edit original-location info';
    pencilBtn.setAttribute('aria-label', 'Edit original-location info');
    pencilBtn.textContent = '\u270e';
    pencilBtn.onclick = () => {
      openOriginEditPopup(
        {
          url: draft.origin.url || '',
          creatorName: draft.origin.creatorName || '',
          creatorUrl: draft.origin.creatorUrl || '',
        },
        (result) => {
          draft.origin = result;
          renderOriginRow(container);
        }
      );
    };
    container.appendChild(pencilBtn);

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'item-modal-origin-btn';
    refreshBtn.title = 'Reparse from folder';
    refreshBtn.setAttribute('aria-label', 'Reparse original-location info from folder');
    refreshBtn.textContent = '\u27f3';
    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      try {
        const detected = await window.catalogAPI.detectItemOrigin(sourceDir);
        if (detected && detected.url) {
          openOriginEditPopup(
            {
              url: detected.url || '',
              creatorName: detected.creatorName || '',
              creatorUrl: detected.creatorUrl || '',
            },
            (result) => {
              draft.origin = result;
              renderOriginRow(container);
            }
          );
        } else {
          alert("Couldn't detect anything from this item's folder.");
        }
      } catch (err) {
        alert(`Reparse failed: ${err.message}`);
      } finally {
        refreshBtn.disabled = false;
      }
    };
    container.appendChild(refreshBtn);
  }

  function buildEditRoot() {
    const root = document.createElement('div');
    root.className = 'item-modal-edit';

    if (mode === 'add') {
      const addLabel = document.createElement('p');
      addLabel.className = 'item-modal-add-label';
      addLabel.textContent = 'Add item';
      root.appendChild(addLabel);
    }

    const header = document.createElement('div');
    header.className = 'item-modal-edit-header';
    root.appendChild(header);

    const thumbChipHolder = document.createElement('div');
    thumbChipHolder.className = 'item-modal-thumb-chip-holder';
    header.appendChild(thumbChipHolder);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'item-modal-name-input';
    nameInput.value = draft.displayName;
    nameInput.placeholder = 'Item name';
    nameInput.oninput = () => {
      draft.displayName = nameInput.value;
    };
    header.appendChild(nameInput);

    const originRow = document.createElement('div');
    originRow.className = 'item-modal-origin-row';
    root.appendChild(originRow);
    renderOriginRow(originRow);

    const tagsWrapLabel = document.createElement('div');
    tagsWrapLabel.className = 'item-modal-tags-row';
    editTagsField = createTagInput('Tagged', draft.tags, () => Array.from(collectTags(allItems)).sort());
    tagsWrapLabel.appendChild(editTagsField.wrap);
    root.appendChild(tagsWrapLabel);

    const filesArea = document.createElement('div');
    filesArea.className = 'item-modal-edit-body';
    root.appendChild(filesArea);

    refreshEditFilesArea = () => {
      filesArea.innerHTML = '';
      thumbChipHolder.innerHTML = '';
      thumbChipHolder.appendChild(buildItemThumbChip());

      const filesCol = document.createElement('div');
      filesCol.className = 'item-modal-edit-files';
      for (const pf of draft.printFiles) filesCol.appendChild(buildPrintFileCard(pf));
      filesArea.appendChild(filesCol);

      filesArea.appendChild(buildGalleryColumn());
    };
    refreshEditFilesArea();

    return root;
  }

  async function saveDraft() {
    const tags = editTagsField.getTags();
    const printFileImages = {};
    const printFileNames = {};
    for (const pf of draft.printFiles) {
      if (pf.images.length > 0) printFileImages[pf.key] = pf.images;
      if (pf.displayName) printFileNames[pf.key] = pf.displayName;
    }
    const payload = {
      name: draft.displayName.trim(),
      tags,
      printFileImages,
      printFileNames,
      origin: draft.origin,
      itemImage: draft.itemImageRef,
    };
    try {
      const result =
        mode === 'add'
          ? await window.catalogAPI.editSessionCommitAdd(sourceDir, payload)
          : await window.catalogAPI.editSessionCommitEdit(sourceDir, payload);
      pendingChanges = result.changes;
      allItems = result.tree;
      close();
      renderPrinterFilter();
      renderTagFilter();
      render();
    } catch (err) {
      alert(err.message);
    }
  }

  // Flips this specific open modal into edit mode in place -- called
  // either immediately below (opened directly in edit mode) or later
  // by the global "enter edit mode" listener (see init()) if this
  // modal is still open in view mode when that happens. No-ops if
  // already in edit mode, since global edit mode can't newly engage
  // without this modal already having been opened while it was active.
  // Never relevant for 'add' -- that always starts in edit mode.
  function enterEditMode() {
    if (mode === 'edit') return;
    mode = 'edit';
    draft = createDraftFromItem(item);
    selectedTargets = new Set();
    renderTopBar();
    renderContent();
  }

  if (mode === 'add') {
    // Mirrors openItemEditor's old add-mode flow: the folder has to be
    // known before there's anything to name/tag, so pick/prepare it
    // first and never show the modal at all if that's cancelled.
    const preparePromise = prefilledSourceDir
      ? window.catalogAPI.editSessionPrepareAddFolder(prefilledSourceDir)
      : window.catalogAPI.editSessionPickAddFolder();
    preparePromise
      .then((picked) => {
        if (!picked) return; // cancelled the folder dialog -- never show the form
        sourceDir = picked.sourceDir;
        folderUrl = `file://${sourceDir}`;
        draft = createDraftFromPicked(picked);
        renderTopBar();
        renderContent();
        document.body.appendChild(overlay);
      })
      .catch((err) => alert(err.message)); // e.g. a dropped path that wasn't actually a folder
    return;
  }

  openModalHandle = { itemPath: item.path, switchToEdit: enterEditMode };

  if (mode === 'edit') draft = createDraftFromItem(item);

  renderTopBar();
  renderContent();
  document.body.appendChild(overlay);
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

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'file-thumb-wrap';

    const img = document.createElement('img');
    img.alt = file.shortname;
    thumbWrap.appendChild(img);

    window.catalogAPI.getFileThumbnail(file, item.imageFiles).then((thumbPath) => {
      img.src = thumbPath ? `file://${thumbPath}` : 'nothumb.svg';
      if (thumbPath) {
        thumbWrap.appendChild(makeZoomButton(() => img.src, img.alt));
      }
    });
    row.appendChild(thumbWrap);

    const name = document.createElement('h3');
    name.className = 'file-name';
    // Read-only: shows the resolved name (custom override if the
    // editor's pencil icon set one, else the parsed shortname), but
    // this view has no rename UI of its own -- that's editor-modal
    // only, per prior correction.
    name.textContent = file.metadataDisplayName || file.shortname;
    row.appendChild(name);

    // Batch/color-change info moved out of the metadata block into a
    // subtitle right under the file name -- these two are the "which
    // variant is this" signal, so they read as part of the file's
    // identity rather than a metadata line among printer/print-time.
    const subtitleParts = [
      file.copies && file.copies > 1 ? `batch of ${file.copies}` : null,
      file.colorChangeCount
        ? `${file.colorChangeCount} color change${file.colorChangeCount === 1 ? '' : 's'}`
        : null,
    ].filter(Boolean);
    if (subtitleParts.length) {
      const subtitle = document.createElement('p');
      subtitle.className = 'file-subtitle';
      subtitle.textContent = subtitleParts.join(', ');
      row.appendChild(subtitle);
    }

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const metaLines = [
      file.printerModel ? `Printer: ${file.printerModel}` : null,
      file.printTime ? `Print time: ${file.printTime}` : null,
      file.filamentType ? `Filament: ${formatFilamentTypes(file.filamentType)}, ${file.filamentUsedG}g` : null,
      // colorChangeCount/copies are now shown in the subtitle above,
      // not here -- see subtitleParts.
      // Rendered specially below (needs a tooltip icon for pause
      // messages, not just plain text) -- see the loop.
      file.pauseCount ? { pause: true, count: file.pauseCount, messages: file.pauseMessages || [] } : null,
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

// Chip-based tag input for the item editor -- replaces the old bare
// comma-separated text field. Two goals drove the design: (1) don't
// let a typo silently fork a new tag ("prnt" vs "print"), and (2)
// make it fast to find the tag you already mean rather than retyping
// it. getAllTags is a function (not a static array) so the dropdown
// always reflects the catalog's current tag vocabulary, including any
// tag created earlier in this same editing session.
//
// Existing tags matching the typed text are offered as ordinary
// suggestions; committing one (click, or Enter/ArrowKeys+Enter) never
// creates anything. A tag that doesn't match anything existing only
// appears as a distinctly-styled "+ Create new tag" suggestion, which
// requires being explicitly selected -- plain Enter with nothing typed
// does nothing, and comma only commits an exact existing match, never
// a new tag, so a mistyped tag followed by a comma doesn't quietly
// mint a near-duplicate.
function createTagInput(labelText, initialTags, getAllTags) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-field tag-input-field';

  const label = document.createElement('label');
  label.className = 'settings-field-label';
  label.textContent = labelText;
  wrap.appendChild(label);

  const box = document.createElement('div');
  box.className = 'tag-input-box';
  wrap.appendChild(box);

  const chipList = document.createElement('div');
  chipList.className = 'tag-chip-list';
  box.appendChild(chipList);

  // The typing input and its dropdown live in their own small
  // relatively-positioned wrapper (rather than the dropdown being
  // absolutely positioned against the whole field). That's what lets
  // the dropdown hang directly below the input itself -- sized to its
  // own content -- instead of stretching to cover the full width of
  // the field and everything below it.
  const inputWrap = document.createElement('div');
  inputWrap.className = 'tag-input-inline';
  box.appendChild(inputWrap);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input-text';
  input.placeholder = '+Tag'; // short on purpose -- anything longer overflows the chip-sized box
  input.size = 1; // overridden per-keystroke below; keeps the initial box small
  inputWrap.appendChild(input);

  const dropdown = document.createElement('div');
  dropdown.className = 'tag-suggestion-dropdown';
  dropdown.style.display = 'none';
  inputWrap.appendChild(dropdown);

  // Each tag is {value, isNew}. isNew marks a tag that didn't already
  // exist in the catalog when it was added in this session -- i.e. one
  // that saving will actually create -- so its chip can stay visually
  // flagged (amber/caution) versus an ordinary recognized tag (blue),
  // even after the dropdown has closed. Tags the item already had are
  // never "new" regardless of what's in the catalog right now.
  let tags = [...new Set((initialTags || []).map((t) => t.trim()).filter(Boolean))].map((value) => ({
    value,
    isNew: false,
  }));
  let suggestions = []; // [{kind: 'existing'|'create', value}]
  let highlightIndex = -1;

  function growInputToContent() {
    input.style.width = Math.max(4, input.value.length + 1) + 'ch';
  }

  function renderChips() {
    chipList.innerHTML = '';
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip' + (tag.isNew ? ' tag-chip-new' : ' tag-chip-existing');
      if (tag.isNew) chip.title = 'New tag -- will be created when you save';

      const text = document.createElement('span');
      text.textContent = tag.value;
      chip.appendChild(text);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-chip-remove';
      remove.textContent = '\u00d7';
      remove.title = `Remove tag "${tag.value}"`;
      remove.setAttribute('aria-label', `Remove tag ${tag.value}`);
      remove.onclick = () => {
        tags = tags.filter((t) => t !== tag);
        renderChips();
        input.focus();
      };
      chip.appendChild(remove);

      chipList.appendChild(chip);
    }
  }

  function closeDropdown() {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    suggestions = [];
    highlightIndex = -1;
  }

  function commitTag(value, isNew) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!tags.some((t) => t.value.toLowerCase() === trimmed.toLowerCase())) {
      tags.push({ value: trimmed, isNew: Boolean(isNew) });
      renderChips();
    }
    input.value = '';
    growInputToContent();
    closeDropdown();
    input.focus();
  }

  // Rebuilds `suggestions` from the current input text. With nothing
  // typed, this shows a handful of existing tags to browse (so the
  // field doubles as a quick picker even before typing) rather than an
  // empty dropdown.
  //
  // The trailing row is one of three things: nothing (query is empty),
  // "+ Create" (query doesn't match any catalog tag at all), or
  // "Already tagged" (query exactly matches a tag this item already
  // has -- checked against `tags`, not just the catalog, so retyping
  // an already-added tag doesn't get offered back as something new to
  // create).
  function updateSuggestions() {
    const query = input.value.trim().toLowerCase();
    const catalogTags = getAllTags();
    const available = catalogTags.filter(
      (t) => !tags.some((existing) => existing.value.toLowerCase() === t.toLowerCase())
    );

    let filtered;
    if (!query) {
      filtered = available.slice(0, 8);
    } else {
      filtered = available
        .filter((t) => t.toLowerCase().includes(query))
        .sort((a, b) => {
          const aPrefix = a.toLowerCase().startsWith(query) ? 0 : 1;
          const bPrefix = b.toLowerCase().startsWith(query) ? 0 : 1;
          if (aPrefix !== bPrefix) return aPrefix - bPrefix;
          return a.localeCompare(b);
        });
    }

    suggestions = filtered.map((t) => ({ kind: 'existing', value: t }));

    if (query) {
      const alreadyAdded = tags.some((t) => t.value.toLowerCase() === query);
      if (alreadyAdded) {
        suggestions.push({ kind: 'already-added', value: input.value.trim() });
      } else if (!catalogTags.some((t) => t.toLowerCase() === query)) {
        suggestions.push({ kind: 'create', value: input.value.trim() });
      }
    }

    renderDropdown();
  }

  function renderDropdown() {
    dropdown.innerHTML = '';
    if (suggestions.length === 0) {
      dropdown.style.display = 'none';
      highlightIndex = -1;
      return;
    }
    if (highlightIndex < 0 || highlightIndex >= suggestions.length) highlightIndex = 0;

    suggestions.forEach((s, i) => {
      const row = document.createElement('div');
      row.className =
        'tag-suggestion' +
        (s.kind === 'create' ? ' tag-suggestion-create' : '') +
        (s.kind === 'already-added' ? ' tag-suggestion-info' : '') +
        (i === highlightIndex ? ' active' : '');
      if (s.kind === 'create') row.textContent = `+ Create \u201c${s.value}\u201d`;
      else if (s.kind === 'already-added') row.textContent = `Already tagged \u201c${s.value}\u201d`;
      else row.textContent = s.value;
      // mousedown (not click) + preventDefault so this fires before the
      // input's blur would otherwise tear the dropdown down. Committing
      // an 'already-added' value is a harmless no-op in commitTag (it's
      // already in `tags`) -- this just clears the draft, same as
      // dismissing it.
      row.onmousedown = (e) => {
        e.preventDefault();
        commitTag(s.value, s.kind === 'create');
      };
      dropdown.appendChild(row);
    });
    dropdown.style.display = '';
  }

  input.addEventListener('input', () => {
    highlightIndex = -1;
    growInputToContent();
    updateSuggestions();
  });

  input.addEventListener('focus', () => updateSuggestions());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      highlightIndex = (highlightIndex + 1) % suggestions.length;
      renderDropdown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      highlightIndex = (highlightIndex - 1 + suggestions.length) % suggestions.length;
      renderDropdown();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions.length > 0 && highlightIndex >= 0) {
        const s = suggestions[highlightIndex];
        commitTag(s.value, s.kind === 'create');
      }
    } else if (e.key === 'Tab') {
      // Tab only takes over when there's actually a draft in progress --
      // an empty box lets Tab do its normal job of moving focus to the
      // next field. With a draft present, treat it the same as Enter
      // (commit the highlighted suggestion) rather than tabbing away and
      // silently discarding what was typed.
      if (input.value.trim() && suggestions.length > 0 && highlightIndex >= 0) {
        e.preventDefault();
        const s = suggestions[highlightIndex];
        commitTag(s.value, s.kind === 'create');
      }
    } else if (e.key === ',') {
      e.preventDefault();
      // Comma is a fast "commit this exact tag" key, but deliberately
      // never creates one -- only an existing tag matching the typed
      // text (case-insensitively) commits here.
      const query = input.value.trim().toLowerCase();
      if (!query) return;
      const match = getAllTags().find((t) => t.toLowerCase() === query);
      if (match) commitTag(match, false);
    } else if (e.key === 'Escape') {
      closeDropdown();
    } else if (e.key === 'Backspace' && input.value === '' && tags.length > 0) {
      tags = tags.slice(0, -1);
      renderChips();
    }
  });

  input.addEventListener('blur', () => {
    // Short delay rather than acting immediately: guards against
    // browsers/platforms where a dropdown-row click still fires blur
    // before its own mousedown handler runs -- that handler calls
    // commitTag(), which clears the draft and refocuses the input
    // itself, so by the time this timeout fires, document.activeElement
    // is back on `input` and there's nothing left to discard.
    //
    // Otherwise, focus genuinely moved elsewhere (another field, tab
    // navigation) -- discard whatever partial tag text was left
    // in-progress, rather than leaving an orphaned draft chip behind.
    setTimeout(() => {
      if (document.activeElement !== input) {
        input.value = '';
        growInputToContent();
      }
      closeDropdown();
    }, 150);
  });

  renderChips();
  growInputToContent();

  return { wrap, getTags: () => tags.map((t) => t.value) };
}

// "Auto-refresh every: [n] [minutes/hours/days]" -- a plain
// number+unit picker rather than a specialized duration control, since
// nothing fancier is available in a bare HTML/Electron view. The
// number input and unit select are disabled together whenever the
// checkbox is unchecked, so it's visually clear they're inert without
// needing to remove them from the layout. Uses the class 'settings-field-line'
// to compactify the whole thing into one line, rather than spread over two.
function createAutoRefreshField(settings) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-field-line';

  const checkboxRow = document.createElement('label');
  checkboxRow.className = 'settings-checkbox-row';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = settings.autoRefreshEnabled;
  checkboxRow.appendChild(checkbox);
  checkboxRow.appendChild(document.createTextNode(' Auto-refresh every:'));
  wrap.appendChild(checkboxRow);

  const pickerRow = document.createElement('div');
  pickerRow.className = 'settings-auto-refresh-row';

  const numberInput = document.createElement('input');
  numberInput.type = 'number';
  numberInput.min = '1';
  numberInput.step = '1';
  numberInput.className = 'settings-number-input';
  numberInput.value = settings.autoRefreshValue || 2;
  pickerRow.appendChild(numberInput);

  const unitSelect = document.createElement('select');
  unitSelect.className = 'settings-unit-select';
  for (const unit of ['minutes', 'hours', 'days']) {
    const opt = document.createElement('option');
    opt.value = unit;
    opt.textContent = unit;
    unitSelect.appendChild(opt);
  }
  unitSelect.value = settings.autoRefreshUnit || 'hours';
  pickerRow.appendChild(unitSelect);

  wrap.appendChild(pickerRow);

  const syncDisabledState = () => {
    numberInput.disabled = !checkbox.checked;
    unitSelect.disabled = !checkbox.checked;
  };
  syncDisabledState();
  checkbox.addEventListener('change', syncDisabledState);

  return { wrap, checkbox, numberInput, unitSelect };
}

// Tab definitions for the (non-required) settings dialog. Kept as a
// flat list so adding a 4th/5th tab later (USB Wiper settings, a
// Tools-menu show/hide tab -- both still planned) is just appending an
// entry here, with no changes needed to the tab bar or panel-switching
// logic in openSettingsDialog() below. Each build() gets the
// (already-attached) panel element plus a shared ctx ({ allPrinters,
// overlay } -- overlay lets the Export/Import tab close and reopen the
// dialog after an import) and returns whatever handles the shared Save
// button needs to read back out of it at save time (an empty object
// for tabs, like Export/Import, that don't feed Save).
const SETTINGS_TABS = [
  { id: 'printer', label: 'Printer', build: (panel, ctx) => buildPrinterTabPanel(panel, ctx.allPrinters) },
  { id: 'data', label: 'Data Repository', build: (panel) => buildDataRepoTabPanel(panel) },
  { id: 'export-import', label: 'Export / Import', build: (panel, ctx) => buildExportImportTabPanel(panel, ctx.overlay) },
];

function buildPrinterTabPanel(panel, allPrinters) {
  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = 'Choose which printers this makerspace actually has.';
  panel.appendChild(intro);

  const checkboxEls = new Map();

  if (allPrinters.length === 0) {
    const none = document.createElement('p');
    none.className = 'settings-intro';
    none.textContent = 'No printers found in the catalog yet.';
    panel.appendChild(none);
  } else {
    for (const printer of allPrinters) {
      const row = document.createElement('label');
      row.className = 'settings-checkbox-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = settings.availablePrinters.includes(printer);
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + printer));
      panel.appendChild(row);
      checkboxEls.set(printer, cb);
    }
  }

  panel.appendChild(document.createElement('hr'));

  const hideRow = document.createElement('label');
  hideRow.className = 'settings-checkbox-row';
  const hideCb = document.createElement('input');
  hideCb.type = 'checkbox';
  hideCb.checked = settings.hideUnavailable;
  hideRow.appendChild(hideCb);
  hideRow.appendChild(document.createTextNode(' Hide unavailable printers'));
  panel.appendChild(hideRow);

  return { checkboxEls, hideCb };
}

function buildDataRepoTabPanel(panel) {
  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = "The git repository this makerspace's catalog data lives in.";
  panel.appendChild(intro);

  const repoField = createSettingsTextField(
    'Git Repository:',
    settings.gitRepoUrl,
    'https://github.com/example/catalog-data.git'
  );
  panel.appendChild(repoField.wrap);

  const branchField = createSettingsTextField('Branch:', settings.gitBranch, 'main');
  panel.appendChild(branchField.wrap);

  panel.appendChild(document.createElement('hr'));

  const autoRefreshField = createAutoRefreshField(settings);
  panel.appendChild(autoRefreshField.wrap);

  return { repoField, branchField, autoRefreshField };
}

// Export writes the current settings (plus, optionally, the GitHub
// sync token) to a JSON file the admin picks; import reads one back
// and applies it. All the actual file I/O and token handling happens
// in main.js (settings:export/settings:import/settings:confirmImportToken)
// -- this just drives the two admin-facing confirms and reflects the
// result. The token itself never passes through this function or any
// other renderer code: settings:export reads it directly into the
// exported file in the main process, and settings:import holds a
// just-read token back in the main process (pendingImportToken) until
// settings:confirmImportToken says whether to write it, so the only
// thing this code ever sees is a plain `hasToken` boolean.
//
// This tab doesn't feed the shared Save button (nothing here is a
// pending field to save -- export/import both act immediately), so it
// returns {} rather than field handles.
function buildExportImportTabPanel(panel, overlay) {
  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = 'Save these settings to a file, or load them from one -- handy when setting up a new laptop.';
  panel.appendChild(intro);

  const exportLabel = document.createElement('div');
  exportLabel.className = 'settings-field-label';
  exportLabel.textContent = 'Export';
  panel.appendChild(exportLabel);

  const tokenRow = document.createElement('label');
  tokenRow.className = 'settings-checkbox-row';
  const tokenCb = document.createElement('input');
  tokenCb.type = 'checkbox';
  tokenRow.appendChild(tokenCb);
  tokenRow.appendChild(document.createTextNode(' Include GitHub sync token (requires admin authorization)'));
  panel.appendChild(tokenRow);

  const exportStatus = document.createElement('p');
  exportStatus.className = 'settings-intro settings-export-import-status';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'settings-action-button';
  exportBtn.textContent = 'Export Settings…';
  exportBtn.onclick = async () => {
    exportStatus.textContent = '';
    try {
      const result = await window.catalogAPI.exportSettings({ includeToken: tokenCb.checked });
      if (result.cancelled) return;
      exportStatus.textContent = result.includedToken
        ? `Exported (with sync token) to ${result.path}`
        : `Exported to ${result.path}`;
    } catch (err) {
      exportStatus.textContent = `Export failed: ${err.message}`;
    }
  };
  panel.appendChild(exportBtn);
  panel.appendChild(exportStatus);

  panel.appendChild(document.createElement('hr'));

  const importLabel = document.createElement('div');
  importLabel.className = 'settings-field-label';
  importLabel.textContent = 'Import';
  panel.appendChild(importLabel);

  const importIntro = document.createElement('p');
  importIntro.className = 'settings-intro';
  importIntro.textContent = 'Importing overwrites the settings above with values from the chosen file.';
  panel.appendChild(importIntro);

  const importStatus = document.createElement('p');
  importStatus.className = 'settings-intro settings-export-import-status';

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'settings-action-button';
  importBtn.textContent = 'Import Settings…';
  importBtn.onclick = async () => {
    importStatus.textContent = '';
    if (!confirm('Import settings from a file? This replaces the current settings shown in this dialog.')) return;

    try {
      const result = await window.catalogAPI.importSettings();
      if (result.cancelled) return;

      settings = result.settings;

      let tokenImported = false;
      if (result.hasToken) {
        const wantsToken = confirm(
          "This file includes a GitHub sync token. Import it too?\n\nThis overwrites this laptop's current sync token and requires admin authorization."
        );
        const tokenResult = await window.catalogAPI.confirmImportToken(wantsToken);
        tokenImported = Boolean(tokenResult && tokenResult.ok);
      }

      importStatus.textContent = tokenImported ? 'Settings and sync token imported.' : 'Settings imported.';

      // Re-derive the active printer filter and rebuild the dialog from
      // scratch so every tab (printer checkboxes, repo fields, etc.)
      // reflects the just-imported values immediately, rather than
      // requiring the admin to close and reopen it to see them.
      applyDefaultPrinterFilter();
      renderPrinterFilter();
      renderTagFilter();
      render();
      document.body.removeChild(overlay);
      openSettingsDialog();

      if (result.needsRestart) {
        const restartNow = confirm(
          'Git repository settings changed. Print Catalog needs to restart for this to take effect.\n\nRestart now?'
        );
        if (restartNow) window.catalogAPI.relaunch();
      }
    } catch (err) {
      importStatus.textContent = `Import failed: ${err.message}`;
    }
  };
  panel.appendChild(importBtn);
  panel.appendChild(importStatus);

  return {};
}

// Lets the admin pick which printers this makerspace actually has, and
// whether to hide anything else entirely, plus the git repo/branch to
// sync catalog data from -- organized into tabs (see SETTINGS_TABS
// above) since this dialog is expected to grow more sections over
// time. Saves via IPC (persisted across launches), then re-derives the
// active filter from the new settings so printer changes take effect
// immediately. Git repo/branch changes require a restart (see main.js's
// settings:save handler), since DATA_DIR itself is only resolved once
// at startup.
//
// First-launch setup (opts.required) is handled by the separate,
// non-tabbed openRequiredSetupDialog() below instead of this function --
// see that function's comment for why.
function openSettingsDialog(opts = {}) {
  if (opts.required) {
    openRequiredSetupDialog();
    return;
  }

  const allPrinters = Array.from(collectPrinters(allItems)).sort();

  const overlay = document.createElement('div');
  overlay.className = 'drive-picker-overlay';

  const box = document.createElement('div');
  box.className = 'drive-picker-box settings-box';

  const title = document.createElement('h3');
  title.textContent = 'Settings';
  box.appendChild(title);

  const tabBar = document.createElement('div');
  tabBar.className = 'settings-tabs';
  box.appendChild(tabBar);

  const panelsWrap = document.createElement('div');
  panelsWrap.className = 'settings-tab-panels';
  box.appendChild(panelsWrap);

  const panelEls = {};
  const tabHandles = {};
  const ctx = { allPrinters, overlay };

  SETTINGS_TABS.forEach((tab, i) => {
    const panel = document.createElement('div');
    panel.className = 'settings-tab-panel';
    panel.style.display = i === 0 ? '' : 'none';
    panelsWrap.appendChild(panel);
    panelEls[tab.id] = panel;
    tabHandles[tab.id] = tab.build(panel, ctx);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-tab' + (i === 0 ? ' active' : '');
    btn.textContent = tab.label;
    btn.onclick = () => {
      tabBar.querySelectorAll('.settings-tab').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      Object.values(panelEls).forEach((el) => {
        el.style.display = 'none';
      });
      panel.style.display = '';
    };
    tabBar.appendChild(btn);
  });

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'settings-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.onclick = async () => {
    const { checkboxEls, hideCb } = tabHandles.printer;
    const { repoField, branchField, autoRefreshField } = tabHandles.data;

    const availablePrinters = allPrinters.filter((p) => checkboxEls.get(p).checked);
    // Fall back to 1 for a blank/zero/negative/non-numeric field rather
    // than saving something that'd make scheduleAutoRefresh() (main.js)
    // skip setting up the timer at all.
    const autoRefreshValue = Math.max(1, Math.round(Number(autoRefreshField.numberInput.value)) || 1);

    const { settings: saved, needsRestart } = await window.catalogAPI.saveSettings({
      availablePrinters,
      hideUnavailable: hideCb.checked,
      gitRepoUrl: repoField.input.value.trim(),
      gitBranch: branchField.input.value.trim(),
      autoRefreshEnabled: autoRefreshField.checkbox.checked,
      autoRefreshValue,
      autoRefreshUnit: autoRefreshField.unitSelect.value,
    });
    settings = saved;

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

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => {
    document.body.removeChild(overlay);
  };
  buttonsRow.appendChild(cancelBtn);

  box.appendChild(buttonsRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// First-launch setup when no repo is configured yet. Kept as a
// separate, non-tabbed dialog rather than folded into the tabbed
// openSettingsDialog() above: allItems is always [] at this point
// (init() skips getTree() when there's no repo configured), so there's
// no printer list to show, and no other tab's content would be
// meaningful yet either -- a tab bar with mostly-empty tabs ahead of
// the one field that actually matters here would just be confusing.
function openRequiredSetupDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'drive-picker-overlay';

  const box = document.createElement('div');
  box.className = 'drive-picker-box settings-box';

  const title = document.createElement('h3');
  title.textContent = 'Set Up Print Catalog';
  box.appendChild(title);

  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = "Enter the git repository this makerspace's catalog data lives in to get started.";
  box.appendChild(intro);

  const repoField = createSettingsTextField(
    'Git Repository:',
    settings.gitRepoUrl,
    'https://github.com/example/catalog-data.git'
  );
  box.appendChild(repoField.wrap);

  const branchField = createSettingsTextField('Branch:', settings.gitBranch, 'main');
  box.appendChild(branchField.wrap);

  box.appendChild(document.createElement('hr'));

  const autoRefreshField = createAutoRefreshField(settings);
  box.appendChild(autoRefreshField.wrap);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'settings-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.onclick = async () => {
    const gitRepoUrl = repoField.input.value.trim();

    // Required mode exists only because there's no repo configured --
    // saving without one would just land back in this same dialog on
    // next launch, so refuse instead of silently closing.
    if (!gitRepoUrl) {
      alert('Enter a git repository URL to continue.');
      return;
    }

    const autoRefreshValue = Math.max(1, Math.round(Number(autoRefreshField.numberInput.value)) || 1);

    await window.catalogAPI.saveSettings({
      availablePrinters: settings.availablePrinters || [],
      hideUnavailable: settings.hideUnavailable,
      gitRepoUrl,
      gitBranch: branchField.input.value.trim(),
      autoRefreshEnabled: autoRefreshField.checkbox.checked,
      autoRefreshValue,
      autoRefreshUnit: autoRefreshField.unitSelect.value,
    });

    // Nothing to show until the app relaunches with an indexer set up
    // against the new repo -- no "keep browsing" option makes sense
    // here the way it does for the normal settings dialog, so just
    // relaunch directly rather than asking.
    window.catalogAPI.relaunch();
  };
  buttonsRow.appendChild(saveBtn);

  // No Cancel -- there's nothing to fall back to (canceling out of an
  // unconfigured, empty catalog isn't a real option), so this dialog
  // can only be dismissed by saving.
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
  addBtn.onclick = () => openItemModal(null, 'add');
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

// "PLA,PLA" -> "PLA"; "PLA,PETG" -> "PLA/PETG". Order of first
// appearance is preserved; a single-material print's one entry
// passes through unchanged.
function formatFilamentTypes(raw) {
  const types = raw.split(',').map((t) => t.trim()).filter(Boolean);
  const unique = [...new Set(types)];
  return unique.join('/');
}

function imageRefSrc(ref, folderUrl) {
  return ref.kind === 'existing' ? `${folderUrl}/${ref.name}` : `file://${ref.path}`;
}

function imageRefEquals(a, b) {
  return a.kind === b.kind && (a.kind === 'existing' ? a.name === b.name : a.path === b.path);
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