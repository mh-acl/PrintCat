'use strict';

// gcodeCommandScan.js
//
// Auto-detects three print-job traits from the actual gcode commands
// (not the "; key = value" slicer-settings comments):
//
//   - Color changes: a count of M600 commands in the body.
//   - Pauses: a count of M601 commands in the body, each paired with
//     whatever custom message preceded it. PrusaSlicer emits an M117
//     status-message line directly before an M601 when the pause was
//     given a message (e.g. "M117 Add filling and continue" then
//     "M601"). The scanner remembers the most recent M117 text seen
//     and, when an M601 shows up, attaches that text to it and clears
//     it -- so a pause with no preceding M117 (or a bare "M117" with
//     no text) records `null` rather than reusing an earlier pause's
//     message.
//   - Batch jobs: PrusaSlicer emits, once per object near the top of
//     the file, a small header block per object:
//         M486 S<index>
//         M486 A<object name>
//         M486 S-1
//     (the S<index> is reused later, without a following A line, to
//     bracket that object's actual print segment). Collecting every
//     "M486 A<name>" line therefore gives the exact set of objects and
//     their names, regardless of how many times S-indices get reused
//     during printing. If 2+ objects share a name -- either exactly,
//     or exactly but for a trailing " (Instance N)" -- that's a batch
//     job of N copies of the same thing.
//
// Both parsers feed this scanner one gcode line at a time via
// feedLine() (already trimmed; comment lines starting with "; " never
// match either pattern, so it's safe to feed every line unfiltered),
// then call result() once at the end.

const M600_RE = /^M600(?:\s|;|$)/;
const M601_RE = /^M601(?:\s|;|$)/;
// Captures whatever follows "M117" as the status message, if anything --
// group 1 is undefined for a bare "M117" with no message.
const M117_RE = /^M117(?:\s+(.*))?$/;
const M486_NAME_PREFIX = 'M486 A';
const INSTANCE_SUFFIX_RE = /\s+\(Instance\s+\d+\)$/;

function stripInstanceSuffix(name) {
  return name.replace(INSTANCE_SUFFIX_RE, '');
}

class GcodeCommandScanner {
  constructor() {
    this.colorChangeCount = 0;
    this.objectNames = [];
    // One entry per M601 seen, in order; each is either the text of the
    // M117 that immediately preceded it, or `null` if there wasn't one.
    this.pauseMessages = [];
    // Most recent M117 text, held until the next M601 consumes it (or
    // until a later M117 overwrites it first).
    this.pendingMessage = null;
  }

  feedLine(line) {
    if (M600_RE.test(line)) {
      this.colorChangeCount++;
      return;
    }
    const m117 = line.match(M117_RE);
    if (m117) {
      this.pendingMessage = m117[1] ? m117[1].trim() : null;
      return;
    }
    if (M601_RE.test(line)) {
      this.pauseMessages.push(this.pendingMessage);
      this.pendingMessage = null;
      return;
    }
    if (line.startsWith(M486_NAME_PREFIX)) {
      this.objectNames.push(line.slice(M486_NAME_PREFIX.length).trim());
    }
  }

  /**
   * `copies` is the detected batch size: 1 unless 2+ M486 objects were
   * seen that all reduce to the same base name once any trailing
   * " (Instance N)" is stripped off.
   *
   * `pauseMessages` mirrors `pauseCount` in length -- one slot per
   * M601 seen, `null` where there was no preceding M117.
   */
  result() {
    let copies = 1;
    if (this.objectNames.length > 1) {
      const bases = this.objectNames.map(stripInstanceSuffix);
      if (bases.every((b) => b === bases[0])) {
        copies = this.objectNames.length;
      }
    }
    return {
      colorChangeCount: this.colorChangeCount,
      copies,
      pauseCount: this.pauseMessages.length,
      pauseMessages: this.pauseMessages,
    };
  }
}

module.exports = { GcodeCommandScanner, stripInstanceSuffix };
