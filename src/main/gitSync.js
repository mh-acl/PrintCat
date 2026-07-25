const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// A shallow clone of a real catalog (gcode + embedded/override thumbnails,
// possibly source photos) can legitimately take minutes on a slow or
// congested makerspace connection, not seconds -- 30s was too tight and
// caused live syncs to be killed mid-checkout. This is generous on purpose;
// callers can still override it via the timeoutMs option.
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs a git command with a hard timeout so a stalled network (or the
 * macOS command-line-tools install stub) can never hang app startup.
 *
 * Uses spawn({ detached: true }) + killing the whole process group
 * (negative pid) on timeout, rather than execFile's built-in timeout,
 * because killing only git's own pid can leave its transport helper
 * (e.g. the process handling smart-HTTP) running and still writing to
 * .git -- which is exactly the kind of half-written state that then
 * fails to fetch/reset on every subsequent launch. POSIX only (fine --
 * this app is macOS-only elsewhere too, e.g. drives.js).
 */
function run(cmd, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (_) {
            // Process (group) may already be gone -- fine.
          }
        }, timeoutMs)
      : null;

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { stdout, stderr }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          Object.assign(new Error(`Timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`), {
            stdout,
            stderr,
            timedOut: true,
          })
        );
      } else if (code !== 0) {
        reject(
          Object.assign(new Error(`Exit ${code}: ${cmd} ${args.join(' ')}\n${stderr}`), { stdout, stderr, code })
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Empties a directory's contents (creating it if needed) without removing
 * the directory itself, so a caller already watching it (chokidar in
 * main.js) never loses its handle. */
function emptyDirContents(dir) {
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** A quick local check (no network) that targetDir is a working, complete
 * git checkout rather than a partial/interrupted one (e.g. left behind by
 * a previous sync that got killed mid-clone). */
async function isValidRepo(targetDir, timeoutMs) {
  try {
    await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: targetDir, timeoutMs: Math.min(timeoutMs, 5000) });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Syncs `targetDir` to match `branch` on `repoUrl` (public HTTPS, no auth).
 * Always resolves — never throws — so a launch-time sync attempt can
 * never block or crash the app. On any failure the caller should just
 * proceed with whatever is already on disk in targetDir.
 *
 * - No existing clone, or an existing one that fails a local integrity
 *   check, or one whose fetch/reset fails -> falls back to wiping
 *   targetDir's contents and doing a fresh `git clone --depth 1`. This
 *   makes sync self-healing: a clone interrupted by a timeout or a crash
 *   gets fully replaced on the next launch instead of failing forever.
 * - Otherwise -> `fetch` + `reset --hard origin/<branch>` + `clean -fd`,
 *   so local drift (partial writes, stray files, hand edits) is always
 *   discarded in favor of the remote — this is a one-way mirror, not a
 *   two-way sync.
 *
 * @param {object} opts
 * @param {string} opts.repoUrl - HTTPS URL of the public git repo.
 * @param {string} [opts.branch] - Branch to track. Defaults to 'main'.
 * @param {string} opts.targetDir - Absolute path to sync into.
 * @param {number} [opts.timeoutMs] - Per-command timeout. Defaults to 5 minutes.
 * @returns {Promise<{synced: boolean, reason?: string, error?: string}>}
 */
async function syncCatalogRepo({ repoUrl, branch = 'main', targetDir, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!repoUrl) {
    return { synced: false, reason: 'no-repo-configured' };
  }
  if (!targetDir) {
    return { synced: false, reason: 'no-target-dir' };
  }

  const gitDir = path.join(targetDir, '.git');

  try {
    let needsFreshClone = true;

    if (fs.existsSync(gitDir)) {
      if (await isValidRepo(targetDir, timeoutMs)) {
        try {
          await run('git', ['fetch', '--depth', '1', 'origin', branch], { cwd: targetDir, timeoutMs });
          await run('git', ['reset', '--hard', `origin/${branch}`], { cwd: targetDir, timeoutMs });
          await run('git', ['clean', '-fd'], { cwd: targetDir, timeoutMs });
          needsFreshClone = false;
        } catch (err) {
          console.warn(
            '[gitSync] existing clone failed to update, falling back to a fresh clone:',
            err.message
          );
        }
      } else {
        console.warn(
          '[gitSync] existing clone looks incomplete (likely interrupted mid-sync last time), falling back to a fresh clone'
        );
      }
    }

    if (needsFreshClone) {
      emptyDirContents(targetDir); // git clone requires an empty (or nonexistent) destination
      await run('git', ['clone', '--depth', '1', '--branch', branch, repoUrl, targetDir], { timeoutMs });
    }

    return { synced: true };
  } catch (err) {
    // Covers: no internet, git not yet installed (first-run macOS stub
    // just triggers the Install Command Line Tools dialog and returns an
    // error immediately rather than hanging), auth failures, bad branch,
    // timeout, etc. All of these are "skip and continue" cases.
    console.warn('[gitSync] catalog sync skipped, continuing with existing local data:', err.message);
    return { synced: false, reason: 'error', error: err.message };
  }
}

module.exports = { syncCatalogRepo, run };
