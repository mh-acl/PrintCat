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
// and -- in edit mode -- the Pending/Edited/Trashed smart-tag filter)
// individually to see which one(s) are actually responsible for the
// empty grid, rather than always blaming the same one.
function buildGridEmptyMessage(effectivePrinters) {
  const wouldMatchWithout = (overrides) =>
    allItems.some(
      (item) =>
        itemMatchesPrinter(item, overrides.printers ?? effectivePrinters) &&
        itemMatchesTags(item, overrides.tags ?? selectedTags) &&
        itemMatchesSmartTags(item, overrides.smartTags ?? selectedSmartTags) &&
        itemMatchesKeyword(item, overrides.keyword ?? keywordQuery)
    );

  return buildFilterMessage(
    [
      {
        active: Boolean(keywordQuery),
        wouldHelp: () => wouldMatchWithout({ keyword: '' }),
        suggestion: 'try a different search term, or clear the search box',
      },
      {
        active: selectedTags.size > 0,
        wouldHelp: () => wouldMatchWithout({ tags: new Set() }),
        suggestion: 'choose "All Tags"',
      },
      {
        active: effectivePrinters.size > 0,
        wouldHelp: () => wouldMatchWithout({ printers: new Set() }),
        suggestion: 'choose "All Printers"',
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
    listing.appendChild(renderEmptyState(buildGridEmptyMessage(effective)));
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

  return card;
}
