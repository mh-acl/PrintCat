'use strict';

// Main catalog grid: the render() entry point, item cards, and the
// grid-level empty state / sync-status footer.
// Depends on: state.js, utils.js, filters.js (buildFilterMessage,
// effectivePrinterFilter, itemMatchesKeyword), lightbox.js (cropRectFor,
// makeZoomButton).

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
// Builds the "nothing matches" message for the main grid, checking each
// currently-active restriction (search text, tag filter, printer filter,
// print-time limit, and -- in edit mode -- the Pending/Edited/Trashed
// smart-tag filter)
// individually to see which one(s) are actually responsible for the
// empty grid, rather than always blaming the same one.
// In edit mode, search/tag/printer/print-time are never actually the reason
// the grid is empty anymore -- render() no longer filters by them
// there, only sorts/marks (see below) -- so their entries are skipped
// as "active" restrictions there; only the smart-tag filter, or a
// genuinely empty catalog, can produce an empty grid in edit mode.
function buildGridEmptyMessage(effectivePrinters, editMode) {
  const wouldMatchWithout = (overrides) => {
    const printers = overrides.printers ?? effectivePrinters;
    // 'maxMinutes' in overrides, not ??: null is itself the override
    // value here ("no limit"), which ?? would mistake for "not overridden".
    const maxMinutes = 'maxMinutes' in overrides ? overrides.maxMinutes : printTimeLimitMinutes;
    return allItems.some(
      (item) =>
        itemMatchesPrinter(item, printers) &&
        itemMatchesPrintTime(item, printers, maxMinutes) &&
        itemMatchesTags(item, overrides.tags ?? selectedTags) &&
        itemMatchesSmartTags(item, overrides.smartTags ?? selectedSmartTags) &&
        itemMatchesKeyword(item, overrides.keyword ?? keywordQuery)
    );
  };

  return buildFilterMessage(
    [
      {
        active: !editMode && Boolean(keywordQuery),
        wouldHelp: () => wouldMatchWithout({ keyword: '' }),
        suggestion: 'try a different search term, or clear the search box',
      },
      {
        active: !editMode && selectedTags.size > 0,
        wouldHelp: () => wouldMatchWithout({ tags: new Set() }),
        suggestion: 'choose "All Tags"',
      },
      {
        active: !editMode && effectivePrinters.size > 0,
        wouldHelp: () => wouldMatchWithout({ printers: new Set() }),
        suggestion: 'choose "All Printers"',
      },
      {
        active: !editMode && printTimeLimitMinutes != null,
        wouldHelp: () => wouldMatchWithout({ maxMinutes: null }),
        suggestion: 'choose a longer print time, or "Any length"',
      },
      {
        active: selectedSmartTags.size > 0,
        wouldHelp: () => wouldMatchWithout({ smartTags: new Set() }),
        suggestion: 'clear the Pending/Edited/Trashed filter',
      },
    ],
    'There are no items in the catalog yet.',
    'Nothing matches the current search and filters together. Try loosening more than one at a time.'
  );
}
// True if this item would actually appear under plain (non-edit-mode)
// browsing rules -- printer/print-time/tag/keyword, but deliberately not the
// Pending/Edited/Trashed smart-tag filter, which is an edit-mode tool
// for finding changes rather than a "would a visitor see this" check
// and stays a strict filter regardless (see render() below).
function itemWouldShowInBrowsing(item, effective) {
  return (
    itemMatchesPrinter(item, effective) &&
    itemMatchesPrintTime(item, effective, printTimeLimitMinutes) &&
    itemMatchesTags(item, selectedTags) &&
    itemMatchesKeyword(item, keywordQuery)
  );
}
// Numeric sort key per mode ('name' is handled separately in
// compareByMode below, as a string compare rather than a numeric
// key). null means "unknown" and is handled as its own case in
// compareByMode so it consistently sorts to the end regardless of
// sortReverse (state.js), rather than jumping to the front when the
// direction flips.
//
// 'recent' is the most recent addedAt (indexer.js's per-file
// timestamp) among only the files that would currently show for this
// item -- filesMatchingCurrentFilters (filters.js), which folds in
// both the printer filter and the ambient keyword search -- not a
// flat item-level date, so an item whose *matching* files are all old
// sorts as old even if some other, currently-hidden file of its was
// added recently.
//
// 'time' is fixed to the shortest print time (printTimeRangeSeconds's
// .min) among the files that would currently print on the selected
// printer(s) -- filesMatchingPrinterAndTime (filters.js), deliberately
// not narrowed by keyword (see that function's comment) -- no matter
// which direction is active. That's a deliberate choice over using
// .min ascending / .max descending: that would make Reverse change
// what an item is being sorted *by*, not just the order, which would
// break Reverse's meaning as a uniform modifier across all three sort
// modes. The full min-max range (over that same printer-filtered file
// set) is still shown on every card regardless of sort (see
// buildItemCardMetaText) so that information isn't lost, just moved
// from the sort key to the display.
//
// The one exception: while the print-time filter is active (state.js's
// printTimeLimitMinutes), the 'time' key becomes the *longest* file
// still within the limit instead -- what the filter's auto-sort
// (filters.js's onPrintTimeFilterChanged) exists to surface is the
// prints closest to the limit without going over, and an item with a
// 20m file and a 1h55m file under a 2h limit should rank by its 1h55m
// option, not its 20m one. It's still a single fixed value per item
// regardless of direction, so Reverse keeps its plain meaning.
function sortKeyForItem(item) {
  const effective = effectivePrinterFilter();
  if (sortMode === 'recent') {
    return latestAddedAtMs(filesMatchingCurrentFilters(item, effective));
  }
  if (sortMode === 'time') {
    const files = filesMatchingPrinterAndTime(item, effective);
    if (printTimeLimitMinutes != null) {
      return longestPrintTimeWithin(files, printTimeLimitMinutes);
    }
    const range = printTimeRangeSeconds(files);
    return range ? range.min : null;
  }
  return null;
}
// 'recent' (default): newest-updated first (see sortKeyForItem above
// for exactly which files/timestamp that means). 'name': plain
// alphabetical by displayName. 'time': shortest print time first (see
// sortKeyForItem above for why it's always the shortest, not
// shortest/longest depending on direction). sortReverse (state.js)
// flips the comparison result -- not the rendered array -- so the
// "unknown sorts to the end" rule below holds regardless of
// direction. See state.js's sortMode/sortReverse and filters.js's
// renderSortFilter().
function compareByMode(a, b) {
  if (sortMode === 'name') {
    const cmp = (a.displayName || '').localeCompare(b.displayName || '');
    return sortReverse ? -cmp : cmp;
  }
  const aKey = sortKeyForItem(a);
  const bKey = sortKeyForItem(b);
  if (aKey == null && bKey == null) return 0;
  if (aKey == null) return 1;
  if (bKey == null) return -1;
  // 'recent' defaults newest-first (larger key first); 'time' defaults
  // shortest-first (smaller key first).
  const base = sortMode === 'recent' ? bKey - aKey : aKey - bKey;
  return sortReverse ? -base : base;
}
// Item card's metadata line (see renderItemCard) -- print-time range
// across the files that would currently print on the selected
// printer(s), within the print-time limit if one's set
// (filesMatchingPrinterAndTime), plus a relative "updated"
// timestamp derived from the most recent addedAt among the files that
// would currently show (filesMatchingCurrentFilters) -- see
// sortKeyForItem above for why those two file sets differ. Shown
// unconditionally, regardless of the active sort (unlike the sort
// keys, which only use single values off these same sets). Either
// clause is omitted on its own if that data isn't available (no
// parseable print time / no addedAt yet on any counted file); returns
// '' if neither is, so the caller can skip rendering the line
// entirely.
function buildItemCardMetaText(item) {
  const effective = effectivePrinterFilter();
  const parts = [];

  const range = printTimeRangeSeconds(filesMatchingPrinterAndTime(item, effective));
  if (range) {
    parts.push(
      range.min === range.max
        ? formatDurationShort(range.min)
        : `${formatDurationShort(range.min)} - ${formatDurationShort(range.max)}`
    );
  }

  const latestMs = latestAddedAtMs(filesMatchingCurrentFilters(item, effective));
  if (latestMs != null) {
    parts.push(`updated ${formatRelativeTime(new Date(latestMs).toISOString())}`);
  }

  return parts.join(', ');
}
function render() {
  const effective = effectivePrinterFilter();
  const listing = document.getElementById('listing');
  listing.innerHTML = '';

  let visibleItems;
  if (editModeActive) {
    // Edit mode never hides an item just because of the ambient
    // browsing filter -- someone managing the catalog shouldn't lose
    // sight of (or accidentally be unable to reach) an item just
    // because a printer/tag/search filter happens to be set from
    // earlier browsing. Still filtered by the smart-tag filter (an
    // explicit edit-mode tool, not a browsing concern) same as
    // before; the rest just get sorted after the ones that do match
    // and marked (.listing-filtered-out below), rather than removed.
    // Same treatment as an item's own file list within its edit view
    // (buildEditRoot/refreshEditFilesArea, itemModal.js).
    // Array.prototype.sort is stable, so sorting by compareByMode first
    // and the would-show grouping second layers the two: each group
    // keeps its Recent/Name order intact rather than the grouping
    // scrambling it.
    visibleItems = allItems
      .filter((item) => itemMatchesSmartTags(item, selectedSmartTags))
      .sort(compareByMode)
      .sort((a, b) => {
        const aShows = itemWouldShowInBrowsing(a, effective);
        const bShows = itemWouldShowInBrowsing(b, effective);
        return aShows === bShows ? 0 : aShows ? -1 : 1;
      });
  } else {
    visibleItems = allItems
      .filter((item) => itemWouldShowInBrowsing(item, effective) && itemMatchesSmartTags(item, selectedSmartTags))
      .sort(compareByMode);
  }

  if (visibleItems.length === 0) {
    listing.appendChild(renderEmptyState(buildGridEmptyMessage(effective, editModeActive)));
    renderEditBar();
    return;
  }

  const itemGrid = document.createElement('div');
  itemGrid.className = 'item-grid';
  for (const item of visibleItems) {
    const card = renderItemCard(item);
    if (editModeActive && !itemWouldShowInBrowsing(item, effective)) {
      card.classList.add('listing-filtered-out');
      card.title = "Wouldn't be shown right now under the current search/printer/print-time/tag filter";
    }
    itemGrid.appendChild(card);
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
  icon.className = 'empty-state-icon icon icon-search-off';
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
    trashBtn.className = `item-trash-btn icon ${isTrashed ? 'icon-restore' : 'icon-delete'}`;
    trashBtn.title = isTrashed ? 'Restore this item' : 'Delete this item';
    trashBtn.setAttribute('aria-label', isTrashed ? 'Restore this item' : 'Delete this item');
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

    // Edit-mode-only "needs attention" indicator (see indexer.js's
    // _computeAttentionFlags) -- a plain span rather than a button
    // since it's purely informational (native title tooltip on hover);
    // no click handler, so a click on it just falls through to the
    // card's own onclick and opens the editor like clicking anywhere
    // else on the card, which is the natural way to act on it. Designed
    // to hold more than one flag id later without changing this
    // rendering: every flag's message is just joined into the one
    // tooltip.
    if (item.attentionFlags && item.attentionFlags.length > 0) {
      const attentionIcon = document.createElement('span');
      attentionIcon.className = 'item-attention-icon icon icon-warning';
      attentionIcon.title = item.attentionFlags.map((f) => f.message).join('\n\n');
      card.appendChild(attentionIcon);
    }
  }

  const mediaSlot = document.createElement('div');
  mediaSlot.className = 'thumb-slot crop-frame';
  card.appendChild(mediaSlot);

  const img = document.createElement('img');
  img.alt = item.displayName || item.name;
  mediaSlot.appendChild(img);

  window.catalogAPI
    .getItemThumbnail(item)
    .then((thumb) => {
      img.src = thumb ? fileUrl(thumb) : 'nothumb.svg';
      // Only offer zoom when there's a real image -- not for the
      // generic "no thumbnail" placeholder graphic.
      if (thumb) {
        applyImageCrop(img, mediaSlot, cropRectFor(item, thumb, 'thumb'), { useDefault: true });
        mediaSlot.appendChild(
          makeZoomButton(() => img.src, img.alt, () => cropRectFor(item, thumb, 'full'))
        );
      }
    })
    // A rejected lookup (e.g. the file vanished mid-scan during a
    // background sync) shouldn't leave the <img> with no src at all --
    // fall back to the same placeholder as "no thumbnail found".
    .catch(() => {
      img.src = 'nothumb.svg';
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

  // Print-time range + "updated" line -- styled like the print-file
  // card's batch/color-change subtitle (see itemModal.js's
  // buildFileSubtitleText / .file-subtitle in itemModal.css): smaller
  // bold monospace text sitting right under the title. A plain <div>
  // rather than a <span> so it isn't also caught by the "a.listing
  // span" padding rule meant for the title (grid.css).
  const metaText = buildItemCardMetaText(item);
  if (metaText) {
    const meta = document.createElement('div');
    meta.className = 'item-card-meta';
    meta.textContent = metaText;
    card.appendChild(meta);
  }

  return card;
}
