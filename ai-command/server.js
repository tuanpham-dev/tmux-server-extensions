// Server hook for the ai-command extension: POST /generate shells out to a
// locally installed AI CLI — Claude Code, OpenAI Codex, Google Gemini, or a
// custom command, chosen via the aiCommand.provider setting — and returns
// one shell command; POST /type inserts text into the active pane (the same
// self-contained send-keys route the bundled command-history and snippets
// extensions carry). The generated command is only ever RETURNED and
// inserted at the prompt — nothing here executes it.
import { execFile } from "node:child_process";

const GENERATE_TIMEOUT = 60_000;
const TMUX_TIMEOUT = 5000;
const MAX_QUERY_LENGTH = 1000;
const MAX_TEXT_LENGTH = 4096;

// Each provider: default binary plus how its CLI takes a one-shot prompt
// and an optional model. All are "print the reply and exit" invocations —
// no interactive/agent modes.
const PROVIDERS = {
  claude: {
    bin: "claude",
    args: (prompt, model) => ["-p", ...(model ? ["--model", model] : []), prompt],
  },
  codex: {
    bin: "codex",
    args: (prompt, model) => ["exec", ...(model ? ["-m", model] : []), prompt],
  },
  gemini: {
    bin: "gemini",
    args: (prompt, model) => [...(model ? ["-m", model] : []), "-p", prompt],
  },
};

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8", timeout: TMUX_TIMEOUT }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

// Strips markdown code fences and a leading "$ " if the model added them
// despite the prompt, then keeps the LAST non-empty line: a well-behaved
// reply is one line either way, and a chatty provider (session banners,
// reasoning preamble) puts the answer at the end, not the start.
function extractCommand(reply) {
  const unfenced = reply.replace(/^```[a-z]*\n?/gim, "").replace(/```/g, "");
  const lines = unfenced.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim().replace(/^\$\s+/, "");
    if (trimmed) return trimmed;
  }
  return "";
}

export function activate({ router, getSettings }) {
  router.post("/generate", async (req, res) => {
    const { query, cwd } = req.body ?? {};
    if (typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    if (query.length > MAX_QUERY_LENGTH) {
      res.status(400).json({ error: "query too long" });
      return;
    }
    const settings = await getSettings();
    const providerId = typeof settings["aiCommand.provider"] === "string" ? settings["aiCommand.provider"] : "claude";
    const binaryOverride = typeof settings["aiCommand.binaryPath"] === "string" ? settings["aiCommand.binaryPath"].trim() : "";
    const model = typeof settings["aiCommand.model"] === "string" ? settings["aiCommand.model"].trim() : "";
    const customCommand =
      typeof settings["aiCommand.customCommand"] === "string" ? settings["aiCommand.customCommand"].trim() : "";

    const prompt =
      "Convert this request into exactly one shell command for a POSIX shell on Linux. " +
      "Reply with ONLY the command itself - no prose, no explanation, no code fences, no leading $.\n" +
      (typeof cwd === "string" && cwd ? `Current directory: ${cwd}\n` : "") +
      `Request: ${query.trim()}`;

    let bin;
    let args;
    if (providerId === "custom") {
      if (!customCommand) {
        res.status(400).json({ error: "custom provider selected but no custom command is configured" });
        return;
      }
      // The user's own configured command line, run via sh with the prompt
      // appended as its single argument ($0 of the -c script) — quoting
      // inside customCommand is the user's, prompt content never needs any.
      bin = "/bin/sh";
      args = ["-c", `${customCommand} "$0"`, prompt];
    } else {
      const provider = PROVIDERS[providerId] ?? PROVIDERS.claude;
      bin = binaryOverride || provider.bin;
      args = provider.args(prompt, model);
    }

    execFile(bin, args, { encoding: "utf8", timeout: GENERATE_TIMEOUT, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || "").trim().slice(0, 300);
        const missing = /ENOENT/.test(err.message ?? "");
        res.status(502).json({
          error: missing
            ? `${providerId} CLI not found ("${bin}") — install it, or pick another provider / set a binary path in this extension's settings`
            : `${providerId} CLI failed: ${detail || "unknown error"}`,
        });
        return;
      }
      const command = extractCommand(stdout);
      if (!command) {
        res.status(502).json({ error: `${providerId} returned no command` });
        return;
      }
      res.json({ command });
    });
  });

  router.post("/type", async (req, res) => {
    const { session, text, submit } = req.body ?? {};
    if (typeof session !== "string" || !session || typeof text !== "string" || !text) {
      res.status(400).json({ error: "session and text are required" });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: "text too long" });
      return;
    }
    try {
      await tmux(["send-keys", "-t", `=${session}:`, "-l", "--", text]);
      // AI-generated commands are never auto-run, but the route keeps the
      // flag for parity with its siblings — the client never sends true.
      if (submit === true) {
        await tmux(["send-keys", "-t", `=${session}:`, "Enter"]);
      }
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
