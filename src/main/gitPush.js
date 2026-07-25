'use strict';

const { run } = require('./gitSync');

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
async function pushNewItem({ targetDir, repoUrl, branch = 'main', token, commitMessage, timeoutMs }) {
  if (!repoUrl.startsWith('https://')) {
    throw new Error('Only HTTPS repository URLs are supported for pushing.');
  }

  const { stdout: statusOutput } = await run('git', ['status', '--porcelain'], { cwd: targetDir, timeoutMs });
  if (!statusOutput.trim()) {
    return { pushed: false, reason: 'nothing-to-commit' };
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
}

module.exports = { pushNewItem };
