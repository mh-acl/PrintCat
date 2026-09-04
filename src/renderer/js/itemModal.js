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
    if (mode === 'view') {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'item-modal-close';
      const closeIcon = document.createElement('span');
      closeIcon.className = 'icon icon-chevron-left';
      closeBtn.appendChild(closeIcon);
      closeBtn.appendChild(document.createTextNode(' Close'));
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
    thumbWrap.className = 'file-thumb-wrap crop-frame';
    const img = document.createElement('img');
    img.alt = pf.displayName || pf.shortname;
    img.src = pf.images.length > 0 ? imageRefSrc(pf.images[0], folderPath) : 'nothumb.svg';
    thumbWrap.appendChild(img);
    if (pf.images.length > 0) {
      applyImageCrop(img, thumbWrap, getDraftCrop(pf.images[0], 'thumb'), { useDefault: true });
    }
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
      chipImg.src = imageRefSrc(ref, folderPath);
      chip.appendChild(chipImg);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon icon-close';
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
        ? `Click the assign icon on an image to assign it to ${selectedTargets.size} selected target${
            selectedTargets.size === 1 ? '' : 's'
          }.`
        : 'Select the item image and/or one or more print files, then click the assign icon on an image to assign it. Drag-and-drop also works.';
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
    pencilBtn.className = 'item-modal-origin-btn icon icon-edit';
    pencilBtn.title = 'Edit original-location info';
    pencilBtn.setAttribute('aria-label', 'Edit original-location info');
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
    refreshBtn.className = 'item-modal-origin-btn icon icon-refresh';
    refreshBtn.title = 'Reparse from folder';
    refreshBtn.setAttribute('aria-label', 'Reparse original-location info from folder');
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
    mode = 'edit';
    draft = createDraftFromItem(item);
    selectedTargets = new Set();
    renderTopBar();
    renderContent();
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
    item = freshItem;
    folderPath = item.path;
    sourceDir = item.path;
    draft = null;
    selectedTargets = new Set();
    mode = 'view';
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
  row.className = 'item-modal-tags-row item-detail-tags';

  const label = document.createElement('span');
  label.className = 'settings-field-label';
  label.textContent = 'Tagged';
  row.appendChild(label);

  const chipList = document.createElement('div');
  chipList.className = 'tag-chip-list';
  row.appendChild(chipList);

  if (tags && tags.length) {
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip tag-chip-existing';
      chip.textContent = tag;
      chipList.appendChild(chip);
    }
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
  const heading = document.createElement('h2');
  heading.textContent = item.displayName || item.name;
  header.appendChild(heading);
  if (item.origin && item.origin.url) {
    header.appendChild(renderOriginInfo(item.origin));
  }
  // Shares .item-modal-tags-row/.tag-chip-list with edit mode's tag
  // input (createTagInput, settings.js) on purpose, even though this
  // is read-only -- keeping the same wrapper/label/chip-list shape in
  // both trees is what lets a future transition (manual FLIP, or the
  // View Transitions API, which Electron's Chromium supports) treat
  // this as one continuous element across the mode switch instead of
  // two unrelated ones. See view-transition-name hook in itemModal.css.
  header.appendChild(renderTagsRow(item.tags));
  wrap.appendChild(header);

  for (const file of item.files) {
    const row = document.createElement('div');
    row.className = 'file-row';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'file-thumb-wrap crop-frame';

    const img = document.createElement('img');
    img.alt = file.shortname;
    thumbWrap.appendChild(img);

    window.catalogAPI
      .getFileThumbnail(file, item.imageFiles)
      .then((thumbPath) => {
        img.src = thumbPath ? fileUrl(thumbPath) : 'nothumb.svg';
        if (thumbPath) {
          applyImageCrop(img, thumbWrap, cropRectFor(item, thumbPath, 'thumb'), { useDefault: true });
          thumbWrap.appendChild(
            makeZoomButton(() => img.src, img.alt, () => cropRectFor(item, thumbPath, 'full'))
          );
        }
      })
      // Same reasoning as the item-card thumbnail above -- don't leave
      // the image blank on a rejected lookup.
      .catch(() => {
        img.src = 'nothumb.svg';
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
      // Always the full model+variant label (not just the model) --
      // otherwise two files sliced for different variants of the same
      // printer model (e.g. different nozzles) would show identically
      // here with nothing to tell them apart.
      file.printerModel ? `Printer: ${printerLabel(file)}` : null,
      file.printTime ? `Print time: ${file.printTime}` : null,
      // filamentUsedG can be null independently of filamentType (see
      // indexer.js) -- drop the weight clause entirely rather than
      // showing a literal "null" when it didn't parse.
      file.filamentType
        ? `Filament: ${formatFilamentTypes(file.filamentType)}${
            file.filamentUsedG != null ? `, ${file.filamentUsedG}g` : ''
          }`
        : null,
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
          icon.className = 'pause-tooltip-icon icon icon-info';
          icon.title = messages.join('\n');
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