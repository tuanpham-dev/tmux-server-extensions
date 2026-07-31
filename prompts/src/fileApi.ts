// Minimal copies of the host's own file-content helpers (client/src/api.ts
// and the bundled extensions' _shared/fileApi.ts) — the prompt editor reads
// and writes through the host's existing routes rather than adding file
// routes to this extension's server hook, exactly like the bundled csv/json
// viewers do.

export function downloadUrl(targetPath: string): string {
  return `/api/download?path=${encodeURIComponent(targetPath)}`;
}

export class NotFoundError extends Error {}

// Rejects with NotFoundError for a path that isn't there, so the editor can
// treat "no file yet" as an empty draft rather than a failure. The host's
// download route answers a missing path with 400 ("path is not a file or
// directory"), not 404 — and since this always sends a non-empty path, its
// only other 400 case ("path is required") can't happen here.
export async function fetchFileText(targetPath: string): Promise<string> {
  const res = await fetch(downloadUrl(targetPath));
  if (res.status === 400 || res.status === 404) throw new NotFoundError(`${targetPath} not found`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

// True if the path exists — a HEAD against the same download route, used for
// the save-time collision check.
export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    const res = await fetch(downloadUrl(targetPath), { method: "HEAD" });
    return res.ok;
  } catch {
    // Network/route failure is not evidence of absence; assume it exists so
    // a save falls into the "pick a name" dialog instead of overwriting.
    return true;
  }
}

async function errorMessage(res: Response): Promise<string> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string } | null;
    if (body?.error) message = body.error;
  } catch {
    // non-JSON error body; keep the status message
  }
  return message;
}

// Writes content back to targetPath via the host's upload route in overwrite
// mode — same mechanism CsvView's Save uses.
export async function saveFileText(targetPath: string, content: string): Promise<void> {
  const slash = targetPath.lastIndexOf("/");
  const dir = targetPath.slice(0, slash);
  const name = targetPath.slice(slash + 1);
  const url = `/api/upload?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(name)}&conflict=overwrite`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: content,
  });
  if (!res.ok) throw new Error(await errorMessage(res));
}

// Creates relativePath (nested segments included) under destDir — the host's
// own mkdir route, which is mkdir -p underneath, so calling it before every
// save is safe whether or not the prompts directory already exists.
export async function makeDir(destDir: string, relativePath: string): Promise<void> {
  const url = `/api/mkdir?dir=${encodeURIComponent(destDir)}&path=${encodeURIComponent(relativePath)}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
}
