// Server hook for the prompts extension. Two routes, both one-shot calls to
// a locally installed AI CLI — Claude Code, OpenAI Codex, Google Gemini, or a
// custom command, chosen via the prompts.provider setting:
//   POST /refine        rewrite a draft prompt, returns the rewritten text
//   POST /suggest-name  propose a kebab-case filename for a prompt's content
// Nothing here writes files or executes any part of the model's reply — the
// editor saves through the host's own /api/upload route, and both replies are
// treated as plain text (the name is sanitized to a strict slug below).
// Deliberately a self-contained copy of ai-command's provider table rather
// than a shared import: each extension talks only to its own activate()
// context.
import { execFile } from "node:child_process";

const CLI_TIMEOUT = 60_000;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_NAME_LENGTH = 60;

const DEFAULT_REFINE_INSTRUCTION =
  "Rewrite the following prompt so it is clearer, more specific, and better structured for an AI coding agent. " +
  "Keep the author's intent and every concrete detail; do not invent requirements. " +
  "Reply with ONLY the rewritten prompt - no preamble, no commentary, no code fences.";

const NAME_INSTRUCTION =
  "Suggest a filename for the following prompt, describing what it is about. " +
  "Use 2-5 lowercase words joined by hyphens (kebab-case), no file extension, no path, no quotes. " +
  "Reply with ONLY the filename.";

// Each provider: default binary plus how its CLI takes a one-shot prompt and
// an optional model. All are "print the reply and exit" invocations — no
// interactive/agent modes.
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

// Strips a wrapping markdown code fence if the model added one despite the
// instruction. Unlike ai-command's extractCommand, everything between the
// fences is kept: a refined prompt is legitimately multi-line, and inner
// fenced blocks (example code the prompt refers to) must survive — so only a
// fence on the very first and very last line is removed.
function stripWrappingFence(reply) {
  const lines = reply.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length >= 2 && /^```/.test(lines[0]) && /^```\s*$/.test(lines[lines.length - 1])) {
    return lines.slice(1, -1).join("\n").trim();
  }
  return lines.join("\n").trim();
}

// The real guard on the filename: whatever the model replies is reduced to
// [a-z0-9-], so a chatty answer, a path, or an extension can't escape the
// prompts directory or become a surprising filename. Empty means "unusable"
// and the client falls back to its own slug of the prompt text.
function sanitizeName(reply) {
  const firstLine = reply.replace(/\r\n/g, "\n").trim().split("\n").find((l) => l.trim()) ?? "";
  return firstLine
    .trim()
    .toLowerCase()
    .replace(/\.(prompt\.)?md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
}

export function activate({ router, getSettings }) {
  // Resolves the configured provider into a spawnable (bin, args) pair for a
  // single one-shot prompt, or an { error } for a misconfigured custom
  // provider.
  async function resolveInvocation(prompt) {
    const settings = await getSettings();
    const providerId = typeof settings["prompts.provider"] === "string" ? settings["prompts.provider"] : "claude";
    const binaryOverride =
      typeof settings["prompts.binaryPath"] === "string" ? settings["prompts.binaryPath"].trim() : "";
    const model = typeof settings["prompts.model"] === "string" ? settings["prompts.model"].trim() : "";
    const customCommand =
      typeof settings["prompts.customCommand"] === "string" ? settings["prompts.customCommand"].trim() : "";

    if (providerId === "custom") {
      if (!customCommand) {
        return { error: "custom provider selected but no custom command is configured" };
      }
      // The user's own configured command line, run via sh with the prompt
      // appended as its single argument ($0 of the -c script) — quoting
      // inside customCommand is the user's, prompt content never needs any.
      return { providerId, bin: "/bin/sh", args: ["-c", `${customCommand} "$0"`, prompt] };
    }
    const provider = PROVIDERS[providerId] ?? PROVIDERS.claude;
    return { providerId, bin: binaryOverride || provider.bin, args: provider.args(prompt, model) };
  }

  function runCli({ providerId, bin, args }, res, onSuccess) {
    execFile(bin, args, { encoding: "utf8", timeout: CLI_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
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
      onSuccess(stdout);
    });
  }

  function requireContent(req, res) {
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!content.trim()) {
      res.status(400).json({ error: "content is required" });
      return null;
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      res.status(400).json({ error: "prompt too long" });
      return null;
    }
    return content;
  }

  router.post("/refine", async (req, res) => {
    const content = requireContent(req, res);
    if (content === null) return;
    const settings = await getSettings();
    const configured =
      typeof settings["prompts.refineInstruction"] === "string" ? settings["prompts.refineInstruction"].trim() : "";
    const instruction = configured || DEFAULT_REFINE_INSTRUCTION;

    const invocation = await resolveInvocation(`${instruction}\n\n---\n\n${content}`);
    if (invocation.error) {
      res.status(400).json({ error: invocation.error });
      return;
    }
    runCli(invocation, res, (stdout) => {
      const text = stripWrappingFence(stdout);
      if (!text) {
        res.status(502).json({ error: `${invocation.providerId} returned an empty prompt` });
        return;
      }
      res.json({ text });
    });
  });

  router.post("/suggest-name", async (req, res) => {
    const content = requireContent(req, res);
    if (content === null) return;
    // Only the head of the prompt is needed to name it, and a short input
    // keeps this call much faster than /refine.
    const excerpt = content.slice(0, 4000);
    const invocation = await resolveInvocation(`${NAME_INSTRUCTION}\n\n---\n\n${excerpt}`);
    if (invocation.error) {
      res.status(400).json({ error: invocation.error });
      return;
    }
    runCli(invocation, res, (stdout) => {
      const name = sanitizeName(stdout);
      if (!name) {
        res.status(502).json({ error: `${invocation.providerId} returned no usable filename` });
        return;
      }
      res.json({ name });
    });
  });
}
