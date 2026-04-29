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
      { encoding: 'utf8', timeout: 10000 }
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
 * user-data-dir substring. Targeted: only kills processes for the dir
 * we're about to launch into; the operator's regular Chrome and the
 * sibling component's profile (different dir) are untouched.
 *
 * Returns the count of processes killed (best-effort — PowerShell
 * isn't always reliable about reporting Stop-Process errors).
 */
function killChromesUsingDir(dirSubstring) {
  if (!dirSubstring) return 0;
  if (process.platform !== 'win32') return 0;
  let killed = 0;
  try {
    const procs = listAllChromes();
    const targets = procs.filter(p => p.cmdline.includes(dirSubstring));
    if (targets.length === 0) return 0;

    logger.info(`[CHROME CLEANUP] Killing ${targets.length} stale chrome.exe process(es) using "${dirSubstring}": ${targets.map(t => t.pid).join(', ')}`);
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
    logger.warn(`[CHROME CLEANUP] Targeted kill for "${dirSubstring}" failed: ${e.message.substring(0, 200)}`);
  }
  return killed;
}

module.exports = { killChromesUsingDir, listAllChromes, logChromeLandscape };
