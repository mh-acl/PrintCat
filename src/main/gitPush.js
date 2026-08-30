'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { run } = require('./gitSync');

// Same limit and reasoning as editSession.js's MAX_FILE_BYTES --
// duplicated rather than imported, same convention that file already
// uses for its own small stable constants (see its GCODE_EXT/IMAGE_EXT
// comment). This is the defensive second check: editSession.js already
// rejects an oversized file before it's ever copied into an item's
// folder, but this catches anything that slips through some other way
// (a file dropped straight into DATA_DIR outside the app, or a future
// caller of pushNewItem that doesn't go through editSession at all) --
// right before the commit that would otherwise bake it into history
// for good.
const MAX_FILE_BYTES = 100 * 1024 * 1024;

// Checks only the files git status --porcelain reports as
// added/modified (i.e. exactly what's about to be committed), not the
// whole working tree -- an already-committed oversized file from
// before this check existed shouldn't block an unrelated item's push.
// Returns { relPath, size } for each offender so the error can name
// them specifically.
async function findOversizedPendingFiles(targetDir, statusOutput, limitBytes) {
  const oversized = [];
  const lines = statusOutput.split('\n').filter((line) => line.trim().length > 0);
  for (const line of lines) {
    // Porcelain v1: two status chars + a space + the path (renames add
    // ` -> newPath`, in which case the new path is what's actually
    // being committed). Quoted paths (unusual filenames) get their
    // surrounding quotes stripped on a best-effort basis; a path this
    // can't make sense of is skipped rather than aborting the whole
    // push over a defensive check.
    const rest = line.slice(3);
    const arrowIdx = rest.indexOf(' -> ');
    const relPath = (arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest).replace(/^"|"$/g, '');
    try {
      const stat = await fsp.stat(path.join(targetDir, relPath));
      if (stat.isFile() && stat.size >= limitBytes) {
        oversized.push({ relPath, size: stat.size });
      }
    } catch (err) {
      // Deleted/renamed-away path, or one this couldn't resolve --
      // nothing to check, move on.
    }
  }
  return oversized;
}

function oversizedFilesMessage(oversized, limitBytes) {
  const limitMb = Math.floor(limitBytes / (1024 * 1024));
  const lines = oversized
    .map((f) => `  - ${f.relPath} (${(f.size / (1024 * 1024)).toFixed(1)} MB)`)
    .join('\n');
  return (
    `The following file(s) are at or above GitHub's ${limitMb}MB per-file limit and can't be pushed:\n` +
    `${lines}\n\nRemove or compress them, then try again.`
  );
}

// GitHub's git-over-HTTP push can fail with a hard "RPC failed; HTTP
// 400 ... unexpected disconnect while reading sideband packet" error
// even when the push actually landed -- the disconnect can happen
// while the server is still streaming back its post-push status
// report, after it's already accepted and written the pack. This is
// common specifically for binary-heavy pushes (gcode + images) over
// an imperfect connection, for two well-documented reasons: git's
// default http.postBuffer (1 MiB) is too small for the request, or
// some networks mishandle GitHub's HTTP/2 multiplexing for git's
// smart-HTTP protocol. Rather than trust the exit code alone, any
// push failure is followed by a quick `git ls-remote` check against
// what we were actually trying to push -- if it already matches,
// the earlier error was spurious and this treats it as a success.
async function remoteHeadMatchesLocal(targetDir, authedUrl, branch, timeoutMs) {
  const { stdout: localHead } = await run('git', ['rev-parse', 'HEAD'], { cwd: targetDir, timeoutMs });
  const { stdout: remoteRefs } = await run('git', ['ls-remote', authedUrl, branch], { cwd: targetDir, timeoutMs });
  const remoteHead = (remoteRefs.split(/\s+/)[0] || '').trim();
  return remoteHead.length > 0 && remoteHead === localHead.trim();
}

// Commits whatever's currently sitting uncommitted in targetDir and
// pushes it to origin/branch, authenticating with a token supplied by
// the caller (see tokenStore.js). The credential is only ever passed
// as a one-off argument to `git push` itself -- it's never written
// into .git/config or anywhere else on disk on this side.
//
// This deliberately does NOT fetch/rebase/merge first. gitSync.js
// already treats the data directory as a one-way mirror with no
// conflict-resolution UI (see ARCHITECTURE.md), and that stance
// carries over here: if origin has moved since this laptop's last
// launch-time sync, the push is simply rejected by git and surfaced
// as an error rather than something this function tries to resolve on
// its own. A restart (which re-syncs DATA_DIR from origin) and a
// retry is the expected recovery path, same as any other gitSync
// failure -- that's distinct from the RPC-failed-but-actually-worked
// case above, which this function resolves itself before ever
// surfacing an error.
//
// Resolves { pushed: true } on a successful push (whether on the
// first try, after ls-remote verification, or after the HTTP/1.1
// retry below), or { pushed: false, reason: 'nothing-to-commit' } if
// targetDir had no uncommitted changes at all (e.g. a re-run after an
// item was already synced) -- that's a normal, non-error outcome, not
// a failure.
// Strips every occurrence of the raw token out of an Error's message
// and stdout/stderr before it's allowed to propagate. Once authedUrl
// (below) exists, every `run()` call in this function embeds the
// token directly into its own argv -- and gitSync.js's run() builds
// its rejection Error from `${cmd} ${args.join(' ')}`, so a failing
// push, retry, or even the ls-remote fallback check would otherwise
// hand back an Error whose .message contains the live token verbatim.
// That error is exactly what main.js's editSession:confirmSession
// handler lets propagate to the renderer, which shows err.message in
// a plain alert() -- every other part of this app goes out of its way
// to keep the token out of renderer memory entirely (see
// tokenStore.js's design notes), so this is the one path that could
// otherwise put it on screen (and in whatever console/log captures the
// alert's text). Mutates and returns the same error so callers can
// just `throw redactToken(err, token)`.
function redactToken(err, token) {
  if (!token || !err || typeof err !== 'object') return err;
  const scrub = (s) => (typeof s === 'string' ? s.split(token).join('***') : s);
  if (typeof err.message === 'string') err.message = scrub(err.message);
  if (typeof err.stdout === 'string') err.stdout = scrub(err.stdout);
  if (typeof err.stderr === 'string') err.stderr = scrub(err.stderr);
  return err;
}

async function pushNewItem({ targetDir, repoUrl, branch = 'main', token, commitMessage, timeoutMs }) {
  if (!repoUrl.startsWith('https://')) {
    throw new Error('Only HTTPS repository URLs are supported for pushing.');
  }

  const { stdout: statusOutput } = await run('git', ['status', '--porcelain'], { cwd: targetDir, timeoutMs });
  if (!statusOutput.trim()) {
    return { pushed: false, reason: 'nothing-to-commit' };
  }

  const oversized = await findOversizedPendingFiles(targetDir, statusOutput, MAX_FILE_BYTES);
  if (oversized.length > 0) {
    throw new Error(oversizedFilesMessage(oversized, MAX_FILE_BYTES));
  }

  await run('git', ['add', '-A'], { cwd: targetDir, timeoutMs });
  await run('git', ['commit', '-m', commitMessage], { cwd: targetDir, timeoutMs });

  const authedUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
  // A larger-than-default postBuffer (git's default is 1 MiB) up
  // front, since these pushes are routinely bigger than that once
  // gcode + images are involved -- cheap insurance against the most
  // common cause of the RPC-failed error above, applied only to this
  // one invocation via -c rather than changed globally.
  const pushArgs = ['-c', 'http.postBuffer=524288000', 'push', authedUrl, `HEAD:${branch}`];

  // Everything from here on embeds `authedUrl` (token included) into a
  // command line that `run()` may echo back inside a rejection Error
  // -- see redactToken()'s comment above for why every exit out of
  // this block goes through it.
  try {
    try {
      await run('git', pushArgs, { cwd: targetDir, timeoutMs });
      return { pushed: true };
    } catch (firstErr) {
      if (await remoteHeadMatchesLocal(targetDir, authedUrl, branch, timeoutMs)) {
        return { pushed: true };
      }

      // Didn't actually land -- try once more forcing HTTP/1.1, the
      // documented fix for the HTTP/2-sideband-disconnect variant of
      // this error on networks that mishandle it.
      try {
        await run('git', ['-c', 'http.version=HTTP/1.1', ...pushArgs], { cwd: targetDir, timeoutMs });
        return { pushed: true };
      } catch (retryErr) {
        if (await remoteHeadMatchesLocal(targetDir, authedUrl, branch, timeoutMs)) {
          return { pushed: true };
        }
        throw retryErr;
      }
    }
  } catch (err) {
    throw redactToken(err, token);
  }
}

module.exports = { pushNewItem };
