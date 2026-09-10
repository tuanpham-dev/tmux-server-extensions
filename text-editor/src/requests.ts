// Hand-off between this extension's editor callbacks and the viewer
// components they open.
//
// ctx.app.openViewerTab only carries a *path* string, so anything richer than
// a path — a line to jump to, both sides of a diff, the stages of a merge —
// has to be parked here and picked up by the component when it mounts. Keys
// are the same strings passed as the viewer path, so a lookup can't collide
// with another tab.

interface OpenFileRequest {
  line?: number;
}

// Keyed by the real file path: a plain file open is always for a path, and a
// second open of the same path replaces the pending request rather than
// queueing behind it.
const fileRequests = new Map<string, OpenFileRequest>();

export function setFileRequest(path: string, req: OpenFileRequest): void {
  fileRequests.set(path, req);
}

/** Reads and clears the pending request for `path`, if any. */
export function takeFileRequest(path: string): OpenFileRequest | undefined {
  const req = fileRequests.get(path);
  fileRequests.delete(path);
  return req;
}

// ---- Diff and merge requests ----
// A diff or a merge has no single path to key on (one side is often index or
// HEAD text that exists nowhere on disk), so each open mints its own key and
// that key is what the viewer tab is opened with.
//
// Entries are never deleted when a viewer unmounts. React remounts a component
// for reasons the component can't see — StrictMode's double mount in
// development, a re-render of the split layout when tabs change — and an entry
// dropped on the first unmount leaves the remounted viewer with nothing to
// show. Instead the map is capped: old entries fall off once it grows past
// MAX_REQUESTS, which bounds memory without ever pulling the rug from a live
// tab. Each entry is a couple of file-sized strings.
const MAX_REQUESTS = 50;

// Drops the oldest entries once `map` grows past the cap. Map iteration is
// insertion-ordered, so the first keys are the oldest.
function trim<T>(map: Map<string, T>): void {
  while (map.size > MAX_REQUESTS) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export interface DiffSide {
  content: string;
  label: string;
  path?: string;
  readOnlyReason?: string;
}

export interface DiffRequest {
  title: string;
  original: DiffSide;
  modified: DiffSide;
}

let diffSeq = 0;
const diffRequests = new Map<string, DiffRequest>();

/** Parks a diff and returns the key to open a viewer tab with. */
export function registerDiffRequest(req: DiffRequest): string {
  const key = `diff:${++diffSeq}`;
  diffRequests.set(key, req);
  trim(diffRequests);
  return key;
}

export function getDiffRequest(key: string): DiffRequest | undefined {
  return diffRequests.get(key);
}



// ---- Merge requests ----
// Same hand-off and the same never-delete policy as diffs. The conflicted
// working file is edited in place, so the request carries the merge stages only
// for the compare action, plus the callback that stages the file once resolved.

export interface MergeRequest {
  title: string;
  path: string;
  ours: { content: string; label: string };
  theirs: { content: string; label: string };
  base?: { content: string; label: string } | null;
  markResolved: () => Promise<void>;
}

let mergeSeq = 0;
const mergeRequests = new Map<string, MergeRequest>();

export function registerMergeRequest(req: MergeRequest): string {
  const key = `merge:${++mergeSeq}`;
  mergeRequests.set(key, req);
  trim(mergeRequests);
  return key;
}

export function getMergeRequest(key: string): MergeRequest | undefined {
  return mergeRequests.get(key);
}


