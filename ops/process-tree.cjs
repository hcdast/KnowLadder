"use strict";
const fs = require("node:fs/promises"),
  { spawn } = require("node:child_process");
function parseStat(pid, text) {
  const split = text.lastIndexOf(")");
  const fields = text
    .slice(split + 2)
    .trim()
    .split(/\s+/);
  if (split < 0 || fields.length < 20 || !/^[0-9]+$/.test(fields[19]))
    throw Error("PROCESS_IDENTITY_UNCONFIRMED");
  return {
    pid: Number(pid),
    ppid: Number(fields[1]),
    start: fields[19],
    state: fields[0],
  };
}
async function snapshot(timeoutMs = 3000) {
  if (process.platform === "linux") {
    const entries = await fs.readdir("/proc");
    const rows = await Promise.all(
      entries
        .filter((p) => /^[0-9]+$/.test(p))
        .map(async (pid) => {
          try {
            return parseStat(
              pid,
              await fs.readFile("/proc/" + pid + "/stat", "utf8"),
            );
          } catch (error) {
            if (["ENOENT", "ESRCH"].includes(error.code)) return null;
            throw Error("PROCESS_IDENTITY_UNCONFIRMED");
          }
        }),
    );
    return rows.filter(Boolean);
  }
  if (process.platform !== "win32") throw Error("PROCESS_PLATFORM_UNSUPPORTED");
  return new Promise((resolve, reject) => {
    const script =
      "@(Get-CimInstance Win32_Process | ForEach-Object { @{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;start=$_.CreationDate.ToUniversalTime().Ticks.ToString();state='R'} }) | ConvertTo-Json -Compress";
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: {
          ...process.env,
          PSModulePath: require("node:path").join(
            process.env.SystemRoot,
            "System32/WindowsPowerShell/v1.0/Modules",
          ),
        },
      },
    );
    let output = "",
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (s) => {
      output += s;
      if (output.length > 2 * 1024 * 1024) {
        failed = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("PROCESS_IDENTITY_UNCONFIRMED"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        if (failed || code !== 0) throw Error();
        const rows = JSON.parse(output);
        if (
          !Array.isArray(rows) ||
          rows.some(
            (p) =>
              !Number.isInteger(p.pid) ||
              !Number.isInteger(p.ppid) ||
              !/^\d+$/.test(p.start),
          )
        )
          throw Error();
        resolve(rows);
      } catch {
        reject(Error("PROCESS_IDENTITY_UNCONFIRMED"));
      }
    });
  });
}
function descendants(rows, roots, excluded = new Set()) {
  const selected = new Set(roots.filter((pid) => !excluded.has(pid)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of rows)
      if (
        !excluded.has(p.pid) &&
        selected.has(p.ppid) &&
        !selected.has(p.pid)
      ) {
        selected.add(p.pid);
        changed = true;
      }
  }
  return rows.filter((p) => selected.has(p.pid));
}
function same(a, b) {
  return !!a && !!b && a.pid === b.pid && a.start === b.start;
}
function alive(row) {
  return row && !["Z", "X"].includes(row.state);
}
async function killVerified(
  expected,
  signal = "SIGKILL",
  take = snapshot,
  kill = (pid, s) => process.kill(pid, s),
) {
  const current = (await take()).find((p) => p.pid === expected.pid);
  if (!alive(current)) return true;
  if (!same(expected, current)) throw Error("PROCESS_IDENTITY_CHANGED");
  if (expected.pid <= 1 || expected.pid === process.pid)
    throw Error("PROCESS_IDENTITY_UNCONFIRMED");
  try {
    kill(expected.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw Error("PROCESS_STOP_UNCONFIRMED");
  }
  return true;
}
module.exports = {
  snapshot,
  parseStat,
  descendants,
  same,
  alive,
  killVerified,
};
