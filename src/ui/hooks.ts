import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import { mediaPool } from "../engine/sharedPool";
import { playback } from "../engine/PlaybackEngine";

/**
 * Assets whose media failed to load.
 *
 * `MediaPool` owns the failure detection (a media element's `error` event); this
 * just exposes it to React. A version counter is the snapshot because an array
 * would be a fresh reference on every read and would loop `useSyncExternalStore`.
 */
let offlineVersion = 0;
let offlineBound = false;

function bindOffline(): void {
  if (offlineBound) return;
  offlineBound = true;
  mediaPool.onOfflineChange(() => {
    offlineVersion += 1;
  });
}

export function useOfflineAssets(): string[] {
  bindOffline();
  const version = useSyncExternalStore(
    (listener) => mediaPool.onOfflineChange(listener),
    () => offlineVersion,
    () => offlineVersion,
  );
  return useMemo(() => mediaPool.offlineAssetIds(), [version]);
}

/**
 * Subscribes a component to the playhead.
 *
 * `throttleMs` of 0 follows every frame (used by the playhead marker and the
 * canvas); a larger value keeps text readouts from re-rendering 60 times a
 * second while still feeling live.
 */
export function usePlayhead(throttleMs = 0): number {
  const [time, setTime] = useState(() => playback.time);

  useEffect(() => {
    if (throttleMs <= 0) {
      return playback.onFrame((t) => setTime(t));
    }
    let last = 0;
    return playback.onFrame((t) => {
      const now = performance.now();
      if (now - last >= throttleMs) {
        last = now;
        setTime(t);
      }
    });
  }, [throttleMs]);

  return time;
}

/** Tracks whether the transport is running. */
export function usePlaying(): boolean {
  const [playing, setPlaying] = useState(() => playback.playing);
  useEffect(() => playback.onFrame((_t, p) => setPlaying(p)), []);
  return playing;
}

/** 订阅播放速率变化（J/K/L 键或速率按钮都会改 rate）。 */
export function useRate(): number {
  const [rate, setRate] = useState(() => playback.rate);
  const ref = useRef(rate);
  ref.current = rate;
  useEffect(() => {
    return playback.onFrame(() => {
      if (playback.rate !== ref.current) setRate(playback.rate);
    });
  }, []);
  return rate;
}

/**
 * 订阅入/出点变化。
 *
 * `markIn`/`markOut`/`clearIn`/`clearOut` 都会把 playback 标脏并 emit，但
 * `usePlayhead` 只比较 time，time 不变就不 setState——所以入出点变化不会触发
 * Transport 重渲染。这里专门盯住 inPoint/outPoint 的变化。
 */
export function useInOutPoints(): { inPoint: number | null; outPoint: number | null } {
  const [points, setPoints] = useState(() => ({
    inPoint: playback.inPoint,
    outPoint: playback.outPoint,
  }));
  const ref = useRef(points);
  ref.current = points;
  useEffect(() => {
    return playback.onFrame(() => {
      const cur = ref.current;
      if (playback.inPoint !== cur.inPoint || playback.outPoint !== cur.outPoint) {
        setPoints({ inPoint: playback.inPoint, outPoint: playback.outPoint });
      }
    });
  }, []);
  return points;
}

/** Observes an element's box, for canvas fitting and virtualised lists. */
export function useElementSize<T extends HTMLElement>(): [
  RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  return [ref, size];
}

/**
 * Keeps a callback in a ref so effects can depend on stable identities without
 * re-subscribing on every render.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Fires `handler` when a click lands outside `ref`. */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) handler();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref, handler, enabled]);
}
