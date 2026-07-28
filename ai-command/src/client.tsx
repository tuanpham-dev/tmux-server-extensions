// ai-command: natural language → shell command via this extension's
// /generate server route (local claude CLI). Entry points: the "AI: Generate
// Command…" palette command and a "??" quick-switcher query. The result is
// typed at the active pane's prompt WITHOUT Enter — the user reviews and
// runs it themselves, always. Dialog UI mounts into its own react root
// (host's react-dom/client via the build shim) so it works with no panel
// anywhere — this extension has no sidebar presence at all.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { injectStylesheet } from "./injectStylesheet";

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;

const NO_CONTEXT: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
let activeContext: ActiveContext = NO_CONTEXT;

async function generate(query: string): Promise<string> {
  if (!serverFetch) throw new Error("extension not active");
  const res = await serverFetch("/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, cwd: activeContext.cwd ?? undefined }),
  });
  const body = (await res.json().catch(() => null)) as { command?: string; error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  if (!body?.command) throw new Error("no command returned");
  return body.command;
}

// Insert only — submit is never sent as true from this extension.
async function insertIntoActivePane(text: string): Promise<void> {
  const session = activeContext.sessionName;
  if (!session || !serverFetch) throw new Error("no active session");
  const res = await serverFetch("/type", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, text, submit: false }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
}

function GenerateDialog({ initialQuery, close }: { initialQuery: string; close: () => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A dialog opened from "??" starts generating immediately; run once.
  const autoRan = useRef(false);

  const submit = async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const command = await generate(q.trim());
      await insertIntoActivePane(command);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialQuery && !autoRan.current) {
      autoRan.current = true;
      void submit(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="aicmd-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <div className="aicmd-dialog" role="dialog" aria-label="AI: Generate Command">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(query);
          }}
        >
          <input
            className="aicmd-input"
            autoFocus
            disabled={busy}
            placeholder="Describe the command — e.g. list the 5 largest files here"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        {busy && (
          <div className="aicmd-status">
            <span className="aicmd-spinner" aria-hidden="true" />
            Generating (the local AI CLI can take a few seconds)…
          </div>
        )}
        {error && <div className="aicmd-error">{error}</div>}
        {!busy && (
          <div className="aicmd-hint">
            Enter generates and types the command at the prompt — it is never run automatically.
          </div>
        )}
      </div>
    </div>
  );
}

function openGenerateDialog(initialQuery = ""): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(<GenerateDialog initialQuery={initialQuery} close={close} />);
}

// ---- Activation ----

interface QuickSwitcherItem {
  label: string;
  tag?: string;
  run: (secondary: boolean) => void;
}

interface ExtensionContext {
  registerCommand(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerQuickSwitcherProvider(provider: {
    id: string;
    provideResults: (query: string) => QuickSwitcherItem[];
  }): { refresh(): void };
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
}

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerCommand({
    id: "generate",
    label: "AI: Generate Command…",
    run: () => openGenerateDialog(),
  });

  // "??<request>" in the quick switcher: one action row that opens the
  // dialog already generating — provideResults is called per keystroke, so
  // the LLM call itself must only ever start from an explicit Enter.
  ctx.registerQuickSwitcherProvider({
    id: "ask",
    provideResults: (query: string) => {
      if (!query.startsWith("??")) return [];
      const request = query.slice(2).trim();
      if (!request) return [];
      return [
        {
          label: `Ask AI: "${request}"`,
          tag: "ai",
          run: () => openGenerateDialog(request),
        },
      ];
    },
  });

  activeContext = ctx.app.getActiveContext();
  removeContextListener = ctx.app.onDidChangeContext((next) => {
    activeContext = next;
  });
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  removeContextListener?.();
  removeContextListener = null;
  serverFetch = null;
  activeContext = NO_CONTEXT;
}
