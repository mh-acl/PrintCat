'use strict';

// Generic modal-dialog helpers built on the shared .drive-picker-overlay/
// .drive-picker-box shell (see styles.css) -- Escape-to-close wiring,
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
// Shown only when more than one USB drive is plugged in at once.
// Resolves to the chosen drive, or null if the user cancels (via the
// Cancel button or Escape).
function pickDrive(drives) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'drive-picker-overlay';

    const box = document.createElement('div');
    box.className = 'drive-picker-box';

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
    overlay.className = 'drive-picker-overlay';

    const box = document.createElement('div');
    box.className = 'drive-picker-box';

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
    overlay.className = 'drive-picker-overlay';

    const box = document.createElement('div');
    box.className = 'drive-picker-box';

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
    overlay.className = 'drive-picker-overlay';

    const box = document.createElement('div');
    box.className = 'drive-picker-box';

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
    overlay.className = 'drive-picker-overlay';

    const box = document.createElement('div');
    box.className = 'drive-picker-box';

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
