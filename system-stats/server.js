// system-stats server hook: the host readings behind the status bar's memory
// item and the popover it opens. Moved out of tmux-server core, which used to
// serve the same shapes at /api/system-stats; the client reaches this at
// /api/ext/tmux-server.system-stats/stats through ctx.serverFetch.
import { statfs, readFile } from "node:fs/promises";
import path from "node:path";
import {
  cpus,
  freemem,
  homedir,
  hostname,
  loadavg,
  release,
  totalmem,
  type,
  uptime,
} from "node:os";

const HOME = homedir();

// "~/..." for anything under the home directory, the way core's file listings
// label paths. Display only.
function shortenHome(p) {
  if (HOME && (p === HOME || p.startsWith(HOME + path.sep))) return "~" + p.slice(HOME.length);
  return p;
}

// ---- Host statistics ----
//
// Served as two readings, because the status bar item polls this every 3 seconds
// for the whole life of a session while only the popover ever shows most of
// it. The plain reading is the bar's: memory, plus the CPU figure. `?detail=1`
// adds everything the popover draws — disks above all, whose statfs can block
// for as long as the filesystem takes to answer (a stalled NFS or fuse mount),
// which is not a thing to do every 3 seconds for a number nobody is looking
// at.
//
// The two readings that are *deltas* (CPU and network) are sampled on every
// request either way: they cost one cheap read each, and keeping them warm is
// what lets the popover show a real rate the instant it opens rather than "—"
// until its second poll.

// MemAvailable is the kernel's own estimate of what a new workload could
// claim without swapping — a far better "used" figure than total - free,
// which counts page cache as used and makes every healthy Linux box look
// full. /proc is Linux-only, so os.freemem() (which IS total - free) stands
// in elsewhere, with the same shape and a coarser meaning. Swap comes from
// the same read; a box without any reports zeroes, and the client drops the
// row rather than drawing an empty meter.
async function readMemory() {
  try {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const field = (name) => {
      const match = meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m"));
      return match ? Number(match[1]) * 1024 : null;
    };
    const total = field("MemTotal");
    const available = field("MemAvailable");
    const swapTotal = field("SwapTotal") ?? 0;
    const swapFree = field("SwapFree") ?? 0;
    if (total !== null && available !== null) {
      return {
        memTotalBytes: total,
        memUsedBytes: Math.max(0, total - available),
        swapTotalBytes: swapTotal,
        swapUsedBytes: Math.max(0, swapTotal - swapFree),
      };
    }
  } catch {
    // Not Linux, or /proc unreadable — fall through.
  }
  return {
    memTotalBytes: totalmem(),
    memUsedBytes: Math.max(0, totalmem() - freemem()),
    swapTotalBytes: 0,
    swapUsedBytes: 0,
  };
}

// CPU times are cumulative since boot, so a *percentage* only exists between
// two readings. Rather than busy-waiting inside the request for a window, the
// server keeps the previous reading and reports the delta since then: the
// status bar polls every few seconds, and "busy since your last poll" is
// exactly what a live readout wants. The first call after a start has nothing
// to compare against and reports null, which the client renders as "—".
const CPU_MIN_SAMPLE_MS = 750;
let lastCpuSample = null;
let lastCpuPercent = null;

function readCpuPercent() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === "idle") idle += ms;
    }
  }
  const now = Date.now();
  const prev = lastCpuSample;
  // Two clients polling milliseconds apart would otherwise each measure a
  // near-empty window and report noise; the second one gets the first one's
  // answer until the window is wide enough to mean something.
  if (prev && now - prev.at < CPU_MIN_SAMPLE_MS) return lastCpuPercent;
  lastCpuSample = { idle, total, at: now };
  if (!prev) return null;
  const dTotal = total - prev.total;
  if (dTotal <= 0) return lastCpuPercent;
  const busy = ((dTotal - (idle - prev.idle)) / dTotal) * 100;
  lastCpuPercent = Math.min(100, Math.max(0, busy));
  return lastCpuPercent;
}

// Network throughput, as a rate rather than the kernel's since-boot totals —
// nobody reads a counter that has been climbing for six weeks. Same
// delta-between-polls shape as the CPU figure above, and warmed on every
// request for the same reason.
//
// Loopback is excluded: this app proxies ports and carries terminal traffic
// over its own localhost, so counting lo would make an idle box look busy
// with nothing but itself.
const NET_MIN_SAMPLE_MS = 750;
let lastNetSample = null;
let lastNetRates = null;

async function readNetworkRates() {
  let rx = 0;
  let tx = 0;
  try {
    const text = await readFile("/proc/net/dev", "utf8");
    // Two header lines, then "  iface: rxBytes rxPackets ... txBytes ...".
    for (const line of text.split("\n").slice(2)) {
      const split = line.indexOf(":");
      if (split === -1) continue;
      if (line.slice(0, split).trim() === "lo") continue;
      const fields = line.slice(split + 1).trim().split(/\s+/);
      rx += Number(fields[0]) || 0;
      tx += Number(fields[8]) || 0;
    }
  } catch {
    // Not Linux — there is no rate to report, and the client drops the row.
    return null;
  }
  const now = Date.now();
  const prev = lastNetSample;
  if (prev && now - prev.at < NET_MIN_SAMPLE_MS) return lastNetRates;
  lastNetSample = { rx, tx, at: now };
  if (!prev) return null;
  const seconds = (now - prev.at) / 1000;
  // Clamped at zero rather than reported negative: these counters wrap on a
  // 32-bit kernel, and an interface going away takes its total with it.
  lastNetRates = {
    rxBytesPerSec: Math.max(0, (rx - prev.rx) / seconds),
    txBytesPerSec: Math.max(0, (tx - prev.tx) / seconds),
  };
  return lastNetRates;
}

// The total-processes field of /proc/loadavg ("running/total"), which the
// load average alone doesn't tell you — a load of 4 means something different
// on a box running 80 processes than on one running 2500.
async function readProcessCount() {
  try {
    const text = await readFile("/proc/loadavg", "utf8");
    const match = text.match(/\s\d+\/(\d+)\s/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// The filesystems worth showing: the root, and the one the user's files live
// on when that is genuinely a different one. Deduplicated on total capacity
// rather than on st_dev — an overlay root and the ext4 underneath it are two
// devices reporting one pool of space, and the common single-partition box
// would otherwise list the same numbers twice under two names. Capacity
// rather than the free counts because those move between the two statfs
// calls on a busy filesystem, which brought the duplicate row back. Two
// genuinely separate disks of byte-identical size would collapse into one
// row; a spurious duplicate is the more likely and more confusing of the
// two mistakes.
async function readDisks() {
  const disks = [];
  const seen = new Set();
  for (const target of ["/", homedir()]) {
    try {
      const fs = await statfs(target);
      const key = `${Number(fs.bsize) * Number(fs.blocks)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // bfree counts blocks free to root, bavail blocks free to everyone
      // else; used against bfree and free against bavail is what `df`
      // reports, so the percentages match what the user sees in a shell.
      const blockSize = Number(fs.bsize);
      disks.push({
        path: shortenHome(target),
        totalBytes: Number(fs.blocks) * blockSize,
        usedBytes: Math.max(0, Number(fs.blocks) - Number(fs.bfree)) * blockSize,
        availableBytes: Number(fs.bavail) * blockSize,
      });
    } catch {
      // A path that doesn't exist, or a platform without statfs — skip that
      // filesystem rather than failing the whole readout over it.
    }
  }
  return disks;
}

export function activate({ router }) {
  // Memory pressure for the bar, and with ?detail=1 everything the popover
  // shows beside it (see the readers above for why that is a separate
  // reading).
  router.get("/stats", async (req, res) => {
    try {
      const detailed = req.query.detail === "1";
      // Sampled on both paths - the delta readers need the history, and the
      // client wants a rate the moment it asks for one.
      const [memory, network] = await Promise.all([readMemory(), readNetworkRates()]);
      const cpuPercent = readCpuPercent();
      if (!detailed) {
        res.json({
          memTotalBytes: memory.memTotalBytes,
          memUsedBytes: memory.memUsedBytes,
          cpuPercent,
        });
        return;
      }
      const [disks, processCount] = await Promise.all([readDisks(), readProcessCount()]);
      const [load1, load5, load15] = loadavg();
      res.json({
        memTotalBytes: memory.memTotalBytes,
        memUsedBytes: memory.memUsedBytes,
        cpuPercent,
        detail: {
          cpuCount: cpus().length,
          // "Unknown" rather than an empty string: the client shows this
          // verbatim under the CPU row, and a blank line there reads as a
          // rendering bug.
          cpuModel: cpus()[0]?.model?.trim() || "Unknown CPU",
          loadAvg: [load1, load5, load15],
          swapTotalBytes: memory.swapTotalBytes,
          swapUsedBytes: memory.swapUsedBytes,
          disks,
          network,
          uptimeSeconds: uptime(),
          processCount,
          hostname: hostname(),
          kernel: `${type().toLowerCase()} ${release()}`,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
