// Silent auto-update (DAT-237). The desktop-release workflow publishes every
// tagged build (v<version>) to GitHub Releases along with electron-updater's
// metadata feed (latest.yml per platform); this module checks that feed in
// the background, downloads updates without asking, and applies them on the
// next app quit — no dialogs, no interruptions. Failures are logged and
// retried on the next interval; an unreachable feed must never surface as an
// app failure.
//
// What it does is visible: the sidebar footer shows the running version and
// the updater's state (checking / up to date / downloading / ready / off and
// why), offers "check now", and "restart to update" once a build is staged.
// Every transition is also appended to <userData>/updater.log for support.
import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import { CHANNEL, type DesktopConfig } from './config';

const CHECK_INTERVAL_MS = 60 * 60_000; // hourly — updates are routine, not urgent

export type UpdateState =
  | { status: 'disabled'; reason: string }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date'; checkedAt: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string; checkedAt: string };

/** What the renderer shows: the running build and where the updater is. */
export interface UpdateStatusView {
  version: string;
  channel: typeof CHANNEL;
  state: UpdateState;
}

let state: UpdateState = { status: 'idle' };
let notify: (view: UpdateStatusView) => void = () => {};

/** Why this install cannot self-update, or null when it can. */
function notUpdatableReason(cfg: DesktopConfig): string | null {
  if (!cfg.autoUpdate) return 'updates off in config';
  // Dev / electron-vite preview runs have no app-update.yml and nothing to
  // replace.
  if (!app.isPackaged) return 'dev run';
  // The portable exe runs from wherever it was copied — there is no install
  // to update in place. Portable users re-download.
  if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable build';
  // Squirrel.Mac refuses unsigned updates, so checking on macOS would only
  // download bits it can never apply. Flip this on when the signing cert
  // lands (procurement item on DAT-237; the zip target the mac feed needs is
  // already built).
  if (process.platform === 'darwin') return 'unsigned macOS build';
  return null;
}

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(`[updater] ${line}`);
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, 'updater.log'), `${stamped}\n`);
  } catch {
    // a full or read-only disk must not break the updater
  }
}

/** electron-updater's messages carry the whole HTTP exchange; the first line says what happened. */
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('
')[0].trim();

function set(next: UpdateState): void {
  state = next;
  log(JSON.stringify(next));
  notify(updateStatus());
}

const current = (): UpdateState => state;

export function updateStatus(): UpdateStatusView {
  return { version: app.getVersion(), channel: CHANNEL, state };
}

/** Ask the feed now. Resolves once the check has settled (state tells how). */
export async function checkForUpdatesNow(): Promise<UpdateStatusView> {
  if (state.status === 'disabled' || state.status === 'checking' || state.status === 'downloading' || state.status === 'downloaded') {
    return updateStatus();
  }
  set({ status: 'checking' });
  try {
    const result = await autoUpdater.checkForUpdates();
    // electron-updater reports 'update-not-available' / 'update-available'
    // through the listeners below; a null result means the updater is
    // disabled in this build.
    // (read through a call: TS cannot see that set() moved `state` on.)
    if (result == null && current().status === 'checking') set({ status: 'up-to-date', checkedAt: new Date().toISOString() });
  } catch (e) {
    // The 'error' listener below has usually recorded it already.
    if (current().status === 'checking') set({ status: 'error', message: firstLine(e), checkedAt: new Date().toISOString() });
  }
  return updateStatus();
}

/** Apply a staged update now instead of on the next quit. */
export function installUpdateNow(): { ok: true } | { ok: false; error: string } {
  if (state.status !== 'downloaded') return { ok: false, error: 'no update is staged' };
  log(`installing v${state.version} now`);
  // isSilent, isForceRunAfter: a silent NSIS install that relaunches the app.
  autoUpdater.quitAndInstall(true, true);
  return { ok: true };
}

export function initAutoUpdate(cfg: DesktopConfig, onChange: (view: UpdateStatusView) => void): void {
  notify = onChange;
  const reason = notUpdatableReason(cfg);
  if (reason) {
    set({ status: 'disabled', reason });
    return;
  }

  // Silent policy: fetch in the background, stage, install on quit. On
  // Windows the staged NSIS installer runs with /S on exit; on Linux the
  // AppImage is swapped in place.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-not-available', () => set({ status: 'up-to-date', checkedAt: new Date().toISOString() }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => {
    if (state.status === 'downloading') set({ status: 'downloading', version: state.version, percent: Math.floor(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => set({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (e) => set({ status: 'error', message: firstLine(e), checkedAt: new Date().toISOString() }));

  log(`v${app.getVersion()} (${CHANNEL}) checking GitHub Releases hourly`);
  void checkForUpdatesNow();
  setInterval(() => void checkForUpdatesNow(), CHECK_INTERVAL_MS);
}
