import './polyfills';
import { render } from 'preact';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './kit/kit.css';
import { resolveShell } from './shell-contract/shell';
import { createPlatform } from './platform/platform';
import { app } from './app/context';
import { adoptShellServer, initJellyfin } from './api/jellyfin';
import { currentFocusKey, initFocus } from './focus/focus';
import { installKeyRouter } from './platform/keyRouter';
import { installDevModeHandoff } from './platform/lgDevMode';
import { installPointer } from './platform/pointer';
import { createStage } from './platform/stage';
import { App, rootBack } from './app/App';
import { push, stack } from './router/router';

// resolveShell reads document.currentScript: it must run while this script is first evaluated
const shell = resolveShell();
const platform = createPlatform(shell);
app.shell = shell;
app.platform = platform;
initJellyfin(platform.deviceName());
initFocus();
installKeyRouter(platform, () => rootBack(() => platform.exit()));
if (platform.name === 'webos') {
  // the Magic Remote's pointer, and LG's Developer Mode kept on through the Tally plugin
  installPointer();
  installDevModeHandoff(shell.devModeToken, platform.model());
}
const stage = createStage();
// a session saved for another address of the shell's server follows the shell (the server moved, or the TV was
// reinstalled for another server) before the first screen asks it for anything
void adoptShellServer(shell.serverUrl).finally(() => render(<App onFirstScreen={() => shell.started()} />, stage));

// For the end-to-end tests and for poking at a TV over the web inspector: open any route directly.
(window as unknown as { TallyDebug: unknown }).TallyDebug = { push, stack, focus: currentFocusKey };
