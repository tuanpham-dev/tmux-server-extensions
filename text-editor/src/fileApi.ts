// Minimal copies of the host's own file-content helpers (client/src/api.ts
// and the bundled extensions' _shared/fileApi.ts) — this editor reads and
// writes through the host's existing routes rather than adding file routes
// to a server hook, exactly like the bundled csv/json viewers do.

export function downloadUrl(targetPath: string): string {
  return `/api/download?path=${encodeURIComponent(targetPath)}`;
}

export async function fetchFileText(targetPath: string): Promise<string> {
  const res = await fetch(downloadUrl(targetPath));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
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
