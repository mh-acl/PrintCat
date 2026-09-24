'use strict';

// Flat filtering UI: no navigation, no breadcrumbs, no categories. Two
// independent filter rows (Printers, Tags) narrow down a single flat
// grid of items; clicking an item shows its print files.
// Tags come from each item's metadata.json (see itemMetadata.js) --
// an item can carry any number of them, but the tag filter itself is
// single-select: clicking a tag pill switches the filter to just that
// tag (replacing whatever was selected before) rather than adding it
// to a set, and clicking the active tag again clears back to "All
// Tags". selectedTags is still a Set under the hood (0 or 1 entries)
// so itemMatchesTags()'s OR-match logic didn't need to change. The
// printer filter is unaffected and remains multi-select OR.

let allItems = [];
let selectedPrinters = new Set(); // empty = no restriction chosen ("All Printers")
let selectedTags = new Set(); // empty = no restriction chosen ("All Tags")
let keywordQuery = ''; // raw text from the search box; '' = no restriction
// Which order the grid displays items in -- 'recent' (default) sorts by
// each item's most recently added/updated print file (filtered by the
// current printer/keyword filters -- see filters.js's
// filesMatchingCurrentFilters and grid.js's sortKeyForItem), 'name' sorts
// alphabetically by displayName, 'time' sorts by the item's shortest
// print file's print time ascending (filtered by the current printer
// filter and print-time limit, not the keyword -- filters.js's
// filesMatchingPrinterAndTime; while a print-time limit is active it
// instead uses the longest file still within that limit, see grid.js's
// sortKeyForItem). See grid.js's compareByMode()/render() and
// filters.js's renderSortFilter().
let sortMode = 'recent';
// Flips compareByMode's comparison result (not the rendered array) --
// see grid.js's compareByMode for why: it keeps "unknown value sorts
// to the end" true regardless of direction, which a plain
// Array.reverse() or array-reversal-based approach wouldn't.
let sortReverse = false;
// Print-time filter ("under" a maximum only -- no minimum/range): which choice is
// selected in the sidebar's Print Time section ('any', a preset's
// minutes as a string like '120', or 'custom'), the raw text in the
// custom h/m fields, and the resulting limit in whole minutes that the
// rest of the renderer actually reads (null = no limit). The limit is
// derived from the other two by filters.js's recomputePrintTimeLimit()
// -- nothing else should assign it directly. Kept in minutes, not
// seconds, because the card shows print times rounded to the nearest
// minute and the filter compares on that same rounded value (see
// utils.js's printTimeWithinLimit) so a file displayed as "1hr 30m"
// always passes a 1h 30m limit.
let printTimeChoice = 'any';
let customPrintTimeInputs = { hours: '', minutes: '' };
let printTimeLimitMinutes = null;
let settings = { availablePrinters: [], hideUnavailable: false, gitRepoUrl: '', gitBranch: '' };
let syncStatus = { configured: false, lastSuccessAt: null, inProgress: false, pausedForEdit: false };

// Edit mode: the main screen doubles as the editing UI (see
// ARCHITECTURE.md) rather than being a separate mode/window. pendingChanges
// mirrors editSession.js's changes map (itemPath -> {type, name}) purely
// for display -- badges, borders, the bottom bar's counts, and the smart
// tag pills below. selectedSmartTags holds which of 'add'/'edit'/'delete'
// are currently filtered on, same shape as selectedTags.
let editModeActive = false;
let pendingChanges = {};
let selectedSmartTags = new Set();

const SMART_TAGS = [
  { type: 'add', label: 'Pending', className: 'smart-tag-add' },
  { type: 'edit', label: 'Edited', className: 'smart-tag-edit' },
  { type: 'delete', label: 'Trashed', className: 'smart-tag-delete' },
];

