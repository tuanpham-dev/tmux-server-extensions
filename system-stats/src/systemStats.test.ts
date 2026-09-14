import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendCpuSample,
  formatBytes,
  formatGb,
  formatUptime,
  levelOf,
  percentOf,
  systemStatRows,
  systemStatsSummary,
  type SystemStats,
  type SystemStatsDetail,
} from "./systemStats.ts";

// The vitest matchers these cases were first written against, over
// node:assert, so the cases read the same as they did in core.
function expect(actual: unknown) {
  const matchers = (negate: boolean) => ({
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBeNull: () => assert.equal(actual, null),
    toBeCloseTo: (expected: number, digits = 2) =>
      assert.ok(Math.abs((actual as number) - expected) < 10 ** -digits / 2, `${actual} ~ ${expected}`),
    toContain: (item: unknown) => {
      const has = (actual as string | unknown[]).includes(item as never);
      assert.equal(has, !negate, `${JSON.stringify(actual)} ${negate ? "contains" : "lacks"} ${JSON.stringify(item)}`);
    },
  });
  return { ...matchers(false), not: matchers(true) };
}

const GB = 1024 ** 3;

const stats: SystemStats = {
  memTotalBytes: 32 * GB,
  memUsedBytes: 8 * GB,
  cpuPercent: 12.4,
};

const detail: SystemStatsDetail = {
  cpuCount: 8,
  cpuModel: "AMD EPYC 7J13",
  loadAvg: [0.5, 1, 1.5],
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  disks: [{ path: "/", totalBytes: 100 * GB, usedBytes: 40 * GB, availableBytes: 55 * GB }],
  network: { rxBytesPerSec: 1.5 * 1024 * 1024, txBytesPerSec: 340 * 1024 },
  uptimeSeconds: 6 * 86400 + 4 * 3600,
  processCount: 312,
  hostname: "box-01",
  kernel: "linux 6.17.0",
};

const rows = (s: Partial<SystemStats> = {}, d: Partial<SystemStatsDetail> = {}) =>
  systemStatRows({ ...stats, ...s }, { ...detail, ...d });

describe("percentOf", () => {
  it("is the used share of the total", () => {
    expect(percentOf(1, 4)).toBe(25);
  });

  it("has no answer for a total of zero", () => {
    // A pseudo-filesystem reporting no blocks would otherwise render a
    // NaN-wide meter.
    expect(percentOf(0, 0)).toBeNull();
  });

  it("clamps a used figure that exceeds the total", () => {
    expect(percentOf(5, 4)).toBe(100);
  });
});

describe("levelOf", () => {
  it("stays normal through ordinary load", () => {
    expect(levelOf(74)).toBe("normal");
    expect(levelOf(null)).toBe("normal");
  });

  it("escalates at three quarters and at ninety percent", () => {
    expect(levelOf(75)).toBe("high");
    expect(levelOf(90)).toBe("critical");
  });
});

describe("formatBytes", () => {
  it("picks the unit that keeps the number short", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(8 * GB)).toBe("8.0 GB");
    expect(formatBytes(2048 * GB)).toBe("2.0 TB");
  });

  it("drops the decimal once there are three digits", () => {
    expect(formatBytes(512 * GB)).toBe("512 GB");
  });
});

describe("formatUptime", () => {
  it("drops to the two units that matter at each scale", () => {
    expect(formatUptime(6 * 86400 + 4 * 3600 + 30 * 60)).toBe("6d 4h");
    expect(formatUptime(4 * 3600 + 12 * 60)).toBe("4h 12m");
    expect(formatUptime(90)).toBe("1m");
  });

  it("has a reading for a host that just booted", () => {
    expect(formatUptime(0)).toBe("0m");
  });
});

describe("systemStatRows", () => {
  it("leads with CPU and memory, then each disk, then network", () => {
    expect(rows().map((r) => r.id)).toEqual(["cpu", "memory", "disk:/", "network"]);
  });

  it("carries the CPU percentage through untouched, including its absence", () => {
    // The first poll after a server start has only one sample of a counter
    // that only counts up, so there is no percentage to show yet.
    const unknown = rows({ cpuPercent: null })[0];
    expect(unknown.meter).toEqual({ percent: null });
    expect(unknown.value).toBe("-");
    expect(rows()[0].meter).toEqual({ percent: 12.4 });
  });

  it("reports the CPU core count, load average and model", () => {
    expect(rows()[0].detail).toBe("8 cores · load 0.50  1.00  1.50");
    expect(rows({}, { cpuCount: 1 })[0].detail).toContain("1 core ");
    expect(rows()[0].note).toBe("AMD EPYC 7J13");
  });

  it("measures memory against the total", () => {
    const memory = rows()[1];
    expect(memory.meter?.percent).toBe(25);
    expect(memory.value).toBe("25%");
    expect(memory.detail).toBe("8.0 GB of 32.0 GB · 24.0 GB free");
  });

  it("measures a disk against what a user can actually claim, as df does", () => {
    // 40 used + 55 available = 95, not the 100 total: the missing 5 GB is
    // reserved for root, and counting it as free would overstate the room.
    const disk = rows()[2];
    expect(disk.meter?.percent).toBeCloseTo((40 / 95) * 100, 6);
    expect(disk.detail).toBe("40.0 GB of 100 GB · 55.0 GB free");
  });

  it("labels each disk by its mount, and gives every row a distinct id", () => {
    const withHome = rows({}, {
      disks: [
        ...detail.disks,
        { path: "~", totalBytes: 500 * GB, usedBytes: 100 * GB, availableBytes: 400 * GB },
      ],
    });
    expect(withHome.map((r) => r.label)).toEqual(["CPU", "Memory", "Disk /", "Disk ~", "Network"]);
    expect(new Set(withHome.map((r) => r.id)).size).toBe(withHome.length);
  });

  it("survives a host that reports no disks at all", () => {
    expect(rows({}, { disks: [] }).map((r) => r.id)).toEqual(["cpu", "memory", "network"]);
  });

  it("shows swap only where there is swap to show", () => {
    // Most cloud instances have none, and a permanent 0% bar is noise.
    expect(rows().map((r) => r.id)).not.toContain("swap");
    const swapping = rows({}, { swapTotalBytes: 4 * GB, swapUsedBytes: 1 * GB });
    expect(swapping.map((r) => r.id)).toEqual(["cpu", "memory", "swap", "disk:/", "network"]);
    expect(swapping[2].detail).toBe("1.0 GB of 4.0 GB · 3.0 GB free");
    expect(swapping[2].value).toBe("25%");
  });

  it("gives network rates no meter, since throughput has no ceiling", () => {
    const network = rows()[3];
    expect(network.meter).toBeNull();
    expect(network.value).toBe("");
    expect(network.detail).toBe("↓ 1.5 MB/s   ↑ 340 KB/s");
  });

  it("drops the network row when there is no rate yet", () => {
    // Off Linux, or between a server start and its second sample.
    expect(rows({}, { network: null }).map((r) => r.id)).not.toContain("network");
  });
});

describe("systemStatsSummary", () => {
  it("names the host and how long it has been up", () => {
    expect(systemStatsSummary(detail)).toBe("box-01 · linux 6.17.0 · up 6d 4h · 312 processes");
  });

  it("leaves out a process count the host didn't report", () => {
    expect(systemStatsSummary({ ...detail, processCount: null })).toBe(
      "box-01 · linux 6.17.0 · up 6d 4h",
    );
  });
});

describe("formatGb", () => {
  it("shows one decimal of a gigabyte", () => {
    expect(formatGb(6.14 * GB)).toBe("6.1");
  });
});

describe("appendCpuSample", () => {
  it("adds a reading to the end", () => {
    expect(appendCpuSample([10, 20], 30)).toEqual([10, 20, 30]);
  });

  it("returns the same history for a reading with no percentage", () => {
    const history = [10, 20];
    assert.equal(appendCpuSample(history, null), history);
  });

  it("drops the oldest reading past the window", () => {
    const full = Array.from({ length: 40 }, (_, i) => i);
    const next = appendCpuSample(full, 99);
    expect(next.length).toBe(40);
    expect(next[0]).toBe(1);
    expect(next[39]).toBe(99);
  });
});
