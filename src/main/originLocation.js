'use strict';

// originLocation.js
//
// Best-effort detection of the page an item's folder was originally
// downloaded from, using only files preserved in the folder itself
// (item folders are kept as-is from the original Thingiverse/Printables
// zip download -- see ARCHITECTURE.md's "Category elimination" notes).
// Never throws; returns null when nothing can be determined, which
// callers treat exactly like an empty/manually-entered field.
//
// Two known schemas:
//
// - Thingiverse: a top-level README.txt containing the exact line
//   "{ITEM NAME} by {CREATOR USERNAME} on Thingiverse: {URL}". Only
//   the URL is pulled out (via regex on "on Thingiverse:"), since
//   that's all this pass needs -- robust to the item name or username
//   containing punctuation that would make parsing the whole sentence
//   fussier than it needs to be.
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
//   PRINTABLES_MODEL_URL_RE below). If none do (annotation missing, or
//   pdf-lib can't parse that particular PDF), this falls back to
//   reconstructing the URL from the first candidate's filename -- a
//   best-effort guess only, never verified over the network, since
//   this module is meant to work fully offline from what's already on
//   disk.
//
// NOTE: the annotation structure this reads (page /Annots -> /A ->
// /URI) has been confirmed against a real Printables-exported PDF
// (its link annotations were dumped and inspected directly), so the
// overall approach is sound. The pdf-lib call sequence itself
// (`PDFArray`/`PDFDict` `.lookup()`, `PDFName`, `.decodeText()`)
// still hasn't been run end-to-end in Node, though -- there was no
// network access available to `npm install pdf-lib` in this
// environment. Sanity-check it once the dependency is actually
// installed, and adjust extractAnnotUri()/detectPrintablesUrl() if
// pdf-lib's low-level API doesn't match what's assumed here.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

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

// entries, if passed, must be the result of an already-done
// fs.readdir(folderPath, { withFileTypes: true }) -- callers that
// already have that listing (e.g. editSession.js's scanSourceFolder,
// which scans the same folder for print files/images) can pass it in
// to avoid a redundant readdir; anyone calling this standalone can
// just omit it.
async function detectOriginUrl(folderPath, entries) {
  const list = entries || (await fsp.readdir(folderPath, { withFileTypes: true }));

  const readme = list.find((e) => e.isFile() && e.name.toLowerCase() === 'readme.txt');
  if (readme) {
    const url = await detectThingiverseUrl(path.join(folderPath, readme.name));
    if (url) return url;
  }

  const pdfCandidates = list.filter((e) => e.isFile() && PRINTABLES_PDF_RE.test(e.name));
  for (const pdf of pdfCandidates) {
    const url = await detectPrintablesUrl(path.join(folderPath, pdf.name));
    if (url) return url;
  }
  // No candidate had a readable link annotation -- fall back to a
  // filename-reconstructed guess rather than returning nothing. Only
  // the first candidate is used for the fallback (arbitrary but
  // deterministic); if there's ever a case with multiple Printables
  // page-printout PDFs in one folder, whichever comes first alphabetically
  // wins the guess.
  for (const pdf of pdfCandidates) {
    const match = PRINTABLES_PDF_RE.exec(pdf.name);
    if (match) return `https://www.printables.com/model/${match[1]}`;
  }

  return null;
}

async function detectThingiverseUrl(readmePath) {
  try {
    const text = await fsp.readFile(readmePath, 'utf8');
    const match = /on Thingiverse:\s*(\S+)/i.exec(text);
    return match ? match[1] : null;
  } catch (err) {
    return null; // unreadable README -- treat like "couldn't detect"
  }
}

async function detectPrintablesUrl(pdfPath) {
  try {
    const bytes = await fsp.readFile(pdfPath);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const annotDict = annots.lookup(i);
        const uri = extractAnnotUri(annotDict);
        if (uri && PRINTABLES_MODEL_URL_RE.test(uri)) return uri;
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

module.exports = { detectOriginUrl };
