'use strict';

// imageCropperTool.js
//
// Modal crop-editing UI, built on Cropper.js (vendored locally --
// see vendor/cropper.min.js/.css -- same offline-bundling approach
// already used for the icon font and CSS fonts, no network fetch at
// runtime). One dialog edits both of an image's crops, one per tab:
//
//   'thumb' -- fixed-aspect crop box (THUMB_ASPECT from
//              imageCropRender.js), box itself isn't resizable, the
//              user drags/zooms the *photo* behind it -- this is the
//              Google Photos profile-picture pattern.
//   'full'  -- freely resizable/movable box, no aspect lock. This
//              mode is meant for light recentering, not tight
//              cropping, so it defaults to nearly the whole image
//              rather than starting zoomed in.
//
// Each tab gets its own Cropper instance (and its own <img>), both
// alive for the dialog's whole lifetime and stacked in the same
// wrapper -- the inactive one is just hidden. Switching tabs
// therefore keeps each tab's exact zoom/pan state, rather than
// rebuilding a cropper from a saved rect (which would reopen a
// zoomed-in thumb crop as a small box over the whole photo).
//
// A tab is only written back if the user actually changed it, so
// merely looking at the Full view tab doesn't save a near-full-image
// crop (its default box is 95% of the photo) for an image that never
// had one.
//
// Reuses the app's real .modal-overlay/.modal-box shell
// (composed with crop-modal-specific modifier classes, see dialogs.css
// and how openItemModal itself composes 'modal-overlay
// item-modal-overlay') and follows the established dismissal
// convention for "consequential" modals: explicit Cancel/Save buttons
// and Escape, no click-outside-to-close (this is an edit action, same
// category as the item editor modal itself, not a lightbox).
//
// Loaded as a plain <script> tag, after imageCropRender.js and before
// renderer.js (see index.html) -- THUMB_ASPECT below is that file's
// global, same "no bundler, shared script scope" setup as
// imageCropRender.js itself.
//
// Usage:
//   openImageCropper({
//     imageSrc: fileUrl(pathToImage),
//     crops: { thumb: cropRectOrNull, full: cropRectOrNull },  // normalized {x,y,w,h}
//     initialTab: 'thumb',           // or 'full'; defaults to 'thumb'
//     onSave: (changes) => { ... },  // { thumb?: rectOrNull, full?: rectOrNull }
//                                    // -- a key is present only for a tab the
//                                    // user changed; null == "reset to default"
//     onCancel: () => { ... },       // optional
//   });

const CROP_TAB_INFO = {
  thumb: {
    label: 'Thumbnail',
    hint: 'Square crop used on cards and thumbnails. Drag and zoom the photo behind the box.',
    resetLabel: 'Reset to default',
  },
  full: {
    label: 'Full view',
    hint: 'Framing shown when the photo is opened full size. Drag or resize the box.',
    resetLabel: 'Reset to full image',
  },
};

function openImageCropper({ imageSrc, crops = {}, initialTab = 'thumb', onSave, onCancel }) {
  // Reuses the app's real overlay/box shell classes (.modal-overlay
  // / .modal-box, composed with modifier classes -- see how
  // openItemModal itself does 'modal-overlay item-modal-overlay').
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay crop-modal-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box crop-modal-box';
  overlay.appendChild(box);

  const title = document.createElement('h2');
  title.className = 'crop-modal-title';
  title.textContent = 'Adjust crops';
  box.appendChild(title);

  const tabList = document.createElement('div');
  tabList.className = 'crop-modal-tabs';
  tabList.setAttribute('role', 'tablist');
  box.appendChild(tabList);

  const hint = document.createElement('p');
  hint.className = 'crop-modal-hint';
  box.appendChild(hint);

  const imgWrap = document.createElement('div');
  imgWrap.className = 'crop-modal-imgwrap';
  box.appendChild(imgWrap);

  const zoomRow = document.createElement('div');
  zoomRow.className = 'crop-modal-zoomrow';
  box.appendChild(zoomRow);

  const zoomSlider = document.createElement('input');
  zoomSlider.type = 'range';
  zoomSlider.className = 'crop-modal-zoom-slider';
  zoomSlider.min = '0';
  zoomSlider.max = '1';
  zoomSlider.step = '0.001';
  zoomSlider.value = '0';
  // Disabled until the active tab's cropper is ready and we know the
  // real zoom range for it -- see syncSlider below.
  zoomSlider.disabled = true;
  zoomRow.appendChild(zoomSlider);

  const actions = document.createElement('div');
  actions.className = 'crop-modal-actions';
  box.appendChild(actions);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'crop-modal-reset';
  actions.appendChild(resetBtn);

  const spacer = document.createElement('div');
  spacer.className = 'crop-modal-spacer';
  actions.appendChild(spacer);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'crop-modal-cancel';
  cancelBtn.textContent = 'Cancel';
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'crop-modal-save';
  saveBtn.textContent = 'Save';
  actions.appendChild(saveBtn);

  // --- Per-tab state ------------------------------------------------------
  // change: 'none'   -- untouched, not reported to onSave
  //         'edited' -- user moved/zoomed something, rect read at save time
  //         'reset'  -- user hit Reset, reported as null
  // startRect is what the cropper was (re)mounted from: the saved crop
  // initially, null after a Reset.
  const tabs = {};
  for (const name of Object.keys(CROP_TAB_INFO)) {
    tabs[name] = {
      name,
      pane: null,
      img: null,
      cropper: null,
      ready: false,
      fitRatio: 1,
      startRect: crops[name] || null,
      savedRect: crops[name] || null,
      change: 'none',
      tabBtn: null,
    };
  }
  let activeTab = tabs[initialTab] ? initialTab : 'thumb';

  function hasCrop(t) {
    if (t.change === 'edited') return true;
    if (t.change === 'reset') return false;
    return !!t.savedRect;
  }

  function refreshChrome() {
    const t = tabs[activeTab];
    for (const other of Object.values(tabs)) {
      const active = other === t;
      other.tabBtn.classList.toggle('active', active);
      other.tabBtn.classList.toggle('has-crop', hasCrop(other));
      other.tabBtn.setAttribute('aria-selected', active ? 'true' : 'false');
      other.tabBtn.tabIndex = active ? 0 : -1;
      other.pane.classList.toggle('crop-modal-pane-hidden', !active);
    }
    hint.textContent = CROP_TAB_INFO[t.name].hint;
    resetBtn.textContent = CROP_TAB_INFO[t.name].resetLabel;
    resetBtn.disabled = !t.ready || !hasCrop(t);
    saveBtn.disabled = !Object.values(tabs).some((x) => x.change !== 'none');
  }

  // Reads back the active crop as a normalized rect, or null if the
  // cropper isn't in a state to answer.
  function readRect(t) {
    if (!t.cropper || !t.ready) return null;
    const data = t.cropper.getData(true); // rounded, in original-image pixel space
    const imageData = t.cropper.getImageData();
    const naturalW = imageData.naturalWidth;
    const naturalH = imageData.naturalHeight;
    if (!naturalW || !naturalH) return null;
    return {
      x: data.x / naturalW,
      y: data.y / naturalH,
      w: data.width / naturalW,
      h: data.height / naturalH,
    };
  }

  function ratioOf(t) {
    return t.cropper.getCanvasData().width / t.cropper.getImageData().naturalWidth;
  }

  // Trackpad pinch/scroll zoom (zoomOnWheel/zoomOnTouch, both default
  // true) and the slider drive the same underlying canvas ratio, kept
  // in sync via Cropper's 'zoom' event. We deliberately do NOT enforce
  // our own zoom-out floor here (an earlier version did, based on the
  // canvas's initial "whole image visible" ratio) -- Cropper already
  // enforces its own floor internally (viewMode: 1 means the canvas
  // can't shrink smaller than the current crop box), and for an image
  // that was previously zoomed in before saving, that real floor sits
  // BELOW the "whole image visible" ratio, since the saved crop box is
  // smaller than the full canvas. Our own stricter floor was cutting
  // the slider off before it reached that real, more permissive limit
  // -- exactly the room needed to zoom back out and expand the crop.
  // So: let Cropper do the clamping, and just reflect wherever it
  // actually lands. The slider is shared between the tabs and always
  // reflects the active one (see switchTab).
  let syncingFromSlider = false;

  function syncSlider() {
    const t = tabs[activeTab];
    if (!t.ready) {
      zoomSlider.disabled = true;
      return;
    }
    // Range first, value second -- a range input clamps a value set
    // against its old min/max.
    zoomSlider.min = String(t.fitRatio * 0.1);
    zoomSlider.max = String(t.fitRatio * 4);
    zoomSlider.step = String((t.fitRatio * 4 - t.fitRatio * 0.1) / 300);
    zoomSlider.value = String(ratioOf(t));
    zoomSlider.disabled = false;
  }

  function markEdited(t) {
    if (!t.ready || t.change === 'edited') return;
    t.change = 'edited';
    refreshChrome();
  }

  function mountCropper(t) {
    t.ready = false;
    if (t.name === activeTab) syncSlider();
    const mode = t.name;
    // eslint-disable-next-line no-undef -- Cropper is a global from the
    // vendored vendor/cropper.min.js script tag, see index.html
    t.cropper = new Cropper(t.img, {
      viewMode: 1, // crop box can't extend outside the canvas
      dragMode: 'move', // pan the photo; box itself stays put
      background: false,
      guides: mode === 'full',
      autoCropArea: mode === 'thumb' ? 1 : 0.95,
      aspectRatio: mode === 'thumb' ? THUMB_ASPECT : NaN,
      cropBoxResizable: mode === 'full',
      cropBoxMovable: mode === 'full',
      toggleDragModeOnDblclick: false,
      ready() {
        const naturalW = t.img.naturalWidth;
        const naturalH = t.img.naturalHeight;
        if (t.startRect) {
          t.cropper.setData({
            x: t.startRect.x * naturalW,
            y: t.startRect.y * naturalH,
            width: t.startRect.w * naturalW,
            height: t.startRect.h * naturalH,
          });
        }
        // else: autoCropArea above already gives a sensible starting
        // box (centered square for thumb, near-full-image for full).

        // setData() above only touches the crop box, never the canvas
        // (confirmed against Cropper's source) -- so the canvas is
        // still exactly at whatever ratio autoCropArea/viewMode landed
        // it at, i.e. "whole image visible". That's a sensible anchor
        // for the slider's *displayed* range, but not an enforced
        // limit -- see the comment above syncSlider.
        t.fitRatio = ratioOf(t);
        t.ready = true;
        if (t.name === activeTab) syncSlider();
        refreshChrome();
      },
      // Fires after any drag of the canvas or crop box finishes.
      cropend() {
        markEdited(t);
      },
      zoom() {
        markEdited(t); // wheel/pinch; the slider path marks it itself
        if (syncingFromSlider || t.name !== activeTab) return;
        // This fires synchronously BEFORE Cropper applies its own
        // clamping (canvasData.width is set and renderCanvas() runs
        // right after this listener returns, back inside zoomTo()) --
        // so the ratio requested here is only that, not necessarily
        // where it'll land. Defer one microtask so the current
        // zoomTo() call has finished by the time we read it.
        queueMicrotask(() => {
          if (t.cropper) zoomSlider.value = String(ratioOf(t));
        });
      },
    });
  }

  function switchTab(name) {
    if (name === activeTab || !tabs[name]) return;
    activeTab = name;
    syncSlider();
    refreshChrome();
  }

  // One pane + <img> per tab, stacked in imgWrap. Both stay laid out
  // (the inactive one is only visibility:hidden, see cropper.css) --
  // Cropper sizes itself from its container, which display:none would
  // collapse to 0x0.
  for (const t of Object.values(tabs)) {
    const info = CROP_TAB_INFO[t.name];

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crop-modal-tab';
    btn.setAttribute('role', 'tab');
    btn.textContent = info.label;
    btn.addEventListener('click', () => switchTab(t.name));
    tabList.appendChild(btn);
    t.tabBtn = btn;

    t.pane = document.createElement('div');
    t.pane.className = 'crop-modal-pane';
    imgWrap.appendChild(t.pane);

    t.img = document.createElement('img');
    t.pane.appendChild(t.img);
    t.img.addEventListener('load', () => mountCropper(t), { once: true });
    t.img.src = imageSrc;
  }

  document.body.appendChild(overlay);
  refreshChrome();

  let resolved = false;

  function close() {
    document.removeEventListener('keydown', onKeydown);
    for (const t of Object.values(tabs)) {
      if (t.cropper) t.cropper.destroy();
    }
    overlay.remove();
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!resolved && onCancel) onCancel();
      close();
    }
  }
  document.addEventListener('keydown', onKeydown);

  cancelBtn.addEventListener('click', () => {
    if (onCancel) onCancel();
    close();
  });

  // Staged like any other change -- goes back to the default view for
  // the active tab, but nothing is reported until Save. (This used to
  // save and close immediately when the dialog only had one crop.)
  resetBtn.addEventListener('click', () => {
    const t = tabs[activeTab];
    if (!t.cropper || !t.ready) return;
    t.change = 'reset';
    t.startRect = null;
    t.cropper.destroy();
    t.cropper = null;
    mountCropper(t); // img is already loaded; ready() fires async
    refreshChrome();
  });

  saveBtn.addEventListener('click', () => {
    const changes = {};
    for (const t of Object.values(tabs)) {
      if (t.change === 'reset') {
        changes[t.name] = null;
      } else if (t.change === 'edited') {
        const rect = readRect(t);
        if (rect) changes[t.name] = rect;
      }
    }
    if (Object.keys(changes).length === 0) {
      close();
      return;
    }
    resolved = true;
    onSave(changes);
    close();
  });

  zoomSlider.addEventListener('input', () => {
    const t = tabs[activeTab];
    if (!t.cropper || !t.ready) return;
    syncingFromSlider = true;
    t.cropper.zoomTo(parseFloat(zoomSlider.value));
    syncingFromSlider = false;
    markEdited(t);
    // zoomTo() is synchronous and has already been clamped by the
    // time it returns -- reflect wherever it actually landed, which may
    // differ from the value the slider was just dragged to.
    zoomSlider.value = String(ratioOf(t));
  });
}
