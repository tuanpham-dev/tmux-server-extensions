// One poll of the server hook's /stats route, however many things are
// watching it, at whichever depth the deepest watcher needs.
//
// The status bar item and the popover it opens are two separate subscribers,
// and the popover's content is a node the host captured at click time. A
// component that fetched for itself would both double the request rate and,
// once that captured node went stale, be the only thing still moving.
// Subscribing to a module singleton solves both.
//
// It also decides how much the server does per poll. The item needs memory;
// everything else in the reading exists only for the popover, and asking for
// it includes a statfs per filesystem, which can block for as long as a
// stalled mount takes to answer. So the detailed reading is requested only
// while something is actually rendering it - see useDetailedSystemStats.

import { useSyncExternalStore } from "react";
import type { SystemStats } from "./systemStats";

const POLL_INTERVAL_MS = 3000;

type ServerFetch = (path: string, init?: RequestInit) => Promise<Response>;

let serverFetch: ServerFetch | null = null;
let current: SystemStats | null = null;
const listeners = new Set<() => void>();
let detailWatchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function setServerFetch(fn: ServerFetch | null): void {
  serverFetch = fn;
}

function load(): void {
  const fetchStats = serverFetch;
  if (!fetchStats || document.hidden) return;
  fetchStats(detailWatchers > 0 ? "/stats?detail=1" : "/stats")
    .then((res) => {
      if (!res.ok) throw new Error(`stats ${res.status}`);
      return res.json() as Promise<SystemStats>;
    })
    .then((next) => {
      // Deactivated while the request was out: drop the late answer rather
      // than waking components that are about to unmount.
      if (serverFetch !== fetchStats) return;
      // A light reading has no detail block, but keeping the last one means
      // reopening the popover paints the previous numbers immediately rather
      // than flashing a loading line - the detailed poll that the reopening
      // itself fires replaces them a moment later.
      current = next.detail ? next : { ...next, detail: current?.detail };
      for (const listener of listeners) listener();
    })
    // A failed poll leaves the last reading on screen rather than blanking
    // the item or raising a banner - this is ambient information, not
    // something worth interrupting anyone over.
    .catch(() => {});
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // First watcher starts the feed; the rest ride it. A late subscriber (the
  // popover opening) paints immediately from `current` and then follows the
  // same interval, so opening it costs no extra request.
  if (listeners.size === 1) {
    load();
    timer = setInterval(load, POLL_INTERVAL_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// null until the first poll answers. The reference only changes when a poll
// succeeds, which is what useSyncExternalStore needs of a snapshot.
export function useSystemStats(): SystemStats | null {
  return useSyncExternalStore(subscribe, () => current);
}

function subscribeDetailed(onChange: () => void): () => void {
  detailWatchers++;
  const unsubscribe = subscribe(onChange);
  // Don't make the popover wait up to a full interval for the block it
  // exists to render: ask for a detailed reading the moment one is wanted.
  // (Skipped when subscribe() has just fired that same request for the first
  // watcher.)
  if (listeners.size > 1) load();
  return () => {
    detailWatchers--;
    unsubscribe();
  };
}

// Same snapshot as useSystemStats, but the detailed one: while a component
// using this is mounted, every poll asks the server for the full reading.
export function useDetailedSystemStats(): SystemStats | null {
  return useSyncExternalStore(subscribeDetailed, () => current);
}

// For deactivate(): stop polling and forget the last reading, so a later
// re-enable starts from a fresh first poll.
export function resetStatsStore(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  serverFetch = null;
  current = null;
}
