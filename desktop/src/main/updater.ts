// Silent auto-update (DAT-237). The desktop-release workflow publishes every
// tagged build (v<version>) to GitHub Releases along with electron-updater's
// metadata feed (latest.yml per platform); this module checks that feed in
// the background, downloads updates without asking, and applies them on the
// next app quit — no dialogs, no interruptions. Failures are logged and
// retried on the next interval; an unreachable feed must never surface as an
// app failure.
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { DesktopConfig } from './config';

const CHECK_INTERVAL_MS = 60 * 60_000; // hourly — updates are routine, not urgent

/** Whether this particular install can meaningfully self-update. */
function updatable(): boolean {
  // Dev / electron-vite preview runs have no app-update.yml and nothing to
  // replace.
  if (!app.isPackaged) return false;
  // The portable exe runs from wherever it was copied — there is no install
  // to update in place. Portable users re-download.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return false;
  // Squirrel.Mac refuses unsigned updates, so checking on macOS would only
  // download bits it can never apply. Flip this on when the signing cert
  // lands (procurement item on DAT-237; the zip target the mac feed needs is
  // already built).
  if (process.platform === 'darwin') return false;
  return true;
}

export function initAutoUpdate(cfg: DesktopConfig): void {
  if (!cfg.autoUpdate || !updatable()) return;

  // Silent policy: fetch in the background, stage, install on quit. On
  // Windows the staged NSIS installer runs with /S on exit; on Linux the
  // AppImage is swapped in place.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] v${info.version} staged; installs on next app quit`);
  });
  autoUpdater.on('error', (e) => {
    console.warn(`[updater] ${e instanceof Error ? e.message : String(e)}`);
  });

  const check = () =>
    void autoUpdater.checkForUpdates().catch(() => {
      // already logged via the error listener
    });
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
