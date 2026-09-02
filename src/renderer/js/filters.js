'use strict';

// Printer/tag/keyword filtering: predicate functions (itemMatches*)
// plus the two filter-pill rows (renderPrinterFilter/renderTagFilter).
// Depends on: state.js (selectedPrinters/selectedTags/keywordQuery/
// editModeActive/selectedSmartTags/settings), utils.js.

function onKeywordInput(e) {
  keywordQuery = e.target.value;
  // Tag pill counts fold in the keyword filter too (see
  // countItemsForTag), so they need a re-render on every
  // keystroke same as the listing does. The printer pills don't show
  // counts, so they don't need to be touched here.
  renderTagFilter();
  render();
}
// Starting filter selection is whatever the admin configured as this
// makerspace's available printers -- if nothing's configured yet,
// that's an empty set, meaning no restriction ("All Printers").
function applyDefaultPrinterFilter() {
  selectedPrinters = new Set(settings.availablePrinters || []);
}
// A file's printer identity for filtering purposes -- same
// model+variant combination the old site displayed, but now derived
// fresh from whatever's actually in the data instead of a hardcoded
// checkbox list.
function printerLabel(file) {
  return [file.printerModel, file.printerVariant].filter(Boolean).join(' ') || 'Unknown printer';
}
function collectPrinters(items) {
  const set = new Set();
  for (const item of items) {
    for (const file of item.files) set.add(printerLabel(file));
  }
  return set;
}
function collectTags(items) {
  const set = new Set();
  for (const item of items) {
    for (const tag of item.tags || []) set.add(tag);
  }
  return set;
}
function itemMatchesPrinter(item, printerSet) {
  if (!printerSet || printerSet.size === 0) return true;
  return item.files.some((f) => printerSet.has(printerLabel(f)));
}
function itemMatchesTags(item, tagSet) {
  if (!tagSet || tagSet.size === 0) return true;
  return (item.tags || []).some((t) => tagSet.has(t));
}
// Only applies in edit mode -- pendingChanges is always empty otherwise,
// so this is a no-op filter outside a session.
function itemMatchesSmartTags(item, smartSet) {
  if (!smartSet || smartSet.size === 0) return true;
  const change = pendingChanges[item.path];
  return Boolean(change && smartSet.has(change.type));
}
// Only the item's own display name -- not its files -- so this can be
// used to decide "does the item name itself justify showing every
// file underneath it" separately from "does this one file match".
function itemNameText(item) {
  return (item.displayName || item.name || '').toLowerCase();
}
function fileSearchText(file) {
  return [file.shortname, file.longname, ...(file.tags || [])]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
}
// True if this item belongs in the browsing grid for the current
// search: either its own name matches, or at least one of its print
// files (by name or tag) does.
function itemMatchesKeyword(item, query) {
  const words = keywordWords(query);
  if (words.length === 0) return true;
  if (textIncludesAllWords(itemNameText(item), words)) return true;
  return item.files.some((f) => textIncludesAllWords(fileSearchText(f), words));
}
// True if this specific file should be shown once its item is open.
// An item-name match (e.g. searching "vase" finding the item
// "Faceted Vase") counts for all of that item's files, since the
// match didn't come from anything file-specific; otherwise it falls
// back to the file's own name/tags.
function fileMatchesKeywordInItem(item, file, query) {
  const words = keywordWords(query);
  if (words.length === 0) return true;
  if (textIncludesAllWords(itemNameText(item), words)) return true;
  return textIncludesAllWords(fileSearchText(file), words);
}
// Total matching *items* for one tag pill's count -- deliberately
// mirrors the exact predicate render() uses to build visibleItems
// (itemMatchesPrinter + itemMatchesKeyword), so this number matches
// what you'd actually see in the grid after clicking the tag. Items
// have multiple print files each, so counting files here (the
// previous behavior) could show a much bigger number than the item
// count you'd actually land on. Not folded through itemMatchesTags
// itself since the tag being counted is the one being tested, and not
// itemMatchesSmartTags since that's edit-session-only and unrelated to
// what a tag pill represents.
function countItemsForTag(items, printerSet, tagValue, query) {
  let total = 0;
  for (const item of items) {
    if (!(item.tags || []).includes(tagValue)) continue;
    if (!itemMatchesPrinter(item, printerSet)) continue;
    if (!itemMatchesKeyword(item, query)) continue;
    total++;
  }
  return total;
}
// Builds a "nothing matches" message that names only the currently-active
// restriction(s) that would actually surface something if relaxed --
// tested individually (holding the others fixed) rather than always
// pointing at the same one regardless of what's actually active, so the
// suggestion matches the person's actual situation instead of sending
// them to fix the wrong thing.
//
// `restrictions` is an array of:
//   { active: boolean, wouldHelp: () => boolean, suggestion: string }
// `allClearMessage` is shown when none of the restrictions are active at
// all (e.g. an empty catalog). `combinedMessage` is shown when every
// active restriction is individually necessary -- no single change would
// help, only loosening more than one at once would.
function buildFilterMessage(restrictions, allClearMessage, combinedMessage) {
  const active = restrictions.filter((r) => r.active);
  if (active.length === 0) return allClearMessage;

  const fixes = active.filter((r) => r.wouldHelp()).map((r) => r.suggestion);
  if (fixes.length === 0) return combinedMessage;

  return `${capitalize(fixes.join(', or '))}.`;
}
// The filter actually in effect, folding the admin's hideUnavailable
// setting in on top of the user's own selection. When hideUnavailable
// is on, "All Printers" (an empty selection) really means "all
// *available* printers" -- browsing can never reach beyond what this
// makerspace actually has, regardless of what's selected.
function effectivePrinterFilter() {
  const available = settings.availablePrinters || [];
  if (settings.hideUnavailable && available.length > 0) {
    const allowed = new Set(available);
    if (selectedPrinters.size === 0) return allowed;
    return new Set([...selectedPrinters].filter((p) => allowed.has(p)));
  }
  return selectedPrinters;
}
// Which printers should even be offered as choices, given the
// hideUnavailable setting: everything, or only what's marked
// available for this makerspace.
function getVisiblePrinterOptions(allPrinters) {
  const available = settings.availablePrinters || [];
  if (!settings.hideUnavailable || available.length === 0) {
    return allPrinters;
  }
  return allPrinters.filter((p) => available.includes(p));
}
function renderPrinterFilter() {
  const el = document.getElementById('printer-filter');
  el.innerHTML = '';

  const allPrinters = Array.from(collectPrinters(allItems)).sort();
  const visiblePrinters = getVisiblePrinterOptions(allPrinters);

  // Nothing to actually choose between -- hide the whole filter bar
  // and just show that one printer's items directly.
  if (settings.hideUnavailable && visiblePrinters.length <= 1) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';

  // Drop any selected printer that's no longer a valid choice (e.g.
  // its last file was removed, or an admin setting hid it).
  selectedPrinters = new Set([...selectedPrinters].filter((p) => visiblePrinters.includes(p)));

  const allBtn = document.createElement('button');
  allBtn.textContent = 'All Printers';
  allBtn.className = 'filter-pill' + (selectedPrinters.size === 0 ? ' active' : '');
  allBtn.onclick = () => {
    selectedPrinters = new Set();
    renderPrinterFilter();
    render();
  };
  el.appendChild(allBtn);

  for (const printer of visiblePrinters) {
    const btn = document.createElement('button');
    btn.textContent = printer;
    btn.className = 'filter-pill' + (selectedPrinters.has(printer) ? ' active' : '');
    btn.onclick = () => {
      if (selectedPrinters.has(printer)) {
        selectedPrinters.delete(printer);
      } else {
        selectedPrinters.add(printer);
      }
      renderPrinterFilter();
      render();
    };
    el.appendChild(btn);
  }
}
function renderTagFilter() {
  const el = document.getElementById('tag-filter');
  el.innerHTML = '';

  const tags = Array.from(collectTags(allItems)).sort();
  // Bail out on the tag-pill portion alone when there are no tags yet
  // -- the smart tag pills (edit mode) still need to render either way.
  if (tags.length > 0) {
    // Drop any selected tag that's no longer valid (e.g. its last item
    // was removed or untagged).
    selectedTags = new Set([...selectedTags].filter((t) => tags.includes(t)));

    const effective = effectivePrinterFilter();

    const allBtn = document.createElement('button');
    allBtn.textContent = 'All Tags';
    allBtn.className = 'filter-pill' + (selectedTags.size === 0 ? ' active' : '');
    allBtn.onclick = () => {
      selectedTags = new Set();
      renderTagFilter();
      render();
    };
    el.appendChild(allBtn);

    for (const tag of tags) {
      const count = countItemsForTag(allItems, effective, tag, keywordQuery);
      const btn = document.createElement('button');
      btn.textContent = `${tag} (${count})`;
      btn.className = 'filter-pill' + (selectedTags.has(tag) ? ' active' : '');
      btn.onclick = () => {
        // Single-select: clicking a tag switches the filter to just that
        // tag, replacing whatever was selected before. Clicking the
        // already-active tag clears back to "All Tags". (Previously this
        // toggled the tag in/out of a multi-select OR set -- see
        // ARCHITECTURE.md's "Tag filter: single-select" note.)
        if (selectedTags.has(tag)) {
          selectedTags = new Set();
        } else {
          selectedTags = new Set([tag]);
        }
        renderTagFilter();
        render();
      };
      el.appendChild(btn);
    }
  }

  if (editModeActive) {
    for (const tag of SMART_TAGS) {
      const count = Object.values(pendingChanges).filter((c) => c.type === tag.type).length;
      // A tag with nothing currently in that state would just filter
      // the grid down to nothing if clicked -- skip showing it rather
      // than offer a pill that's guaranteed to look "broken".
      if (count === 0 && !selectedSmartTags.has(tag.type)) continue;

      const btn = document.createElement('button');
      btn.textContent = `${tag.label} (${count})`;
      btn.className = `filter-pill smart-tag ${tag.className}` + (selectedSmartTags.has(tag.type) ? ' active' : '');
      btn.onclick = () => {
        if (selectedSmartTags.has(tag.type)) {
          selectedSmartTags.delete(tag.type);
        } else {
          selectedSmartTags.add(tag.type);
        }
        renderTagFilter();
        render();
      };
      el.appendChild(btn);
    }
  }
}
