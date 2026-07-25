const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const drives = require('./drives');

// Polling cadence, both for detecting a newly-inserted drive and for
// checking whether a finished (done/error) drive has actually been
// physically pulled yet. Matches the poll-based approach already used
// elsewhere in the app for USB state.
const POLL_INTERVAL_MS = 2000;

let win = null;
let pollTimer = null;
let pollBusy = false; // guards against a slow wipe still running when the
                       // next setInterval tick fires
let sessionActive = false;

// Bumped on every start/stop. A wipe cycle captures the generation it
// started under and checks it before writing any shared state back --
// if the session was stopped (or stopped-then-restarted) while a wipe was
// still in flight (e.g. the window lost focus mid-delete), the cycle's
// eventual result is discarded instead of clobbering a newer session's
// state. The underlying delete/eject calls aren't actually cancelled --
// letting a file deletion finish rather than aborting it mid-way is the
// safer failure mode -- this only prevents its *result* from being acted
// on late.
let generation = 0;

// Only one drive is tracked/displayed at a time (single status line +
// single progress bar). `activeDiskId` is set for the whole
// wiping -> unmounting -> done/error span; once set to done/error,
// `awaitingRemovalDiskId` (same id) takes over so we know to poll
// isDiskPresent() instead of listUsbDrives() while waiting for the
// physical unplug that resets everything to idle.
let activeDiskId = null;
let awaitingRemovalDiskId = null;

// Mounted-volume disk-identifier set as of the last poll, used only
// while idle (no active/awaiting-removal drive) to detect a fresh
// insertion by diffing against this.
let previousMountedIds = new Set();

function openUsbWiperWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 480,
    height: 260,
    resizable: false,
    minimizable: false, // sidesteps having to decide whether "minimized"
    fullscreenable: false, // counts as "left the foreground" (see blur handler)
    webPreferences: {
      preload: path.join(__dirname, 'usbWiperPreload.js'),
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(__dirname, 'usbWiperWindow.html'));

  // Precaution required by the feature spec: if this window stops being the
  // foreground window for any reason, drop out of wiping mode automatically.
  // We deliberately do NOT close the window here -- only `stopSession()` plus
  // notifying the renderer so it can reset the button label and status.
  // The user has to explicitly click "Stop Wiping USBs" to dismiss the
  // window itself.
  win.on('blur', () => {
    if (sessionActive) {
      stopSession();
      if (win) {
        win.webContents.send('usb-wiper:session-ended', { reason: 'lost-focus' });
      }
    }
  });

  win.on('closed', () => {
    stopSession();
    win = null;
  });
}

function sendStatus(phase, message) {
  if (win) win.webContents.send('usb-wiper:status', { phase, message });
}

function startSession() {
  if (sessionActive) return;
  sessionActive = true;
  generation += 1;
  activeDiskId = null;
  awaitingRemovalDiskId = null;
  previousMountedIds = new Set();
  sendStatus('idle', 'Insert a drive to wipe it.');
  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
  pollTick();
}

function stopSession() {
  sessionActive = false;
  generation += 1; // invalidates any wipe cycle still in flight -- see note above
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  activeDiskId = null;
  awaitingRemovalDiskId = null;
}

async function pollTick() {
  if (!sessionActive || !win || pollBusy) return;
  pollBusy = true;
  try {
    await pollOnce();
  } finally {
    pollBusy = false;
  }
}

function groupByDisk(driveList) {
  const byDisk = new Map();
  for (const drive of driveList) {
    const volumes = byDisk.get(drive.diskIdentifier) || [];
    volumes.push(drive);
    byDisk.set(drive.diskIdentifier, volumes);
  }
  return byDisk;
}

async function pollOnce() {
  // Case 1: a drive finished (done/error) and we're just waiting for it
  // to be physically unplugged before resetting to idle.
  if (awaitingRemovalDiskId) {
    let present;
    try {
      present = await drives.isDiskPresent(awaitingRemovalDiskId);
    } catch (error) {
      return; // transient diskutil hiccup -- try again next tick
    }
    if (!present) {
      awaitingRemovalDiskId = null;
      activeDiskId = null;
      previousMountedIds = new Set(); // fresh baseline once back to idle
      sendStatus('idle', 'Insert a drive to wipe it.');
    }
    return;
  }

  // Case 2: a wipe/unmount cycle is actively running -- it drives its own
  // status sends and sets awaitingRemovalDiskId when it finishes, so
  // there's nothing to poll for here.
  if (activeDiskId) return;

  // Case 3: idle -- look for a newly-inserted drive.
  let currentDrives;
  try {
    currentDrives = await drives.listUsbDrives();
  } catch (error) {
    return;
  }

  const byDisk = groupByDisk(currentDrives);
  const currentMountedIds = new Set(byDisk.keys());
  const newDiskIds = [...currentMountedIds].filter((id) => !previousMountedIds.has(id));
  previousMountedIds = currentMountedIds;

  if (newDiskIds.length === 0) return;

  // Only one drive is tracked/displayed at a time. If more than one shows
  // up in the same tick (e.g. several drives in a hub, inserted together),
  // the rest are simply picked up on a later tick once this one is done
  // and physically removed -- previousMountedIds already includes them, so
  // they won't be treated as "new" again until unplugged and replugged.
  const diskIdentifier = newDiskIds[0];
  await runWipeCycle(diskIdentifier, byDisk.get(diskIdentifier), generation);
}

async function runWipeCycle(diskIdentifier, volumes, myGeneration) {
  activeDiskId = diskIdentifier;
  sendStatus('wiping', 'Wiping drive\u2026');

  try {
    // Not surfaced separately in this single-status-line UI: a drive that
    // wipes with some leftover files (e.g. permission-protected macOS
    // system files) still ends in "safe to remove" below, same as a fully
    // clean wipe. If that distinction ever needs to be visible, it'd need
    // its own status phase.
    for (const volume of volumes) {
      await drives.wipeDriveContents(volume.mountPoint);
    }

    if (myGeneration !== generation) return; // session stopped/restarted meanwhile

    sendStatus('unmounting', 'Unmounting drive\u2026');
    await drives.ejectDrive(diskIdentifier);

    if (myGeneration !== generation) return;

    sendStatus('done', 'Drive is safe to remove.');
    awaitingRemovalDiskId = diskIdentifier;
  } catch (error) {
    if (myGeneration !== generation) return;
    sendStatus('error', error.message);
    awaitingRemovalDiskId = diskIdentifier;
  }
}

ipcMain.handle('usb-wiper:start-session', () => {
  startSession();
});

ipcMain.handle('usb-wiper:stop-session', () => {
  stopSession();
});

module.exports = { openUsbWiperWindow };
