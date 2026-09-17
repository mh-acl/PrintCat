'use strict';

// Printer/tag/keyword filtering: predicate functions (itemMatches*)
// plus the sidebar filter option-lists (renderPrinterFilter/
// renderTagFilter, the latter also driving the edit-mode-only status
// list) and the sort-mode/direction control up top (renderSortFilter).
// Depends on: state.js (selectedPrinters/selectedTags/keywordQuery/
// editModeActive/selectedSmartTags/settings), utils.js.

// Builds one checkbox/radio row for a sidebar filter list --
// renderPrinterFilter (checkboxes, multi-select), renderTagFilter
// (radios, single-select, both the tag list and the edit-mode status
// list) all share this shape rather than each hand-rolling a <label>.
function buildFilterOptionRow({ type, name, checked, labelText, countText, extraClass, onChange }) {
  const label = document.createElement('label');
  label.className = 'filter-option' + (extraClass ? ` ${extraClass}` : '');

  const input = document.createElement('input');
  input.type = type;
  if (name) input.name = name;
  input.checked = checked;
  input.onchange = onChange;
  label.appendChild(input);

  const labelSpan = document.createElement('span');
  labelSpan.className = 'filter-option-label';
  labelSpan.textContent = labelText;
  label.appendChild(labelSpan);

  if (countText !== undefined) {
    const countSpan = document.createElement('span');
    countSpan.className = 'filter-option-count';
    countSpan.textContent = countText;
    label.appendChild(countSpan);
  }
  return label;
}

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
// A single file's printer identity vs. the current filter -- the
// shared building block behind itemMatchesPrinter (any-file-matches,
// used to decide whether an item shows at all) and the "which files
// count for this item" helpers below (filesMatchingPrinter/
// filesMatchingCurrentFilters), which need the same per-file test but
// keep or drop individual files rather than the whole item.
function fileMatchesPrinter(file, printerSet) {
  return !printerSet || printerSet.size === 0 || printerSet.has(printerLabel(file));
}
function itemMatchesPrinter(item, printerSet) {
  if (!printerSet || printerSet.size === 0) return true;
  return item.files.some((f) => fileMatchesPrinter(f, printerSet));
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
// "Which of this item's files count" for the two grid-card metadata
// values (grid.js's sortKeyForItem/buildItemCardMetaText) -- each
// falls back a tier at a time rather than ever returning empty, same
// reasoning as itemModal.js's view-mode file list (matchesPrinterOnly/
// matchingFiles): an item can pass the ambient item-level filters
// (itemMatchesPrinter/itemMatchesKeyword, which only require *some*
// file to match each independently) while literally no single file
// satisfies both at once, and the card still needs to show something
// rather than going blank in that edge case.
//
// filesMatchingCurrentFilters is the "updated" timestamp's notion of
// "showing" -- printer filter, narrowed further by the ambient
// keyword search, matching what you'd actually see if you opened this
// item's own modal right now.
//
// filesMatchingPrinter is print time's narrower notion -- printer
// filter only. Deliberately ignores the keyword search: which files
// physically fit the selected printer(s) doesn't depend on what text
// you happen to be searching for.
function filesMatchingCurrentFilters(item, printerSet) {
  const printerOnly = item.files.filter((f) => fileMatchesPrinter(f, printerSet));
  const combined = printerOnly.filter((f) => fileMatchesKeywordInItem(item, f, keywordQuery));
  if (combined.length > 0) return combined;
  if (printerOnly.length > 0) return printerOnly;
  return item.files;
}
function filesMatchingPrinter(item, printerSet) {
  const printerOnly = item.files.filter((f) => fileMatchesPrinter(f, printerSet));
  return printerOnly.length > 0 ? printerOnly : item.files;
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

  // Nothing to actually choose between -- hide the whole sidebar
  // section (heading included, not just the option list) and just
  // show that one printer's items directly.
  const section = el.closest('.filter-section');
  if (settings.hideUnavailable && visiblePrinters.length <= 1) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';

  // Drop any selected printer that's no longer a valid choice (e.g.
  // its last file was removed, or an admin setting hid it).
  selectedPrinters = new Set([...selectedPrinters].filter((p) => visiblePrinters.includes(p)));

  // "All Printers" isn't itself a printer to multi-select alongside the
  // others -- it's a checked-when-nothing-else-is reset row, same
  // behavior as the old pill (clicking it always clears the set, it's
  // just also checked automatically once the set empties out).
  el.appendChild(
    buildFilterOptionRow({
      type: 'checkbox',
      checked: selectedPrinters.size === 0,
      labelText: 'All Printers',
      onChange: () => {
        selectedPrinters = new Set();
        renderPrinterFilter();
        render();
      },
    })
  );

  for (const printer of visiblePrinters) {
    el.appendChild(
      buildFilterOptionRow({
        type: 'checkbox',
        checked: selectedPrinters.has(printer),
        labelText: printer,
        onChange: (e) => {
          if (e.target.checked) {
            selectedPrinters.add(printer);
          } else {
            selectedPrinters.delete(printer);
          }
          renderPrinterFilter();
          render();
        },
      })
    );
  }
}
function renderTagFilter() {
  const el = document.getElementById('tag-filter');
  el.innerHTML = '';

  const tags = Array.from(collectTags(allItems)).sort();
  const tagSection = el.closest('.filter-section');
  if (tags.length === 0) {
    // Nothing to choose between yet -- hide the section entirely
    // (heading included) rather than show an empty radio list.
    if (tagSection) tagSection.style.display = 'none';
  } else {
    if (tagSection) tagSection.style.display = '';

    // Drop any selected tag that's no longer valid (e.g. its last item
    // was removed or untagged).
    selectedTags = new Set([...selectedTags].filter((t) => tags.includes(t)));

    const effective = effectivePrinterFilter();

    // True radio-group single-select: "All Tags" is one of the options
    // rather than a separate reset control, so exactly one row is
    // always checked. (Previously, clicking the already-active tag
    // pill cleared it back to "All Tags" -- with real radios that's
    // done by clicking "All Tags" itself instead, same as any other
    // radio-button filter list.)
    el.appendChild(
      buildFilterOptionRow({
        type: 'radio',
        name: 'tag-filter-radio',
        checked: selectedTags.size === 0,
        labelText: 'All Tags',
        onChange: () => {
          selectedTags = new Set();
          renderTagFilter();
          render();
        },
      })
    );

    for (const tag of tags) {
      const count = countItemsForTag(allItems, effective, tag, keywordQuery);
      el.appendChild(
        buildFilterOptionRow({
          type: 'radio',
          name: 'tag-filter-radio',
          checked: selectedTags.has(tag),
          labelText: tag,
          countText: `(${count})`,
          onChange: () => {
            selectedTags = new Set([tag]);
            renderTagFilter();
            render();
          },
        })
      );
    }
  }

  renderStatusFilter();
}
// Edit-mode-only Pending/Edited/Trashed rows -- split into their own
// sidebar section (rather than sharing #tag-filter with real tags,
// as the old smart-tag pills did) since they're a different filter
// dimension. Still multi-select checkboxes, unlike the tag radios
// above: any combination of statuses can be shown at once.
function renderStatusFilter() {
  const el = document.getElementById('status-filter');
  const section = document.getElementById('status-filter-section');
  if (!el || !section) return;
  el.innerHTML = '';

  if (!editModeActive) {
    section.style.display = 'none';
    return;
  }

  let shown = 0;
  for (const tag of SMART_TAGS) {
    const count = Object.values(pendingChanges).filter((c) => c.type === tag.type).length;
    // A status with nothing currently in it would just filter the grid
    // down to nothing if checked -- skip showing it rather than offer
    // a row that's guaranteed to look "broken".
    if (count === 0 && !selectedSmartTags.has(tag.type)) continue;
    shown++;

    el.appendChild(
      buildFilterOptionRow({
        type: 'checkbox',
        checked: selectedSmartTags.has(tag.type),
        labelText: tag.label,
        countText: `(${count})`,
        extraClass: tag.className,
        onChange: (e) => {
          if (e.target.checked) {
            selectedSmartTags.add(tag.type);
          } else {
            selectedSmartTags.delete(tag.type);
          }
          renderStatusFilter();
          render();
        },
      })
    );
  }
  section.style.display = shown > 0 ? '' : 'none';
}
// Recent/Name/Print Time sort control -- always exactly one active,
// unlike the printer/tag pills above which support "none selected".
// Each mode has its own preferredReverse -- the direction it snaps to
// whenever you switch into it, regardless of what direction whichever
// mode was active before happened to be in -- plus its own inline
// direction indicator, so the direction and the mode live on the same
// button rather than a separate control. Rendered once at startup
// (see renderer.js's init()) and again on every mode/direction change,
// same as before.
const SORT_MODES = [
  { mode: 'recent', label: 'Recent', preferredReverse: false },
  { mode: 'name', label: 'Name', preferredReverse: false },
  { mode: 'time', label: 'Print Time', preferredReverse: false },
];
const SORT_DIRECTION_INDICATOR_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>';
function renderSortFilter() {
  const el = document.getElementById('sort-filter');
  if (!el) return;
  el.innerHTML = '';

  for (const { mode, label, preferredReverse } of SORT_MODES) {
    const isActive = sortMode === mode;
    // An inactive button's indicator shows the direction you'd land
    // on by switching to it (its preferredReverse); the active
    // button's indicator shows the direction actually in effect right
    // now (sortReverse), which can differ from preferredReverse once
    // it's been clicked a second time.
    const reversed = isActive ? sortReverse : preferredReverse;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'filter-pill sort-mode-pill' + (isActive ? ' active' : '') + (reversed ? ' reversed' : '');
    // Clicking the already-active mode reverses it in place; clicking
    // a different mode switches to it at that mode's own preferred
    // direction rather than carrying over whatever direction the
    // previous mode was left in.
    btn.title = isActive
      ? `Sorted by ${label}, ${sortReverse ? 'reversed' : 'default'} order \u2014 click to reverse`
      : `Sort by ${label}`;
    btn.setAttribute('aria-label', btn.title);
    btn.onclick = () => {
      if (isActive) {
        sortReverse = !sortReverse;
      } else {
        sortMode = mode;
        sortReverse = preferredReverse;
      }
      renderSortFilter();
      render();
    };

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);

    const indicator = document.createElement('span');
    indicator.className = 'sort-direction-indicator';
    indicator.innerHTML = SORT_DIRECTION_INDICATOR_SVG;
    btn.appendChild(indicator);

    el.appendChild(btn);
  }
}
