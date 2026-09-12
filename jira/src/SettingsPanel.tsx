// The API token field, rendered by registerSettingsComponent below the
// extension's scalar settings. The token is deliberately not a manifest
// property: it lives in the host's per-extension secret store, which no
// client can read back. So this component only ever learns whether one is
// set (GET /token -> { set }), never its value, and drops what you typed as
// soon as the write lands.
import { useCallback, useEffect, useState } from "react";

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

let serverFetch: Fetcher | null = null;

export function setFetcher(fetcher: Fetcher): void {
  serverFetch = fetcher;
}

// The token is not a setting, so ctx.settings.onDidChange never fires for it —
// without this the sidebar panel would keep showing "add an API token" until
// something else made it refetch /status. Saving here tells it to re-check.
const tokenListeners = new Set<() => void>();

export function onTokenChange(cb: () => void): () => void {
  tokenListeners.add(cb);
  return () => tokenListeners.delete(cb);
}

export default function SettingsPanel() {
  const [set, setSet] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!serverFetch) return;
    serverFetch("/token")
      .then((res) => res.json())
      .then((body: { set: boolean }) => setSet(body.set))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const write = useCallback(
    async (next: string) => {
      if (!serverFetch) return;
      setBusy(true);
      setError(null);
      try {
        const res = await serverFetch("/token", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: next }),
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        setValue("");
        refresh();
        for (const cb of tokenListeners) cb();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // Deliberately the same markup and host classes as core's own API key field
  // (client/src/components/settings/AiSection.tsx's ApiKeyField): settings-row
  // wrapper, a settings-label whose trailing settings-hint carries the
  // stored/not-set state, dialog-input for the box, and dialog-button
  // primary/secondary for Save/Clear. Extensions render inside the app's DOM,
  // so reusing its classes is what keeps this field looking native in every
  // theme instead of falling back to the browser's own control styling.
  return (
    <div className="settings-row">
      <span className="settings-label">
        API token{" "}
        <span className="settings-hint">- {set === null ? "checking…" : set ? "stored" : "not set"}</span>
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          id="jira-api-token"
          className="dialog-input"
          style={{ flex: 1 }}
          type="password"
          autoComplete="off"
          placeholder={set ? "Stored - type to replace" : "Paste your Atlassian API token"}
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) void write(value);
          }}
        />
        <button className="dialog-button primary" disabled={busy || !value.trim()} onClick={() => void write(value)}>
          Save
        </button>
        {set && (
          <button className="dialog-button secondary" disabled={busy} onClick={() => void write("")}>
            Clear
          </button>
        )}
      </div>
      {error && <div className="settings-hint settings-error">{error}</div>}
    </div>
  );
}
