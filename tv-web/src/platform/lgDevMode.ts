/**
 * LG Developer Mode, kept on. Apps installed in Developer Mode stay only while its session lasts (50 hours, then LG
 * removes them); the Developer Mode app's EXTEND button, or LG's session reset with the TV's session token, starts
 * another 50 hours. Tally for LG reads that token from the TV and stamps it into the shell's config.js; once someone
 * is signed in, the app hands it to the Tally plugin (POST /JellyTV/Client/v1/lg/devmode), which resets the session
 * every day (server: LgDevModeService). Sent on every start with a session: cheap, and a server that lost it (a new
 * server, a restored backup) has it again the next time the TV starts.
 */
import axios from 'axios';
import { currentApi, session, type Session } from '../api/jellyfin';

export const DEVMODE_PATH = '/JellyTV/Client/v1/lg/devmode';

/** What the TV sends: the token, and the TV's model for the settings page's line. */
export interface DevModeHandoff {
  token: string;
  model: string;
}

/**
 * A token as the TV stores it (/var/luna/preferences/devmode_enabled: letters and digits, as webosbrew's
 * dev-manager checks it); anything else is never sent.
 */
export function plausibleToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9]{8,512}$/.test(token);
}

let sentFor = '';

/** Sends the token once per signed-in session (a new sign-in or another server sends it again). */
export async function handOff(s: Session | null, token: string, model: string, post = defaultPost): Promise<boolean> {
  if (s === null) return false;
  const key = s.serverUrl + '|' + s.userId + '|' + s.token;
  if (sentFor === key) return false;
  sentFor = key;
  try {
    await post({ token, model });
    return true;
  } catch {
    // an older plugin (404) or a server that is busy: the next start tries again
    sentFor = '';
    return false;
  }
}

async function defaultPost(body: DevModeHandoff): Promise<void> {
  const api = currentApi();
  await axios.post(api.basePath + DEVMODE_PATH, body, {
    headers: { Authorization: api.authorizationHeader, 'Content-Type': 'application/json' },
    timeout: 20000,
  });
}

/** Watches the session and hands the token over whenever someone is signed in. */
export function installDevModeHandoff(token: string | null | undefined, model: string): void {
  if (!plausibleToken(token)) return;
  const send = (s: Session | null): void => void handOff(s, token, model);
  send(session.get());
  session.subscribe(send);
}

/** For the tests. */
export function resetHandoff(): void {
  sentFor = '';
}
