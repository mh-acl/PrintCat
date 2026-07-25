const fs = require('fs').promises;
const path = require('path');

/**
 * Persists just the timestamp of the last *successful* git sync, so the
 * "Last catalog refresh: ..." footer note in the renderer still has
 * something meaningful to show immediately after a fresh app launch,
 * before this session's own sync attempt has finished (or if it fails).
 *
 * Deliberately stored outside the git-synced data folder itself -- that
 * folder gets `git clean -fd`'d on every sync, which would otherwise wipe
 * a state file living alongside the catalog data.
 */
class SyncStateStore {
  constructor({ stateFile }) {
    this.stateFile = stateFile;
    this.state = { lastSuccessAt: null };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      this.state = JSON.parse(raw);
    } catch (_) {
      // No file yet (first run), or unreadable/corrupt -- start fresh
      // rather than blocking startup on it.
    }
    return this.state;
  }

  async recordSuccess() {
    this.state = { lastSuccessAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(this.state), 'utf8');
    return this.state;
  }

  get() {
    return this.state;
  }
}

module.exports = { SyncStateStore };
