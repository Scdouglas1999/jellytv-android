import { useEffect, useRef } from 'preact/hooks';
import { DvrState, type DvrJob } from '../../api/tallyDvr';
import { FocusGroup, setFocus, useFocusable } from '../../focus/focus';
import { Button } from '../../kit/Button';
import { useKeyHandler } from '../../platform/keyRouter';
import { dvrActions, playRecording, watchFromStart } from './dvrState';
import { jobTitle } from './dvrFormat';
import { MenuDialog, type MenuLine } from './MenuDialog';

/** A job's HOLD menu (RecordingsTab.kt JobMenu): watch from the start / stop, cancel, or play / delete a recording. */
export function JobMenu(props: { job: DvrJob; canManage: boolean; onDelete: (job: DvrJob) => void; onDismiss: () => void }) {
  const { job, canManage } = props;
  const title = jobTitle(job);
  const lines: MenuLine[] = [];
  const startOver = job.startOverPath;
  if (job.state === DvrState.DONE) {
    lines.push({ id: 'play', label: 'Play', dismiss: true, onPress: () => void playRecording(job.itemId, job.libraryState, title) });
    if (canManage) lines.push({ id: 'delete', label: 'Delete', onPress: () => props.onDelete(job) });
  } else if (job.state === DvrState.RECORDING) {
    if (startOver !== null) lines.push({ id: 'start', label: 'Watch from the start', dismiss: true, onPress: () => watchFromStart(startOver, title) });
    if (canManage) {
      lines.push({ id: 'stop', label: 'Stop recording', description: 'Stopping keeps what was recorded.', dismiss: true, onPress: () => void dvrActions.cancel(job.id) });
    }
  } else if ((job.state === DvrState.SCHEDULED || job.state === DvrState.WAITING) && canManage) {
    lines.push({ id: 'cancel', label: 'Cancel recording', dismiss: true, onPress: () => void dvrActions.cancel(job.id) });
  }
  const empty = lines.length === 0;
  useEffect(() => {
    if (empty) props.onDismiss();
  }, [empty]);
  if (empty) return null;
  return <MenuDialog focusKey="sports-job-menu" kicker={job.game.league} title={title} lines={lines} onDismiss={props.onDismiss} />;
}

/** "Delete?" with the recording's title; Cancel (focused: the safe choice) and Delete in red (TallyConfirmPanel). */
export function ConfirmDeleteDialog(props: { title: string; onCancel: () => void; onConfirm: () => void }) {
  const group = useFocusable<HTMLDivElement>({ focusKey: 'sports-confirm', isFocusBoundary: true });
  const openedAt = useRef(Date.now());
  useKeyHandler((key) => {
    if (key !== 'back') return false;
    props.onCancel();
    return true;
  });
  useEffect(() => setFocus('sports-confirm-cancel'), []);
  return (
    <div class="menu-scrim">
      <div ref={group.ref} class="confirm-panel">
        <div class="kicker mono-label">DELETE?</div>
        <div class="rule" />
        {props.title !== '' ? <div class="message">{props.title}</div> : null}
        <div class="buttons">
          <FocusGroup focusKey="sports-confirm">
            <Button focusKey="sports-confirm-cancel" label="Cancel" onPress={props.onCancel} />
            <span class="destructive">
              <Button
                focusKey="sports-confirm-delete"
                label="Delete"
                onPress={() => {
                  if (Date.now() - openedAt.current >= 400) props.onConfirm();
                }}
              />
            </span>
          </FocusGroup>
        </div>
      </div>
    </div>
  );
}
