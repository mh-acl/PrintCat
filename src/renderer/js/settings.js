'use strict';

// Admin settings dialog (Printer / Data Repository / Export-Import
// tabs) plus the first-run required-setup dialog, and the tag-chip
// input component (also reused by itemModal.js's tag editor).
// Depends on: state.js, utils.js, dialogs.js.

// A labeled single-line text input for the settings dialog. Returns
// the wrapping element (to append) and the input itself (to read back
// on Save).
function createSettingsTextField(labelText, value, placeholder) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-field';

  const label = document.createElement('label');
  label.className = 'settings-field-label';
  label.textContent = labelText;
  wrap.appendChild(label);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'settings-text-input';
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  wrap.appendChild(input);

  return { wrap, input };
}
// Chip-based tag input for the item editor -- replaces the old bare
// comma-separated text field. Two goals drove the design: (1) don't
// let a typo silently fork a new tag ("prnt" vs "print"), and (2)
// make it fast to find the tag you already mean rather than retyping
// it. getAllTags is a function (not a static array) so the dropdown
// always reflects the catalog's current tag vocabulary, including any
// tag created earlier in this same editing session.
//
// Existing tags matching the typed text are offered as ordinary
// suggestions; committing one (click, or Enter/ArrowKeys+Enter) never
// creates anything. A tag that doesn't match anything existing only
// appears as a distinctly-styled "+ Create new tag" suggestion, which
// requires being explicitly selected -- plain Enter with nothing typed
// does nothing, and comma only commits an exact existing match, never
// a new tag, so a mistyped tag followed by a comma doesn't quietly
// mint a near-duplicate.
function createTagInput(labelText, initialTags, getAllTags) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-field tag-input-field';

  const label = document.createElement('label');
  label.className = 'settings-field-label';
  label.textContent = labelText;
  wrap.appendChild(label);

  const box = document.createElement('div');
  box.className = 'tag-input-box';
  wrap.appendChild(box);

  const chipList = document.createElement('div');
  chipList.className = 'tag-chip-list';
  box.appendChild(chipList);

  // The typing input and its dropdown live in their own small
  // relatively-positioned wrapper (rather than the dropdown being
  // absolutely positioned against the whole field). That's what lets
  // the dropdown hang directly below the input itself -- sized to its
  // own content -- instead of stretching to cover the full width of
  // the field and everything below it.
  const inputWrap = document.createElement('div');
  inputWrap.className = 'tag-input-inline';
  box.appendChild(inputWrap);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-input-text';
  input.placeholder = '+Tag'; // short on purpose -- anything longer overflows the chip-sized box
  input.size = 1; // overridden per-keystroke below; keeps the initial box small
  inputWrap.appendChild(input);

  const dropdown = document.createElement('div');
  dropdown.className = 'tag-suggestion-dropdown';
  dropdown.style.display = 'none';
  inputWrap.appendChild(dropdown);

  // Each tag is {value, isNew}. isNew marks a tag that didn't already
  // exist in the catalog when it was added in this session -- i.e. one
  // that saving will actually create -- so its chip can stay visually
  // flagged (amber/caution) versus an ordinary recognized tag (blue),
  // even after the dropdown has closed. Tags the item already had are
  // never "new" regardless of what's in the catalog right now.
  let tags = [...new Set((initialTags || []).map((t) => t.trim()).filter(Boolean))].map((value) => ({
    value,
    isNew: false,
  }));
  let suggestions = []; // [{kind: 'existing'|'create', value}]
  let highlightIndex = -1;

  function growInputToContent() {
    input.style.width = Math.max(4, input.value.length + 1) + 'ch';
  }

  function renderChips() {
    chipList.innerHTML = '';
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip' + (tag.isNew ? ' tag-chip-new' : ' tag-chip-existing');
      if (tag.isNew) chip.title = 'New tag -- will be created when you save';

      const text = document.createElement('span');
      text.textContent = tag.value;
      chip.appendChild(text);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-chip-remove icon icon-close';
      remove.title = `Remove tag "${tag.value}"`;
      remove.setAttribute('aria-label', `Remove tag ${tag.value}`);
      remove.onclick = () => {
        tags = tags.filter((t) => t !== tag);
        renderChips();
        input.focus();
      };
      chip.appendChild(remove);

      chipList.appendChild(chip);
    }
  }

  function closeDropdown() {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    suggestions = [];
    highlightIndex = -1;
  }

  function commitTag(value, isNew) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!tags.some((t) => t.value.toLowerCase() === trimmed.toLowerCase())) {
      tags.push({ value: trimmed, isNew: Boolean(isNew) });
      renderChips();
    }
    input.value = '';
    growInputToContent();
    closeDropdown();
    input.focus();
  }

  // Rebuilds `suggestions` from the current input text. With nothing
  // typed, this shows a handful of existing tags to browse (so the
  // field doubles as a quick picker even before typing) rather than an
  // empty dropdown.
  //
  // The trailing row is one of three things: nothing (query is empty),
  // "+ Create" (query doesn't match any catalog tag at all), or
  // "Already tagged" (query exactly matches a tag this item already
  // has -- checked against `tags`, not just the catalog, so retyping
  // an already-added tag doesn't get offered back as something new to
  // create).
  function updateSuggestions() {
    const query = input.value.trim().toLowerCase();
    const catalogTags = getAllTags();
    const available = catalogTags.filter(
      (t) => !tags.some((existing) => existing.value.toLowerCase() === t.toLowerCase())
    );

    let filtered;
    if (!query) {
      filtered = available.slice(0, 8);
    } else {
      filtered = available
        .filter((t) => t.toLowerCase().includes(query))
        .sort((a, b) => {
          const aPrefix = a.toLowerCase().startsWith(query) ? 0 : 1;
          const bPrefix = b.toLowerCase().startsWith(query) ? 0 : 1;
          if (aPrefix !== bPrefix) return aPrefix - bPrefix;
          return a.localeCompare(b);
        });
    }

    suggestions = filtered.map((t) => ({ kind: 'existing', value: t }));

    if (query) {
      const alreadyAdded = tags.some((t) => t.value.toLowerCase() === query);
      if (alreadyAdded) {
        suggestions.push({ kind: 'already-added', value: input.value.trim() });
      } else if (!catalogTags.some((t) => t.toLowerCase() === query)) {
        suggestions.push({ kind: 'create', value: input.value.trim() });
      }
    }

    renderDropdown();
  }

  function renderDropdown() {
    dropdown.innerHTML = '';
    if (suggestions.length === 0) {
      dropdown.style.display = 'none';
      highlightIndex = -1;
      return;
    }
    if (highlightIndex < 0 || highlightIndex >= suggestions.length) highlightIndex = 0;

    suggestions.forEach((s, i) => {
      const row = document.createElement('div');
      row.className =
        'tag-suggestion' +
        (s.kind === 'create' ? ' tag-suggestion-create' : '') +
        (s.kind === 'already-added' ? ' tag-suggestion-info' : '') +
        (i === highlightIndex ? ' active' : '');
      if (s.kind === 'create') row.textContent = `+ Create \u201c${s.value}\u201d`;
      else if (s.kind === 'already-added') row.textContent = `Already tagged \u201c${s.value}\u201d`;
      else row.textContent = s.value;
      // mousedown (not click) + preventDefault so this fires before the
      // input's blur would otherwise tear the dropdown down. Committing
      // an 'already-added' value is a harmless no-op in commitTag (it's
      // already in `tags`) -- this just clears the draft, same as
      // dismissing it.
      row.onmousedown = (e) => {
        e.preventDefault();
        commitTag(s.value, s.kind === 'create');
      };
      dropdown.appendChild(row);
    });
    dropdown.style.display = '';
  }

  input.addEventListener('input', () => {
    highlightIndex = -1;
    growInputToContent();
    updateSuggestions();
  });

  input.addEventListener('focus', () => updateSuggestions());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      highlightIndex = (highlightIndex + 1) % suggestions.length;
      renderDropdown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestions.length === 0) return;
      highlightIndex = (highlightIndex - 1 + suggestions.length) % suggestions.length;
      renderDropdown();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestions.length > 0 && highlightIndex >= 0) {
        const s = suggestions[highlightIndex];
        commitTag(s.value, s.kind === 'create');
      }
    } else if (e.key === 'Tab') {
      // Tab only takes over when there's actually a draft in progress --
      // an empty box lets Tab do its normal job of moving focus to the
      // next field. With a draft present, treat it the same as Enter
      // (commit the highlighted suggestion) rather than tabbing away and
      // silently discarding what was typed.
      if (input.value.trim() && suggestions.length > 0 && highlightIndex >= 0) {
        e.preventDefault();
        const s = suggestions[highlightIndex];
        commitTag(s.value, s.kind === 'create');
      }
    } else if (e.key === ',') {
      e.preventDefault();
      // Comma is a fast "commit this exact tag" key, but deliberately
      // never creates one -- only an existing tag matching the typed
      // text (case-insensitively) commits here.
      const query = input.value.trim().toLowerCase();
      if (!query) return;
      const match = getAllTags().find((t) => t.toLowerCase() === query);
      if (match) commitTag(match, false);
    } else if (e.key === 'Escape') {
      closeDropdown();
    } else if (e.key === 'Backspace' && input.value === '' && tags.length > 0) {
      tags = tags.slice(0, -1);
      renderChips();
    }
  });

  input.addEventListener('blur', () => {
    // Short delay rather than acting immediately: guards against
    // browsers/platforms where a dropdown-row click still fires blur
    // before its own mousedown handler runs -- that handler calls
    // commitTag(), which clears the draft and refocuses the input
    // itself, so by the time this timeout fires, document.activeElement
    // is back on `input` and there's nothing left to discard.
    //
    // Otherwise, focus genuinely moved elsewhere (another field, tab
    // navigation) -- discard whatever partial tag text was left
    // in-progress, rather than leaving an orphaned draft chip behind.
    setTimeout(() => {
      if (document.activeElement !== input) {
        input.value = '';
        growInputToContent();
      }
      closeDropdown();
    }, 150);
  });

  renderChips();
  growInputToContent();

  return { wrap, getTags: () => tags.map((t) => t.value) };
}
// "Auto-refresh every: [n] [minutes/hours/days]" -- a plain
// number+unit picker rather than a specialized duration control, since
// nothing fancier is available in a bare HTML/Electron view. The
// number input and unit select are disabled together whenever the
// checkbox is unchecked, so it's visually clear they're inert without
// needing to remove them from the layout. Uses the class 'settings-field-line'
// to compactify the whole thing into one line, rather than spread over two.
function createAutoRefreshField(settings) {
  const wrap = document.createElement('div');
  wrap.className = 'settings-field-line';

  const checkboxRow = document.createElement('label');
  checkboxRow.className = 'settings-checkbox-row';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = settings.autoRefreshEnabled;
  checkboxRow.appendChild(checkbox);
  checkboxRow.appendChild(document.createTextNode(' Auto-refresh every:'));
  wrap.appendChild(checkboxRow);

  const pickerRow = document.createElement('div');
  pickerRow.className = 'settings-auto-refresh-row';

  const numberInput = document.createElement('input');
  numberInput.type = 'number';
  numberInput.min = '1';
  numberInput.step = '1';
  numberInput.className = 'settings-number-input';
  numberInput.value = settings.autoRefreshValue || 2;
  pickerRow.appendChild(numberInput);

  const unitSelect = document.createElement('select');
  unitSelect.className = 'settings-unit-select';
  for (const unit of ['minutes', 'hours', 'days']) {
    const opt = document.createElement('option');
    opt.value = unit;
    opt.textContent = unit;
    unitSelect.appendChild(opt);
  }
  unitSelect.value = settings.autoRefreshUnit || 'hours';
  pickerRow.appendChild(unitSelect);

  wrap.appendChild(pickerRow);

  const syncDisabledState = () => {
    numberInput.disabled = !checkbox.checked;
    unitSelect.disabled = !checkbox.checked;
  };
  syncDisabledState();
  checkbox.addEventListener('change', syncDisabledState);

  return { wrap, checkbox, numberInput, unitSelect };
}

// Tab definitions for the (non-required) settings dialog. Kept as a
// flat list so adding a 4th/5th tab later (USB Wiper settings, a
// Tools-menu show/hide tab -- both still planned) is just appending an
// entry here, with no changes needed to the tab bar or panel-switching
// logic in openSettingsDialog() below. Each build() gets the
// (already-attached) panel element plus a shared ctx ({ allPrinters,
// overlay } -- overlay lets the Export/Import tab close and reopen the
// dialog after an import) and returns whatever handles the shared Save
// button needs to read back out of it at save time (an empty object
// for tabs, like Export/Import, that don't feed Save).
const SETTINGS_TABS = [
  { id: 'printer', label: 'Printer', build: (panel, ctx) => buildPrinterTabPanel(panel, ctx.allPrinters) },
  { id: 'data', label: 'Data Repository', build: (panel) => buildDataRepoTabPanel(panel) },
  { id: 'export-import', label: 'Export / Import', build: (panel, ctx) => buildExportImportTabPanel(panel, ctx.overlay) },
];
function buildPrinterTabPanel(panel, allPrinters) {
  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = 'Choose which printers this makerspace actually has.';
  panel.appendChild(intro);

  const checkboxEls = new Map();

  if (allPrinters.length === 0) {
    const none = document.createElement('p');
    none.className = 'settings-intro';
    none.textContent = 'No printers found in the catalog yet.';
    panel.appendChild(none);
  } else {
    for (const printer of allPrinters) {
      const row = document.createElement('label');
      row.className = 'settings-checkbox-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = settings.availablePrinters.includes(printer);
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + printer));
      panel.appendChild(row);
      checkboxEls.set(printer, cb);
    }
  }

  panel.appendChild(document.createElement('hr'));

  const hideRow = document.createElement('label');
  hideRow.className = 'settings-checkbox-row';
  const hideCb = document.createElement('input');
  hideCb.type = 'checkbox';
  hideCb.checked = settings.hideUnavailable;
  hideRow.appendChild(hideCb);
  hideRow.appendChild(document.createTextNode(' Hide unavailable printers'));
  panel.appendChild(hideRow);

  return { checkboxEls, hideCb };
}
function buildDataRepoTabPanel(panel) {
  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = "The git repository this makerspace's catalog data lives in.";
  panel.appendChild(intro);

  const repoField = createSettingsTextField(
    'Git Repository:',
    settings.gitRepoUrl,
    'https://github.com/example/catalog-data.git'
  );
  panel.appendChild(repoField.wrap);

  const branchField = createSettingsTextField('Branch:', settings.gitBranch, 'main');
  panel.appendChild(branchField.wrap);

  panel.appendChild(document.createElement('hr'));

  const autoRefreshField = createAutoRefreshField(settings);
  panel.appendChild(autoRefreshField.wrap);

  return { repoField, branchField, autoRefreshField };
}
// Export writes the current settings (plus, optionally, the GitHub
// sync token) to a JSON file the admin picks; import reads one back
// and applies it. All the actual file I/O and token handling happens
// in main.js (settings:export/settings:import/settings:confirmImportToken)
// -- this just drives the two admin-facing confirms and reflects the
// result. The token itself never passes through this function or any
// other renderer code: settings:export reads it directly into the
// exported file in the main process, and settings:import holds a
// just-read token back in the main process (pendingImportToken) until
// settings:confirmImportToken says whether to write it, so the only
// thing this code ever sees is a plain `hasToken` boolean.
//
// This tab doesn't feed the shared Save button (nothing here is a
// pending field to save -- export/import both act immediately), so it
// returns {} rather than field handles.
function buildExportImportTabPanel(panel, overlay) {
  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = 'Save these settings to a file, or load them from one -- handy when setting up a new laptop.';
  panel.appendChild(intro);

  const exportLabel = document.createElement('div');
  exportLabel.className = 'settings-field-label';
  exportLabel.textContent = 'Export';
  panel.appendChild(exportLabel);

  const tokenRow = document.createElement('label');
  tokenRow.className = 'settings-checkbox-row';
  const tokenCb = document.createElement('input');
  tokenCb.type = 'checkbox';
  tokenRow.appendChild(tokenCb);
  tokenRow.appendChild(document.createTextNode(' Include GitHub sync token (requires admin authorization)'));
  panel.appendChild(tokenRow);

  const exportStatus = document.createElement('p');
  exportStatus.className = 'settings-intro settings-export-import-status';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'settings-action-button';
  exportBtn.textContent = 'Export Settings…';
  exportBtn.onclick = async () => {
    exportStatus.textContent = '';
    try {
      const result = await window.catalogAPI.exportSettings({ includeToken: tokenCb.checked });
      if (result.cancelled) return;
      exportStatus.textContent = result.includedToken
        ? `Exported (with sync token) to ${result.path}`
        : `Exported to ${result.path}`;
    } catch (err) {
      exportStatus.textContent = `Export failed: ${err.message}`;
    }
  };
  panel.appendChild(exportBtn);
  panel.appendChild(exportStatus);

  panel.appendChild(document.createElement('hr'));

  const importLabel = document.createElement('div');
  importLabel.className = 'settings-field-label';
  importLabel.textContent = 'Import';
  panel.appendChild(importLabel);

  const importIntro = document.createElement('p');
  importIntro.className = 'settings-intro';
  importIntro.textContent = 'Importing overwrites the settings above with values from the chosen file.';
  panel.appendChild(importIntro);

  const importStatus = document.createElement('p');
  importStatus.className = 'settings-intro settings-export-import-status';

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'settings-action-button';
  importBtn.textContent = 'Import Settings…';
  importBtn.onclick = async () => {
    importStatus.textContent = '';
    if (!confirm('Import settings from a file? This replaces the current settings shown in this dialog.')) return;

    try {
      const result = await window.catalogAPI.importSettings();
      if (result.cancelled) return;

      settings = result.settings;

      let tokenImported = false;
      if (result.hasToken) {
        const wantsToken = confirm(
          "This file includes a GitHub sync token. Import it too?\n\nThis overwrites this laptop's current sync token and requires admin authorization."
        );
        const tokenResult = await window.catalogAPI.confirmImportToken(wantsToken);
        tokenImported = Boolean(tokenResult && tokenResult.ok);
      }

      importStatus.textContent = tokenImported ? 'Settings and sync token imported.' : 'Settings imported.';

      // Re-derive the active printer filter and rebuild the dialog from
      // scratch so every tab (printer checkboxes, repo fields, etc.)
      // reflects the just-imported values immediately, rather than
      // requiring the admin to close and reopen it to see them.
      applyDefaultPrinterFilter();
      renderPrinterFilter();
      renderTagFilter();
      render();
      document.body.removeChild(overlay);
      openSettingsDialog();

      if (result.needsRestart) {
        const restartNow = confirm(
          'Git repository settings changed. Print Catalog needs to restart for this to take effect.\n\nRestart now?'
        );
        if (restartNow) window.catalogAPI.relaunch();
      }
    } catch (err) {
      importStatus.textContent = `Import failed: ${err.message}`;
    }
  };
  panel.appendChild(importBtn);
  panel.appendChild(importStatus);

  return {};
}
// Lets the admin pick which printers this makerspace actually has, and
// whether to hide anything else entirely, plus the git repo/branch to
// sync catalog data from -- organized into tabs (see SETTINGS_TABS
// above) since this dialog is expected to grow more sections over
// time. Saves via IPC (persisted across launches), then re-derives the
// active filter from the new settings so printer changes take effect
// immediately. Git repo/branch changes require a restart (see main.js's
// settings:save handler), since DATA_DIR itself is only resolved once
// at startup.
//
// First-launch setup (opts.required) is handled by the separate,
// non-tabbed openRequiredSetupDialog() below instead of this function --
// see that function's comment for why.
function openSettingsDialog(opts = {}) {
  if (opts.required) {
    openRequiredSetupDialog();
    return;
  }

  const allPrinters = Array.from(collectPrinters(allItems)).sort();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box modal-wide';

  const title = document.createElement('h3');
  title.textContent = 'Settings';
  box.appendChild(title);

  const tabBar = document.createElement('div');
  tabBar.className = 'settings-tabs';
  box.appendChild(tabBar);

  const panelsWrap = document.createElement('div');
  panelsWrap.className = 'settings-tab-panels';
  box.appendChild(panelsWrap);

  const panelEls = {};
  const tabHandles = {};
  const ctx = { allPrinters, overlay };

  SETTINGS_TABS.forEach((tab, i) => {
    const panel = document.createElement('div');
    panel.className = 'settings-tab-panel';
    panel.style.display = i === 0 ? '' : 'none';
    panelsWrap.appendChild(panel);
    panelEls[tab.id] = panel;
    tabHandles[tab.id] = tab.build(panel, ctx);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-tab' + (i === 0 ? ' active' : '');
    btn.textContent = tab.label;
    btn.onclick = () => {
      tabBar.querySelectorAll('.settings-tab').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      Object.values(panelEls).forEach((el) => {
        el.style.display = 'none';
      });
      panel.style.display = '';
    };
    tabBar.appendChild(btn);
  });

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'settings-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.onclick = async () => {
    const { checkboxEls, hideCb } = tabHandles.printer;
    const { repoField, branchField, autoRefreshField } = tabHandles.data;

    const availablePrinters = allPrinters.filter((p) => checkboxEls.get(p).checked);
    // Fall back to 1 for a blank/zero/negative/non-numeric field rather
    // than saving something that'd make scheduleAutoRefresh() (main.js)
    // skip setting up the timer at all.
    const autoRefreshValue = Math.max(1, Math.round(Number(autoRefreshField.numberInput.value)) || 1);

    const { settings: saved, needsRestart } = await window.catalogAPI.saveSettings({
      availablePrinters,
      hideUnavailable: hideCb.checked,
      gitRepoUrl: repoField.input.value.trim(),
      gitBranch: branchField.input.value.trim(),
      autoRefreshEnabled: autoRefreshField.checkbox.checked,
      autoRefreshValue,
      autoRefreshUnit: autoRefreshField.unitSelect.value,
    });
    settings = saved;

    applyDefaultPrinterFilter();
    document.body.removeChild(overlay);
    renderPrinterFilter();
    renderTagFilter();
    render();

    // The git repo/branch feed into DATA_DIR, which is only resolved
    // once at startup (see main.js) -- changing either here can't take
    // effect on a running indexer/watcher, so ask before relaunching.
    if (needsRestart) {
      const restartNow = confirm(
        'Git repository settings changed. Print Catalog needs to restart for this to take effect.\n\nRestart now?'
      );
      if (restartNow) window.catalogAPI.relaunch();
    }
  };
  buttonsRow.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => {
    document.body.removeChild(overlay);
  };
  buttonsRow.appendChild(cancelBtn);

  box.appendChild(buttonsRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}
// First-launch setup when no repo is configured yet. Kept as a
// separate, non-tabbed dialog rather than folded into the tabbed
// openSettingsDialog() above: allItems is always [] at this point
// (init() skips getTree() when there's no repo configured), so there's
// no printer list to show, and no other tab's content would be
// meaningful yet either -- a tab bar with mostly-empty tabs ahead of
// the one field that actually matters here would just be confusing.
function openRequiredSetupDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box modal-wide';

  const title = document.createElement('h3');
  title.textContent = 'Set Up Print Catalog';
  box.appendChild(title);

  const intro = document.createElement('p');
  intro.className = 'settings-intro';
  intro.textContent = "Enter the git repository this makerspace's catalog data lives in to get started.";
  box.appendChild(intro);

  // Setting up a new laptop for a makerspace that already has one
  // configured is the common case -- offer to import a settings file
  // (exported from the Data Repository > Export/Import tab on an
  // existing laptop) instead of re-typing everything by hand. Uses
  // the same settings:import/settings:confirmImportToken IPC calls as
  // the tabbed dialog's import button (see buildExportImportTabPanel
  // above), so token handling follows the identical never-touches-
  // other-renderer-code path.
  const importIntro = document.createElement('p');
  importIntro.className = 'settings-intro';
  importIntro.textContent = 'Already have a settings file from another laptop?';
  box.appendChild(importIntro);

  const importStatus = document.createElement('p');
  importStatus.className = 'settings-intro settings-export-import-status';

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'settings-action-button';
  importBtn.textContent = 'Import Settings…';
  importBtn.onclick = async () => {
    importStatus.textContent = '';
    if (!confirm('Import settings from a file? This replaces the values below with values from the chosen file.')) return;

    try {
      const result = await window.catalogAPI.importSettings();
      if (result.cancelled) return;

      settings = result.settings;

      // Reflect the imported values in the fields below immediately,
      // whether or not we end up relaunching right away.
      repoField.input.value = settings.gitRepoUrl || '';
      branchField.input.value = settings.gitBranch || '';
      autoRefreshField.checkbox.checked = settings.autoRefreshEnabled;
      autoRefreshField.numberInput.value = settings.autoRefreshValue || 2;
      autoRefreshField.unitSelect.value = settings.autoRefreshUnit;

      let tokenImported = false;
      if (result.hasToken) {
        const wantsToken = confirm(
          "This file includes a GitHub sync token. Import it too?\n\nThis overwrites this laptop's current sync token and requires admin authorization."
        );
        const tokenResult = await window.catalogAPI.confirmImportToken(wantsToken);
        tokenImported = Boolean(tokenResult && tokenResult.ok);
      }

      importStatus.textContent = tokenImported ? 'Settings and sync token imported.' : 'Settings imported.';

      // settings:import already persists via settingsStore.save (same
      // as a normal Save), so a usable repo URL means there's nothing
      // left to do here -- relaunch straight away, same as this
      // dialog's own Save button does unconditionally (see its
      // comment below for why no "keep browsing" option is offered).
      // If the import didn't include a repo URL, leave the admin to
      // review/complete the fields below and press Save themselves.
      if (settings.gitRepoUrl) {
        window.catalogAPI.relaunch();
      }
    } catch (err) {
      importStatus.textContent = `Import failed: ${err.message}`;
    }
  };
  box.appendChild(importBtn);
  box.appendChild(importStatus);

  box.appendChild(document.createElement('hr'));

  const repoField = createSettingsTextField(
    'Git Repository:',
    settings.gitRepoUrl,
    'https://github.com/example/catalog-data.git'
  );
  box.appendChild(repoField.wrap);

  const branchField = createSettingsTextField('Branch:', settings.gitBranch, 'main');
  box.appendChild(branchField.wrap);

  box.appendChild(document.createElement('hr'));

  const autoRefreshField = createAutoRefreshField(settings);
  box.appendChild(autoRefreshField.wrap);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'settings-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';
  saveBtn.onclick = async () => {
    const gitRepoUrl = repoField.input.value.trim();

    // Required mode exists only because there's no repo configured --
    // saving without one would just land back in this same dialog on
    // next launch, so refuse instead of silently closing.
    if (!gitRepoUrl) {
      alert('Enter a git repository URL to continue.');
      return;
    }

    const autoRefreshValue = Math.max(1, Math.round(Number(autoRefreshField.numberInput.value)) || 1);

    await window.catalogAPI.saveSettings({
      availablePrinters: settings.availablePrinters || [],
      hideUnavailable: settings.hideUnavailable,
      gitRepoUrl,
      gitBranch: branchField.input.value.trim(),
      autoRefreshEnabled: autoRefreshField.checkbox.checked,
      autoRefreshValue,
      autoRefreshUnit: autoRefreshField.unitSelect.value,
    });

    // Nothing to show until the app relaunches with an indexer set up
    // against the new repo -- no "keep browsing" option makes sense
    // here the way it does for the normal settings dialog, so just
    // relaunch directly rather than asking.
    window.catalogAPI.relaunch();
  };
  buttonsRow.appendChild(saveBtn);

  // No Cancel -- there's nothing to fall back to (canceling out of an
  // unconfigured, empty catalog isn't a real option), so this dialog
  // can only be dismissed by saving.
  box.appendChild(buttonsRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}