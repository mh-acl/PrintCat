'use strict';

// Image lightbox (hover zoom button + full-size overlay) and the
// soft-crop viewport lookup used both by the main grid and the item
// modal's view-mode file rows.
// Depends on: state.js (none directly), utils.js (none directly).

// A small magnifying-glass button that sits over a thumbnail (see
// CSS .thumb-zoom-btn -- hidden until the containing .thumb-slot /
// .file-thumb-wrap is hovered). getSrc is a function rather than a
// plain string so the click handler always reads whatever src the
// <img> currently has, even though the button is created before the
// thumbnail promise resolves. getCropRect is optional -- a function
// returning the image's saved 'full' crop (or null), read lazily the
// same way as getSrc; omit it entirely for a chip with no crop
// concept (e.g. anything already showing a generated/embedded gcode
// thumbnail rather than a photo).
function makeZoomButton(getSrc, altText, getCropRect) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb-zoom-btn icon icon-zoom-in';
  btn.title = 'View full size';
  btn.setAttribute('aria-label', 'View full size image');
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openImageLightbox(getSrc(), altText, getCropRect ? getCropRect() : null);
  };
  return btn;
}
// Full-size image viewer opened by the zoom button. Dismissed via its
// close button, clicking the dimmed backdrop, or Escape. cropRect is
// the image's saved 'full' viewport (see itemMetadata.js's imageCrops
// schema) -- null means "show the whole image", which is also what
// happens if it's just omitted, so every existing call site (photos
// with no full-view crop set yet) keeps behaving exactly as before.
function openImageLightbox(src, altText, cropRect) {
  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox-overlay';

  const box = document.createElement('div');
  box.className = 'image-lightbox-box';

  const img = document.createElement('img');
  img.src = src;
  img.alt = altText || '';
  box.appendChild(img);

  if (cropRect) {
    // .image-lightbox-box normally auto-sizes to the photo itself (no
    // fixed width/height -- see styles.css, just a max-width/max-height
    // clamp) -- that doesn't work for applyImageCrop's technique, which
    // needs a frame with a *known* size to scale/position against. When
    // a full-view crop is set, size the box explicitly to the crop
    // rect's own aspect ratio instead, clamped to the same 90vw/90vh
    // the uncropped case already respects.
    const aspect = cropRect.w / cropRect.h;
    const maxW = window.innerWidth * 0.9;
    const maxH = window.innerHeight * 0.9;
    let boxW = maxW;
    let boxH = boxW / aspect;
    if (boxH > maxH) {
      boxH = maxH;
      boxW = boxH * aspect;
    }
    box.style.width = `${boxW}px`;
    box.style.height = `${boxH}px`;
    box.classList.add('crop-frame');
    // .image-lightbox-box img's max-width/max-height (90vw/90vh) would
    // clip applyImageCrop's deliberately-oversized <img> before its
    // translate() ever gets a chance to do the actual cropping -- this
    // class (see crop-modal.append.css) overrides both back to none for
    // exactly this element, since the frame above is already the thing
    // enforcing the 90vw/90vh clamp now.
    img.classList.add('crop-frame-uncapped-img');
    applyImageCrop(img, box, cropRect, { useDefault: false });
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-lightbox-close icon icon-close';
  closeBtn.setAttribute('aria-label', 'Close');
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
// View-mode (read-only) crop lookup: item.imageCrops (see indexer.js)
// is keyed by plain image filename, exactly like item.imageFiles --
// this just picks the filename back out of whatever thumbnail path
// getItemThumbnail/getFileThumbnail actually resolved to, so it works
// the same regardless of which fallback in thumbnailResolver.js's
// chain produced that path. Returns null (not just for a gcode-
// embedded thumbnail, which was never a photo to crop in the first
// place, but also for "no crop saved yet") -- applyImageCrop already
// treats null as "use the default" (thumb) or "show the whole image"
// (full) as appropriate.
function cropRectFor(item, thumbPath, mode) {
  if (!thumbPath || !item.imageCrops) return null;
  const filename = thumbPath.split(/[\\/]/).pop();
  const entry = item.imageCrops[filename];
  return (entry && entry[mode]) || null;
}
