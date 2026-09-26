import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { absolute } from '../../api/tally';
import { DvrState, type DvrJob, type DvrList, type DvrRule } from '../../api/tallyDvr';
import { useFocusable } from '../../focus/focus';
import { RowHeader } from '../../kit/Bits';
import { MediaRow, useRowReveal } from '../../kit/MediaRow';
import { ScrollPage, usePageScroll } from '../../kit/ScrollPage';
import { EmptyState, KeyHint } from '../../sports/SportsBits';
import { tallyUppercase } from '../../util/format';
import { useStore } from '../../util/store';
import { dvrActions, dvrError, dvrList, dvrStorage, playRecording, useDvrPolling, watchFromStart } from './dvrState';
import { jobTitle, recordedMeta, recordingNowMeta, recordingsSections, recordingStateText, ruleMeta, scheduledMeta, sectionsEmpty, storageLine } from './dvrFormat';
import { useTabArrival } from './tabArrival';

export const jobFocusKey = (job: DvrJob): string => 'srj-' + job.id;
export const ruleFocusKey = (rule: DvrRule): string => 'srr-' + rule.id;

/** Ticks once a second while `active` (the running times of recordings in progress). */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/**
 * A Recordings row (DvrTvRow): an indicator square, the title (Sans) over a mono meta line, key hints at the right.
 * Focused: the amber frame on groundRaised, as every Tally row.
 */
function DvrRow(props: { focusKey: string; title: string; meta: string; metaLive?: boolean; indicator: 'live' | 'idle' | 'muted'; onPress: () => void; children?: ComponentChildren }) {
  const page = usePageScroll();
  const f = useFocusable<HTMLDivElement>({
    focusKey: props.focusKey,
    onEnter: props.onPress,
    onFocus: () => {
      if (f.ref.current !== null) page.reveal(f.ref.current, 'nearest');
    },
  });
  return (
    <div ref={f.ref} class="dvr-row" onClick={props.onPress}>
      <span class={'dvr-dot ' + props.indicator} />
      <div class="text">
        <div class="title ellipsis">{props.title}</div>
        <div class={'meta mono-label ellipsis' + (props.metaLive === true ? ' live' : '')}>{tallyUppercase(props.meta)}</div>
      </div>
      <div class="hints">{props.children}</div>
    </div>
  );
}

/** A finished recording: its 16:9 thumb (the matchup art the server drew for it) and "Otters at Herons". */
function RecordedCard(props: { job: DvrJob }) {
  const { job } = props;
  const reveal = useRowReveal();
  const [failed, setFailed] = useState(false);
  const f = useFocusable<HTMLDivElement>({
    focusKey: jobFocusKey(job),
    onEnter: () => void playRecording(job.itemId, job.libraryState, jobTitle(job)),
    onFocus: () => {
      if (f.ref.current !== null) reveal(f.ref.current);
    },
  });
  const url = job.itemId !== null ? absolute(`/Items/${job.itemId}/Images/Thumb?maxWidth=640`) : null;
  return (
    <div ref={f.ref} class="card landscape" onClick={() => void playRecording(job.itemId, job.libraryState, jobTitle(job))}>
      <div class="art">{url !== null && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : <div class="art-fallback">{jobTitle(job)}</div>}</div>
      <div class="bar">
        <div class="kicker ellipsis">{tallyUppercase(recordedMeta(job))}</div>
        <div class="title ellipsis">{jobTitle(job)}</div>
      </div>
    </div>
  );
}

function Section(props: { title: string; count: number; children: ComponentChildren }) {
  return (
    <div class="dvr-section">
      <RowHeader title={props.title} count={props.count} />
      <div class="dvr-rows">{props.children}</div>
    </div>
  );
}

/**
 * RECORDINGS (RecordingsTab.kt), only when the server records: the storage line, then RECORDING NOW (OK watches from
 * the start, HOLD to stop), SCHEDULED (OK cancels), RECORDED (16:9 cards: OK plays, HOLD to delete), FAILED (the
 * reason; OK dismisses) and TEAM RULES (keep-last; OK changes it or deletes the rule). Without the permission to
 * record, rows only show. Never a score anywhere. The page's HOLD opens `onJobMenu` / `onRule`.
 */
export function RecordingsTab(props: { takeFocus: boolean; active: boolean; onJobMenu: (job: DvrJob) => void; onRule: (rule: DvrRule) => void }) {
  useDvrPolling(props.active, 10_000);
  const list: DvrList | null = useStore(dvrList);
  const storage = useStore(dvrStorage);
  const error = useStore(dvrError);
  const sections = list !== null ? recordingsSections(list) : null;
  const now = useSecondTick(sections !== null && sections.recordingNow.length > 0);
  const firstJob = sections === null ? undefined : sections.recordingNow.concat(sections.scheduled, sections.recorded, sections.failed)[0];
  const firstRule = sections?.rules[0];
  const target = sections === null ? 'srec-loading' : sectionsEmpty(sections) ? 'srec-empty' : firstJob !== undefined ? jobFocusKey(firstJob) : firstRule !== undefined ? ruleFocusKey(firstRule) : null;
  useTabArrival(props.takeFocus && props.active, target, true);

  if (list === null || sections === null) {
    return <EmptyState focusKey="srec-loading" class="tab-empty fill" title={error !== null ? "Can't load the recordings" : 'Loading recordings…'} subtitle={error ?? ''} />;
  }
  const canManage = list.canManage;
  return (
    <div class="recordings-tab">
      <ScrollPage>
        <div class="storage-line mono-label">{tallyUppercase(storageLine(storage) ?? '')}</div>
        {sectionsEmpty(sections) ? (
          <EmptyState
            focusKey="srec-empty"
            class="tab-empty in-list"
            title="No recordings yet"
            subtitle={canManage ? 'Hold OK on a game and choose Record, or Record every game of a team.' : 'Recordings made on this server show up here.'}
          />
        ) : null}
        {sections.recordingNow.length > 0 ? (
          <Section title="Recording now" count={sections.recordingNow.length}>
            {sections.recordingNow.map((job) => {
              const startOver = job.startOverPath;
              return (
                <DvrRow
                  key={job.id}
                  focusKey={jobFocusKey(job)}
                  title={jobTitle(job)}
                  meta={recordingNowMeta(job, now)}
                  indicator="live"
                  onPress={() => (startOver !== null ? watchFromStart(startOver, jobTitle(job)) : props.onJobMenu(job))}
                >
                  {startOver !== null ? <KeyHint keyName="OK" label="Watch from the start" /> : null}
                  {canManage && job.state === DvrState.RECORDING ? <KeyHint keyName="HOLD" label="Stop recording" /> : null}
                </DvrRow>
              );
            })}
          </Section>
        ) : null}
        {sections.scheduled.length > 0 ? (
          <Section title="Scheduled" count={sections.scheduled.length}>
            {sections.scheduled.map((job) => (
              <DvrRow
                key={job.id}
                focusKey={jobFocusKey(job)}
                title={jobTitle(job)}
                meta={scheduledMeta(job, list.rules, now)}
                indicator="idle"
                onPress={() => {
                  if (canManage) props.onJobMenu(job);
                }}
              >
                {canManage ? <KeyHint keyName="OK" label="Cancel recording" /> : null}
              </DvrRow>
            ))}
          </Section>
        ) : null}
        {sections.recorded.length > 0 ? (
          <MediaRow focusKey="srec-recorded" title="Recorded" count={sections.recorded.length}>
            {sections.recorded.map((job) => (
              <RecordedCard key={job.id} job={job} />
            ))}
          </MediaRow>
        ) : null}
        {sections.failed.length > 0 ? (
          <Section title="Failed" count={sections.failed.length}>
            {sections.failed.map((job) => (
              <DvrRow
                key={job.id}
                focusKey={jobFocusKey(job)}
                title={jobTitle(job)}
                meta={recordingStateText({ state: job.state, startedAt: null, reason: job.reason })}
                metaLive={true}
                indicator="live"
                onPress={() => {
                  if (canManage) void dvrActions.dismiss(job.id);
                }}
              >
                {canManage ? <KeyHint keyName="OK" label="Dismiss" /> : null}
              </DvrRow>
            ))}
          </Section>
        ) : null}
        {sections.rules.length > 0 ? (
          <Section title="Team rules" count={sections.rules.length}>
            {sections.rules.map((rule) => (
              <DvrRow
                key={rule.id}
                focusKey={ruleFocusKey(rule)}
                title={rule.title}
                meta={ruleMeta(rule, list)}
                indicator="muted"
                onPress={() => {
                  if (canManage) props.onRule(rule);
                }}
              >
                {canManage ? <KeyHint keyName="OK" label="Change" /> : null}
              </DvrRow>
            ))}
          </Section>
        ) : null}
      </ScrollPage>
    </div>
  );
}

/** Kept for the page's HOLD: the job or rule behind a Recordings focus key. */
export function recordingsTarget(list: DvrList | null, focusKey: string): { job: DvrJob } | { rule: DvrRule } | null {
  if (list === null) return null;
  if (focusKey.indexOf('srj-') === 0) {
    const job = list.jobs.find((j) => jobFocusKey(j) === focusKey);
    return job !== undefined ? { job } : null;
  }
  if (focusKey.indexOf('srr-') === 0) {
    const rule = list.rules.find((r) => ruleFocusKey(r) === focusKey);
    return rule !== undefined ? { rule } : null;
  }
  return null;
}
