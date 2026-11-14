import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface SandboxResult {
  status: "passed" | "failed" | "timed_out" | "unavailable";
  detail: string;
}

const digest = /^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/;
const unavailable = (detail: string): SandboxResult => ({ status: "unavailable", detail });

// This preflight runs before the source is loaded. It also catches rootless
// engines that warn about unsupported limits and silently ignore a request.
const preflight = `
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
try {
  const read = path => readFileSync(path, "utf8").trim();
  const limit = name => read("/sys/fs/cgroup/" + name);
  const [quota, period] = limit("cpu.max").split(" ").map(Number);
  const status = read("/proc/self/status");
  if (process.versions.node.split(".")[0] !== "24" || process.getuid() !== 65534 ||
      !/^NoNewPrivs:\\s+1$/m.test(status) || !/^CapEff:\\s+0+$/m.test(status) ||
      !/^Seccomp:\\s+2$/m.test(status) || !(Number(limit("memory.max")) <= 268435456) ||
      !(Number(limit("pids.max")) <= 48) || !(quota > 0 && quota <= period) ||
      !Object.keys(networkInterfaces()).every(name => name === "lo")) process.exit(78);
} catch { process.exit(78); }
`;

interface CommandResult { code: number | null; timedOut: boolean; output: string }

// Query output is small and bounded. Source-controlled test output is discarded
// at the OS boundary, so it cannot grow a transcript or enter reports.
function podman(args: string[], timeout: number, source?: string): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const name of ["HOME", "USER", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return new Promise(resolve => {
    const child = spawn("podman", ["--remote=false", ...args], {
      env, cwd: "/", stdio: [source === undefined ? "ignore" : "pipe", source === undefined ? "pipe" : "ignore", "ignore"],
    });
    let size = 0;
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 4096) output += chunk.toString("utf8");
      else child.kill("SIGKILL");
    });
    // Early node/engine exit can close stdin before the source is delivered.
    child.stdin?.on("error", () => {});
    child.stdin?.end(source);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output: output.trim() });
    };
    child.once("error", () => finish(null));
    child.once("close", finish);
  });
}

function validateCheck(source: string, image: string, timeoutMs: number): SandboxResult | undefined {
  if (!digest.test(image) || image.length !== "docker.io/library/node@sha256:".length + 64) {
    return unavailable("Select a preloaded official Node image by its exact sha256 digest.");
  }
  if (!source.trim() || Buffer.byteLength(source) > 128 * 1024) {
    return unavailable("The test must contain at most 128 KiB of nonempty source.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30000) {
    return unavailable("The check deadline must be between 500 and 30000 milliseconds.");
  }
  if (process.platform !== "linux" || process.getuid?.() === 0) {
    return unavailable("Run this check as a non-root user on Linux with rootless Podman.");
  }
}

export function checkProfile(name: string, image: string, timeoutMs: number) {
  return [
    "create", "--name", name, "--rm", "--interactive", "--pull=never",
    "--network=none", "--pid=private", "--ipc=private", "--cgroupns=private",
    "--user=65534:65534", "--read-only", "--read-only-tmpfs=false", "--image-volume=ignore",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777", "--workdir=/tmp",
    "--cap-drop=all", "--security-opt=no-new-privileges", "--no-healthcheck",
    "--memory=256m", "--memory-swap=256m", "--cpus=1", "--pids-limit=48", "--shm-size=8m",
    "--http-proxy=false", "--unsetenv-all", "--log-driver=none",
    "--timeout=" + (Math.ceil(timeoutMs / 1000) + 2), "--stop-timeout=0",
    "--entrypoint=/bin/sh", image, "-ec",
    'umask 077; cat > /tmp/check.test.mjs; exec /usr/local/bin/node "$1" --test /tmp/check.test.mjs',
    "perry-test", "--import=data:text/javascript," + encodeURIComponent(preflight),
  ];
}

/** Execute one owner-selected, self-contained Node test blob. No checkout is mounted. */
export async function runSandboxCheck(source: string, image: string, timeoutMs = 10000): Promise<SandboxResult> {
  const invalid = validateCheck(source, image, timeoutMs);
  if (invalid) return invalid;
  const info = await podman(["info", "--format", "{{.Host.Security.Rootless}} {{.Host.CgroupsVersion}}"], 10000);
  if (info.code !== 0 || info.output !== "true v2") {
    return unavailable("Rootless local Podman with cgroup v2 is required.");
  }
  const name = "perry-check-" + randomUUID();
  const create = checkProfile(name, image, timeoutMs);
  let result = unavailable("Podman could not create the check with the pinned image and required limits.");
  try {
    const created = await podman(create, 15000);
    if (created.code === 0) {
      const run = await podman(["start", "--attach", "--interactive", name], timeoutMs, source);
      if (run.timedOut) result = { status: "timed_out", detail: "The check exceeded its wall-clock deadline." };
      else if (run.code === 0) result = { status: "passed", detail: "The isolated Node test process exited successfully." };
      else if (run.code === 1) result = { status: "failed", detail: "The isolated Node test process exited with a failure." };
      else result = unavailable("The engine or its runtime checks could not complete the test.");
    }
  } finally {
    const cleanup = await podman(["rm", "--force", "--ignore", "--time=0", name], 10000);
    if (cleanup.code !== 0) result = unavailable("Podman could not confirm disposal of the check container.");
  }
  return result;
}
