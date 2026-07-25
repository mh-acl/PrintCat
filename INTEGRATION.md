# Integrating this scaffold into PrintCat

## 1. File layout

Drop the `src/` folder from this scaffold into your project root, alongside
your existing `package.json`. You should end up with:

```
PrintCat/
  package.json
  src/
    main/
      main.js
      preload.js
      indexer.js
      gcodeParser.js
      thumbnailCache.js
      thumbnailResolver.js
    renderer/
      index.html
      renderer.js
      styles.css
```

The old root-level `main.js` and `index.html` (the "does Electron even
work" test files) can be deleted -- they're superseded by `src/main/main.js`
and `src/renderer/index.html`.

## 2. Update package.json

Change `"main"` to point at the new entry point:

```json
"main": "src/main/main.js"
```

## 3. Install the one new dependency

```bash
npm install chokidar
```

## 4. Point it at your data folder

For now, the data directory is picked up from an environment variable
(there's a `TODO` in `main.js` to make this a proper setting later):

```bash
PRINTCAT_DATA_DIR=/path/to/your/data/repo npm start
```

If unset, it defaults to a `data/` folder next to the project root -- handy
for testing with a small sample set before pointing at your real library.

## 5. A generic placeholder image

The renderer falls back to `nothumb.png` when no thumbnail is available.
Copy your existing `nothumb.png` into `src/renderer/` so that fallback
resolves.

## What's implemented vs. what's next

**Implemented:**
- Filename parsing for both the legacy `(tags)[printer]_id` convention and
  the new `name.printer.ext` convention (printer segment always discarded
  as metadata either way -- see comments in `gcodeParser.js`)
- Gcode header metadata + embedded thumbnail extraction
- Disk-persisted, mtime-keyed cache so unchanged files are never
  re-parsed
- Thumbnail resolution (explicit `thumb.*` -> embedded gcode thumbnail ->
  generated mosaic -> null), all cached in the app's userData directory,
  never written into the data repo
- Background rescanning via chokidar when the data folder changes
  (e.g. after a `git pull`)
- A bare-bones renderer that browses the tree and offers gcode downloads,
  replacing the jQuery/ajax/HTML-snippet approach entirely

**Not yet implemented / open items:**
- `.bgcode` (binary gcode) parsing -- currently just flagged as
  `unsupportedFormat: true` and skipped
- Printer/tag filter UI (the old hardcoded checkboxes) -- now that the
  indexer knows every tag and printer that actually exists in the data,
  this can be generated dynamically instead of hand-maintained
- Parsing the original Thingiverse/Printables folder name for a
  "view original" link -- the folder name is preserved verbatim in
  `node.name` for an item, ready for that later
- Any visual polish -- this renderer is intentionally bare
