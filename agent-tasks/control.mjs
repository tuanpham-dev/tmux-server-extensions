// The control socket: how a worker, from inside its own tmux pane, talks to
// this extension - and how automations talks to it from its own server hook.
//
// Why a unix socket and not /api/ext/...: reaching the HTTP API needs the
// app's auth token, which core deliberately strips from every pane's
// environment (spawnEnv.ts). A socket at a 0600 path in a 0700 directory is
// reachable by exactly the user who owns the app and nobody else, with no
// token and no change to core's security model
// (plans/agent-orchestration-and-automations.md, decision 1).
//
// Plain HTTP over the socket, one verb per path: `POST /<verb>` with a JSON
// body, answered with JSON (or text, for dispatch-show). curl speaks it with
// --unix-socket, which is all cli/agent-task is. `subscribe` is the one
// long-lived verb: newline-delimited JSON of lifecycle transitions until the
// client hangs up.
//
// Every handler is wrapped: a rejection becomes a JSON error response, never
// an unhandled rejection - the core this runs in may be one that exits the
// whole server on one.
import { chmod, mkdir, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const MAX_BODY_BYTES = 1024 * 1024;

export class ControlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ControlError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseBody(raw) {
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ControlError(400, "request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControlError(400, "request body must be a JSON object");
  }
  return parsed;
}

function sendJson(res, status, value) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// handlers: { [verb]: async (body, { req, res }) => result }
//   result undefined         the handler wrote the response itself (subscribe)
//   result { text }          text/plain
//   result anything else     200 JSON
// A thrown ControlError picks its status; anything else is a 500.
export function createControlServer({ socketPath, handlers, log = console.log }) {
  let server = null;

  async function handle(req, res) {
    try {
      if (req.method !== "POST" && req.method !== "GET") throw new ControlError(405, "use POST");
      const verb = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname.replace(/^\/+/, ""));
      const handler = Object.hasOwn(handlers, verb) ? handlers[verb] : null;
      if (!handler) throw new ControlError(404, `unknown verb "${verb}" - run agent-task help`);
      const body = parseBody(await readBody(req));
      const result = await handler(body, { req, res });
      if (result === undefined) return;
      if (result && typeof result === "object" && typeof result.text === "string" && Object.keys(result).length === 1) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(result.text);
        return;
      }
      sendJson(res, 200, result);
    } catch (err) {
      const status = err instanceof ControlError ? err.status : typeof err?.status === "number" ? err.status : 500;
      if (status >= 500) log(`control socket: ${req.url} failed:`, err?.stack ?? err);
      sendJson(res, status, { error: err?.message ?? String(err) });
    }
  }

  return {
    socketPath,

    async start() {
      if (server) return;
      await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(socketPath), 0o700).catch(() => {});
      // A socket file left by a previous process (or a crash) makes listen()
      // fail with EADDRINUSE even though nothing is listening on it.
      await unlink(socketPath).catch((err) => {
        if (err.code !== "ENOENT") throw err;
      });
      const next = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          log("control socket: handler escaped:", err);
          try {
            sendJson(res, 500, { error: "internal error" });
          } catch {
            // the connection is already gone
          }
        });
      });
      // Long-poll `check --wait` and `subscribe` hold connections open.
      next.requestTimeout = 0;
      next.headersTimeout = 60_000;
      next.keepAliveTimeout = 5_000;
      next.on("error", (err) => log("control socket error:", err));
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        next.once("error", onError);
        next.listen(socketPath, () => {
          next.off("error", onError);
          resolve();
        });
      });
      await chmod(socketPath, 0o600);
      server = next;
    },

    // Closes the listener and every open connection (subscribe streams and
    // long polls included), then removes the socket file.
    async stop() {
      const current = server;
      server = null;
      if (!current) return;
      await new Promise((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
      await unlink(socketPath).catch(() => {});
    },

    isListening() {
      return server !== null;
    },
  };
}
