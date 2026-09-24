'use strict';

// Printer/tag/keyword/print-time filtering: predicate functions
// (itemMatches*/fileMatches*) plus the sidebar filter option-lists
// (renderPrinterFilter/renderPrintTimeFilter/renderTagFilter, the
// latter also driving the edit-mode-only status list) and the
// sort-mode/direction control up top (renderSortFilter).
// Depends on: state.js (selectedPrinters/selectedTags/keywordQuery/
// printTimeChoice/printTimeLimitMinutes/editModeActive/
// selectedSmartTags/settings), utils.js.

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
// count for this item" helpers below (filesMatchingPrinterAndTime/
// filesMatchingCurrentFilters), which need the same per-file test but
// keep or drop individual files rather than the whole item.
function fileMatchesPrinter(file, printerSet) {
  return !printerSet || printerSet.size === 0 || printerSet.has(printerLabel(file));
}
function itemMatchesPrinter(item, printerSet) {
  if (!printerSet || printerSet.size === 0) return true;
  return item.files.some((f) => fileMatchesPrinter(f, printerSet));
}
// Print-time filter ("under" a maximum only): a single file's print time vs. the
// limit in whole minutes (null = no limit, everything passes). Files
// with an unknown/unparseable print time fail an active limit -- see
// utils.js's printTimeWithinLimit.
function fileMatchesPrintTime(file, limitMinutes) {
  if (limitMinutes == null) return true;
  return printTimeWithinLimit(parsePrintTimeSeconds(file.printTime), limitMinutes);
}
// The two physical-fit tests together, using the limit currently in
// effect (state.js's printTimeLimitMinutes): "could this file be
// printed here, within the time I've got" -- the per-file counterpart
// of itemMatchesPrintTime below, and what the item modal's file list
// filters on alongside the keyword search.
function fileMatchesPrinterAndTime(file, printerSet) {
  return fileMatchesPrinter(file, printerSet) && fileMatchesPrintTime(file, printTimeLimitMinutes);
}
// An item passes the print-time filter if at least one of its files
// satisfies the printer filter AND the time limit *at once* -- not
// "some file matches the printer and some (possibly other) file is
// short enough", which would let an item through on the strength of
// a quick print for a printer that isn't even selected. With no limit
// set this is always true, so the printer filter's own any-file-
// matches test (itemMatchesPrinter) stays what decides that alone.
// limitMinutes is a parameter (rather than read from state.js like
// fileMatchesPrinterAndTime) so grid.js's buildGridEmptyMessage can ask
// "would this match with the limit removed".
function itemMatchesPrintTime(item, printerSet, limitMinutes) {
  if (limitMinutes == null) return true;
  return item.files.some(
    (f) => fileMatchesPrinter(f, printerSet) && fileMatchesPrintTime(f, limitMinutes)
  );
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
// filesMatchingPrinterAndTime is print time's narrower notion --
// printer filter plus the print-time limit (if one's set), no keyword.
// Deliberately ignores the keyword search: which files physically fit
// the selected printer(s), within the time you've got, doesn't depend
// on what text you happen to be searching for. Both helpers fall back
// tier by tier (printer+time, then printer alone, then every file)
// rather than ever returning empty -- an item can only reach a card
// with nothing under the limit in edit mode, where non-matching items
// are shown anyway (see grid.js's render()).
function filesMatchingCurrentFilters(item, printerSet) {
  const strict = item.files.filter((f) => fileMatchesPrinterAndTime(f, printerSet));
  const combined = strict.filter((f) => fileMatchesKeywordInItem(item, f, keywordQuery));
  if (combined.length > 0) return combined;
  if (strict.length > 0) return strict;
  const printerOnly = item.files.filter((f) => fileMatchesPrinter(f, printerSet));
  return printerOnly.length > 0 ? printerOnly : item.files;
}
function filesMatchingPrinterAndTime(item, printerSet) {
  const strict = item.files.filter((f) => fileMatchesPrinterAndTime(f, printerSet));
  if (strict.length > 0) return strict;
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
// what a tag pill represents. The print-time limit is folded in for
// the same reason as the printer filter and keyword: render() applies
// it, so the count has to as well.
function countItemsForTag(items, printerSet, tagValue, query, limitMinutes) {
  let total = 0;
  for (const item of items) {
    if (!(item.tags || []).includes(tagValue)) continue;
    if (!itemMatchesPrinter(item, printerSet)) continue;
    if (!itemMatchesPrintTime(item, printerSet, limitMinutes)) continue;
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
// Print Time sidebar section: "under" a maximum only (no minimum, no
// range) -- a single-select radio group like the tag list, with "Any
// length" as the reset option, four presets, and a last "custom" row
// with number-only hours/minutes fields (buildCustomPrintTimeRow).
// Rendered once at startup (renderer.js's init()) rather than on every
// catalog update: it has nothing catalog-derived to refresh, and
// rebuilding it would tear the custom fields out from under a cursor
// mid-typing. Radio checked-state is left to the browser's native
// radio-group behavior (shared `name`) after that.
const PRINT_TIME_PRESETS = [
  { minutes: 120, label: 'Under 2 hours' },
  { minutes: 60, label: 'Under 1 hour' },
  { minutes: 30, label: 'Under 30 minutes' },
  { minutes: 10, label: 'Under 10 minutes' },
];
const PRINT_TIME_RADIO_NAME = 'print-time-filter-radio';
// Derives state.js's printTimeLimitMinutes from the selected choice
// (+ the custom fields' contents, when custom's the choice). A custom
// selection with both fields empty/zero is "nothing entered yet", not
// a limit of zero minutes that would match nothing.
function recomputePrintTimeLimit() {
  if (printTimeChoice === 'any') {
    printTimeLimitMinutes = null;
  } else if (printTimeChoice === 'custom') {
    const { totalMinutes } = normalizeHoursMinutes(
      customPrintTimeInputs.hours,
      customPrintTimeInputs.minutes
    );
    printTimeLimitMinutes = totalMinutes > 0 ? totalMinutes : null;
  } else {
    printTimeLimitMinutes = parseInt(printTimeChoice, 10);
  }
}
// Called after any change to printTimeChoice/customPrintTimeInputs.
// No-ops when the effective limit didn't actually change (e.g. picking
// custom while its fields are still empty). Going from no limit to a
// limit also switches the sort to Print Time, longest first -- so the
// files closest to the limit without going over land at the top (see
// grid.js's sortKeyForItem) -- but only on that transition: once
// a limit is active, moving between presets or editing the custom time
// leaves whatever sort the person has since chosen alone. Tag counts
// are refreshed too, since they fold the limit in (countItemsForTag).
function onPrintTimeFilterChanged() {
  const previous = printTimeLimitMinutes;
  recomputePrintTimeLimit();
  if (printTimeLimitMinutes === previous) return;

  if (previous == null) {
    sortMode = 'time';
    sortReverse = true;
    renderSortFilter();
  }
  renderTagFilter();
  render();
}
function buildPrintTimeInput(ariaLabel, maxLength, value) {
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.maxLength = maxLength;
  input.placeholder = '0';
  input.value = value;
  input.className = 'print-time-input';
  input.setAttribute('aria-label', ariaLabel);
  // Digits only, not just at typing time: beforeinput stops a typed
  // non-digit before it lands (no flicker), and the input handler
  // scrubs whatever still got through -- pastes, drops -- since
  // beforeinput doesn't reliably carry the inserted text for those.
  input.addEventListener('beforeinput', (e) => {
    if (e.data && /\D/.test(e.data)) e.preventDefault();
  });
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '');
    if (digits !== input.value) input.value = digits;
  });
  return input;
}
// The last row: (o) Under [__]h [__]m. Typing (or just focusing a
// field) selects the custom option and applies whatever's entered as
// you go; the fields are rewritten into normalized form (e.g. 0h 90m
// -> 1h 30m) once focus leaves the row entirely -- not on tabbing from
// the hours field to the minutes field, which would rewrite the
// minutes field out from under the person about to type in it.
function buildCustomPrintTimeRow() {
  const row = document.createElement('div');
  row.className = 'filter-option print-time-custom';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = PRINT_TIME_RADIO_NAME;
  radio.checked = printTimeChoice === 'custom';
  radio.setAttribute('aria-label', 'Custom print time limit');
  row.appendChild(radio);

  const prefix = document.createElement('span');
  prefix.className = 'print-time-unit';
  prefix.textContent = 'Under';
  row.appendChild(prefix);

  const hoursInput = buildPrintTimeInput('Custom limit, hours', 2, customPrintTimeInputs.hours);
  row.appendChild(hoursInput);
  const hoursUnit = document.createElement('span');
  hoursUnit.className = 'print-time-unit';
  hoursUnit.textContent = 'h';
  row.appendChild(hoursUnit);

  const minutesInput = buildPrintTimeInput('Custom limit, minutes', 3, customPrintTimeInputs.minutes);
  row.appendChild(minutesInput);
  const minutesUnit = document.createElement('span');
  minutesUnit.className = 'print-time-unit';
  minutesUnit.textContent = 'm';
  row.appendChild(minutesUnit);

  const activateCustom = () => {
    customPrintTimeInputs = { hours: hoursInput.value, minutes: minutesInput.value };
    if (printTimeChoice !== 'custom') {
      printTimeChoice = 'custom';
      radio.checked = true;
    }
    onPrintTimeFilterChanged();
  };
  const normalizeInputs = () => {
    const { totalMinutes, hours, minutes } = normalizeHoursMinutes(
      hoursInput.value,
      minutesInput.value
    );
    // Zero/empty isn't a usable limit -- clear both fields back to
    // their blank placeholders rather than leave a stray "0h 0m".
    hoursInput.value = totalMinutes > 0 ? String(hours) : '';
    minutesInput.value = totalMinutes > 0 ? String(minutes) : '';
    customPrintTimeInputs = { hours: hoursInput.value, minutes: minutesInput.value };
    onPrintTimeFilterChanged();
  };

  radio.addEventListener('change', () => {
    activateCustom();
    hoursInput.focus();
  });
  for (const input of [hoursInput, minutesInput]) {
    input.addEventListener('focus', activateCustom);
    input.addEventListener('input', activateCustom);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur(); // -> focusout below does the normalizing
      }
    });
  }
  row.addEventListener('focusout', (e) => {
    if (row.contains(e.relatedTarget)) return;
    normalizeInputs();
  });

  return row;
}
function renderPrintTimeFilter() {
  const el = document.getElementById('print-time-filter');
  if (!el) return;
  el.innerHTML = '';

  el.appendChild(
    buildFilterOptionRow({
      type: 'radio',
      name: PRINT_TIME_RADIO_NAME,
      checked: printTimeChoice === 'any',
      labelText: 'Any length',
      onChange: () => {
        printTimeChoice = 'any';
        onPrintTimeFilterChanged();
      },
    })
  );
  for (const preset of PRINT_TIME_PRESETS) {
    el.appendChild(
      buildFilterOptionRow({
        type: 'radio',
        name: PRINT_TIME_RADIO_NAME,
        checked: printTimeChoice === String(preset.minutes),
        labelText: preset.label,
        onChange: () => {
          printTimeChoice = String(preset.minutes);
          onPrintTimeFilterChanged();
        },
      })
    );
  }
  el.appendChild(buildCustomPrintTimeRow());
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
      const count = countItemsForTag(allItems, effective, tag, keywordQuery, printTimeLimitMinutes);
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
