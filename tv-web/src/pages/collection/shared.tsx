/**
 * Pieces the collection and playlist pages share (media/kit on Android): the header's action row that scrolls
 * sideways when its buttons do not fit (a LazyRow there), the library's SORT / FILTER controls in it, and the empty
 * state under a header.
 */
import type { FocusableComponentLayout } from '@noriginmedia/norigin-spatial-navigation-core';
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useRef } from 'preact/hooks';
import { FocusGroup, useFocusable } from '../../focus/focus';
import { offsetWithin, reveal } from '../../kit/scroll';
import { tallyUppercase } from '../../util/format';
import './pages.css';

const StripFocus = createContext<(layout: FocusableComponentLayout) => void>(() => undefined);

/** For controls inside an ActionStrip: pass as the control's onFocus (it also keeps the page at its top). */
export function useStripFocus(): (layout: FocusableComponentLayout) => void {
  return useContext(StripFocus);
}

/** Room kept beside a focused control inside the strip: the focus frame's (focus + 1dp, Android's FocusEdge). */
const STRIP_MARGIN = 7;

/**
 * The header's row of TallyButtons and controls (CollectionActions / PlaylistHeader's LazyRow): one focus group that
 * comes back to the control focused last (PLAY the first time), scrolled sideways just enough to show the focused one.
 * It ends at the page margin (plus the focus room), where Android's row cuts its last control until focus reaches it.
 */
export function ActionStrip(props: { focusKey: string; primaryKey: string; onFocusControl?: () => void; children: ComponentChildren }) {
  const f = useFocusable<HTMLDivElement>({ focusKey: props.focusKey, saveLastFocusedChild: true, preferredChildFocusKey: props.primaryKey });
  const latest = useRef(props.onFocusControl);
  latest.current = props.onFocusControl;
  const onFocus = (layout: FocusableComponentLayout): void => {
    latest.current?.();
    const strip = f.ref.current;
    const node = layout.node as HTMLElement | undefined;
    if (strip === null || node === undefined) return;
    const left = offsetWithin(node, strip).left + strip.scrollLeft;
    strip.scrollLeft = reveal(strip.scrollLeft, strip.clientWidth, left, node.offsetWidth, STRIP_MARGIN, STRIP_MARGIN, strip.scrollWidth - strip.clientWidth);
  };
  return (
    <div ref={f.ref} class="pages-strip">
      <FocusGroup focusKey={props.focusKey}>
        <StripFocus.Provider value={onFocus}>
          <div class="pages-strip-track">{props.children}</div>
        </StripFocus.Provider>
      </FocusGroup>
    </div>
  );
}

/** The library page's SORT / FILTER control (LibraryControlButton): square, hairline, mono label, the sort's arrow. */
export function StripControl(props: { focusKey: string; label: string; suffix?: string; onPress: () => void }) {
  const onFocus = useStripFocus();
  const f = useFocusable<HTMLDivElement>({ focusKey: props.focusKey, onEnter: props.onPress, onFocus });
  return (
    <div ref={f.ref} class="lib-control" onClick={props.onPress}>
      <span class="label">{tallyUppercase(props.label)}</span>
      {props.suffix !== undefined ? <span class="suffix">{props.suffix}</span> : null}
    </div>
  );
}

/** EmptyState under a header (takeFocus = false on Android): a dashed frame with a title and a muted line. */
export function PagesEmpty(props: { title: string; subtitle: string }) {
  return (
    <div class="pages-empty">
      <div class="title">{props.title}</div>
      <div class="subtitle">{props.subtitle}</div>
    </div>
  );
}

/** A row that is loading or failed (RowNote): its header and a mono line. */
export function RowNote(props: { title: string; message: string; failure: boolean }) {
  return (
    <div class="pages-row-note">
      <div class="row-header">
        <span class="title mono-label-large">{tallyUppercase(props.title)}</span>
      </div>
      <div class={'mono-label' + (props.failure ? ' failure' : '')}>{tallyUppercase(props.message)}</div>
    </div>
  );
}
