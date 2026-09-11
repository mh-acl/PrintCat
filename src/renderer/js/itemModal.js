'use strict';

// Unified item view/edit modal (openItemModal) -- the bulk of the
// item-detail and item-editing UI, including draft creation, the
// origin-info popup, and view-mode's print-file list (renderItemDetail,
// still live -- called from openItemModal's view-mode render path, not
// dead code).
// Depends on: state.js, utils.js, filters.js (buildFilterMessage,
// fileMatchesKeywordInItem, effectivePrinterFilter, printerLabel),
// grid.js (renderEmptyState), lightbox.js (cropRectFor, makeZoomButton),
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
function buildFileEntry(opts) {
  const {
    editable,
    selected,
    onToggleSelect,
    thumbWrap,
    nameEl,
    subtitleText,
    metaLines,
    chips, // array of { src, onRemove }
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
  (chips || []).forEach((chipData) => {
    const chip = document.createElement('span');
    chip.className = 'print-file-image-chip';
    const chipImg = document.createElement('img');
    chipImg.src = chipData.src;
    chip.appendChild(chipImg);
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
let openModalHandle = null; // { itemPath, switchToEdit() } or null while nothing's open
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
  let sourceDir = item ? item.path : null; // becomes known for 'add' once the folder's picked, below
  let folderPath = item ? item.path : null; // raw fs path, not a URL -- see imageRefSrc/fileUrl

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay item-modal-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box modal-wide item-modal-box';
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
      // buildItemThumbChip's own condition (draft.itemImageRef, which
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
          if (thumb) img.src = fileUrl(thumb);
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
      const matchesPrinterOnly =
        effective && effective.size > 0 ? item.files.filter((f) => effective.has(printerLabel(f))) : item.files;
      const matchingFiles = matchesPrinterOnly.filter((f) => fileMatchesKeywordInItem(item, f, keywordQuery));
      if (matchingFiles.length === 0) {
        // Same reasoning as the main grid's empty state (buildGridEmptyMessage)
        // -- check which active restriction (search text, printer filter)
        // is actually responsible rather than always naming the same one.
        const matchesKeywordOnly = item.files.filter((f) => fileMatchesKeywordInItem(item, f, keywordQuery));
        const message = buildFilterMessage(
          [
            {
              active: Boolean(keywordQuery),
              wouldHelp: () => matchesPrinterOnly.length > 0,
              suggestion: 'try a different search term, or clear the search box',
            },
            {
              active: effective && effective.size > 0,
              wouldHelp: () => matchesKeywordOnly.length > 0,
              suggestion: 'choose "All Printers" to see every version',
            },
          ],
          'This item has no print files.',
          'No print files here match both your search and the selected printer(s). Try loosening one of them.'
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

  // --- Edit-mode crop helpers --------------------------------------------
  // See itemMetadata.js's imageCrops schema and refIdentity above.

  function getDraftCrop(ref, mode) {
    const modes = draft.imageCrops[refIdentity(ref)];
    return (modes && modes[mode]) || null;
  }

  function setDraftCrop(ref, mode, rectOrNull) {
    const key = refIdentity(ref);
    draft.imageCrops[key] = { ...(draft.imageCrops[key] || {}), [mode]: rectOrNull };
    refreshEditFilesArea();
  }

  // Opens the crop tool for one assigned image chip. `frameEl`/`imgEl`
  // are re-cropped in place immediately on save, ahead of the full
  // refreshEditFilesArea() rebuild triggered by setDraftCrop, so the
  // chip doesn't visibly flash back to uncropped before catching up.
  function openCropperForRef(ref, mode, imgEl, frameEl) {
    openImageCropper({
      imageSrc: imageRefSrc(ref, folderPath),
      mode,
      existingRect: getDraftCrop(ref, mode),
      onSave(rect) {
        applyImageCrop(imgEl, frameEl, rect, { useDefault: mode === 'thumb' });
        setDraftCrop(ref, mode, rect);
      },
    });
  }

  // Small corner badge, added to a chip's frame in edit mode only,
  // that opens the crop tool for that specific image/mode. Mirrors
  // the existing removeBtn corner-badge pattern used elsewhere in
  // this file (e.g. buildItemThumbChip's remove button).
  function makeCropAdjustButton(ref, mode, imgEl, frameEl) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'image-crop-adjust-btn icon icon-crop';
    btn.title = mode === 'thumb' ? 'Adjust thumbnail crop' : 'Adjust framing';
    btn.setAttribute('aria-label', mode === 'thumb' ? 'Adjust thumbnail crop' : 'Adjust framing');
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCropperForRef(ref, mode, imgEl, frameEl);
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

    const frame = document.createElement('div');
    frame.className = 'crop-frame';
    chip.appendChild(frame);

    const img = document.createElement('img');
    img.alt = 'Item image';
    frame.appendChild(img);

    if (draft.itemImageRef) {
      img.src = imageRefSrc(draft.itemImageRef, folderPath);
      applyImageCrop(img, frame, getDraftCrop(draft.itemImageRef, 'thumb'), { useDefault: true });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'item-modal-chip-remove icon icon-close';
      removeBtn.title = 'Remove item image';
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        draft.itemImageRef = null;
        refreshEditFilesArea();
      };
      chip.appendChild(removeBtn);
    } else if (mode === 'edit' && item) {
      // No explicit item-level assignment in the draft (no
      // metadataItemImage, no thumb.* convention match) -- but that
      // doesn't mean the item has no thumbnail: resolveItemThumbnail
      // (thumbnailResolver.js, via this same getItemThumbnail IPC)
      // has a third fallback tier below those two -- the first print
      // file that resolves to a real thumbnail, including an embedded
      // gcode thumbnail generated/cached in the main process. That's
      // exactly what the grid card already shows for this same item
      // (see grid.js's identical getItemThumbnail call), so without
      // this the editor showed the "no thumbnail" placeholder for the
      // common case of an item with no *explicit* image, even though
      // one is clearly visible everywhere else. This tier can't be
      // computed client-side the way the other two are (it depends on
      // gcode parsing and the on-disk thumbnail cache), so it's
      // resolved async via IPC, same as grid.js's card thumbnail.
      // Deliberately no crop/remove controls here -- there's no real
      // assignment in the draft to act on, only a borrowed preview.
      window.catalogAPI
        .getItemThumbnail(item)
        .then((thumb) => {
          img.src = thumb ? fileUrl(thumb) : 'nothumb.svg';
        })
        .catch(() => {
          img.src = 'nothumb.svg';
        });
    } else {
      // Add-mode: no catalog entry exists yet for this folder, so
      // there's no IPC-resolvable fallback to ask for -- this mirrors
      // createDraftFromPicked's two-tier (explicitThumb + per-file
      // filename match) client-side-only resolution.
      img.src = 'nothumb.svg';
    }

    return chip;
  }

  function buildPrintFileCard(pf) {
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
    nameInput.oninput = () => {
      pf.displayName = nameInput.value;
    };

    const card = buildFileEntry({
      editable: true,
      selected: selectedTargets.has(pf.key),
      onToggleSelect: (checked) => {
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
        onRemove: () => {
          pf.images.splice(idx, 1);
          refreshEditFilesArea();
        },
      })),
    });
    // Same view-transition-name a matching file's card gets in view
    // mode (printFileTransitionName) -- lets the browser morph this
    // specific card smoothly across the mode switch instead of a hard
    // cut, same mechanism as the tags row and its chip-remove buttons.
    card.style.viewTransitionName = printFileTransitionName(pf);

    // Card-level drag/drop -- pure event wiring, not a DOM-shape
    // concern, so this stays here rather than in buildFileEntry; view
    // mode's row simply never gets these handlers.
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

    // Condensed from a heading + explanatory paragraph into a single
    // help icon carrying the same instructions as a tooltip (title
    // attribute) -- now that the column is a single narrow list
    // rather than a grid, a full paragraph took up disproportionate
    // space. No aria-label needed beyond title; not disabled/no
    // onclick, so it stays focusable/hoverable for the native tooltip
    // via mouse or keyboard, purely informational otherwise.
    const helpIcon = document.createElement('button');
    helpIcon.type = 'button';
    helpIcon.className = 'item-modal-gallery-help';
    helpIcon.textContent = '?';
    helpIcon.title =
      selectedTargets.size > 0
        ? `Click the assign icon on an image to assign it to ${selectedTargets.size} selected target${
            selectedTargets.size === 1 ? '' : 's'
          }.`
        : 'Select the item image and/or one or more print files, then click the assign icon on an image to assign it. Drag-and-drop also works.';
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

      // The one crop-adjust control for this image -- sets its default
      // thumbnail crop, used everywhere this image is later assigned
      // (item image, any print file), rather than a separate control
      // per place it happens to be assigned. Appended to the cell
      // (not the frame) so it sits outside the image wrapper, next to
      // the assign button -- appending it inside .crop-frame put it
      // under that element's overflow:hidden (needed for the crop
      // translate itself), which clipped its negative-offset overhang
      // instead of showing it as a clean corner badge. Bottom-left
      // corner mirrors the existing assign button (bottom-right, see
      // .item-modal-assign-btn below), so the two sit side by side.
      cell.appendChild(makeCropAdjustButton(ref, 'thumb', thumb, frame));

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
    addBtn.className = 'item-modal-gallery-add-btn';
    // TEMP: plain "+" text, not the icon font -- same situation as the
    // thumbnail-cycle arrows (lightbox.js, makeThumbCycleButtons):
    // no glyph for this in the current subset (printcat-icons.woff2)
    // yet. Flagged for the same future re-subsetting pass as those
    // arrows, not blocking on it now.
    addBtn.textContent = '+';
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
    if (effective && effective.size > 0 && !effective.has(printerLabel(pf))) return false;
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
      for (const pf of files) {
        const card = buildPrintFileCard(pf);
        if (mode === 'edit' && !fileWouldShowInBrowsing(pf)) {
          card.classList.add('print-file-filtered-out');
          card.title = "Wouldn't be shown right now under the current search/printer filter";
        }
        filesCol.appendChild(card);
      }
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
  // Re-reads the item from the now-current allItems (post-cancel/
  // confirm) rather than reusing the stale closured item, since the
  // underlying data may have changed. If the item is gone entirely --
  // e.g. this was a staged delete that just got confirmed -- there's
  // nothing left to view, so close the modal instead.
  function exitEditMode() {
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
      })
      .catch((err) => alert(err.message)); // e.g. a dropped path that wasn't actually a folder
    return;
  }

  openModalHandle = { itemPath: item.path, switchToEdit: enterEditMode, switchToView: exitEditMode };

  if (mode === 'edit') draft = createDraftFromItem(item);

  renderTopBar();
  renderContent();
  document.body.appendChild(overlay);
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
          applyImageCrop(img, thumbWrap, cropRectFor(item, currentPath, 'thumb'), { useDefault: true });
          thumbWrap.appendChild(
            makeZoomButton(() => img.src, img.alt, () => cropRectFor(item, currentPath, 'full'))
          );
          // metadataImages[0] is guaranteed to be the thumbPath we just
          // resolved above whenever this list is non-empty (see
          // thumbnailResolver.js's resolveFileThumbnail -- it's the
          // first, unconditional check in the chain), so waiting until
          // here to attach these means makeThumbCycleButtons never has
          // to reconcile a mismatch between the two -- index 0 always
          // matches what's already on screen.
          const imagePaths = (file.metadataImages || []).map((imgName) => `${item.path}/${imgName}`);
          for (const btn of makeThumbCycleButtons(imagePaths, img, thumbWrap, item, (path) => {
            currentPath = path;
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
  helpIcon.className = 'item-modal-gallery-help';
  helpIcon.textContent = '?';
  helpIcon.disabled = true;
  helpIcon.tabIndex = -1;
  col.appendChild(helpIcon);

  const grid = document.createElement('div');
  grid.className = 'item-modal-gallery-grid';
  col.appendChild(grid);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'item-modal-gallery-add-btn';
  addBtn.textContent = '+';
  addBtn.disabled = true;
  addBtn.tabIndex = -1;
  col.appendChild(addBtn);

  return col;
}