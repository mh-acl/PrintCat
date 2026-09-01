'use strict';

// imageCropRender.js
//
// Applies a saved (or default) crop rect -- see itemMetadata.js's
// imageCrops schema, { x, y, w, h } normalized 0-1 fractions of the
// image's own natural size -- to a plain <img> element, without
// canvas/data-URL redraws. Works by oversizing the <img> and
// translating it inside an overflow:hidden container, the same
// technique Cropper.js's own live preview uses internally, so a crop
// applied here and a crop being *edited* in the cropper tool look
// visually identical.
//
// Loaded as a plain <script> tag (see index.html), same as
// renderer.js itself -- no bundler in this app, so applyImageCrop/
// defaultCropRect/THUMB_ASPECT below are just ordinary top-level
// declarations, sharing renderer.js's global scope like everything
// else it defines.
//
// Usage:
//   <div class="crop-frame"> <!-- fixed size via CSS, position:relative, overflow:hidden -->
//     <img class="crop-frame-img" />
//   </div>
//
//   applyImageCrop(imgEl, frameEl, cropRect); // cropRect may be null

// Square default: centered square crop, used whenever no `thumb` crop
// has been saved yet for an image. Kept as a function (not a bare
// aspect-ratio constant) so a future non-square thumbnail shape only
// means changing THUMB_ASPECT below -- nothing else in this file
// assumes "square".
const THUMB_ASPECT = 1; // width / height. Change here if thumb shape ever changes.

function defaultCropRect(naturalWidth, naturalHeight, aspect = THUMB_ASPECT) {
  const imgAspect = naturalWidth / naturalHeight;
  let w, h;
  if (imgAspect > aspect) {
    // wider than target -- full height, centered horizontally
    h = 1;
    w = (naturalHeight * aspect) / naturalWidth;
  } else {
    w = 1;
    h = naturalWidth / aspect / naturalHeight;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// The "full view" mode has no default rect -- unset simply means "show
// the whole image", so callers should skip calling this helper at all
// (or pass null) rather than synthesizing a full-image rect; null is
// handled below as a no-crop passthrough for exactly that reason.

/**
 * @param {HTMLImageElement} imgEl   the <img> to position; must already
 *                                    have its `src` set (or about to be)
 * @param {HTMLElement} frameEl      the fixed-size, overflow:hidden
 *                                    container imgEl lives inside
 * @param {{x,y,w,h}|null} cropRect  normalized crop rect, or null/
 *                                    undefined for "no crop" (natural
 *                                    object-fit: cover-ish behavior is
 *                                    left to CSS in that case)
 * @param {{aspect?: number, useDefault?: boolean}} [opts]
 *          useDefault: true  -> when cropRect is null, synthesize a
 *          centered default at `aspect` (or THUMB_ASPECT) instead of
 *          leaving the image unpositioned. Use this for thumb contexts;
 *          leave false/omitted for full-view contexts.
 */
function applyImageCrop(imgEl, frameEl, cropRect, opts = {}) {
  const { aspect = THUMB_ASPECT, useDefault = false } = opts;

  const position = () => {
    const naturalW = imgEl.naturalWidth;
    const naturalH = imgEl.naturalHeight;
    if (!naturalW || !naturalH) return; // not loaded yet

    let rect = cropRect;
    if (!rect) {
      if (!useDefault) {
        // No crop requested for this context (typical full-view case) --
        // clear any prior inline positioning and let normal img/CSS
        // sizing (e.g. object-fit: contain) take over.
        imgEl.style.width = '';
        imgEl.style.height = '';
        imgEl.style.transform = '';
        return;
      }
      rect = defaultCropRect(naturalW, naturalH, aspect);
    }

    const frameW = frameEl.clientWidth;
    const frameH = frameEl.clientHeight;
    if (!frameW || !frameH) return;

    const cropPxW = rect.w * naturalW;
    const cropPxH = rect.h * naturalH;
    // Scale so the crop rect fully *fits within* the frame (like
    // object-fit: contain would, but anchored to the chosen rect
    // instead of showing the whole image) -- Math.min, not Math.max.
    //
    // This matters specifically because not every frame this gets
    // called against is actually square, even for THUMB_ASPECT-locked
    // (square) crops: e.g. .file-row .file-thumb-wrap is a fixed
    // height with 100%-of-card width, which isn't necessarily square
    // itself. A cover-style Math.max would force the image to fill
    // that non-square box exactly, silently slicing part of the
    // (actually square) crop off the bottom to do it. Math.min instead
    // guarantees the full crop rect is always shown intact -- letter-
    // boxed within a non-square frame where the frame's own shape
    // doesn't match the crop's, filled edge-to-edge where it does
    // (every genuinely-square frame -- .thumb-slot, the item-modal
    // chip, the gallery thumb -- Math.min and Math.max agree there,
    // so this doesn't change anything for those).
    const scale = Math.min(frameW / cropPxW, frameH / cropPxH);

    // Whichever dimension isn't the binding constraint above has
    // leftover space in the frame (e.g. the .file-thumb-wrap case: a
    // square crop scaled to fit a 10em height leaves horizontal space
    // in a wider-than-10em frame) -- center the crop within that
    // leftover space, same as object-fit: contain does, rather than
    // pinning it to the top-left corner and leaving the gap on only
    // one side.
    const offsetX = (frameW - cropPxW * scale) / 2;
    const offsetY = (frameH - cropPxH * scale) / 2;

    imgEl.style.position = 'absolute';
    imgEl.style.left = '0';
    imgEl.style.top = '0';
    imgEl.style.width = `${naturalW * scale}px`;
    imgEl.style.height = `${naturalH * scale}px`;
    imgEl.style.transform = `translate(${offsetX - rect.x * naturalW * scale}px, ${
      offsetY - rect.y * naturalH * scale
    }px)`;
    imgEl.style.transformOrigin = 'top left';

    // Caller's CSS should already set frameEl { position: relative;
    // overflow: hidden } -- not set here to avoid fighting existing
    // layout rules on elements this is reused across.
  };

  if (imgEl.complete && imgEl.naturalWidth) position();
  else imgEl.addEventListener('load', position, { once: true });
}
