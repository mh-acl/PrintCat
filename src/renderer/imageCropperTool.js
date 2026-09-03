'use strict';

// imageCropperTool.js
//
// Modal crop-editing UI, built on Cropper.js (vendored locally --
// see vendor/cropper.min.js/.css -- same offline-bundling approach
// already used for the icon font and CSS fonts, no network fetch at
// runtime). Two modes:
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
// Reuses the app's real .drive-picker-overlay/.drive-picker-box shell
// (composed with crop-modal-specific modifier classes, see styles.css
// and how openItemModal itself composes 'drive-picker-overlay
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
//     mode: 'thumb',                 // or 'full'
//     existingRect: cropRectOrNull,  // normalized {x,y,w,h}, or null
//     onSave: (rectOrNull) => { ... },  // null == explicit "reset to default"
//     onCancel: () => { ... },          // optional
//   });

function openImageCropper({ imageSrc, mode, existingRect, onSave, onCancel }) {
  // Reuses the app's real overlay/box shell classes (.drive-picker-overlay
  // / .drive-picker-box, composed with modifier classes -- see how
  // openItemModal itself does 'drive-picker-overlay item-modal-overlay'),
  // not invented .modal-overlay/.modal-box names.
  const overlay = document.createElement('div');
  overlay.className = 'drive-picker-overlay crop-modal-overlay';

  const box = document.createElement('div');
  box.className = 'drive-picker-box crop-modal-box';
  overlay.appendChild(box);

  const title = document.createElement('h2');
  title.className = 'crop-modal-title';
  title.textContent = mode === 'thumb' ? 'Adjust thumbnail crop' : 'Adjust framing';
  box.appendChild(title);

  const imgWrap = document.createElement('div');
  imgWrap.className = 'crop-modal-imgwrap';
  box.appendChild(imgWrap);

  const img = document.createElement('img');
  img.src = imageSrc;
  imgWrap.appendChild(img);

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
  // Disabled until the cropper is ready and we know the real zoom
  // range for this image -- see img 'load' handler below.
  zoomSlider.disabled = true;
  zoomRow.appendChild(zoomSlider);

  const actions = document.createElement('div');
  actions.className = 'crop-modal-actions';
  box.appendChild(actions);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'crop-modal-reset';
  resetBtn.textContent = mode === 'thumb' ? 'Reset to default' : 'Reset to full image';
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

  document.body.appendChild(overlay);

  let cropper = null;
  let resolved = false;

  function close() {
    document.removeEventListener('keydown', onKeydown);
    if (cropper) cropper.destroy();
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

  resetBtn.addEventListener('click', () => {
    resolved = true;
    onSave(null);
    close();
  });

  saveBtn.addEventListener('click', () => {
    if (!cropper) return;
    const data = cropper.getData(true); // rounded, in original-image pixel space
    const imageData = cropper.getImageData();
    const naturalW = imageData.naturalWidth;
    const naturalH = imageData.naturalHeight;
    if (!naturalW || !naturalH) return;

    const rect = {
      x: data.x / naturalW,
      y: data.y / naturalH,
      w: data.width / naturalW,
      h: data.height / naturalH,
    };
    resolved = true;
    onSave(rect);
    close();
  });

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
  // actually lands.
  let syncingFromSlider = false;
  // Hoisted out of the img 'load' closure below -- the zoomSlider
  // 'input' listener also needs these, and it's a sibling of that
  // closure, not nested inside it.
  let naturalW = 0;
  let naturalH = 0;

  function readActualRatio() {
    return cropper.getCanvasData().width / naturalW;
  }

  img.addEventListener('load', () => {
    naturalW = img.naturalWidth;
    naturalH = img.naturalHeight;

    // eslint-disable-next-line no-undef -- Cropper is a global from the
    // vendored vendor/cropper.min.js script tag, see index.html
    cropper = new Cropper(img, {
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
        if (existingRect) {
          cropper.setData({
            x: existingRect.x * naturalW,
            y: existingRect.y * naturalH,
            width: existingRect.w * naturalW,
            height: existingRect.h * naturalH,
          });
        }
        // else: autoCropArea above already gives a sensible starting
        // box (centered square for thumb, near-full-image for full).

        // setData() above only touches the crop box, never the canvas
        // (confirmed against Cropper's source) -- so the canvas is
        // still exactly at whatever ratio autoCropArea/viewMode landed
        // it at, i.e. "whole image visible". That's a sensible anchor
        // for the slider's *displayed* range, but not an enforced
        // limit -- see the 'zoom' handler below for why.
        const fitRatio = readActualRatio();
        zoomSlider.min = String(fitRatio * 0.1);
        zoomSlider.max = String(fitRatio * 4);
        zoomSlider.step = String((fitRatio * 4 - fitRatio * 0.1) / 300);
        zoomSlider.value = String(fitRatio);
        zoomSlider.disabled = false;
      },
      zoom(e) {
        if (syncingFromSlider) return;
        // This fires synchronously BEFORE Cropper applies its own
        // clamping (canvasData.width is set and renderCanvas() runs
        // right after this listener returns, back inside zoomTo()) --
        // so e.detail.ratio here is only the requested ratio, not
        // necessarily where it'll land. Defer one microtask so the
        // current zoomTo() call has finished by the time we read it.
        queueMicrotask(() => {
          zoomSlider.value = String(readActualRatio());
        });
      },
    });
  });

  zoomSlider.addEventListener('input', () => {
    if (!cropper) return;
    syncingFromSlider = true;
    cropper.zoomTo(parseFloat(zoomSlider.value));
    syncingFromSlider = false;
    // zoomTo() is synchronous and has already been clamped by the time
    // it returns -- reflect wherever it actually landed, which may
    // differ from the value the slider was just dragged to.
    zoomSlider.value = String(readActualRatio());
  });
}