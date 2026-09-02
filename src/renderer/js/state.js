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

