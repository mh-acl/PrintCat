'use strict';

// "Print This" button handling -- USB state detection, save, and the
// post-save eject flow.
// Depends on: dialogs.js.

async function handlePrintClick(file) {
  const drives = await window.catalogAPI.listDrives();

  if (drives.length === 0) {
    await showMessageDialog('No USB drive detected. Plug one in and try again.');
    return;
  }

  const drive = drives.length === 1 ? drives[0] : await pickDrive(drives);
  if (!drive) return; // cancelled the picker

  const confirmed = await showConfirmDialog(`Save "${file.shortname}" to "${drive.name}"?`, {
    confirmLabel: 'Save',
  });
  if (!confirmed) return;

  try {
    // The drive is shared with everyone else at the makerspace and may
    // already have a same-named file on it -- saveFileToDrive picks a
    // non-colliding name (see uniqueFilename.js) and reports back
    // whatever name it actually used, which can differ from
    // file.shortname.
    const saved = await window.catalogAPI.saveFileToDrive(file.path, drive.mountPoint);
    const choice = await showActionDialog(
      `Saved "${saved.name}" to "${drive.name}".`,
      [
        { label: 'Keep Browsing', value: 'continue' },
        { label: 'Eject Drive', value: 'eject', className: 'eject' },
      ],
      { escapeValue: 'continue' }
    );

    if (choice === 'eject') {
      try {
        await window.catalogAPI.ejectDrive(drive.diskIdentifier);
        await showEjectSafeDialog(
          `"${drive.name}" has been ejected -- it's safe to unplug now.`,
          drive.diskIdentifier
        );
      } catch (err) {
        await showMessageDialog(`Couldn't eject the drive: ${err.message}`);
      }
    }
  } catch (err) {
    await showMessageDialog(`Couldn't save the file: ${err.message}`);
  }
}
