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
// thumbnail rather than a photo). getGallery is optional too -- a
// function returning buildLightboxGallery's result (or null) for a
// thumbnail that's one of several photos (a print file or item with
// more than one assigned image), read lazily at click time so it
// reflects whichever photo carousel cycling has put on screen by
// then. When it returns a gallery, the lightbox opens as a carousel
// (prev/next arrows + a thumbnail strip) starting on that photo; when
// it's omitted or returns null, the lightbox is the plain single-
// image viewer it always was.
function makeZoomButton(getSrc, altText, getCropRect, getGallery) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb-zoom-btn icon icon-zoom-in';
  btn.title = 'View full size';
  btn.setAttribute('aria-label', 'View full size image');
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openImageLightbox(
      getSrc(),
      altText,
      getCropRect ? getCropRect() : null,
      getGallery ? getGallery() : null
    );
  };
  return btn;
}
// Builds the `gallery` argument openImageLightbox takes, from the same
// plain list of absolute image paths makeThumbCycleButtons cycles
// through, plus the index of whichever one is currently on screen.
// Each image carries both crops the lightbox needs: 'full' (the
// main viewer -- null means show the whole photo) and 'thumb' (the
// square strip thumbnail, which falls back to the default centered
// square, same as every other thumbnail). Returns null for fewer than
// two images, since a one-image "carousel" is just the plain viewer.
function buildLightboxGallery(item, imagePaths, index, altText) {
  if (!imagePaths || imagePaths.length <= 1) return null;
  return {
    index: Math.min(Math.max(index || 0, 0), imagePaths.length - 1),
    images: imagePaths.map((path) => ({
      src: fileUrl(path),
      alt: altText || '',
      fullCrop: cropRectFor(item, path, 'full'),
      thumbCrop: cropRectFor(item, path, 'thumb'),
    })),
  };
}
// Cycle-through buttons for a thumbnail with more than one assigned
// image -- either a print file (file.metadataImages.length > 1; see
// the view-mode file-row loop in itemModal.js) or a whole item
// (item.metadataItemImages.length > 1; see renderItemCard in
// grid.js). Assigning multiple images to one print file or item has
// been possible for a while, this is what makes the rest of them
// visible outside the editor instead of just the first).
// imagePaths[0] always matches whatever the caller's thumbnail lookup
// already resolved as the initial image (see thumbnailResolver.js's
// resolveFileThumbnail / resolveItemThumbnail, which return
// metadataImages[0] / metadataItemImage first, unconditionally,
// whenever that list is non-empty) -- so this only ever needs to run
// after that initial resolution has already happened (see the call
// sites), and never needs to touch it itself. onChange(path, index)
// fires after every cycle so the caller can keep its zoom button's
// crop/gallery lookups pointed at the photo actually on screen.
// Uses the icon font (icon-chevron-left/icon-chevron-right) -- added
// to the printcat-icons.woff2 subset alongside icon-add/icon-help/
// icon-target/icon-target-check; .file-thumb-cycle-btn (lightbox.css)
// doesn't need to change either way, same as .thumb-zoom-btn above
// already handles icon-vs-text content.
function makeThumbCycleButtons(imagePaths, img, thumbWrap, item, onChange) {
  if (imagePaths.length <= 1) return [];

  let index = 0;
  function show(newIndex) {
    index = (newIndex + imagePaths.length) % imagePaths.length;
    const path = imagePaths[index];
    img.src = fileUrl(path);
    applyImageCrop(img, thumbWrap, cropRectFor(item, path, 'thumb'), { useDefault: true });
    // Lets the caller's zoom button (see the call sites in
    // itemModal.js / grid.js) keep reading the crop -- and, for the
    // lightbox carousel, the starting index -- for whichever image is
    // actually on screen right now, rather than staying frozen on
    // whatever was first resolved before any cycling happened.
    if (onChange) onChange(path, index);
  }

  function makeBtn(direction, iconClass, ariaLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `file-thumb-cycle-btn file-thumb-cycle-${direction} icon ${iconClass}`;
    btn.title = ariaLabel;
    btn.setAttribute('aria-label', ariaLabel);
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      show(index + (direction === 'prev' ? -1 : 1));
    };
    return btn;
  }

  return [
    makeBtn('prev', 'icon-chevron-left', 'Show previous image'),
    makeBtn('next', 'icon-chevron-right', 'Show next image'),
  ];
}
// Builds one .image-lightbox-box (the photo, sized/cropped) -- shared
// by the plain single-image viewer and each slide of the gallery
// carousel below. cropRect is the image's saved 'full' viewport (see
// itemMetadata.js's imageCrops schema); null means "show the whole
// image". bounds is {w, h} in px: the largest the box may be. The
// single viewer passes 90vw/90vh (the same clamp its CSS applies to
// an uncropped photo); the carousel passes the measured stage size
// instead. Only the *cropped* case strictly needs it (see below), but
// the carousel's uncropped case also gets it applied as an inline
// max-width/max-height, since there the CSS clamp is switched off
// (.image-lightbox-gallery-mode).
function buildLightboxImageBox(src, altText, cropRect, bounds, { inlineMax } = {}) {
  const box = document.createElement('div');
  box.className = 'image-lightbox-box';

  const img = document.createElement('img');
  img.alt = altText || '';
  box.appendChild(img);

  if (cropRect) {
    // .image-lightbox-box normally auto-sizes to the photo itself (no
    // fixed width/height -- see lightbox.css, just a max-width/
    // max-height clamp) -- that doesn't work for applyImageCrop's
    // technique, which needs a frame with a *known* size to scale/
    // position against. When a full-view crop is set, size the box
    // explicitly to the crop rect's own aspect ratio instead, clamped
    // to the bounds.
    const aspect = cropRect.w / cropRect.h;
    let boxW = bounds.w;
    let boxH = boxW / aspect;
    if (boxH > bounds.h) {
      boxH = bounds.h;
      boxW = boxH * aspect;
    }
    box.style.width = `${boxW}px`;
    box.style.height = `${boxH}px`;
    box.classList.add('crop-frame');
    // .image-lightbox-box img's max-width/max-height (90vw/90vh) would
    // clip applyImageCrop's deliberately-oversized <img> before its
    // translate() ever gets a chance to do the actual cropping -- this
    // class (see cropper.css) overrides both back to none for exactly
    // this element, since the frame above is already the thing
    // enforcing the clamp now.
    img.classList.add('crop-frame-uncapped-img');
  } else if (inlineMax) {
    box.style.maxWidth = `${bounds.w}px`;
    box.style.maxHeight = `${bounds.h}px`;
    img.style.maxWidth = `${bounds.w}px`;
    img.style.maxHeight = `${bounds.h}px`;
  }

  // Deferred to a separate step the caller runs once `box` is actually
  // in the document: applyImageCrop reads the frame's clientWidth/
  // clientHeight, which is 0 for a detached element, and an already-
  // cached image can take its "already loaded" path synchronously.
  const apply = () => {
    img.src = src;
    if (cropRect) applyImageCrop(img, box, cropRect, { useDefault: false });
  };

  return { box, img, apply };
}
// Full-size image viewer opened by the zoom button. Dismissed via its
// close button, clicking the dimmed backdrop, or Escape. cropRect is
// the image's saved 'full' viewport (see itemMetadata.js's imageCrops
// schema) -- null means "show the whole image", which is also what
// happens if it's just omitted, so every existing call site (photos
// with no full-view crop set yet) keeps behaving exactly as before.
//
// gallery (optional, see buildLightboxGallery) turns this into a
// carousel for a print file / item with more than one photo: the same
// viewer, plus prev/next arrows either side of the photo and a strip
// of clickable thumbnails along the bottom (the current one
// highlighted). It ignores src/altText/cropRect in favor of
// gallery.images[gallery.index] and friends -- the caller has already
// resolved which photo is current. The arrows/strip wrap around, same
// as the thumbnail's own cycle buttons (makeThumbCycleButtons), and
// the left/right arrow keys do the same as clicking them.
function openImageLightbox(src, altText, cropRect, gallery) {
  if (gallery && gallery.images && gallery.images.length > 1) {
    openImageLightboxGallery(gallery);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox-overlay';

  const { box, apply } = buildLightboxImageBox(src, altText, cropRect, {
    w: window.innerWidth * 0.9,
    h: window.innerHeight * 0.9,
  });

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
  apply();
}
// The carousel flavor of openImageLightbox -- see its comment for the
// overall behavior. Layout (lightbox.css's .image-lightbox-gallery-mode
// block): the overlay becomes a column of [stage][thumbnail strip].
// The stage is the flexible area the current photo is centered in,
// with the prev/next arrows pinned to its left/right edges -- pinned to
// the stage, not the photo, so they stay put instead of jumping around
// as photos of different shapes swap in. The close button is likewise
// pinned to the overlay's corner rather than riding on the photo's.
// Each photo change rebuilds the .image-lightbox-box from scratch
// (buildLightboxImageBox), measuring the stage fresh every time, which
// also makes a window resize just "re-show the current photo".
function openImageLightboxGallery(gallery) {
  const images = gallery.images;
  let index = Math.min(Math.max(gallery.index || 0, 0), images.length - 1);

  const overlay = document.createElement('div');
  overlay.className = 'image-lightbox-overlay image-lightbox-gallery-mode';

  const stage = document.createElement('div');
  stage.className = 'image-lightbox-stage';
  overlay.appendChild(stage);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'image-lightbox-close image-lightbox-close-fixed icon icon-close';
  closeBtn.setAttribute('aria-label', 'Close');
  overlay.appendChild(closeBtn);

  function makeNavBtn(direction, iconClass, ariaLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `image-lightbox-nav image-lightbox-nav-${direction} icon ${iconClass}`;
    btn.title = ariaLabel;
    btn.setAttribute('aria-label', ariaLabel);
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      show(index + (direction === 'prev' ? -1 : 1));
    };
    return btn;
  }
  stage.appendChild(makeNavBtn('prev', 'icon-chevron-left', 'Previous image'));
  stage.appendChild(makeNavBtn('next', 'icon-chevron-right', 'Next image'));

  const strip = document.createElement('div');
  strip.className = 'image-lightbox-strip';
  overlay.appendChild(strip);

  const thumbBtns = images.map((spec, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'image-lightbox-thumb';
    btn.title = `Image ${i + 1} of ${images.length}`;
    btn.setAttribute('aria-label', `Show image ${i + 1} of ${images.length}`);
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      show(i);
    };
    strip.appendChild(btn);
    return btn;
  });

  function stageBounds() {
    // The arrows/close button live in the left/right/top margins, so
    // the photo gets the stage minus ~4em gutters each side (matching
    // .image-lightbox-nav's offset + width in lightbox.css).
    const em = parseFloat(getComputedStyle(stage).fontSize) || 16;
    return {
      w: Math.max(stage.clientWidth - 8 * em, 1),
      h: Math.max(stage.clientHeight, 1),
    };
  }

  function show(newIndex) {
    index = (newIndex + images.length) % images.length;
    const spec = images[index];

    const old = stage.querySelector('.image-lightbox-box');
    if (old) stage.removeChild(old);
    const { box, apply } = buildLightboxImageBox(spec.src, spec.alt, spec.fullCrop, stageBounds(), {
      inlineMax: true,
    });
    stage.insertBefore(box, stage.firstChild);
    apply();

    thumbBtns.forEach((btn, i) => {
      btn.classList.toggle('active', i === index);
      if (i === index) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    });
    thumbBtns[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  const close = () => {
    if (overlay.parentNode) document.body.removeChild(overlay);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', onResize);
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
  };
  const onResize = () => show(index);

  closeBtn.onclick = close;
  // Clicking the empty part of the stage (around the photo) dismisses,
  // same as the plain viewer's backdrop -- but not the thumbnail
  // strip's background, where a slightly-off click aimed at a
  // thumbnail shouldn't throw the whole viewer away.
  overlay.onclick = (e) => {
    if (e.target === overlay || e.target === stage) close();
  };
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);

  // Everything above is detached until here on purpose: the stage
  // needs to be laid out (so stageBounds() can measure it), and
  // applyImageCrop needs its frames in the document, before either the
  // main photo or the strip thumbnails are populated.
  document.body.appendChild(overlay);

  images.forEach((spec, i) => {
    const frame = document.createElement('div');
    frame.className = 'crop-frame';
    const img = document.createElement('img');
    img.alt = '';
    frame.appendChild(img);
    thumbBtns[i].appendChild(frame);
    img.src = spec.src;
    applyImageCrop(img, frame, spec.thumbCrop, { useDefault: true });
  });

  show(index);
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
