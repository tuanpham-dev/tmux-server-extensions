// Server hook for the prompts extension. Two routes, both one-shot calls to
// the app's shared AI backend (ctx.ai — configured once in Settings → AI Providers, see
// the host's server/src/ai.ts):
//   POST /refine        rewrite a draft prompt, returns the rewritten text
//   POST /suggest-name  propose a kebab-case filename for a prompt's content
// Nothing here writes files or executes any part of the model's reply — the
// editor saves through the host's own /api/upload route, and both replies are
// treated as plain text (the name is sanitized to a strict slug below).
//
// This used to hold a self-contained copy of ai-command's provider table,
// because an extension talks only to its own activate() context and there was
// nothing shared to import. Core now owns the provider table and the four
// settings that drove it, so the copy is gone and this contributes only its
// two prompts.

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

export function activate({ router, getSettings, ai }) {
  // Shared by both routes: ask the configured AI, map its typed "you haven't
  // configured this yet" errors to 400 and real failures to 502.
  async function ask(prompt, res, onText) {
    try {
      // prompts.aiProfile names one of the AIs configured in Settings → AI Providers;
      // empty (the default) lets the app's default profile answer.
      const settings = (await getSettings?.()) ?? {};
      const profileId =
        typeof settings["prompts.aiProfile"] === "string" ? settings["prompts.aiProfile"].trim() : "";
      // Empty falls back to that profile's own model — "use the provider's
      // setting" — which is what ai.run does with no model of its own.
      const model =
        typeof settings["prompts.aiModel"] === "string" ? settings["prompts.aiModel"].trim() : "";
      const reply = await ai.run(prompt, {
        ...(profileId ? { profileId } : {}),
        ...(model ? { model } : {}),
      });
      onText(reply);
    } catch (err) {
      const code = err?.code;
      const configIssue =
        code === "missing-binary" || code === "missing-key" || code === "missing-model" || code === "missing-command";
      res.status(configIssue ? 400 : 502).json({ error: String(err?.message ?? err) });
    }
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

    await ask(`${instruction}\n\n---\n\n${content}`, res, (reply) => {
      const text = stripWrappingFence(reply);
      if (!text) {
        res.status(502).json({ error: "the AI returned an empty prompt" });
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
    await ask(`${NAME_INSTRUCTION}\n\n---\n\n${excerpt}`, res, (reply) => {
      const name = sanitizeName(reply);
      if (!name) {
        res.status(502).json({ error: "the AI returned no usable filename" });
        return;
      }
      res.json({ name });
    });
  });
}
