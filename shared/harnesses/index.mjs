// Stable import path for the harness adapters, shared by the desktop app and
// (eventually) the devbox runner.
//
// The adapters still physically live in devbox-runner/harnesses.mjs because
// active harness work (DAT-209, DAT-221 omnigent) is in flight against that
// path — moving the file now would conflict with open branches. Once those
// land, the file moves here and this shim inverts (devbox-runner re-exports).
// Consumers should import from shared/harnesses either way.
export { getHarness, normalizeState, toolLabel } from '../../devbox-runner/harnesses.mjs';
