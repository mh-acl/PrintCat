'use strict';

// Bottom edit-session bar (Confirm/Cancel, pending-change counts).
// Depends on: state.js, grid.js (render()).

// The "Add item" button plus the persistent bottom bar showing
// pending-change counts and Confirm/Cancel actions. Rendered fresh
// into #listing on every render() call (append-only, listing.innerHTML
// was already cleared at the top of render()) -- cheap enough given
// how small this is, and keeps it in sync with pendingChanges without
// a separate update path to maintain.
function renderEditBar() {
  const listing = document.getElementById('listing');
  if (!editModeActive) return;

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add item';
  addBtn.className = 'add-item-button';
  addBtn.onclick = () => openItemModal(null, 'add');
  listing.appendChild(addBtn);

  const counts = { add: 0, edit: 0, delete: 0 };
  for (const change of Object.values(pendingChanges)) counts[change.type]++;
  const total = counts.add + counts.edit + counts.delete;

  const bar = document.createElement('div');
  bar.className = 'edit-session-bar';

  const stats = document.createElement('span');
  stats.textContent = `${counts.add} added \u00b7 ${counts.edit} edited \u00b7 ${counts.delete} deleted`;
  bar.appendChild(stats);

  const buttons = document.createElement('div');

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel changes';
  cancelBtn.onclick = async () => {
    if (total > 0 && !confirm('Discard all pending changes?')) return;
    allItems = await window.catalogAPI.editSessionCancel();
    editModeActive = false;
    pendingChanges = {};
    selectedSmartTags = new Set();
    renderPrinterFilter();
    renderTagFilter();
    render();
  };
  buttons.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = `Confirm ${total} change${total === 1 ? '' : 's'}`;
  confirmBtn.disabled = total === 0;
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Pushing\u2026';
    try {
      const result = await window.catalogAPI.editSessionConfirm();
      if (result.cancelled) {
        // Admin backed out of the token/provisioning prompt -- changes
        // are untouched, just re-enable the button.
        confirmBtn.disabled = false;
        confirmBtn.textContent = `Confirm ${total} change${total === 1 ? '' : 's'}`;
        return;
      }
      allItems = result.tree;
      editModeActive = false;
      pendingChanges = {};
      selectedSmartTags = new Set();
      renderPrinterFilter();
      renderTagFilter();
      render();
    } catch (err) {
      // Session stays active on the main-process side (see
      // editSession:confirmSession) so a retry after fixing whatever
      // went wrong (network, auth) just works.
      alert(`Push failed: ${err.message}\n\nYour changes are still staged -- fix the issue and try again.`);
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Confirm ${total} change${total === 1 ? '' : 's'}`;
    }
  };
  buttons.appendChild(confirmBtn);

  bar.appendChild(buttons);
  listing.appendChild(bar);
}
