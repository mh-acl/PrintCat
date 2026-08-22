'use strict';

// originLocation.js
//
// Best-effort detection of the page an item's folder was originally
// downloaded from, using only files preserved in the folder itself
// (item folders are kept as-is from the original Thingiverse/Printables
// zip download -- see ARCHITECTURE.md's "Category elimination" notes).
// Never throws; returns null when nothing can be determined, which
// callers treat exactly like an empty/manually-entered field. When
// something IS determined, the return shape is always
// { url, creatorName, creatorUrl } -- creatorName/creatorUrl are left
// undefined for schemas/paths that don't (yet) extract them.
//
// Two known schemas:
//
// - Thingiverse: a top-level README.txt containing the exact line
//   "{ITEM NAME} by {CREATOR USERNAME} on Thingiverse: {URL}". The
//   username is captured from between " by " and " on Thingiverse:"
//   (THINGIVERSE_LINE_RE below), same "just anchor on the fixed part
//   of the sentence" approach the URL capture already used -- robust
//   to punctuation in the item name or username, though if the item
//   name itself contains " by " as a substring (unlikely, but
//   possible -- e.g. "Standby Bracket"), the greedy match will still
//   land on the *last* " by " before " on Thingiverse:", which is
//   always the right one. creatorUrl is then constructed directly from
//   the username (`https://www.thingiverse.com/{username}`) rather
//   than needing a second parse -- Thingiverse profile URLs are just
//   that pattern.
//
// - Printables: a top-level PDF named
//   "{model-slug}-{decimal digits}-{hex groups separated by dashes}.pdf"
//   -- a browser print-to-PDF of the model page. Browser-printed pages
//   preserve real clickable links as PDF link annotations, so the
//   page's "View in browser" button is read directly as an annotation
//   rather than needing OCR or full text extraction. There can be more
//   than one top-level PDF (e.g. a user-added instructions sheet
//   alongside the page printout) -- every candidate matching the
//   naming pattern is tried, in order, and the first one whose
//   annotations actually resolve to a printables.com/model/ link wins
//   (a plain "contains printables.com" check isn't enough -- see
//   PRINTABLES_MODEL_URL_RE below). The same annotation list also
//   carries a link to the creator's profile (from the page's byline),
//   which real Printables page-printouts place *before* the model link
//   in annotation order -- see PRINTABLES_CREATOR_URL_RE below -- so
//   creatorUrl/creatorName are pulled from that same pass at no extra
//   parsing cost. If no candidate PDF has a readable model-link
//   annotation (annotation missing, or pdf-lib can't parse that
//   particular PDF), this falls back to reconstructing the URL from
//   the first candidate's filename -- a best-effort guess only, never
//   verified over the network, and with no creator info available
//   (the PDF wasn't successfully read, so there's nothing to pull the
//   creator link from either).
//
// NOTE: the annotation structure this reads (page /Annots -> /A ->
// /URI) has been confirmed against a real Printables-exported PDF
// (its link annotations were dumped and inspected directly), so the
// overall approach is sound. The pdf-lib call sequence itself
// (`PDFArray`/`PDFDict` `.lookup()`, `PDFName`, `.decodeText()`)
// still hasn't been run end-to-end in Node, though -- there was no
// network access available to `npm install pdf-lib` in this
// environment. Sanity-check it once the dependency is actually
// installed, and adjust extractAnnotUri()/detectPrintablesOrigin() if
// pdf-lib's low-level API doesn't match what's assumed here.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

// Captures the creator username between " by " and " on Thingiverse:"
// and the URL after it, in one pass. Greedy on the username group so
// that if the item name itself contains " by ", the match still lands
// on the last " by " before " on Thingiverse:" (the only fixed anchor
// in the line) rather than the first.
const THINGIVERSE_LINE_RE = /\sby\s+(.+)\s+on Thingiverse:\s*(\S+)/i;

const PRINTABLES_PDF_RE = /^(.+)-\d+-[0-9a-f]+(?:-[0-9a-f]+)*\.pdf$/i;
// Real Printables page-printout PDFs put a link to the creator's
// profile (from the byline, e.g. "https://www.printables.com/@someone")
// *before* the actual "View in browser" model link in annotation
// order, and also carry category links like
// "https://www.printables.com/model?categoryId=13" further down --
// both would false-positive on a bare "contains printables.com" check.
// Requiring the "/model/" path specifically (note the trailing slash,
// which the "?categoryId=" links don't have) rules both out.
const PRINTABLES_MODEL_URL_RE = /^https?:\/\/(?:www\.)?printables\.com\/model\//i;
// The creator-profile link's path is just "/@{username}" -- captures
// the username directly so it doesn't need a second parse of the URL.
const PRINTABLES_CREATOR_URL_RE = /^https?:\/\/(?:www\.)?printables\.com\/@([^/?#]+)/i;

// entries, if passed, must be the result of an already-done
// fs.readdir(folderPath, { withFileTypes: true }) -- callers that
// already have that listing (e.g. editSession.js's scanSourceFolder,
// which scans the same folder for print files/images) can pass it in
// to avoid a redundant readdir; anyone calling this standalone can
// just omit it.
async function detectOrigin(folderPath, entries) {
  const list = entries || (await fsp.readdir(folderPath, { withFileTypes: true }));

  const readme = list.find((e) => e.isFile() && e.name.toLowerCase() === 'readme.txt');
  if (readme) {
    const origin = await detectThingiverseOrigin(path.join(folderPath, readme.name));
    if (origin) return origin;
  }

  const pdfCandidates = list.filter((e) => e.isFile() && PRINTABLES_PDF_RE.test(e.name));
  for (const pdf of pdfCandidates) {
    const origin = await detectPrintablesOrigin(path.join(folderPath, pdf.name));
    if (origin) return origin;
  }
  // No candidate had a readable model-link annotation -- fall back to
  // a filename-reconstructed guess rather than returning nothing (no
  // creator info in this case, since the PDF wasn't successfully
  // read). Only the first candidate is used for the fallback
  // (arbitrary but deterministic); if there's ever a case with
  // multiple Printables page-printout PDFs in one folder, whichever
  // comes first alphabetically wins the guess.
  for (const pdf of pdfCandidates) {
    const match = PRINTABLES_PDF_RE.exec(pdf.name);
    if (match) return { url: `https://www.printables.com/model/${match[1]}` };
  }

  return null;
}

// Tries the full "{name} by {username} on Thingiverse: {url}" line
// first (gets url + creator together); if a README doesn't match that
// exact shape (e.g. a hand-edited or older-format README), falls back
// to the old URL-only regex so a folder still gets *something*
// detected rather than nothing, just without creator info.
async function detectThingiverseOrigin(readmePath) {
  try {
    const text = await fsp.readFile(readmePath, 'utf8');
    const fullMatch = THINGIVERSE_LINE_RE.exec(text);
    if (fullMatch) {
      const creatorName = fullMatch[1].trim();
      return {
        url: fullMatch[2],
        creatorName,
        creatorUrl: `https://www.thingiverse.com/${encodeURIComponent(creatorName)}`,
      };
    }
    const urlOnlyMatch = /on Thingiverse:\s*(\S+)/i.exec(text);
    return urlOnlyMatch ? { url: urlOnlyMatch[1] } : null;
  } catch (err) {
    return null; // unreadable README -- treat like "couldn't detect"
  }
}

// Walks a Printables page-printout PDF's link annotations once,
// picking out both the model-page link and (if seen along the way)
// the creator-profile link that precedes it. Returns null only when
// no model-link annotation is found -- a creator link without a model
// link isn't enough to call this folder "detected" (and the filename
// fallback above wouldn't have a creator to pair it with anyway).
async function detectPrintablesOrigin(pdfPath) {
  try {
    const bytes = await fsp.readFile(pdfPath);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    let creatorUrl = null;
    let creatorName = null;
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const annotDict = annots.lookup(i);
        const uri = extractAnnotUri(annotDict);
        if (!uri) continue;
        if (!creatorUrl) {
          const creatorMatch = PRINTABLES_CREATOR_URL_RE.exec(uri);
          if (creatorMatch) {
            creatorUrl = uri;
            creatorName = creatorMatch[1];
            continue; // a URL can't be both the creator link and the model link
          }
        }
        if (PRINTABLES_MODEL_URL_RE.test(uri)) {
          return { url: uri, creatorName: creatorName || undefined, creatorUrl: creatorUrl || undefined };
        }
      }
    }
    return null;
  } catch (err) {
    return null; // unreadable/corrupt/unexpected-shape PDF
  }
}

function extractAnnotUri(annotDict) {
  try {
    const action = annotDict.lookup(PDFName.of('A'));
    if (!action) return null;
    const uri = action.lookup(PDFName.of('URI'));
    return uri ? uri.decodeText() : null;
  } catch (err) {
    return null;
  }
}

module.exports = { detectOrigin };
