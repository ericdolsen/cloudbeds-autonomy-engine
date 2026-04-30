const { execSync, execFileSync } = require('child_process');
const { logger } = require('./logger');

/**
 * Best-effort: list every chrome.exe currently running, with a short
 * snippet of each command line. Used as a diagnostic before launching
 * a Playwright Chrome — if the launch then fails because Chrome
 * "Opens in existing browser session", the log shows exactly which
 * pre-existing process forced the exit.
 */
function listAllChromes() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        // Each row: PID|first 240 chars of CommandLine|
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)|\" }"
      ],
      { encoding: 'utf8', timeout: 30000 }
    );
    return out
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && l.includes('|'))
      .map(l => {
        const [pid, ...rest] = l.split('|');
        const cmdline = rest.join('|').replace(/\|$/, '');
        return { pid, cmdline };
      });
  } catch (e) {
    logger.error(`[CHROME CLEANUP] listAllChromes failed: ${e.message}`);
    return [];
  }
}

function logChromeLandscape(prefix) {
  const procs = listAllChromes();
  if (procs.length === 0) {
    logger.info(`${prefix} no chrome.exe processes currently running.`);
    return;
  }
  logger.info(`${prefix} found ${procs.length} chrome.exe process(es) before launch:`);
  for (const p of procs.slice(0, 12)) {
    // Tag whether this looks like one of OUR profiles or somebody else's
    const tags = [];
    if (p.cmdline.includes('cloudbeds_payment_session')) tags.push('PAYMENT-DIR');
    if (p.cmdline.includes('cloudbeds_session')) tags.push('WHISTLE-DIR');
    if (p.cmdline.includes('--type=')) {
      const m = p.cmdline.match(/--type=(\S+)/);
      if (m) tags.push(`subprocess:${m[1]}`);
    }
    logger.info(`${prefix}   pid=${p.pid} ${tags.length ? '[' + tags.join(',') + '] ' : ''}cmdline=${p.cmdline.substring(0, 160)}${p.cmdline.length > 160 ? '…' : ''}`);
  }
  if (procs.length > 12) {
    logger.info(`${prefix}   ... and ${procs.length - 12} more`);
  }
}

/**
 * Kill any chrome.exe processes whose command line references the given
 * user-data-dir basename. Match anchors on `--user-data-dir=<basename>` so
 * we only target processes whose data-dir is exactly this one — no false
 * positives if a future profile name is a substring of another (e.g.
 * `.cloudbeds_session` vs hypothetical `.cloudbeds_session_old`).
 *
 * Returns the count of processes killed (best-effort — PowerShell
 * isn't always reliable about reporting Stop-Process errors).
 */
function killChromesUsingDir(dirBasename) {
  if (!dirBasename) return 0;
  if (process.platform !== 'win32') return 0;
  let killed = 0;
  try {
    const procs = listAllChromes();
    // Anchor on the launch flag so we don't accidentally cross-match a
    // dir whose name happens to be a substring of another. Cmd lines
    // appear with the path quoted on Windows, hence the bracket
    // alternative for the character right before the basename.
    const needle = `--user-data-dir=`;
    const targets = procs.filter(p => {
      const idx = p.cmdline.indexOf(needle);
      if (idx === -1) return false;
      // Slice the value of --user-data-dir up to the next quote or
      // whitespace, then check basename equality. This is more robust
      // than a substring sniff against the whole cmdline.
      const tail = p.cmdline.slice(idx + needle.length);
      const match = tail.match(/^"([^"]+)"|^(\S+)/);
      const value = match ? (match[1] || match[2] || '') : '';
      if (!value) return false;
      const base = value.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      return base === dirBasename;
    });
    if (targets.length === 0) return 0;

    logger.info(`[CHROME CLEANUP] Killing ${targets.length} stale chrome.exe process(es) using "${dirBasename}": ${targets.map(t => t.pid).join(', ')}`);
    for (const t of targets) {
      try {
        // taskkill is more reliable than PowerShell Stop-Process for
        // chrome.exe with subprocesses — /T tree-kills the descendants.
        execSync(`taskkill /F /T /PID ${t.pid}`, { stdio: 'ignore', timeout: 5000 });
        killed++;
      } catch (e) {
        // PID may have exited between list and kill, that's fine.
      }
    }
    // Brief pause so Windows actually releases the user-data-dir lock
    // before our caller tries to launchPersistentContext.
    if (killed > 0) {
      execSync('cmd /c "ping 127.0.0.1 -n 2 >nul"', { stdio: 'ignore', timeout: 5000 });
    }
  } catch (e) {
    logger.warn(`[CHROME CLEANUP] Targeted kill for "${dirBasename}" failed: ${e.message.substring(0, 200)}`);
  }
  return killed;
}

module.exports = { killChromesUsingDir, listAllChromes, logChromeLandscape };
