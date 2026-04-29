const { execSync } = require('child_process');
const { logger } = require('./logger');

/**
 * Kill any chrome.exe processes whose command line references the given
 * user-data-dir substring. Safer than `taskkill /IM chrome.exe /F /T`
 * (which murders the operator's regular Chrome and any sibling Playwright
 * Chromes) and stronger than just removing SingletonLock — sometimes a
 * crashed prior run leaves the actual chrome.exe process alive holding
 * the profile, and a fresh launchPersistentContext attempt against the
 * same dir then exits cleanly with "Opening in existing browser session"
 * → Playwright reports `Browser window not found`.
 *
 * Windows-only. PowerShell's CIM gives us command-line filtering that
 * native taskkill doesn't support.
 */
function killChromesUsingDir(dirSubstring) {
  if (!dirSubstring) return;
  if (process.platform !== 'win32') return;
  try {
    // Single-quote-escape the substring for the PowerShell -like filter.
    const escaped = String(dirSubstring).replace(/'/g, "''");
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`;
    execSync(cmd, { stdio: 'ignore', timeout: 10000 });
  } catch (e) {
    // Best-effort. If PowerShell isn't on PATH, the dir substring matches
    // nothing, or Stop-Process throws on a now-gone PID — none of those
    // are fatal to the caller.
    logger.warn(`[CHROME CLEANUP] Targeted kill for "${dirSubstring}" reported: ${e.message}`);
  }
}

module.exports = { killChromesUsingDir };
