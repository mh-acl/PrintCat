# Image cropping — what changed, and what to actually check by hand

## Update: two real bugs fixed after hands-on testing

**Bug 1 (the modal not overlaying):** entirely on me. I wrote the crop
modal's CSS against invented class names — `.modal-overlay`/
`.modal-box` — that don't exist anywhere in this codebase. The real
pattern here is `.drive-picker-overlay`/`.drive-picker-box`, composed
with a modifier class (exactly how `openItemModal` itself does
`'drive-picker-overlay item-modal-overlay'`). Worse, I'd only ever
written that CSS block into a standalone handoff file and never
actually merged it into the real `styles.css` during the "full
integration" pass — so the dialog was rendering with *zero* layout
CSS at all, hence appearing as a huge, unstyled, appended-to-body
block. Both are fixed now: `imageCropperTool.js` uses the real shell
classes, and the CSS is actually appended to `styles.css` this time
(verified via `grep` against the real file, not assumed).

**Bug 2 (where cropping gets initiated):** moved. The crop-adjust
control is no longer on the item-thumbnail chip or the print-file
card's thumbnail — those now just *display* whatever crop is set (or
the default), with no separate control. The one control lives on each
image's chip in "Available images" (the pool gallery), setting that
image's default crop once, used everywhere it's later assigned. This
matches the schema, which was already keyed per-file, not
per-assignment — so this was a pure UI-placement fix, not a data model
change.

## Files touched in this pass
- `src/renderer/imageCropperTool.js` — real shell classes
- `src/renderer/styles.css` — the crop-modal CSS actually appended
  this time, plus `.item-modal-gallery-thumb` restructured (size moved
  from the `<img>` onto a wrapping `.crop-frame`, same reasoning as the
  `.file-thumb-wrap` fix below), plus the crop-adjust badge
  repositioned to bottom-left (matching the existing assign-button's
  bottom-right overhang on the same cell, so they don't collide)
- `src/renderer/renderer.js` — crop-adjust control moved to
  `buildGalleryColumn`'s pool chips; removed from `buildItemThumbChip`
  and `buildPrintFileCard`'s thumbnail (display-only now)

## The .file-thumb-wrap bug from the previous pass (still relevant, unchanged)

`.item-modal-file-card .file-thumb-wrap` and `.file-row .file-thumb-wrap`
both had their fixed height set on the `<img>` itself, not on the
wrapping element. `.crop-frame`'s `height: 100%` needs a real
(non-auto) number on its parent to resolve against — against an
auto-height wrapper it's simply invalid and the frame collapses to
zero height, which would've made `applyImageCrop` silently no-op. I
moved the explicit height onto the wrap in both places. Note this
same class of bug is why `.item-modal-gallery-thumb` above needed its
own scoped rule rather than just adding `.crop-frame` directly —
combining a fixed-size class and `.crop-frame`'s generic 100%/100% on
the *same* element is a source-order footgun, not a real fix, so I
kept `.crop-frame` reserved for cases where it's a dedicated child of
an already-sized wrapper.

## What I could verify vs. what still needs your eyes

I checked schema shape, merge semantics, JS syntax (`node --check` on
every touched/new file), and this time actually confirmed via `grep`
against the real repo file that every CSS class referenced from JS has
a matching rule in `styles.css` — that's exactly the check that would
have caught bug 1 the first time, and I hadn't done it. What I still
can't verify without actually running the app:

- Cropper.js's own runtime behavior (drag/zoom/`setData`/`getData`)
- The lightbox's explicit width/height-from-aspect-ratio sizing when a
  full-view crop is set
- Whether the `⤡` glyph for the crop-adjust badge renders how I'm
  picturing it in your font stack
- End-to-end save/reload: stage a crop → save → does it survive a
  catalog rescan and show up correctly on the next load

That last one is still the one I'd run first.

