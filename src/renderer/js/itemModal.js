'use strict';

// Unified item view/edit modal (openItemModal) -- the bulk of the
// item-detail and item-editing UI, including draft creation, the
// origin-info popup, and view-mode's print-file list (renderItemDetail,
// still live -- called from openItemModal's view-mode render path, not
// dead code).
// Depends on: state.js, utils.js, filters.js (buildFilterMessage,
// fileMatchesKeywordInItem, fileMatchesPrinter, fileMatchesPrintTime,
// fileMatchesPrinterAndTime, effectivePrinterFilter, printerLabel),
// grid.js (renderEmptyState), lightbox.js (cropRectFor, makeZoomButton,
// makeThumbCycleButtons, buildLightboxGallery),
// settings.js (createTagInput), dialogs.js.
// NOTE: openItemModal is ~700 lines on its own -- flagged as a future
// internal split once stage 2/3 of the modal work lands (see
// ARCHITECTURE.md / memory).

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
// Item-level "where this came from" line, shown above the file list in
// both modes now (metadata.json's origin.url -- see
// itemMetadata.js/originLocation.js), falling back to "No original
// location set." when there isn't one, rather than omitting the row.
// Also displays creatorName/creatorUrl when present, even though
// nothing in this app populates them yet (planned: a future pass
// scrapes the origin page for the creator's username + profile URL)
// -- built this way now so that once that data exists, it shows up
// here with no further display-side changes needed.
// Builds just the "Created by X, from Y" (or "From Y") node sequence --
// shared by view mode's renderItemDetail and edit mode's renderOriginRow
// (both via buildOriginRowContents below), so the wording/links are
// identical in both rather than edit mode having its own plainer
// "By X — url" text. Assumes origin.url is present; buildOriginRowContents
// handles the "no origin set yet" case itself (falls back to "No
// original location set." in both modes now).
function buildOriginSummaryNodes(origin) {
  const label = originPlatformLabel(origin.url);
  const nodes = [];

  if (origin.creatorName) {
    nodes.push(document.createTextNode('Created by '));
    if (origin.creatorUrl) {
      const creatorLink = document.createElement('a');
      creatorLink.href = origin.creatorUrl;
      creatorLink.target = '_blank';
      creatorLink.rel = 'noopener noreferrer';
      creatorLink.textContent = origin.creatorName;
      nodes.push(creatorLink);
    } else {
      nodes.push(document.createTextNode(origin.creatorName));
    }
    nodes.push(document.createTextNode(', from '));
  } else {
    // When there's no creator to credit, this stands alone as the
    // whole line rather than a trailing clause -- still needs its own
    // lead-in.
    nodes.push(document.createTextNode('From '));
  }

  const siteLink = document.createElement('a');
  siteLink.href = origin.url;
  siteLink.target = '_blank';
  siteLink.rel = 'noopener noreferrer';
  siteLink.textContent = label || 'the original site';
  nodes.push(siteLink);

  return nodes;
}
// Shared by view mode's renderItemDetail and edit mode's
// renderOriginRow (openItemModal) -- builds the full row contents
// (info line + pencil + refresh buttons) identically in both, so the
// two only differ in whether the buttons are real or an inert, hidden
// twin (see .item-modal-origin-btn-inert, itemModal.css). Always
// shows something (falls back to "No original location set." when
// there's no origin.url), in both modes now, rather than view mode
// omitting the row entirely -- same reasoning as the tags row already
// showing "No tags": a plain factual statement, not an instruction,
// so it's fine for a read-only viewer to see too.
function buildOriginRowContents(container, { origin, editable, onPencilClick, onRefreshClick }) {
  container.innerHTML = '';

  const info = document.createElement('small');
  info.className = 'item-origin-info item-modal-origin-summary';
  if (origin && origin.url) {
    for (const node of buildOriginSummaryNodes(origin)) info.appendChild(node);
  } else {
    info.textContent = 'No original location set.';
  }
  container.appendChild(info);

  const pencilBtn = document.createElement('button');
  pencilBtn.type = 'button';
  pencilBtn.className = 'item-modal-origin-btn icon icon-edit' + (editable ? '' : ' item-modal-origin-btn-inert');
  pencilBtn.title = 'Edit original-location info';
  pencilBtn.setAttribute('aria-label', 'Edit original-location info');
  pencilBtn.disabled = !editable;
  pencilBtn.tabIndex = editable ? 0 : -1;
  if (editable && onPencilClick) pencilBtn.onclick = onPencilClick;
  container.appendChild(pencilBtn);

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'item-modal-origin-btn icon icon-refresh' + (editable ? '' : ' item-modal-origin-btn-inert');
  refreshBtn.title = 'Reparse from folder';
  refreshBtn.setAttribute('aria-label', 'Reparse original-location info from folder');
  refreshBtn.disabled = !editable;
  refreshBtn.tabIndex = editable ? 0 : -1;
  if (editable && onRefreshClick) refreshBtn.onclick = onRefreshClick;
  container.appendChild(refreshBtn);
}
// Shared by view mode's renderItemDetail and edit mode's
// buildPrintFileCard -- same read-only fields exist on both a plain
// item.files entry (view) and a draft print-file object (edit; see
// createDraftFromItem/createDraftFromPicked's pass-through fields),
// so one pair of builders can generate identical subtitle/meta
// content for both instead of edit mode quietly showing less (it
// used to show none of print time/filament/pauses at all, and folded
// printer model into the subtitle instead of .file-meta).
function buildFileSubtitleText(f) {
  const parts = [
    f.copies && f.copies > 1 ? `batch of ${f.copies}` : null,
    f.colorChangeCount ? `${f.colorChangeCount} color change${f.colorChangeCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
function buildFileMetaLines(f) {
  return [
    // Always the full model+variant label (not just the model) --
    // otherwise two files sliced for different variants of the same
    // printer model (e.g. different nozzles) would show identically
    // here with nothing to tell them apart.
    f.printerModel ? `Printer: ${printerLabel(f)}` : null,
    f.printTime ? `Print time: ${f.printTime}` : null,
    // filamentUsedG can be null independently of filamentType (see
    // indexer.js) -- drop the weight clause entirely rather than
    // showing a literal "null" when it didn't parse.
    f.filamentType
      ? `Filament: ${formatFilamentTypes(f.filamentType)}${f.filamentUsedG != null ? `, ${f.filamentUsedG}g` : ''}`
      : null,
    // Rendered specially by renderMetaLines below (needs a tooltip
    // icon for pause messages, not just plain text).
    f.pauseCount ? { pause: true, count: f.pauseCount, messages: f.pauseMessages || [] } : null,
  ].filter(Boolean);
}
function renderMetaLines(container, metaLines) {
  for (const line of metaLines) {
    const lineEl = document.createElement('div');
    if (typeof line === 'string') {
      lineEl.textContent = line;
    } else {
      // Pause line: "N pause(s)" as text, plus a tooltip icon carrying
      // the M117 message(s) that preceded each M601 -- only when at
      // least one pause actually had one. Built with DOM methods
      // (textContent/title), not innerHTML, so a message containing
      // HTML-ish characters can't break the markup.
      lineEl.appendChild(document.createTextNode(`${line.count} pause${line.count === 1 ? '' : 's'} `));
      const messages = line.messages.filter(Boolean);
      if (messages.length) {
        const icon = document.createElement('i');
        icon.className = 'pause-tooltip-icon icon icon-info';
        icon.title = messages.join('\n');
        lineEl.appendChild(icon);
      }
    }
    container.appendChild(lineEl);
  }
}
// Shared by view mode's renderItemDetail and edit mode's
// buildPrintFileCard -- builds one print-file row/card with the same
// DOM shape and child order in both, so the two only differ in which
// pieces are the real, interactive version and which are an inert,
// hidden twin (.print-file-action-hidden, .item-modal-target-select-
// inert -- itemModal.css). Same approach as the tags row's per-chip
// remove-button placeholders and the collapsed gallery column: full
// DOM shape parity, real behavior only where the mode actually needs
// it. The one exception left is the name element itself (nameEl
// below) -- a static heading and a text input can't be the same
// element, so that's the one piece allowed to differ in tag/class.
// The card itself no longer has a mode-specific class at all
// (.file-row/.item-modal-file-card both dropped once nothing --
// visual styling included -- depended on telling them apart; see
// .print-file-entry in itemModal.css).
// Stable, unique-per-file view-transition-name -- derived from the
// file's own path basename (the same value a draft print-file's own
// .key already is; view mode's raw file objects don't have .key but
// do have the same .path to derive it from), not array index. Naming
// by index (the way the tags row's per-chip-remove buttons do,
// see makeThumbCycleButtons/withViewTransition) would be unsafe here:
// the new filter-relevance sort (refreshEditFilesArea/render()) can
// put the same file at different positions in view vs edit mode, so
// an index-based name could morph the wrong two cards into each
// other. Sanitized to a valid CSS custom-ident (letters/digits/-/_
// only) -- two very differently-named files that happen to sanitize
// to the same string would collide, but that's a low-risk edge case
// given actual filenames in this catalog, not worth a heavier hashing
// scheme.
function printFileTransitionName(fileOrPf) {
  const key = fileOrPf.key || fileOrPf.path.split(/[\\/]/).pop();
  return 'print-file-' + key.replace(/[^a-zA-Z0-9_-]/g, '-');
}
// --- Image-chip reordering (drag and drop) -------------------------------
// The little assigned-image chips at the bottom of a card (a print file's
// photos, the Item photos card) can be dragged to reorder within their
// own row. This uses its own drag payload type rather than the
// 'text/plain' one the gallery's pool images use, so a chip drag can
// never be mistaken for "assign this pool image" (dragIsImage in
// openItemModal keys off 'text/plain') or for a print-file drag (the
// file list's own drop zone treats any drag it doesn't recognize as
// one -- see dragIsChipReorder's use there).
const CHIP_REORDER_DRAG_TYPE = 'application/x-printcat-chip-reorder';
// dataTransfer contents aren't readable during dragover (browser
// security model, same as dragIsImage's note), so which row a chip
// drag came from and which chip it is lives here instead: only one
// drag can be in flight at a time.
let activeChipDrag = null; // { rowEl, from } while a chip is being dragged

function dragIsChipReorder(e) {
  return e.dataTransfer.types.includes(CHIP_REORDER_DRAG_TYPE);
}

// Moves list[from] so it lands at insert position `insertAt` -- an
// index into the list *as it was before the move* (0 = before the
// first item, list.length = after the last), which is what the drop
// indicator naturally points at. Removing the item first shifts every
// later position down by one, hence the adjustment.
function moveListItem(list, from, insertAt) {
  const [moved] = list.splice(from, 1);
  list.splice(insertAt > from ? insertAt - 1 : insertAt, 0, moved);
}

// Which gap in a chip row the pointer is nearest to: { index, side,
// insertAt } where `index` is the chip it's hovering (or the closest
// one, for the flex gap / empty space around the chips -- vertical
// distance is weighted heavily so a wrapped row picks a chip in its
// own line) and `side` is which half of it the pointer is in.
function chipDropPosition(rowEl, x, y) {
  const chipEls = [...rowEl.querySelectorAll(':scope > .print-file-image-chip')];
  let best = null;
  let bestDist = Infinity;
  chipEls.forEach((el, index) => {
    const r = el.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dist = dy * 4 + dx;
    if (dist < bestDist) {
      bestDist = dist;
      best = { index, el, rect: r };
    }
  });
  if (!best) return null;
  const side = x < best.rect.left + best.rect.width / 2 ? 'before' : 'after';
  return {
    index: best.index,
    el: best.el,
    side,
    insertAt: side === 'before' ? best.index : best.index + 1,
  };
}

// The drag ghost for a chip: just its cropped thumbnail. Left to
// itself the browser snapshots the dragged element from the page, and
// what comes along with the chip is unpredictable -- bits of the
// neighboring chips and the text above the row were showing up in it.
// So the ghost is supplied explicitly: a copy of the chip's crop frame
// (the square, cropped image -- not the remove button that overhangs its
// corner), parked off-screen for the moment the browser takes its
// snapshot, then removed. It's sized in the chip's own font-size since
// the frame's dimensions are in em.
function setChipDragImage(e, chip) {
  const source = chip.querySelector('.crop-frame') || chip.querySelector('img');
  if (!source || typeof e.dataTransfer.setDragImage !== 'function') return;
  const rect = source.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'print-file-image-chip print-file-chip-drag-ghost';
  ghost.style.fontSize = getComputedStyle(chip).fontSize;
  ghost.appendChild(source.cloneNode(true));
  document.body.appendChild(ghost);
  // Keep the ghost under the pointer at the spot it was grabbed.
  const offsetX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  const offsetY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
  e.dataTransfer.setDragImage(ghost, offsetX, offsetY);
  setTimeout(() => ghost.remove(), 0);
}

function buildFileEntry(opts) {
  const {
    editable,
    selected,
    onToggleSelect,
    thumbWrap,
    nameEl,
    subtitleText,
    metaLines,
    chips, // array of { src, onRemove, thumbCrop? } -- see buildFileEntry's chip loop
    onReorderChips, // (from, insertAt) => void, edit mode only -- see moveListItem
    onPrintClick,
  } = opts;

  const card = document.createElement('div');
  card.className = `print-file-entry${selected ? ' selected' : ''}`;

  const selectToggle = document.createElement('input');
  selectToggle.type = 'checkbox';
  selectToggle.className = 'item-modal-target-select' + (editable ? '' : ' item-modal-target-select-inert');
  selectToggle.title = 'Select as an image-assignment target';
  selectToggle.checked = Boolean(selected);
  selectToggle.disabled = !editable;
  selectToggle.tabIndex = editable ? 0 : -1;
  if (editable && onToggleSelect) {
    selectToggle.onchange = () => onToggleSelect(selectToggle.checked);
  }
  card.appendChild(selectToggle);

  card.appendChild(thumbWrap);
  card.appendChild(nameEl);

  if (subtitleText) {
    const subtitle = document.createElement('p');
    subtitle.className = 'file-subtitle';
    subtitle.textContent = subtitleText;
    card.appendChild(subtitle);
  }

  const meta = document.createElement('div');
  meta.className = 'file-meta';
  renderMetaLines(meta, metaLines);
  card.appendChild(meta);

  // Action area: the print button and the assigned-image chip list
  // both exist in both modes now, one real and one an inert/hidden
  // twin, rather than only whichever one the mode actually uses.
  const printButton = document.createElement('button');
  printButton.className = 'print-button' + (editable ? ' print-file-action-hidden' : '');
  printButton.textContent = 'Print This';
  printButton.disabled = editable;
  printButton.tabIndex = editable ? -1 : 0;
  if (!editable && onPrintClick) printButton.onclick = onPrintClick;
  card.appendChild(printButton);

  const chipsEl = document.createElement('div');
  chipsEl.className = 'print-file-image-chips' + (editable ? '' : ' print-file-image-chips-hidden');

  // Drag-to-reorder: only in edit mode, only with something to reorder.
  const reorderable = editable && typeof onReorderChips === 'function' && (chips || []).length > 1;
  // The dividing line shown where the dragged chip will land -- one
  // absolutely positioned element in the row (see .print-file-chip-drop-
  // line), moved around by showDropLine, rather than per-chip styling,
  // so it sits in the middle of the gap between two chips (or at the
  // row's start/end) even when the row wraps.
  let dropLine = null;
  const hideDropLine = () => {
    if (dropLine) dropLine.style.display = 'none';
  };
  const showDropLine = (pos) => {
    if (!dropLine) {
      dropLine = document.createElement('div');
      dropLine.className = 'print-file-chip-drop-line';
      chipsEl.appendChild(dropLine);
    }
    const rowRect = chipsEl.getBoundingClientRect();
    const r = pos.el.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(chipsEl).columnGap) || 4;
    const edge = pos.side === 'before' ? r.left - gap / 2 : r.right + gap / 2;
    dropLine.style.left = `${edge - rowRect.left - 1}px`;
    dropLine.style.top = `${r.top - rowRect.top}px`;
    dropLine.style.height = `${r.height}px`;
    dropLine.style.display = 'block';
  };
  // Where a drop at this pointer position would actually change
  // something -- null when it'd land the chip right back where it was
  // (its own slot, or the slot just after it), in which case no line is
  // shown either, so the indicator only ever promises a real move.
  const effectiveDropPosition = (e) => {
    if (!activeChipDrag || activeChipDrag.rowEl !== chipsEl) return null;
    const pos = chipDropPosition(chipsEl, e.clientX, e.clientY);
    if (!pos) return null;
    const { from } = activeChipDrag;
    if (pos.insertAt === from || pos.insertAt === from + 1) return null;
    return pos;
  };
  if (reorderable) {
    chipsEl.ondragover = (e) => {
      if (!activeChipDrag || activeChipDrag.rowEl !== chipsEl) return; // not ours
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const pos = effectiveDropPosition(e);
      if (pos) showDropLine(pos);
      else hideDropLine();
    };
    chipsEl.ondragleave = (e) => {
      if (!chipsEl.contains(e.relatedTarget)) hideDropLine();
    };
    chipsEl.ondrop = (e) => {
      if (!activeChipDrag || activeChipDrag.rowEl !== chipsEl) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = effectiveDropPosition(e);
      const { from } = activeChipDrag;
      // Cleared here, not left to the chip's dragend: the reorder below
      // rebuilds this whole row, and a dragend on a chip that's no
      // longer in the document isn't reliably delivered.
      activeChipDrag = null;
      hideDropLine();
      if (pos) onReorderChips(from, pos.insertAt);
    };
  }

  (chips || []).forEach((chipData, chipIndex) => {
    const chip = document.createElement('span');
    chip.className = 'print-file-image-chip';
    // Optional per-chip extras, only ever passed by the item photos
    // card (buildItemPhotosCard) so far: `primary` outlines the chip
    // that's the item's main image, `title` is a hover hint, and
    // `onClick` makes the whole chip a button (edit mode only -- the
    // view-mode twin is inert like everything else in it).
    if (chipData.primary) chip.classList.add('print-file-image-chip-primary');
    const chipImg = document.createElement('img');
    chipImg.src = chipData.src;
    if (chipData.title) chip.title = chipData.title;
    if ('thumbCrop' in chipData) {
      // Edit-mode chips show the image's thumbnail crop (rect or null
      // for the default centered square), same as every other place
      // that image shows as a thumbnail. The view-mode twins below
      // are hidden and just skip this.
      const chipFrame = document.createElement('span');
      chipFrame.className = 'crop-frame';
      chipFrame.appendChild(chipImg);
      chip.appendChild(chipFrame);
      applyImageCrop(chipImg, chipFrame, chipData.thumbCrop, { useDefault: true });
    } else {
      chip.appendChild(chipImg);
    }
    if (editable && chipData.onClick) {
      chip.classList.add('print-file-image-chip-clickable');
      chip.tabIndex = 0;
      chip.setAttribute('role', 'button');
      chip.onclick = chipData.onClick;
      chip.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          chipData.onClick();
        }
      };
    }
    if (reorderable) {
      chip.draggable = true;
      chip.classList.add('print-file-image-chip-draggable');
      // The <img> is draggable by default and would start its own
      // (image/URL) drag instead of the chip's.
      chipImg.draggable = false;
      chip.ondragstart = (e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(CHIP_REORDER_DRAG_TYPE, String(chipIndex));
        activeChipDrag = { rowEl: chipsEl, from: chipIndex };
        setChipDragImage(e, chip);
        // Dimmed a tick later -- doing it synchronously would bake the
        // faded look into the drag ghost image too.
        requestAnimationFrame(() => chip.classList.add('print-file-image-chip-dragging'));
      };
      chip.ondragend = () => {
        activeChipDrag = null;
        chip.classList.remove('print-file-image-chip-dragging');
        hideDropLine();
      };
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon icon-close';
    removeBtn.title = 'Remove';
    removeBtn.disabled = !editable;
    removeBtn.tabIndex = editable ? 0 : -1;
    if (editable && chipData.onRemove) {
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        chipData.onRemove();
      };
    }
    chip.appendChild(removeBtn);
    chipsEl.appendChild(chip);
  });
  card.appendChild(chipsEl);

  return card;
}

// Tracks the currently open item modal (see openItemModal below), so
// the global "enter edit mode" listener (see init()) can transition an
// already-open view-mode modal into edit mode in place, rather than
// requiring the co-admin to close and reopen it -- per prior design
// discussion, entering edit mode while viewing an item should behave
// exactly as if they'd been in the main view and clicked to edit it.
let openModalHandle = null; // { itemPath, switchToEdit(), switchToView() } or null while nothing's open -- itemPath is null for an 'add'-mode modal
// Wraps a synchronous DOM-mutating callback in document.startViewTransition
// when the engine supports it (Electron's Chromium does), so any element
// present in both the before/after DOM with a matching view-transition-name
// (currently just .item-detail-tags -- see the @supports block in
// itemModal.css) animates smoothly across the mutation instead of
// hard-cutting. Falls back to calling fn() directly with no
// animation on engines without the API. Kept generic/reusable rather than
// tied to any one mode-switch caller, since more elements are expected to
// pick up view-transition-name over time as this effort continues.
function withViewTransition(fn) {
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(fn);
  } else {
    fn();
  }
}
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
    // Ordered item-level images, primary first -- the whole explicit
    // metadata.json list wins, same as the main process's
    // resolveItemThumbnail does for the primary -- but fall back to
    // the thumb.* filename convention (item.explicitThumb) before
    // giving up, so legacy items assigned that way don't lose their
    // image just because edit mode never used to look for it.
    itemImageRefs:
      item.metadataItemImages && item.metadataItemImages.length > 0
        ? item.metadataItemImages.map((name) => ({ kind: 'existing', name }))
        : item.explicitThumb
          ? [{ kind: 'existing', name: item.explicitThumb }]
          : [],
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
        // Read-only pass-through -- nothing edits this, it's only here
        // so fileMatchesKeywordInItem (filters.js) can search it the
        // same way it does for view mode's real file objects, via
        // fileSearchText's [shortname, longname, ...tags] -- without
        // it, edit mode's "would this be filtered out" check
        // (refreshEditFilesArea) would silently ignore longname
        // matches that view mode's equivalent check would catch.
        longname: f.longname,
        displayName: f.metadataDisplayName || null,
        printerModel: f.printerModel,
        printerVariant: f.printerVariant,
        colorChangeCount: f.colorChangeCount,
        copies: f.copies,
        // Read-only pass-through -- nothing in edit mode edits these,
        // they're only here so the shared .file-meta block (see
        // buildFileEntry) has the same data to show in both modes,
        // not just view mode.
        printTime: f.printTime,
        filamentType: f.filamentType,
        filamentUsedG: f.filamentUsedG,
        pauseCount: f.pauseCount,
        pauseMessages: f.pauseMessages,
        images,
      };
    }),
    poolImages: imageFiles.map((name) => ({ kind: 'existing', name })),
    // { [refIdentity]: { thumb?: cropRect, full?: cropRect } } -- see
    // itemMetadata.js's imageCrops schema and refIdentity above.
    // item.imageCrops (from indexer.js) is keyed by plain filename,
    // which is exactly what an 'existing:' identity wraps, so this is
    // a straight re-keying, not a lookup -- every image already saved
    // with a crop is, by definition, an 'existing' image in this item's
    // folder.
    imageCrops: Object.fromEntries(
      Object.entries(item.imageCrops || {}).map(([filename, modes]) => [
        `existing:${filename}`,
        modes,
      ])
    ),
    // .3mf companion files picked via "Add print file(s)"/drop, staged
    // as { path, name }. A .gcode/.bgcode instead goes straight into
    // printFiles above (isNew: true, parsed immediately for a real
    // preview card) -- this array only exists for .3mf, which has no
    // card of its own even after a real scan, so there's nothing to
    // preview it as. Not copied anywhere until Save -- see
    // editSession.js's _resolveNewPrintFiles, called from saveDraft
    // below.
    newPrintFiles: [],
    // Set of pf.key (real on-disk filenames, see the printFiles map
    // above) for *existing* print files staged for deletion -- toggled
    // by the trash/restore button on each card (buildPrintFileCard),
    // same delete/undelete-before-save shape as the main grid's
    // item-level trashing (pendingChanges), just scoped to one item's
    // files instead of whole items. A pending *new* print file never
    // enters this set -- it has its own plain remove button, since it
    // was never saved in the first place.
    trashedPrintFiles: new Set(),
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
    itemImageRefs: picked.explicitThumb ? [{ kind: 'existing', name: picked.explicitThumb }] : [],
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
        // Same read-only pass-through as createDraftFromItem above.
        printTime: f.printTime,
        filamentType: f.filamentType,
        filamentUsedG: f.filamentUsedG,
        pauseCount: f.pauseCount,
        pauseMessages: f.pauseMessages,
        images: matched ? [{ kind: 'existing', name: matched }] : [],
      };
    }),
    poolImages: imageFiles.map((name) => ({ kind: 'existing', name })),
    // A freshly-scanned folder has no metadata.json yet -- see
    // createDraftFromItem's identical field for the shape.
    imageCrops: {},
    // Same staged-external shape as createDraftFromItem's field above --
    // lets a co-admin add an extra loose print file while assembling a
    // brand-new item, not just after it's already in the catalog.
    newPrintFiles: [],
    // Same shape as createDraftFromItem's field above -- lets a
    // just-scanned file be excluded before the item is even added,
    // not just after.
    trashedPrintFiles: new Set(),
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
  overlay.className = 'modal-overlay origin-popup-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box modal-wide';

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
  let thumbChipHolder = null; // set fresh by renderTopBar() each render; refreshEditFilesArea() (buildEditRoot) targets whatever this currently points to
  let itemPhotosCardEl = null; // the current edit-mode Item photos card, set by refreshEditFilesArea() -- the topbar chip's "+N" badge scrolls to it (focusItemPhotosCard)
  let sourceDir = item ? item.path : null; // becomes known for 'add' once the folder's picked, below
  let folderPath = item ? item.path : null; // raw fs path, not a URL -- see imageRefSrc/fileUrl
  // Set alongside openModalHandle below (both the 'add' and non-'add'
  // paths) -- close() compares against this by reference to know
  // whether *this* modal instance is the one currently registered
  // globally, so it can clear openModalHandle without needing item.path
  // (which 'add' mode doesn't have).
  let myOpenModalHandle = null;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay item-modal-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box modal-wide item-modal-box';
  overlay.appendChild(box);

  const topBar = document.createElement('div');
  topBar.className = 'item-modal-topbar';
  box.appendChild(topBar);

  const content = document.createElement('div');
  // .item-modal-content (itemModal.css) makes this the flexible,
  // non-scrolling half of .modal-box's column layout -- see that
  // rule's comment for the full independent-scroll-regions chain this
  // is the top of (topbar fixed -> this -> .item-detail's header
  // fixed/body scrolling -> the two body columns scrolling on their
  // own).
  content.className = 'item-modal-content';
  box.appendChild(content);

  function close() {
    if (overlay.parentNode) document.body.removeChild(overlay);
    document.removeEventListener('keydown', onKeydown);
    unlockBackgroundScroll();
    // Reference equality rather than itemPath, so this works for 'add'
    // mode too (item is null there, so there's no path to key off of) --
    // clears the handle whenever *this* modal instance is the one
    // currently registered, regardless of mode.
    if (openModalHandle === myOpenModalHandle) openModalHandle = null;
  }
  // This modal supports its explicit button (Close in view mode, Cancel
  // in edit/add mode) and Escape, but deliberately NOT click-on-backdrop
  // -- unlike the image lightbox, dismissing this one in edit/add mode
  // discards an in-progress draft, and a backdrop click is too easy to
  // trigger by accident for something with that consequence. Escape maps
  // to the same close() the Cancel/Close button already uses in every
  // mode, so it's no more destructive than that button -- it's just a
  // keyboard equivalent of it, not a separate lighter-weight dismissal.
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeydown);

  function renderTopBar() {
    topBar.innerHTML = '';

    const left = document.createElement('div');
    left.className = 'item-modal-topbar-side item-modal-topbar-left';
    topBar.appendChild(left);

    const title = document.createElement('div');
    title.className = 'item-modal-topbar-title';
    topBar.appendChild(title);

    const right = document.createElement('div');
    right.className = 'item-modal-topbar-side item-modal-topbar-right';
    topBar.appendChild(right);

    if (mode === 'view') {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'item-modal-close';
      const closeIcon = document.createElement('span');
      closeIcon.className = 'icon icon-chevron-left';
      closeBtn.appendChild(closeIcon);
      closeBtn.appendChild(document.createTextNode(' Close'));
      closeBtn.onclick = close;
      left.appendChild(closeBtn);

      thumbChipHolder = document.createElement('div');
      thumbChipHolder.className = 'item-modal-topbar-thumb';
      title.appendChild(thumbChipHolder);
      // Mirrors buildItemThumbChip's shape below (chip > checkbox +
      // .crop-frame > img [+ remove button]) rather than just a bare
      // img -- the checkbox and remove button are inert twins, same
      // pattern as everywhere else in this modal (per-file checkbox,
      // print button, image chips). The remove button specifically
      // only appears when item.metadataItemImage is set, mirroring
      // buildItemThumbChip's own condition (draft.itemImageRefs[0], which
      // is just this same field wrapped into draft form) exactly --
      // edit mode never shows a real remove button for a "borrowed
      // preview" thumbnail (no explicit assignment, just the first-
      // print-file/embedded-gcode fallback), so this placeholder
      // shouldn't exist for that case either.
      const chip = document.createElement('div');
      chip.className = 'item-modal-thumb-chip';
      thumbChipHolder.appendChild(chip);

      const itemSelectToggle = document.createElement('input');
      itemSelectToggle.type = 'checkbox';
      itemSelectToggle.className = 'item-modal-target-select item-modal-target-select-inert';
      itemSelectToggle.title = 'Select as an image-assignment target';
      itemSelectToggle.disabled = true;
      itemSelectToggle.tabIndex = -1;
      chip.appendChild(itemSelectToggle);

      const frame = document.createElement('div');
      frame.className = 'crop-frame';
      chip.appendChild(frame);

      // View mode has no draft to read an explicit assignment off of,
      // so just ask for the same fully-resolved thumbnail the grid
      // card already shows for this item (explicit assignment ->
      // thumb.* convention -> first-print-file/embedded-gcode
      // fallback, all handled server-side by resolveItemThumbnail) --
      // no need to reimplement those tiers client-side here.
      const img = document.createElement('img');
      img.alt = 'Item image'; // matches buildItemThumbChip's wording
      img.src = 'nothumb.svg';
      frame.appendChild(img);
      window.catalogAPI
        .getItemThumbnail(item)
        .then((thumb) => {
          if (!thumb) return;
          img.src = fileUrl(thumb);
          // Same crop the grid card applies to this exact thumbnail
          // (cropRectFor picks the filename back out of the resolved
          // path; null means no crop saved, or not a photo at all,
          // and useDefault falls back to the centered square).
          applyImageCrop(img, frame, cropRectFor(item, thumb, 'thumb'), { useDefault: true });
        })
        .catch(() => {});

      if (item.metadataItemImage) {
        const removePlaceholder = document.createElement('button');
        removePlaceholder.type = 'button';
        removePlaceholder.className = 'item-modal-chip-remove icon icon-close print-file-action-hidden';
        removePlaceholder.title = 'Remove item image';
        removePlaceholder.disabled = true;
        removePlaceholder.tabIndex = -1;
        chip.appendChild(removePlaceholder);
      }
      // Inert twin of buildItemThumbChip's "+N" badge, present under
      // the same condition (more than one explicit item image) --
      // same shape-parity reasoning as the remove placeholder above.
      // Deliberately never shown in view mode: the extra photos only
      // surface on the main-grid card, not in this header.
      if ((item.metadataItemImages || []).length > 1) {
        const countPlaceholder = document.createElement('button');
        countPlaceholder.type = 'button';
        countPlaceholder.className = 'item-modal-chip-count print-file-action-hidden';
        countPlaceholder.textContent = `+${item.metadataItemImages.length - 1}`;
        countPlaceholder.disabled = true;
        countPlaceholder.tabIndex = -1;
        chip.appendChild(countPlaceholder);
      }

      const heading = document.createElement('h2');
      heading.className = 'item-modal-title-text';
      heading.textContent = item.displayName || item.name;
      title.appendChild(heading);
    } else {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'item-modal-close cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = close;
      left.appendChild(cancelBtn);

      // Same interactive chip as before (target-select checkbox,
      // drag-drop assignment, remove button -- see buildItemThumbChip)
      // just mounted here instead of buildEditRoot's own header row,
      // and sized down via .item-modal-topbar-thumb (itemModal.css) to
      // sit icon-sized next to the name rather than as its own row.
      // refreshEditFilesArea (buildEditRoot) re-renders whatever
      // thumbChipHolder currently points to whenever the assigned
      // image changes, same as before the move.
      thumbChipHolder = document.createElement('div');
      thumbChipHolder.className = 'item-modal-topbar-thumb';
      thumbChipHolder.appendChild(buildItemThumbChip());
      title.appendChild(thumbChipHolder);

      // Same field draft.displayName was always bound to (previously
      // lived in buildEditRoot's item-modal-edit-header row, alongside
      // the thumb chip) -- moved here so the title sits centered on
      // the same row as Cancel/Save instead of its own row below,
      // and so it's one persistent element (topBar is never torn
      // down by renderContent) rather than being rebuilt every time
      // content is.
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'item-modal-name-input item-modal-title-input';
      nameInput.value = draft.displayName;
      nameInput.placeholder = 'Item name';
      // Sized via the `size` attribute rather than CSS width: 100% --
      // this input's containing block (.item-modal-topbar-title) is an
      // `auto`-sized CSS Grid track, so a percentage width here has
      // nothing definite to resolve against and silently fell back to
      // the UA default input width (~20 chars), completely disconnected
      // from the actual name length. That fixed-width fallback was
      // wider than most titles ever need, so it (not the print-file/
      // gallery row) was what set the modal's width on any item with
      // few enough files -- switching to edit mode would visibly widen
      // the whole box for no reason tied to its content. `size` gives
      // the browser real content to size against, matching how the
      // view-mode <h2> (.item-modal-title-text) sizes to its actual
      // text instead of a constant.
      nameInput.size = Math.max((draft.displayName || '').length, 1);
      nameInput.oninput = () => {
        draft.displayName = nameInput.value;
        nameInput.size = Math.max(nameInput.value.length, 1);
      };
      title.appendChild(nameInput);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'item-modal-close save';
      saveBtn.textContent = 'Save to pending';
      saveBtn.onclick = saveDraft;
      right.appendChild(saveBtn);
    }
  }

  function renderContent() {
    content.innerHTML = '';
    if (mode === 'view') {
      const effective = effectivePrinterFilter();
      const matchesPrinterAndTime = item.files.filter((f) => fileMatchesPrinterAndTime(f, effective));
      const matchingFiles = matchesPrinterAndTime.filter((f) => fileMatchesKeywordInItem(item, f, keywordQuery));
      if (matchingFiles.length === 0) {
        // Same reasoning as the main grid's empty state (buildGridEmptyMessage)
        // -- check which active restriction (search text, printer
        // filter, print-time limit) is actually responsible rather
        // than always naming the same one.
        const matchesKeywordOnly = item.files.filter((f) => fileMatchesKeywordInItem(item, f, keywordQuery));
        const message = buildFilterMessage(
          [
            {
              active: Boolean(keywordQuery),
              wouldHelp: () => matchesPrinterAndTime.length > 0,
              suggestion: 'try a different search term, or clear the search box',
            },
            {
              active: effective && effective.size > 0,
              wouldHelp: () => matchesKeywordOnly.some((f) => fileMatchesPrintTime(f, printTimeLimitMinutes)),
              suggestion: 'choose "All Printers" to see every version',
            },
            {
              active: printTimeLimitMinutes != null,
              wouldHelp: () => matchesKeywordOnly.some((f) => fileMatchesPrinter(f, effective)),
              suggestion: 'choose a longer print time, or "Any length", to see longer prints',
            },
          ],
          'This item has no print files.',
          'No print files here match your search, the selected printer(s), and the print-time limit together. Try loosening one of them.'
        );
        content.appendChild(renderEmptyState(message));
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
      if (draft.trashedPrintFiles.has(target.key)) continue; // pointless to share into something being deleted
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
      // Appends (skipping a duplicate), same as a print file -- the
      // item can hold several images now, primary first. Making a
      // different one the primary is a separate action on the Item
      // photos card's chips (buildItemPhotosCard), not something
      // assigning again does.
      if (draft.itemImageRefs.some((r) => imageRefEquals(r, ref))) return;
      draft.itemImageRefs.push(ref);
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

  // Drop handler body shared by the two item-level drop targets (the
  // topbar chip and the Item photos card): real OS image files are
  // added to the pool and assigned, an in-app gallery drag assigns
  // that pool image by its index -- same two payloads
  // buildPrintFileCard's own card-level ondrop handles.
  function assignDroppedImages(targetId, e) {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      for (const f of files) {
        if (!isImageFileName(f.name)) continue;
        assignSingleTargetImage(targetId, addExternalToPoolDraft(window.catalogAPI.getPathForFile(f), f.name));
      }
    } else {
      const idx = Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isNaN(idx) && draft.poolImages[idx]) assignSingleTargetImage(targetId, draft.poolImages[idx]);
    }
  }

  // Scrolls the Item photos card into view and flashes it -- what the
  // topbar chip's "+N" badge does, since the extra photos live on that
  // card rather than in the header.
  function focusItemPhotosCard() {
    if (!itemPhotosCardEl) return;
    itemPhotosCardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    itemPhotosCardEl.classList.remove('item-photos-flash');
    void itemPhotosCardEl.offsetWidth; // force a reflow so re-adding the class restarts the animation
    itemPhotosCardEl.classList.add('item-photos-flash');
  }

  // --- Edit-mode crop helpers --------------------------------------------
  // See itemMetadata.js's imageCrops schema and refIdentity above.

  function getDraftCrop(ref, mode) {
    const modes = draft.imageCrops[refIdentity(ref)];
    return (modes && modes[mode]) || null;
  }

  // `changes` is { thumb?: rectOrNull, full?: rectOrNull } straight
  // from the crop dialog -- only the modes the user actually changed,
  // so an untouched mode keeps whatever the draft already had.
  function setDraftCrops(ref, changes) {
    const key = refIdentity(ref);
    draft.imageCrops[key] = { ...(draft.imageCrops[key] || {}), ...changes };
    refreshEditFilesArea();
  }

  // Opens the crop dialog (thumbnail + full-view tabs) for one pool
  // image. `frameEl`/`imgEl` are re-cropped in place immediately on
  // save, ahead of the full refreshEditFilesArea() rebuild triggered
  // by setDraftCrops, so the chip doesn't visibly flash back to
  // uncropped before catching up. Only the thumb crop is ever visible
  // on the chip itself -- a full-view crop only shows up in the
  // lightbox, so applying its rect to this square frame would misdraw
  // the chip.
  function openCropperForRef(ref, imgEl, frameEl) {
    openImageCropper({
      imageSrc: imageRefSrc(ref, folderPath),
      crops: { thumb: getDraftCrop(ref, 'thumb'), full: getDraftCrop(ref, 'full') },
      onSave(changes) {
        if ('thumb' in changes) applyImageCrop(imgEl, frameEl, changes.thumb, { useDefault: true });
        setDraftCrops(ref, changes);
      },
    });
  }

  // Small corner badge, added to a chip's frame in edit mode only,
  // that opens the crop dialog for that specific image. Mirrors
  // the existing removeBtn corner-badge pattern used elsewhere in
  // this file (e.g. buildItemThumbChip's remove button).
  function makeCropAdjustButton(ref, imgEl, frameEl) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'image-crop-adjust-btn icon icon-crop';
    btn.title = 'Adjust crops (thumbnail and full view)';
    btn.setAttribute('aria-label', 'Adjust crops');
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCropperForRef(ref, imgEl, frameEl);
    };
    return btn;
  }

  function addExternalToPoolDraft(extPath, name) {
    const existing = draft.poolImages.find((r) => r.kind === 'external' && r.path === extPath);
    if (existing) return existing;
    const ref = { kind: 'external', path: extPath, name };
    draft.poolImages.push(ref);
    return ref;
  }

  // Stages an externally-picked print file (from the "Add print
  // file(s)" button or a drop onto the file list/tile) into the draft.
  // A .gcode/.bgcode file is parsed immediately -- via the
  // editSession:parseNewPrintFile IPC call, which reuses the same
  // per-file parser a real folder scan uses -- and dropped straight
  // into draft.printFiles as a full, editable card (isNew: true,
  // sourcePath: extPath): selectable as an image-assignment target,
  // droppable-onto, renameable, right away, rather than only after a
  // save+reopen round trip. A .3mf has no equivalent real card even
  // after a real scan (indexer.js never cards project files, only
  // gcode/bgcode -- see PRINTFILE_ADD_EXT's comment in editSession.js),
  // so it keeps the older, lighter "Pending" placeholder treatment
  // instead (draft.newPrintFiles, buildPendingPrintFileCard). Deduped
  // by source path either way -- picking/dropping the same file twice
  // before Save just no-ops the second time.
  async function addExternalPrintFileToDraft(extPath, name) {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (ext === '.3mf') {
      if (draft.newPrintFiles.some((f) => f.path === extPath)) return;
      draft.newPrintFiles.push({ path: extPath, name });
      return;
    }
    if (draft.printFiles.some((f) => f.isNew && f.sourcePath === extPath)) return;
    const parsed = await window.catalogAPI.editSessionParseNewPrintFile(extPath);
    draft.printFiles.push({
      key: extPath,
      isNew: true,
      sourcePath: extPath,
      shortname: parsed.shortname,
      longname: parsed.longname,
      tags: parsed.tags,
      displayName: null,
      printerModel: parsed.printerModel,
      printerVariant: parsed.printerVariant,
      colorChangeCount: parsed.colorChangeCount,
      copies: parsed.copies,
      printTime: parsed.printTime,
      filamentType: parsed.filamentType,
      filamentUsedG: parsed.filamentUsedG,
      pauseCount: parsed.pauseCount,
      pauseMessages: parsed.pauseMessages,
      images: [],
    });
  }

  // --- Edit-mode DOM builders ---------------------------------------------

  // True if the drag payload looks like it's carrying image data --
  // either an in-app pool-image chip drag (identified by the
  // 'text/plain' index payload those chips use as their drag data) or
  // real OS files that all report an image/* MIME type. Checked at
  // dragenter/dragover time, when only `types`/`items` (not `files` or
  // getData()) are readable -- that's the browser's drag-and-drop
  // security model, not an oversight here. Used to decide whether a
  // print-file-entry card (or the item thumbnail chip) should claim a
  // drag at all -- previously every card unconditionally
  // preventDefault+stopPropagation'd and highlighted on dragover
  // regardless of what was being dragged, so dragging an actual print
  // file over the list lit up every card as a false "drop here"
  // signal even though dropping one there did nothing. A card that
  // doesn't claim the drag now leaves it alone entirely (no
  // preventDefault/stopPropagation), letting it bubble to
  // refreshEditFilesArea's filesCol-level handler below, which is
  // where a real print-file drop actually gets handled.
  function dragIsImage(e) {
    const types = e.dataTransfer.types;
    if (types.includes('text/plain')) return true; // internal pool-image chip drag
    if (!types.includes('Files')) return false;
    const items = e.dataTransfer.items;
    if (!items || items.length === 0) return false;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      if (!item.type || !item.type.startsWith('image/')) return false;
    }
    return true;
  }

  function buildItemThumbChip() {
    const chip = document.createElement('div');
    chip.className = 'item-modal-thumb-chip' + (selectedTargets.has('item') ? ' selected' : '');
    // A chip-reorder drag passing over this chip isn't an image to
    // assign -- assignDroppedImages would fall back to reading a pool
    // index out of an empty 'text/plain' payload (Number('') is 0) and
    // assign the first pool image.
    chip.ondragover = (e) => {
      if (dragIsChipReorder(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    chip.ondrop = (e) => {
      if (dragIsChipReorder(e)) return;
      e.preventDefault();
      e.stopPropagation();
      assignDroppedImages('item', e);
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

    const frame = document.createElement('div');
    frame.className = 'crop-frame';
    chip.appendChild(frame);

    const img = document.createElement('img');
    img.alt = 'Item image';
    frame.appendChild(img);

    // The chip only ever shows the primary image (index 0) -- the rest
    // live on the Item photos card (buildItemPhotosCard), with a "+N"
    // badge here pointing at it.
    const primaryRef = draft.itemImageRefs[0] || null;
    if (primaryRef) {
      img.src = imageRefSrc(primaryRef, folderPath);
      applyImageCrop(img, frame, getDraftCrop(primaryRef, 'thumb'), { useDefault: true });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'item-modal-chip-remove icon icon-close';
      removeBtn.title =
        draft.itemImageRefs.length > 1
          ? 'Remove the main item image (the next one takes its place)'
          : 'Remove item image';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        draft.itemImageRefs.shift();
        refreshEditFilesArea();
      };
      chip.appendChild(removeBtn);

      if (draft.itemImageRefs.length > 1) {
        const countBtn = document.createElement('button');
        countBtn.type = 'button';
        countBtn.className = 'item-modal-chip-count';
        countBtn.textContent = `+${draft.itemImageRefs.length - 1}`;
        countBtn.title = 'Show all item photos';
        countBtn.setAttribute('aria-label', 'Show all item photos');
        countBtn.onclick = (e) => {
          e.stopPropagation();
          focusItemPhotosCard();
        };
        chip.appendChild(countBtn);
      }
    } else {
      showBorrowedItemThumbnail(img, frame);
    }

    return chip;
  }

  // Fills an item-level image slot (the topbar chip's <img>, the Item
  // photos card's thumbnail) when the draft has no explicit item image.
  // No explicit assignment in the draft (no metadataItemImages, no
  // thumb.* convention match) doesn't mean the item has no thumbnail:
  // resolveItemThumbnail (thumbnailResolver.js, via this same
  // getItemThumbnail IPC) has a third fallback tier below those two --
  // the first print file that resolves to a real thumbnail, including
  // an embedded gcode thumbnail generated/cached in the main process.
  // That's exactly what the grid card already shows for this same item
  // (see grid.js's identical getItemThumbnail call), so without this
  // the editor showed the "no thumbnail" placeholder for the common
  // case of an item with no *explicit* image, even though one is
  // clearly visible everywhere else. This tier can't be computed
  // client-side the way the other two are (it depends on gcode parsing
  // and the on-disk thumbnail cache), so it's resolved async via IPC,
  // same as grid.js's card thumbnail. Deliberately no crop/remove
  // controls on it -- there's no real assignment in the draft to act
  // on, only a borrowed preview. Add-mode has no catalog entry yet for
  // this folder, so there's no IPC-resolvable fallback to ask for --
  // that path mirrors createDraftFromPicked's client-side-only
  // resolution (explicitThumb + per-file filename match) and just
  // shows the placeholder.
  //
  // `frame` is the .crop-frame the <img> sits in. The borrowed image
  // is often a real photo that has its own thumb crop (the grid card
  // shows it cropped), so the crop is looked up by filename against
  // the draft's crops -- same source every other edit-mode thumbnail
  // reads, so a crop edited in this session shows up here too.
  function showBorrowedItemThumbnail(img, frame) {
    img.src = 'nothumb.svg';
    if (mode !== 'edit' || !item) return;
    window.catalogAPI
      .getItemThumbnail(item)
      .then((thumb) => {
        img.src = thumb ? fileUrl(thumb) : 'nothumb.svg';
        if (thumb) {
          img.title = "Preview borrowed from a print file -- not an assigned item photo";
          const filename = thumb.split(/[\\/]/).pop();
          applyImageCrop(img, frame, getDraftCrop({ kind: 'existing', name: filename }, 'thumb'), {
            useDefault: true,
          });
        }
      })
      .catch(() => {
        img.src = 'nothumb.svg';
      });
  }

  // The item's own photos, laid out as the first card in the file list
  // -- same .print-file-entry shell and image-chip row a print file
  // gets (buildFileEntry), and the same three ways to assign to it: a
  // click-selected target (its checkbox, kept in sync with the topbar
  // chip's, since both are the one 'item' target), drag-and-drop, and
  // the gallery's assign arrow. The chips are every assigned image in
  // order; the first is the main image (outlined), and clicking any
  // other one promotes it. The topbar chip and the main-grid card show
  // only that main image for now.
  function buildItemPhotosCard() {
    const refs = draft.itemImageRefs;

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'file-thumb-wrap crop-frame';
    const img = document.createElement('img');
    img.alt = 'Item photos';
    thumbWrap.appendChild(img);
    if (refs.length > 0) {
      img.src = imageRefSrc(refs[0], folderPath);
      applyImageCrop(img, thumbWrap, getDraftCrop(refs[0], 'thumb'), { useDefault: true });
    } else {
      showBorrowedItemThumbnail(img, thumbWrap);
    }

    const nameEl = document.createElement('h3');
    nameEl.className = 'file-name';
    nameEl.textContent = 'Item photos';

    const card = buildFileEntry({
      editable: true,
      selected: selectedTargets.has('item'),
      onToggleSelect: (checked) => {
        if (checked) selectedTargets.add('item');
        else selectedTargets.delete('item');
        refreshEditFilesArea();
      },
      thumbWrap,
      nameEl,
      subtitleText:
        refs.length === 0
          ? 'No item photos yet'
          : refs.length === 1
            ? '1 photo'
            : `${refs.length} photos, click one to make it the main image`,
      metaLines: [],
      chips: refs.map((ref, idx) => ({
        src: imageRefSrc(ref, folderPath),
        thumbCrop: getDraftCrop(ref, 'thumb'),
        primary: idx === 0,
        title: idx === 0 ? 'Main image' : 'Make this the main image',
        onClick:
          idx === 0
            ? null
            : () => {
                refs.splice(idx, 1);
                refs.unshift(ref);
                refreshEditFilesArea();
              },
        onRemove: () => {
          refs.splice(idx, 1);
          refreshEditFilesArea();
        },
      })),
      // The first chip is the item's main image, so dragging one to the
      // front promotes it -- same result as clicking it.
      onReorderChips: (from, insertAt) => {
        moveListItem(refs, from, insertAt);
        refreshEditFilesArea();
      },
    });
    card.classList.add('item-photos-card');
    // Same name the hidden view-mode twin gets (renderHiddenItemPhotosCard)
    // so the browser can pair them across the mode switch.
    card.style.viewTransitionName = 'item-photos-card';

    // Same drag claiming rules as buildPrintFileCard's card-level
    // handlers, minus the trashed check (this card can't be trashed) --
    // see dragIsImage for why anything that isn't an image drag is
    // left alone to bubble up to the file-area drop zone instead.
    card.ondragover = (e) => {
      if (!dragIsImage(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    card.ondragenter = (e) => {
      if (!dragIsImage(e)) return;
      card.classList.add('drop-target-active');
    };
    card.ondragleave = (e) => {
      if (!card.contains(e.relatedTarget)) card.classList.remove('drop-target-active');
    };
    card.ondrop = (e) => {
      if (!dragIsImage(e)) return;
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('drop-target-active');
      assignDroppedImages('item', e);
    };

    return card;
  }

  function buildPrintFileCard(pf) {
    const isTrashed = draft.trashedPrintFiles.has(pf.key);
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'file-thumb-wrap crop-frame';
    const img = document.createElement('img');
    img.alt = pf.displayName || pf.shortname;
    img.src = pf.images.length > 0 ? imageRefSrc(pf.images[0], folderPath) : 'nothumb.svg';
    thumbWrap.appendChild(img);
    if (pf.images.length > 0) {
      applyImageCrop(img, thumbWrap, getDraftCrop(pf.images[0], 'thumb'), { useDefault: true });
    }
    // Inert placeholders -- real and functional only in view mode (see
    // renderItemDetail's file-row loop, makeZoomButton/
    // makeThumbCycleButtons in lightbox.js). Kept here, disabled and
    // hidden, purely so .file-thumb-wrap's shape matches in both
    // modes; wiring these up for real in edit mode too (a working
    // zoom/cycle here would need its own crop-lookup path, since edit
    // mode resolves crops via getDraftCrop against draft.imageCrops,
    // not cropRectFor against the saved item) is a separate,
    // not-yet-requested feature, not a DOM-shape concern.
    const zoomPlaceholder = document.createElement('button');
    zoomPlaceholder.type = 'button';
    zoomPlaceholder.className = 'thumb-zoom-btn icon icon-zoom-in print-file-action-hidden';
    zoomPlaceholder.disabled = true;
    zoomPlaceholder.tabIndex = -1;
    thumbWrap.appendChild(zoomPlaceholder);
    const prevPlaceholder = document.createElement('button');
    prevPlaceholder.type = 'button';
    prevPlaceholder.className = 'file-thumb-cycle-btn file-thumb-cycle-prev print-file-action-hidden';
    prevPlaceholder.disabled = true;
    prevPlaceholder.tabIndex = -1;
    thumbWrap.appendChild(prevPlaceholder);
    const nextPlaceholder = document.createElement('button');
    nextPlaceholder.type = 'button';
    nextPlaceholder.className = 'file-thumb-cycle-btn file-thumb-cycle-next print-file-action-hidden';
    nextPlaceholder.disabled = true;
    nextPlaceholder.tabIndex = -1;
    thumbWrap.appendChild(nextPlaceholder);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'item-modal-file-name-input';
    nameInput.value = pf.displayName || pf.shortname;
    nameInput.title = pf.key;
    nameInput.disabled = isTrashed;
    nameInput.oninput = () => {
      pf.displayName = nameInput.value;
    };

    const card = buildFileEntry({
      editable: true,
      selected: !isTrashed && selectedTargets.has(pf.key),
      onToggleSelect: (checked) => {
        if (isTrashed) return; // can't be an image target while staged for deletion
        if (checked) selectedTargets.add(pf.key);
        else selectedTargets.delete(pf.key);
        refreshEditFilesArea();
      },
      thumbWrap,
      nameEl: nameInput,
      // Printer model moved out of the subtitle and into .file-meta,
      // to match view mode exactly -- see buildFileSubtitleText/
      // buildFileMetaLines (top of file). This card used to fold
      // printer model into the subtitle and show no meta block at
      // all (no print time, filament, or pauses); now both modes
      // build the exact same two pieces from the exact same fields.
      subtitleText: buildFileSubtitleText(pf),
      metaLines: buildFileMetaLines(pf),
      chips: pf.images.map((ref, idx) => ({
        src: imageRefSrc(ref, folderPath),
        thumbCrop: getDraftCrop(ref, 'thumb'),
        onRemove: () => {
          pf.images.splice(idx, 1);
          refreshEditFilesArea();
        },
      })),
      // pf.images[0] is the print file's thumbnail, so order matters
      // here too. Not offered on a card that's queued for deletion.
      onReorderChips: isTrashed
        ? null
        : (from, insertAt) => {
            moveListItem(pf.images, from, insertAt);
            refreshEditFilesArea();
          },
    });
    // Same view-transition-name a matching file's card gets in view
    // mode (printFileTransitionName) -- lets the browser morph this
    // specific card smoothly across the mode switch instead of a hard
    // cut, same mechanism as the tags row and its chip-remove buttons.
    card.style.viewTransitionName = printFileTransitionName(pf);

    if (isTrashed) {
      card.classList.add('print-file-entry-trashed');
      // buildFileEntry's `editable` flag has to stay true above (it
      // also controls the real-vs-placeholder Print button, which
      // must stay hidden/placeholder in edit mode regardless of trash
      // state), so the checkbox is disabled directly here rather than
      // by threading a second meaning through that flag.
      const checkbox = card.querySelector('.item-modal-target-select');
      if (checkbox) checkbox.disabled = true;
    }

    if (pf.isNew) {
      // Same "not saved yet" badge buildPendingPrintFileCard uses for
      // a .3mf staged add -- this card is otherwise a full, real
      // print-file-entry (see addExternalPrintFileToDraft above), just
      // not actually on disk yet. insertBefore rather than append so
      // it reads as the top of the card, ahead of the (absolutely
      // positioned, flow-inert) checkbox/thumbnail rather than after
      // everything else.
      const badge = document.createElement('span');
      badge.className = 'pending-badge pending-badge-add';
      badge.textContent = 'Pending';
      card.insertBefore(badge, card.firstChild);
    }

    const trashBtn = document.createElement('button');
    trashBtn.type = 'button';
    if (pf.isNew) {
      // Nothing to restore -- this print file was never saved in the
      // first place, so its only action is a plain removal from the
      // draft, same as buildPendingPrintFileCard's remove button for
      // a staged .3mf.
      trashBtn.className = 'print-file-trash-btn icon icon-close';
      trashBtn.title = 'Remove this print file';
      trashBtn.setAttribute('aria-label', 'Remove this print file');
      trashBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        draft.printFiles = draft.printFiles.filter((f) => f !== pf);
        selectedTargets.delete(pf.key);
        refreshEditFilesArea();
      };
    } else {
      trashBtn.className = `print-file-trash-btn icon ${isTrashed ? 'icon-restore' : 'icon-delete'}`;
      trashBtn.title = isTrashed ? 'Restore this print file' : 'Delete this print file';
      trashBtn.setAttribute('aria-label', isTrashed ? 'Restore this print file' : 'Delete this print file');
      trashBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isTrashed) {
          draft.trashedPrintFiles.delete(pf.key);
        } else {
          draft.trashedPrintFiles.add(pf.key);
          selectedTargets.delete(pf.key); // can't stay an image-assignment target once staged for deletion
        }
        refreshEditFilesArea();
      };
    }
    card.appendChild(trashBtn);

    // Card-level drag/drop -- pure event wiring, not a DOM-shape
    // concern, so this stays here rather than in buildFileEntry; view
    // mode's row simply never gets these handlers. Only claims the
    // drag (preventDefault/stopPropagation/highlight) when it looks
    // like an image and the card isn't trashed -- see dragIsImage
    // above for why anything else is left alone rather than swallowed.
    const cardClaimsDrag = (e) => !isTrashed && dragIsImage(e);
    card.ondragover = (e) => {
      if (!cardClaimsDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    card.ondragenter = (e) => {
      if (!cardClaimsDrag(e)) return;
      card.classList.add('drop-target-active');
    };
    card.ondragleave = (e) => {
      if (!card.contains(e.relatedTarget)) card.classList.remove('drop-target-active');
    };
    card.ondrop = (e) => {
      if (!cardClaimsDrag(e)) return;
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

    return card;
  }

  // A staged (not-yet-copied) .3mf companion file (see
  // addExternalPrintFileToDraft -- a .gcode/.bgcode gets a full,
  // parsed buildPrintFileCard() preview instead, isNew: true, since it
  // has real fields to show). A .3mf has no equivalent real card even
  // after a real scan (indexer.js never cards project files), so
  // there's nothing to preview it as -- deliberately lighter than a
  // real card (no thumb/meta/checkbox/rename) rather than a full card
  // with placeholder fields standing in for data that doesn't exist.
  // Reuses the same .pending-badge-add styling the main grid's
  // "Added" badge uses (editSession.css) so it reads as the same kind
  // of "not saved yet" state, not a new visual language.
  function buildPendingPrintFileCard(entry) {
    const card = document.createElement('div');
    card.className = 'print-file-entry print-file-entry-pending';

    const badge = document.createElement('span');
    badge.className = 'pending-badge pending-badge-add';
    badge.textContent = 'Pending';
    card.appendChild(badge);

    const name = document.createElement('p');
    name.className = 'print-file-pending-name';
    name.textContent = entry.name;
    name.title = entry.name;
    card.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon icon-close';
    removeBtn.title = 'Remove';
    removeBtn.onclick = () => {
      draft.newPrintFiles = draft.newPrintFiles.filter((f) => f !== entry);
      refreshEditFilesArea();
    };
    card.appendChild(removeBtn);

    return card;
  }

  // "+ Add print file(s)" tile at the end of the card list -- opens
  // its own file-picker dialog (editSession:browsePrintFiles, main.js),
  // and doubles as a drop zone so a print file can be dragged straight
  // in instead. Nothing is copied to disk here -- see
  // addExternalPrintFileToDraft for what actually happens to a picked/
  // dropped file (a full parsed preview card for .gcode/.bgcode, or
  // the older lightweight staging for .3mf); either way nothing hits
  // disk until Save, same as every other edit-mode field.
  function buildAddPrintFileTile() {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'print-file-add-tile';
    tile.textContent = '+ Add print file(s)';
    tile.title = 'Add print file(s)\u2026';
    tile.onclick = async () => {
      const picked = await window.catalogAPI.editSessionBrowsePrintFiles();
      for (const p of picked) await addExternalPrintFileToDraft(p.path, p.name);
      if (picked.length > 0) refreshEditFilesArea();
    };
    tile.ondragover = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    tile.ondragenter = () => tile.classList.add('drop-target-active');
    tile.ondragleave = (e) => {
      if (!tile.contains(e.relatedTarget)) tile.classList.remove('drop-target-active');
    };
    tile.ondrop = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      tile.classList.remove('drop-target-active');
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return; // in-app drags have nothing to do with this tile
      let added = false;
      for (const f of files) {
        if (!isPrintFileName(f.name)) continue;
        await addExternalPrintFileToDraft(window.catalogAPI.getPathForFile(f), f.name);
        added = true;
      }
      if (added) refreshEditFilesArea();
    };
    return tile;
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

    // Condensed from a heading + explanatory paragraph into a single
    // help icon carrying the same instructions as a tooltip (title
    // attribute) -- now that the column is a single narrow list
    // rather than a grid, a full paragraph took up disproportionate
    // space. No aria-label needed beyond title; not disabled/no
    // onclick, so it stays focusable/hoverable for the native tooltip
    // via mouse or keyboard, purely informational otherwise.
    const helpIcon = document.createElement('button');
    helpIcon.type = 'button';
    helpIcon.className = 'item-modal-gallery-help icon icon-help';
    helpIcon.title =
      selectedTargets.size > 0
        ? `Click the assign icon on an image to assign it to ${selectedTargets.size} selected target${
            selectedTargets.size === 1 ? '' : 's'
          }.`
        : 'Select the item photos and/or one or more print files, then click the assign icon on an image to assign it. Drag-and-drop also works.';
    col.appendChild(helpIcon);

    const grid = document.createElement('div');
    grid.className = 'item-modal-gallery-grid';
    draft.poolImages.forEach((ref, idx) => {
      const cell = document.createElement('div');
      cell.className = 'item-modal-gallery-item';

      const frame = document.createElement('div');
      frame.className = 'item-modal-gallery-thumb crop-frame';
      cell.appendChild(frame);

      const thumb = document.createElement('img');
      thumb.title = ref.name;
      thumb.draggable = true;
      thumb.ondragstart = (e) => e.dataTransfer.setData('text/plain', String(idx));
      thumb.src = imageRefSrc(ref, folderPath);
      frame.appendChild(thumb);
      applyImageCrop(thumb, frame, getDraftCrop(ref, 'thumb'), { useDefault: true });

      // The one crop-adjust control for this image -- opens the
      // dialog for both its thumbnail crop and its full-view crop
      // (tabs), used everywhere this image is later assigned
      // (item image, any print file), rather than a separate control
      // per place it happens to be assigned. Appended to the cell
      // (not the frame) so it sits outside the image wrapper, next to
      // the assign button -- appending it inside .crop-frame put it
      // under that element's overflow:hidden (needed for the crop
      // translate itself), which clipped its negative-offset overhang
      // instead of showing it as a clean corner badge. Bottom-left
      // corner mirrors the existing assign button (bottom-right, see
      // .item-modal-assign-btn below), so the two sit side by side.
      cell.appendChild(makeCropAdjustButton(ref, thumb, frame));

      const assignBtn = document.createElement('button');
      assignBtn.type = 'button';
      assignBtn.className = 'item-modal-assign-btn icon icon-arrow-back';
      assignBtn.title = 'Assign to selected target(s)';
      assignBtn.setAttribute('aria-label', 'Assign to selected targets');
      assignBtn.disabled = selectedTargets.size === 0;
      assignBtn.onclick = () => assignImageToTargets(ref);
      cell.appendChild(assignBtn);

      grid.appendChild(cell);
    });
    col.appendChild(grid);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'item-modal-gallery-add-btn icon icon-add';
    addBtn.title = 'Add image\u2026';
    addBtn.setAttribute('aria-label', 'Add image');
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
    buildOriginRowContents(container, {
      origin: draft.origin,
      editable: true,
      onPencilClick: () => {
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
      },
      onRefreshClick: async (e) => {
        const refreshBtn = e.currentTarget;
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
      },
    });
  }

  // Same predicate view mode's own file list uses to decide what's
  // shown at all (renderContent's matchesPrinterOnly/matchingFiles) --
  // reused here so edit mode's sort/mark treatment (refreshEditFilesArea)
  // classifies files exactly the way switching to view mode actually
  // would, not a separately-maintained approximation of it.
  function fileWouldShowInBrowsing(pf) {
    const effective = effectivePrinterFilter();
    if (!fileMatchesPrinterAndTime(pf, effective)) return false;
    return fileMatchesKeywordInItem(item, pf, keywordQuery);
  }

  function buildEditRoot() {
    const root = document.createElement('div');
    // Same class as view mode's root (renderItemDetail's wrap) --
    // neither .item-modal-edit nor .item-detail was ever an actual
    // CSS selector or a JS mode-detection check, just an inert marker
    // each mode happened to name differently; no reason for two names
    // when both do (and always did) nothing.
    root.className = 'item-detail';

    if (mode === 'add') {
      const addLabel = document.createElement('p');
      addLabel.className = 'item-modal-add-label';
      addLabel.textContent = 'Add item';
      root.appendChild(addLabel);
    }

    // Thumbnail and name both now live in the topbar (see
    // renderTopBar) -- item-modal-edit-header used to hold them here,
    // but with both hoisted out it had nothing left in it, so it's
    // gone rather than kept as an empty wrapper.

    // Mirrors view mode's .item-detail-header exactly (same class),
    // enclosing origin info + tags the same way there -- .item-detail
    // isn't a flex container here the way view mode's wrap is, so
    // .item-detail-header's flex: 1 0 100% is simply inert, not
    // conflicting with anything.
    const header = document.createElement('div');
    header.className = 'item-detail-header';
    root.appendChild(header);

    const originRow = document.createElement('div');
    originRow.className = 'item-modal-origin-row';
    header.appendChild(originRow);
    renderOriginRow(originRow);

    const tagsWrapLabel = document.createElement('div');
    tagsWrapLabel.className = 'item-detail-tags';
    editTagsField = createTagInput('Tagged', draft.tags, () => Array.from(collectTags(allItems)).sort());
    tagsWrapLabel.appendChild(editTagsField.wrap);
    header.appendChild(tagsWrapLabel);

    const filesArea = document.createElement('div');
    filesArea.className = 'item-detail-body';
    root.appendChild(filesArea);

    refreshEditFilesArea = () => {
      filesArea.innerHTML = '';
      // thumbChipHolder is now built by renderTopBar(), not here (see
      // the outer-scope declaration near `mode`/`draft` above) --
      // still refreshed from this same spot since an image
      // assignment change needs it updated regardless of where the
      // element physically lives.
      thumbChipHolder.innerHTML = '';
      thumbChipHolder.appendChild(buildItemThumbChip());

      const filesCol = document.createElement('div');
      filesCol.className = 'item-detail-files';
      // Whole-area drop zone for adding print files -- a print-file
      // drag isn't claimed by any individual card (see dragIsImage/
      // cardClaimsDrag in buildPrintFileCard) or by the add-print-file
      // tile unless it's dropped exactly on the tile, so it bubbles up
      // to here from anywhere in the list, and the highlight covers
      // the whole area rather than implying one particular card (or
      // nothing at all) is the drop target. Mirrors
      // buildAddPrintFileTile's own drop handling below, just scoped
      // to "anywhere in this column" instead of "exactly on this
      // button".
      // A chip being dragged to reorder isn't a print file either --
      // without the dragIsChipReorder checks the whole list would light
      // up as a print-file drop zone every time a chip is picked up.
      filesCol.ondragover = (e) => {
        if (dragIsImage(e) || dragIsChipReorder(e)) return; // no whole-list image target -- let it fall through unhandled
        e.preventDefault();
      };
      filesCol.ondragenter = (e) => {
        if (dragIsImage(e) || dragIsChipReorder(e)) return;
        filesCol.classList.add('item-detail-files-drop-active');
      };
      filesCol.ondragleave = (e) => {
        if (!filesCol.contains(e.relatedTarget)) filesCol.classList.remove('item-detail-files-drop-active');
      };
      filesCol.ondrop = async (e) => {
        if (dragIsImage(e) || dragIsChipReorder(e)) return;
        e.preventDefault();
        filesCol.classList.remove('item-detail-files-drop-active');
        const files = e.dataTransfer.files;
        if (!files || files.length === 0) return;
        let added = false;
        for (const f of files) {
          if (!isPrintFileName(f.name)) continue;
          await addExternalPrintFileToDraft(window.catalogAPI.getPathForFile(f), f.name);
          added = true;
        }
        if (added) refreshEditFilesArea();
      };
      // Edit mode never hides a file the way view mode's printer/
      // search filter does (see renderContent's matchingFiles) -- but
      // rather than showing everything in a flat, undifferentiated
      // list with no relationship to whatever filter happens to be
      // active, files that WOULD be filtered out under view mode's own
      // rules are sorted after the ones that wouldn't, and marked
      // (.print-file-filtered-out) rather than looking identical to a
      // real match. mode === 'edit' only -- add mode has no existing
      // item/browsing context for "current filter relevance" to mean
      // anything against.
      const files =
        mode === 'edit'
          ? [...draft.printFiles].sort((a, b) => {
              const aShows = fileWouldShowInBrowsing(a);
              const bShows = fileWouldShowInBrowsing(b);
              return aShows === bShows ? 0 : aShows ? -1 : 1;
            })
          : draft.printFiles;
      // Always first, ahead of the print files' relevance sort -- it's
      // the item's own card, not one of the files.
      itemPhotosCardEl = buildItemPhotosCard();
      filesCol.appendChild(itemPhotosCardEl);
      for (const pf of files) {
        const card = buildPrintFileCard(pf);
        if (mode === 'edit' && !fileWouldShowInBrowsing(pf)) {
          card.classList.add('print-file-filtered-out');
          card.title = "Wouldn't be shown right now under the current search/printer filter";
        }
        filesCol.appendChild(card);
      }
      for (const entry of draft.newPrintFiles) {
        filesCol.appendChild(buildPendingPrintFileCard(entry));
      }
      filesCol.appendChild(buildAddPrintFileTile());
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
      if (pf.isNew) continue; // carries its own images/displayName via newPrintFiles below -- pf.key is a sourcePath, not a real on-disk name, until editSession.js resolves it
      if (draft.trashedPrintFiles.has(pf.key)) continue; // being deleted -- nothing to carry into metadata.json
      if (pf.images.length > 0) printFileImages[pf.key] = pf.images;
      if (pf.displayName) printFileNames[pf.key] = pf.displayName;
    }
    const payload = {
      name: draft.displayName.trim(),
      tags,
      printFileImages,
      printFileNames,
      origin: draft.origin,
      itemImages: draft.itemImageRefs,
      // { path, images, displayName } descriptors -- editSession.js
      // copies each one in (resolving collisions), then resolves its
      // own images/displayName under whatever final name it actually
      // lands on (see _resolveNewPrintFiles). The isNew draft.printFiles
      // entries (gcode/bgcode, parsed+previewed immediately -- see
      // addExternalPrintFileToDraft) carry real images/displayName;
      // the older draft.newPrintFiles staging (.3mf only, no card of
      // its own to carry either on) just sends empty/null for both.
      newPrintFiles: [
        ...draft.printFiles
          .filter((f) => f.isNew)
          .map((f) => ({ path: f.sourcePath, images: f.images, displayName: f.displayName || null })),
        ...draft.newPrintFiles.map((f) => ({ path: f.path, images: [], displayName: null })),
      ],
      // Plain on-disk filenames (pf.key) -- editSession.js deletes each
      // one from the item's folder and drops its stale metadata.json
      // override (writeItemMetadata's removePrintFiles); nothing here
      // needs to do more than list which ones, since
      // printFileImages/printFileNames above already just omit them.
      trashedPrintFiles: Array.from(draft.trashedPrintFiles),
      // Sent as-is, still keyed by refIdentity -- editSession.js
      // resolves each identity to its final on-disk filename itself
      // (see its _resolveImageCrops), using the same resolvedPathToName
      // map the image assignments above just got resolved through, so
      // an external image's crop always ends up filed under whatever
      // name that image actually landed at, even after a collision
      // rename.
      imageCrops: draft.imageCrops,
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
    withViewTransition(() => {
      mode = 'edit';
      draft = createDraftFromItem(item);
      selectedTargets = new Set();
      renderTopBar();
      renderContent();
    });
  }

  // The symmetric counterpart to enterEditMode() -- called by the
  // global edit-session bar (see editSession-ui.js) when edit mode
  // ends (Discard All Changes or a successful Confirm) while this
  // modal is still open in edit mode, so it doesn't get stranded
  // showing a draft that no longer corresponds to anything staged.
  // Any in-progress unsaved draft is simply dropped -- consistent
  // with Discard All Changes, and harmless after Confirm since a
  // draft only ever affects pendingChanges via saveDraft(), which if
  // called already landed before Confirm was clicked.
  //
  // For 'add' mode there's no "view" to fall back into -- the item
  // doesn't exist until Save is clicked -- so the session ending just
  // closes the modal outright, same as if its own Cancel button had
  // been clicked.
  //
  // Re-reads the item from the now-current allItems (post-cancel/
  // confirm) rather than reusing the stale closured item, since the
  // underlying data may have changed. If the item is gone entirely --
  // e.g. this was a staged delete that just got confirmed -- there's
  // nothing left to view, so close the modal instead.
  function exitEditMode() {
    if (mode === 'add') {
      close();
      return;
    }
    if (mode !== 'edit') return;
    const freshItem = allItems.find((i) => i.path === item.path);
    if (!freshItem) {
      close();
      return;
    }
    withViewTransition(() => {
      item = freshItem;
      folderPath = item.path;
      sourceDir = item.path;
      draft = null;
      selectedTargets = new Set();
      mode = 'view';
      renderTopBar();
      renderContent();
    });
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
        folderPath = sourceDir;
        draft = createDraftFromPicked(picked);
        renderTopBar();
        renderContent();
        document.body.appendChild(overlay);
        lockBackgroundScroll();
        // Registered only once the form is actually visible -- nothing
        // to close before this point beyond the native folder picker,
        // which already handles its own cancellation above. No
        // itemPath (there's no item yet); switchToEdit is a no-op
        // since 'add' mode never starts out in 'view' for the global
        // "entered edit mode" listener to catch (see enterEditMode's
        // own comment).
        myOpenModalHandle = { itemPath: null, switchToEdit: () => {}, switchToView: exitEditMode };
        openModalHandle = myOpenModalHandle;
      })
      .catch((err) => alert(err.message)); // e.g. a dropped path that wasn't actually a folder
    return;
  }

  myOpenModalHandle = { itemPath: item.path, switchToEdit: enterEditMode, switchToView: exitEditMode };
  openModalHandle = myOpenModalHandle;

  if (mode === 'edit') draft = createDraftFromItem(item);

  renderTopBar();
  renderContent();
  document.body.appendChild(overlay);
  lockBackgroundScroll();
}
// Read-only "Tagged" row for view mode -- same label class
// (.settings-field-label) and chip classes (.tag-chip.tag-chip-existing,
// no remove button) as the editable tag-chip-list edit mode already
// uses, so the two only differ by the interactive bits, not by
// structure. Always renders the row (even with zero tags) so the
// transition anchor point exists in both modes regardless of the
// item's tag count.
function renderTagsRow(tags) {
  const row = document.createElement('div');
  row.className = 'item-detail-tags';

  // Matches edit mode's own wrapper (editTagsField.wrap from
  // createTagInput, settings.js -- '.settings-field.tag-input-field')
  // exactly, tag and class both, even though nothing here needs
  // tag-input-field's position: relative (that's for anchoring the
  // suggestion dropdown, which doesn't exist in this read-only
  // version) -- full structural parity was the point, and an unused
  // position: relative is harmless.
  const field = document.createElement('div');
  field.className = 'settings-field tag-input-field';
  row.appendChild(field);

  const label = document.createElement('label');
  label.className = 'settings-field-label';
  label.textContent = 'Tagged';
  field.appendChild(label);

  // Reuses .tag-input-box (settings.css) -- the same bordered shell
  // edit mode's chip list sits inside (see createTagInput,
  // settings.js) -- rather than a bare wrapper, so the container's
  // padding/border/background already match edit mode before the
  // transition even starts. That leaves the input field itself (only
  // present in edit mode) as the one real shape difference the morph
  // has to show, instead of also resizing/redecorating the box around
  // it every time.
  const box = document.createElement('div');
  box.className = 'tag-input-box item-detail-tags-box';
  field.appendChild(box);

  const chipList = document.createElement('div');
  chipList.className = 'tag-chip-list';
  box.appendChild(chipList);

  if (tags && tags.length) {
    tags.forEach((tag, index) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip tag-chip-existing';

      const text = document.createElement('span');
      text.textContent = tag;
      chip.appendChild(text);

      // Invisible, non-interactive placeholder -- exists purely so
      // this position has a real element on BOTH sides of the
      // view<->edit transition, sharing the same
      // item-modal-chip-remove-<index> view-transition-name as edit
      // mode's actual clickable button (renderChips(), settings.js).
      // With a genuine match on both sides, the browser interpolates
      // size/opacity between the two real states on its own -- the
      // same native morph already working cleanly for the row itself
      // -- rather than treating the button as a synthetic enter/exit,
      // which needs its own hand-written keyframes (see the
      // :only-child rules in itemModal.css) and turned out to fly in
      // from an unrelated spot on the page. Those rules are kept as a
      // fallback for when this doesn't apply -- if the tag count/
      // order actually changed during editing (a tag added/removed
      // before Cancel/Save), some indices genuinely won't have a
      // counterpart on one side.
      const removePlaceholder = document.createElement('span');
      removePlaceholder.className = 'tag-chip-remove tag-chip-remove-placeholder icon icon-close';
      removePlaceholder.setAttribute('aria-hidden', 'true');
      removePlaceholder.style.viewTransitionName = `item-modal-chip-remove-${index}`;
      chip.appendChild(removePlaceholder);

      chipList.appendChild(chip);
    });
  } else {
    const none = document.createElement('span');
    none.className = 'item-detail-tags-none';
    none.textContent = 'No tags';
    chipList.appendChild(none);
  }

  return row;
}

function renderItemDetail(item) {
  const wrap = document.createElement('div');
  wrap.className = 'item-detail';

  const header = document.createElement('div');
  header.className = 'item-detail-header';
  // Name itself now renders in the topbar (see renderTopBar), centered
  // on the same row as the Close button -- not duplicated here anymore.

  // Always present now, matching edit mode's origin row exactly (see
  // buildOriginRowContents) -- including the pencil/refresh buttons,
  // just inert here. Previously this whole element was omitted when
  // there was no origin; now it always renders, falling back to "No
  // original location set." like edit mode does, for full structural
  // parity between the two modes.
  const originRow = document.createElement('div');
  originRow.className = 'item-modal-origin-row';
  header.appendChild(originRow);
  buildOriginRowContents(originRow, { origin: item.origin, editable: false });

  // Shares .item-detail-tags/.tag-chip-list with edit mode's tag
  // input (createTagInput, settings.js) on purpose, even though this
  // is read-only -- keeping the same wrapper/label/chip-list shape in
  // both trees is what lets a future transition (manual FLIP, or the
  // View Transitions API, which Electron's Chromium supports) treat
  // this as one continuous element across the mode switch instead of
  // two unrelated ones. See view-transition-name hook in itemModal.css.
  header.appendChild(renderTagsRow(item.tags));
  wrap.appendChild(header);

  // Shared shape with edit mode's own body row now (see
  // buildEditRoot): .item-detail-body > .item-detail-files
  // (the actual wrapping file-card grid) + the gallery column. Files
  // used to be flat children of .item-detail itself, which did its
  // own flex-wrap/justify-content -- both moved down to
  // .item-detail-files (itemModal.css) now that it's the real
  // shared file-list container instead of edit-mode-only.
  const body = document.createElement('div');
  // item-detail-body-reserve (itemModal.css, view-mode only -- not
  // applied in buildEditRoot) pads this out by the same amount the
  // real gallery column takes up in edit mode, so the file cards below
  // never have to rewrap when switching modes.
  body.className = 'item-detail-body item-detail-body-reserve';
  wrap.appendChild(body);

  const filesCol = document.createElement('div');
  filesCol.className = 'item-detail-files';
  body.appendChild(filesCol);

  // Present but hidden -- see renderHiddenItemPhotosCard below.
  filesCol.appendChild(renderHiddenItemPhotosCard());

  for (const file of item.files) {
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'file-thumb-wrap crop-frame';

    const img = document.createElement('img');
    // Matches edit mode's alt text logic exactly now (pf.displayName
    // || pf.shortname, in buildPrintFileCard) -- previously this used
    // shortname only, so a file with a custom display name set would
    // get different alt text depending on which mode you were in for
    // what's visually the same thumbnail.
    img.alt = file.metadataDisplayName || file.shortname;
    thumbWrap.appendChild(img);

    const name = document.createElement('h3');
    name.className = 'file-name';
    // Read-only: shows the resolved name (custom override if the
    // editor's pencil icon set one, else the parsed shortname), but
    // this view has no rename UI of its own -- that's editor-modal
    // only, per prior correction.
    name.textContent = file.metadataDisplayName || file.shortname;

    const row = buildFileEntry({
      editable: false,
      thumbWrap,
      nameEl: name,
      // Printer model lives in metaLines below, not the subtitle --
      // matches buildFileSubtitleText/buildFileMetaLines exactly, the
      // same pair edit mode's card now builds from too.
      subtitleText: buildFileSubtitleText(file),
      metaLines: buildFileMetaLines(file),
      // Read-only twins of edit mode's real, removable chips -- same
      // count/images as file.metadataImages, no onRemove since
      // there's nothing to remove here; inert and hidden either way
      // (see buildFileEntry), just present for shape parity.
      chips: (file.metadataImages || []).map((imgName) => ({
        src: fileUrl(`${item.path}/${imgName}`),
      })),
      onPrintClick: () => handlePrintClick(file),
    });
    // Same view-transition-name buildPrintFileCard gives the matching
    // draft print-file, derived the same way (path basename) so it's
    // stable regardless of which mode's sort order put this file at a
    // different position -- see printFileTransitionName.
    row.style.viewTransitionName = printFileTransitionName(file);
    filesCol.appendChild(row);

    // Thumbnail resolution is unchanged -- async, via
    // getFileThumbnail's full fallback chain -- and just mutates
    // thumbWrap/img in place once it resolves. thumbWrap is already
    // part of the row appended above; building the row synchronously
    // doesn't need to wait for this.
    window.catalogAPI
      .getFileThumbnail(file, item.imageFiles)
      .then((thumbPath) => {
        img.src = thumbPath ? fileUrl(thumbPath) : 'nothumb.svg';
        if (thumbPath) {
          // Tracked separately from thumbPath (which stays fixed to
          // whatever was first resolved) so the zoom button below
          // always reads the crop for whichever image cycling has
          // currently put on screen, not just the first one.
          let currentPath = thumbPath;
          // Index into imagePaths (below) of whichever photo is on
          // screen -- the lightbox carousel opens on it. 0 is right
          // to start with for the reason given just before the cycle
          // buttons below.
          let currentIndex = 0;
          const imagePaths = (file.metadataImages || []).map((imgName) => `${item.path}/${imgName}`);
          applyImageCrop(img, thumbWrap, cropRectFor(item, currentPath, 'thumb'), { useDefault: true });
          thumbWrap.appendChild(
            makeZoomButton(
              () => img.src,
              img.alt,
              () => cropRectFor(item, currentPath, 'full'),
              () => buildLightboxGallery(item, imagePaths, currentIndex, img.alt)
            )
          );
          // metadataImages[0] is guaranteed to be the thumbPath we just
          // resolved above whenever this list is non-empty (see
          // thumbnailResolver.js's resolveFileThumbnail -- it's the
          // first, unconditional check in the chain), so waiting until
          // here to attach these means makeThumbCycleButtons never has
          // to reconcile a mismatch between the two -- index 0 always
          // matches what's already on screen.
          for (const btn of makeThumbCycleButtons(imagePaths, img, thumbWrap, item, (path, index) => {
            currentPath = path;
            currentIndex = index;
          })) {
            thumbWrap.appendChild(btn);
          }
        }
      })
      // Same reasoning as the item-card thumbnail above -- don't leave
      // the image blank on a rejected lookup.
      .catch(() => {
        img.src = 'nothumb.svg';
      });
  }

  // Present but collapsed -- see renderHiddenGalleryColumn below for
  // why this exists at all in a mode that can't use it. Sibling of
  // filesCol within body now, matching edit mode's own
  // .item-modal-edit-gallery placement inside .item-detail-body.
  body.appendChild(renderHiddenGalleryColumn());

  return wrap;
}
// View mode's structural counterpart to buildItemPhotosCard (edit mode
// only, openItemModal) -- same purpose as renderHiddenGalleryColumn
// below: the card is part of both modes' file-list structure, but
// only means anything while editing (view mode shows the item's main
// image in the topbar chip, and there's nowhere to show the rest), so
// this is just the same buildFileEntry shell, empty and collapsed.
// Same view-transition-name as the real card so the two pair up
// across the mode switch.
function renderHiddenItemPhotosCard() {
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'file-thumb-wrap crop-frame';
  const img = document.createElement('img');
  img.alt = 'Item photos';
  thumbWrap.appendChild(img);

  const nameEl = document.createElement('h3');
  nameEl.className = 'file-name';
  nameEl.textContent = 'Item photos';

  const card = buildFileEntry({
    editable: false,
    thumbWrap,
    nameEl,
    subtitleText: null,
    metaLines: [],
    chips: [],
  });
  card.classList.add('item-photos-card', 'item-photos-card-hidden');
  card.style.viewTransitionName = 'item-photos-card';
  return card;
}
// View mode's structural counterpart to buildGalleryColumn (edit mode
// only, openItemModal) -- part of an ongoing effort to keep the two
// modes' DOM shapes close, not just their behavior. Can't reuse
// buildGalleryColumn itself: it's a closure over draft/selectedTargets/
// folderPath, all edit-mode-only state that's null here, and it
// renders real, interactive pool-image cells with no read-only
// equivalent for a viewer to make sense of anyway. So this only
// mirrors the outer shell (column > help icon > empty grid > add
// button) using the same classes -- enough for the structure to
// match -- rather than
// reproducing populated content nobody would ever see, since
// .item-detail-gallery-collapsed (itemModal.css) hides the whole
// thing regardless of what's inside it.
function renderHiddenGalleryColumn() {
  const col = document.createElement('div');
  col.className = 'item-modal-edit-gallery item-detail-gallery-collapsed';

  // Mirrors buildGalleryColumn's current shape (help icon + chip grid
  // + add button), not the old heading -- kept in sync since this
  // only exists for structural parity in the first place.
  const helpIcon = document.createElement('button');
  helpIcon.type = 'button';
  helpIcon.className = 'item-modal-gallery-help icon icon-help';
  helpIcon.disabled = true;
  helpIcon.tabIndex = -1;
  col.appendChild(helpIcon);

  const grid = document.createElement('div');
  grid.className = 'item-modal-gallery-grid';
  col.appendChild(grid);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'item-modal-gallery-add-btn icon icon-add';
  addBtn.disabled = true;
  addBtn.tabIndex = -1;
  col.appendChild(addBtn);

  return col;
}