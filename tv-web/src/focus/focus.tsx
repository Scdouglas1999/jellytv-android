/**
 * The focus system: Norigin's spatial navigation core (framework-free, MIT) with a small Preact binding.
 *
 * - Every focusable thing calls `useFocusable`. Groups (a row, a page, the rail) are focusables with children; they
 *   pass their key down through `FocusGroup`.
 * - Keys do not reach Norigin directly: platform/keyRouter.ts decides what each remote key means and hands arrows
 *   and OK to `navigate` below, so BACK, media keys and overlays are handled in one place.
 * - The focused element carries `data-focused` (set by Norigin's adapter without a Preact render, which keeps
 *   D-pad movement cheap on a TV). Styles draw the amber frame from that attribute; components that must know they
 *   are focused (a header describing the focused card) use `onFocus`.
 * - Layout is measured with offsetLeft/offsetTop, which ignore the stage's scale transform and include scrollLeft/
 *   scrollTop: scroll containers must scroll with scrollLeft/scrollTop, never with a transform.
 */
import {
  BaseWebAdapter,
  SpatialNavigation,
  type AddEventListenersOptions,
  type FocusableComponentLayout,
  type FocusDetails,
  type Direction,
} from '@noriginmedia/norigin-spatial-navigation-core';
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

type NavKey = 'left' | 'right' | 'up' | 'down' | 'enter';

let keyDown: ((key: NavKey, event: Event) => void) | undefined;
let keyUp: ((key: NavKey) => void) | undefined;

/** Norigin's web adapter, minus its own window key listeners: keys come from the key router. */
class RoutedAdapter extends BaseWebAdapter {
  override addEventListeners(options: AddEventListenersOptions): void {
    keyDown = options.keyDown as typeof keyDown;
    keyUp = options.keyUp as typeof keyUp;
  }

  override removeEventListeners(): void {
    keyDown = undefined;
    keyUp = undefined;
  }
}

let started = false;

export function initFocus(): void {
  if (started) return;
  started = true;
  SpatialNavigation.init({
    // no throttle: Norigin cancels a throttled press on key-up, which dropped quick second presses; a held key
    // repeats at the TV's own rate
    throttle: 0,
    shouldFocusDOMNode: true,
    domNodeFocusOptions: { preventScroll: true },
    distanceCalculationMethod: 'center',
    layoutAdapter: RoutedAdapter as never,
  });
}

/** Called by the key router for arrows and OK. */
export function navigate(key: NavKey, event: Event): void {
  keyDown?.(key, event);
}

export function navigateRelease(key: NavKey): void {
  keyUp?.(key);
}

export function setFocus(focusKey: string): void {
  void SpatialNavigation.setFocus(focusKey);
}

export function currentFocusKey(): string {
  return SpatialNavigation.getCurrentFocusKey();
}

export function focusExists(focusKey: string): boolean {
  return SpatialNavigation.doesFocusableExist(focusKey);
}

const ParentKey = createContext<string>('SN:ROOT');

/** Which focusable an element is (for a pointer: the Magic Remote on LG) and which keys have children (groups). */
const nodeKeys = new WeakMap<Element, string>();
const childCount: Record<string, number> = {};

/**
 * The focusable a pointer is over: the nearest registered element from `el` up that is not a group (hovering a row's
 * gap must not jump to the row's remembered card). Null over anything else.
 */
export function focusKeyAt(el: Element | null): string | null {
  return focusableAt(el)?.key ?? null;
}

/** `focusKeyAt` with the element that registered it. */
export function focusableAt(el: Element | null): { key: string; node: Element } | null {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    const key = nodeKeys.get(node);
    if (key !== undefined) return (childCount[key] ?? 0) > 0 ? null : { key, node };
  }
  return null;
}

let generated = 0;

export interface FocusableOptions {
  /** Stable key (to focus it by name, or to restore it). Generated when omitted. */
  focusKey?: string;
  /** OK pressed while focused. */
  onEnter?: () => void;
  /** Gained focus (layout in canvas pixels, relative to the offset parent chain). */
  onFocus?: (layout: FocusableComponentLayout, details: FocusDetails) => void;
  onBlur?: () => void;
  /** An arrow while focused; return false to stop Norigin moving focus. */
  onArrow?: (direction: Direction) => boolean;
  /** Keep `hasFocusedChild` up to date (groups that restyle when focus is inside them). */
  trackChildren?: boolean;
  /** Re-entering the group goes back to the child focused last. */
  saveLastFocusedChild?: boolean;
  /** Focus cannot leave this group by arrows (a page, a dialog). */
  isFocusBoundary?: boolean;
  focusBoundaryDirections?: Direction[];
  preferredChildFocusKey?: string;
  focusable?: boolean;
  /** Re-render when focus changes (only for components that draw differently when focused beyond the frame). */
  trackFocus?: boolean;
}

export interface Focusable<T extends HTMLElement> {
  ref: { current: T | null };
  focusKey: string;
  focused: boolean;
  hasFocusedChild: boolean;
  focusSelf: () => void;
}

/**
 * Registers the element in `ref` (it must be rendered from the first render on: registration happens once per key;
 * swap its children, never the element itself).
 */
export function useFocusable<T extends HTMLElement = HTMLDivElement>(options: FocusableOptions = {}): Focusable<T> {
  const parentFocusKey = useContext(ParentKey);
  const ref = useRef<T | null>(null);
  const focusKey = useMemo(() => options.focusKey ?? 'fk-' + String(++generated), [options.focusKey]);
  const [focused, setFocused] = useState(false);
  const [hasFocusedChild, setHasFocusedChild] = useState(false);
  // callbacks read through a ref so Norigin never holds a stale closure
  const latest = useRef(options);
  latest.current = options;

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    if (!node.hasAttribute('tabindex') && node.tagName !== 'INPUT') node.setAttribute('tabindex', '-1');
    nodeKeys.set(node, focusKey);
    childCount[parentFocusKey] = (childCount[parentFocusKey] ?? 0) + 1;
    SpatialNavigation.addFocusable({
      focusKey,
      node,
      parentFocusKey,
      preferredChildFocusKey: options.preferredChildFocusKey,
      onEnterPress: () => latest.current.onEnter?.(),
      onEnterRelease: () => undefined,
      onArrowPress: (direction: string) => latest.current.onArrow?.(direction as Direction) ?? true,
      onArrowRelease: () => undefined,
      onFocus: (layout: FocusableComponentLayout, details: FocusDetails) => latest.current.onFocus?.(layout, details),
      onBlur: () => latest.current.onBlur?.(),
      onUpdateFocus: (value: boolean) => {
        if (latest.current.trackFocus === true) setFocused(value);
      },
      onUpdateHasFocusedChild: (value: boolean) => {
        if (latest.current.trackChildren === true) setHasFocusedChild(value);
      },
      saveLastFocusedChild: options.saveLastFocusedChild ?? true,
      trackChildren: options.trackChildren ?? false,
      isFocusBoundary: options.isFocusBoundary ?? false,
      focusBoundaryDirections: options.focusBoundaryDirections,
      autoRestoreFocus: true,
      forceFocus: false,
      focusable: options.focusable ?? true,
    });
    return () => {
      childCount[parentFocusKey] = (childCount[parentFocusKey] ?? 1) - 1;
      SpatialNavigation.removeFocusable({ focusKey });
    };
    // registration is per key (and parent); option changes go through updateFocusable below
  }, [focusKey, parentFocusKey]);

  useEffect(() => {
    const node = ref.current;
    if (node === null || !SpatialNavigation.doesFocusableExist(focusKey)) return;
    SpatialNavigation.updateFocusable(focusKey, {
      node,
      preferredChildFocusKey: options.preferredChildFocusKey,
      focusable: options.focusable ?? true,
      isFocusBoundary: options.isFocusBoundary ?? false,
      focusBoundaryDirections: options.focusBoundaryDirections,
      onEnterPress: () => latest.current.onEnter?.(),
      onEnterRelease: () => undefined,
      onArrowPress: (direction: string) => latest.current.onArrow?.(direction as Direction) ?? true,
      onArrowRelease: () => undefined,
      onFocus: (layout: FocusableComponentLayout, details: FocusDetails) => latest.current.onFocus?.(layout, details),
      onBlur: () => latest.current.onBlur?.(),
    });
  }, [focusKey, options.focusable, options.isFocusBoundary, options.preferredChildFocusKey, options.focusBoundaryDirections]);

  return {
    ref,
    focusKey,
    focused,
    hasFocusedChild,
    focusSelf: () => setFocus(focusKey),
  };
}

/** Children of this element register under `focusKey`. */
export function FocusGroup(props: { focusKey: string; children: ComponentChildren }) {
  return <ParentKey.Provider value={props.focusKey}>{props.children}</ParentKey.Provider>;
}
