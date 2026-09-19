'use strict';

// Generic modal-dialog helpers built on the shared .modal-overlay/
// .modal-box shell (see styles.css) -- Escape-to-close wiring,
// the USB drive picker, and the message/confirm/action/eject dialogs
// reused across the USB flow and elsewhere.
// Depends on: nothing else in renderer/ (self-contained).

// Dismissal pattern shared by every dialog below (drive picker, action
// dialog, eject-safe dialog, message/confirm dialogs): the explicit
// button(s) plus Escape, but deliberately NOT click-on-backdrop -- these
// all sit in the middle of the "save/eject a USB drive" flow, where an
// accidental dismissal is more disruptive than in something like the
// image lightbox. attachEscapeHandler wires Escape to whatever the
// dialog's own "safe default" resolution is and returns a cleanup
// function each dialog's own finish/close path should call.
function attachEscapeHandler(onEscape) {
  const onKeydown = (e) => {
    if (e.key === 'Escape') onEscape();
  };
  document.addEventListener('keydown', onKeydown);
  return () => document.removeEventListener('keydown', onKeydown);
}
// Background-scroll lock for overlay modals whose backdrop shows the
// still-intact main view behind them (currently just the item modal --
// the USB dialogs above don't need this since they're shown over an
// already-static admin flow). Without this, scrolling the mouse past
// the edge of the modal box bubbles the wheel event up to the page,
// scrolling the dimmed grid behind it.
//
// Counted rather than a plain boolean, so nested/overlapping callers
// (e.g. the item modal's own origin-info popup, itself a .modal-overlay
// on top of the item modal) can each lock/unlock independently without
// the inner one's unlock prematurely re-enabling scroll while the outer
// modal is still open. `overflow: hidden` on body specifically (not
// html) is deliberate -- per the CSS spec, a body with non-'visible'
// overflow has that value propagate up to become the viewport's actual
// scrolling behavior, which is what actually stops the page from
// scrolling here since body itself has no set height to scroll within.
let scrollLockCount = 0;
function lockBackgroundScroll() {
  if (scrollLockCount === 0) document.body.classList.add('scroll-locked');
  scrollLockCount++;
}
function unlockBackgroundScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) document.body.classList.remove('scroll-locked');
}
// Shown only when more than one USB drive is plugged in at once.
// Resolves to the chosen drive, or null if the user cancels (via the
// Cancel button or Escape).
function pickDrive(drives) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box';

    const title = document.createElement('h3');
    title.textContent = 'Choose a USB drive';
    box.appendChild(title);

    const detachEscape = attachEscapeHandler(() => finish(null));
    const finish = (result) => {
      detachEscape();
      document.body.removeChild(overlay);
      resolve(result);
    };

    for (const drive of drives) {
      const btn = document.createElement('button');
      btn.textContent = `${drive.name} (${drive.mountPoint})`;
      btn.onclick = () => finish(drive);
      box.appendChild(btn);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => finish(null);
    box.appendChild(cancelBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
// A generic "message + a few buttons" modal -- used for the
// continue-browsing-or-eject choice after a save completes. Resolves to
// whichever action's `value` was clicked. `escapeValue`, if given, is
// the action value Escape resolves to (the caller's "safe default", e.g.
// "keep browsing" rather than "eject") -- if omitted, Escape does
// nothing, since a dialog with no safe default shouldn't guess which
// choice was meant.
function showActionDialog(message, actions, { escapeValue } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box';

    const text = document.createElement('p');
    text.textContent = message;
    box.appendChild(text);

    const detachEscape = attachEscapeHandler(() => {
      if (escapeValue !== undefined) finish(escapeValue);
    });
    const finish = (value) => {
      detachEscape();
      document.body.removeChild(overlay);
      resolve(value);
    };

    for (const action of actions) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      if (action.className) btn.className = action.className;
      btn.onclick = () => finish(action.value);
      box.appendChild(btn);
    }

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
// Shown after a successful eject. Auto-closes once the drive is
// physically removed (polling, since diskutil eject already unmounted
// the volume -- we're watching for the whole disk to vanish from the
// external-disk list). The Dismiss button and Escape both close it
// manually in case detection ever misses for some reason.
function showEjectSafeDialog(message, diskIdentifier) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box';

    const text = document.createElement('p');
    text.textContent = message;
    box.appendChild(text);

    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    box.appendChild(dismissBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let pollTimer = null;
    const detachEscape = attachEscapeHandler(() => close());
    const close = () => {
      clearInterval(pollTimer);
      detachEscape();
      if (overlay.parentNode) document.body.removeChild(overlay);
      resolve();
    };

    dismissBtn.onclick = close;

    pollTimer = setInterval(async () => {
      const stillPresent = await window.catalogAPI.isDrivePresent(diskIdentifier);
      if (!stillPresent) close();
    }, 1000);
  });
}
// Styled replacement for the native alert() -- a single-button "OK"
// info dialog. Button + Escape, no click-on-backdrop (see
// attachEscapeHandler above).
function showMessageDialog(message, buttonLabel = 'OK') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box';

    const text = document.createElement('p');
    text.textContent = message;
    box.appendChild(text);

    const detachEscape = attachEscapeHandler(() => finish());
    const finish = () => {
      detachEscape();
      document.body.removeChild(overlay);
      resolve();
    };

    const okBtn = document.createElement('button');
    okBtn.textContent = buttonLabel;
    okBtn.onclick = finish;
    box.appendChild(okBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    okBtn.focus();
  });
}
// Styled replacement for the native confirm() -- resolves true/false.
// Button + Escape (Escape = Cancel), no click-on-backdrop.
function showConfirmDialog(message, { confirmLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box';

    const text = document.createElement('p');
    text.textContent = message;
    box.appendChild(text);

    const detachEscape = attachEscapeHandler(() => finish(false));
    const finish = (value) => {
      detachEscape();
      document.body.removeChild(overlay);
      resolve(value);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.onclick = () => finish(false);
    box.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.onclick = () => finish(true);
    box.appendChild(confirmBtn);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}

// Auto-update progress modal. Driven entirely by 'update:progress'
// pushes from autoUpdate.js (registered in renderer.js's init()) rather
// than by a caller awaiting it like the dialogs above: it appears on the
// first push after the person accepts an update, tracks the download
// (determinate bar) and the unzip/finishing steps (indeterminate bar),
// and stays up until either the app quits or a failure push ('closed')
// hands off to the native error dialog. Deliberately has no buttons and
// no Escape/backdrop dismissal -- there's nothing safe to cancel once
// the download is underway -- and marks everything else on the page
// `inert` so the keyboard can't reach the dimmed UI behind it either.
// Idempotent: any push creates the modal if it isn't already showing,
// so a renderer that (re)loaded mid-update just picks it up from the
// next event.
let updateProgressModal = null;

function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function showUpdateProgressModal() {
  if (updateProgressModal) return updateProgressModal;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay update-progress-overlay';

  const box = document.createElement('div');
  box.className = 'modal-box update-progress-box';
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-labelledby', 'update-progress-title');
  box.tabIndex = -1;

  const title = document.createElement('h3');
  title.id = 'update-progress-title';
  title.textContent = 'Updating Print Catalog';
  box.appendChild(title);

  const status = document.createElement('p');
  status.className = 'update-progress-status';
  status.setAttribute('aria-live', 'polite');
  box.appendChild(status);

  const track = document.createElement('div');
  track.className = 'update-progress-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'update-progress-fill';
  track.appendChild(fill);
  box.appendChild(track);

  const detail = document.createElement('p');
  detail.className = 'update-progress-detail';
  box.appendChild(detail);

  overlay.appendChild(box);

  // Everything already on the page (main view, any open item modal)
  // goes inert; remembered so hide restores exactly what this set.
  const inertedElements = [];
  for (const el of Array.from(document.body.children)) {
    if (!el.inert) {
      el.inert = true;
      inertedElements.push(el);
    }
  }

  document.body.appendChild(overlay);
  lockBackgroundScroll();
  box.focus();

  updateProgressModal = { overlay, status, track, fill, detail, inertedElements };
  return updateProgressModal;
}

function hideUpdateProgressModal() {
  if (!updateProgressModal) return;
  const { overlay, inertedElements } = updateProgressModal;
  updateProgressModal = null;
  for (const el of inertedElements) el.inert = false;
  if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  unlockBackgroundScroll();
}

// `update` is autoUpdate.js's push payload: { stage, version, and (for
// 'downloading') receivedBytes/totalBytes }.
function handleUpdateProgress(update) {
  if (!update) return;
  if (update.stage === 'closed') {
    hideUpdateProgressModal();
    return;
  }

  const modal = showUpdateProgressModal();
  const setDeterminate = (percent) => {
    modal.track.classList.remove('indeterminate');
    modal.track.setAttribute('aria-valuenow', String(percent));
    modal.fill.style.width = `${percent}%`;
  };
  const setIndeterminate = () => {
    modal.track.classList.add('indeterminate');
    modal.track.removeAttribute('aria-valuenow');
    modal.fill.style.width = '';
  };

  if (update.stage === 'downloading') {
    modal.status.textContent = `Downloading Print Catalog v${update.version}\u2026`;
    const received = update.receivedBytes || 0;
    if (update.totalBytes) {
      const percent = Math.min(100, Math.floor((received / update.totalBytes) * 100));
      setDeterminate(percent);
      modal.detail.textContent =
        `${percent}% \u2014 ${formatMegabytes(received)} of ${formatMegabytes(update.totalBytes)} MB`;
    } else {
      // No Content-Length from the server -- can't show a real
      // percentage, so fall back to an indeterminate bar with a running
      // byte count (blank until the first bytes arrive).
      setIndeterminate();
      modal.detail.textContent = received > 0 ? `${formatMegabytes(received)} MB downloaded` : '';
    }
  } else if (update.stage === 'unzipping') {
    modal.status.textContent = 'Unzipping update\u2026';
    setIndeterminate();
    modal.detail.textContent = 'This can take a few seconds.';
  } else if (update.stage === 'finishing') {
    modal.status.textContent = 'Closing Print Catalog to finish installing\u2026';
    setIndeterminate();
    modal.detail.textContent = 'macOS will ask for an administrator password next.';
  }
}
