/**
 * The notice a recording without a library item gets instead of playing (plugin contract 3): "Still being added to
 * the library…" or "This server has no library for recordings yet…", in the Tally panel (the dialog family of the
 * item menu). Raised from anywhere a recording plays (the Recordings tab, a job's menu, a game's menu); shown by the
 * <RecordingNoticeHost/> of the page on top (pages that can raise one render it, as they do the ToastHost).
 */
import { useRef } from 'preact/hooks';
import { libraryNotice, type LibraryState } from '../../api/tallyDvr';
import { currentFocusKey, focusExists, setFocus } from '../../focus/focus';
import { Panel } from '../../kit/Panel';
import { createStore, useStore } from '../../util/store';

interface Notice {
  title: string;
  text: string;
}

const current = createStore<Notice | null>(null);

/** Shows why the recording `title` cannot play yet; false when it can (`state` ready). */
export function showRecordingNotice(state: LibraryState, title: string): boolean {
  const text = libraryNotice(state);
  if (text === null) return false;
  current.set({ title: title !== '' ? title : 'Recording', text });
  return true;
}

export function RecordingNoticeHost(props: { active: boolean; pageKey: string }) {
  const notice = useStore(current);
  const returnKey = useRef<string | null>(null);
  const shown = props.active && notice !== null;
  // what had focus when the notice came up (a menu that raised it has already put focus back on its card)
  if (shown && returnKey.current === null) returnKey.current = currentFocusKey();
  if (!shown || notice === null) return null;
  const close = (): void => {
    current.set(null);
    const back = returnKey.current;
    returnKey.current = null;
    window.setTimeout(() => setFocus(back !== null && back.indexOf('recording-notice') !== 0 && focusExists(back) ? back : props.pageKey), 0);
  };
  return <Panel title={notice.title} body={notice.text} entries={[{ key: 'ok', label: 'OK', onPress: close }]} focusKey="recording-notice" onClose={close} />;
}
