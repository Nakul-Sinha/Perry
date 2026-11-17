import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = "2.1.325";
const inputLimit = 256 * 1024;
const outputLimit = 1024 * 1024;
const replyLimit = 16 * 1024;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class NativeClaudeUnavailable extends Error {}

export type ClaudeRuntime = {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; spawn: typeof spawn;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  verifyDirectory?: (path: string) => Promise<void>;
  deadline?: number;
};

async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !process.getuid || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new NativeClaudeUnavailable("Native Claude needs a private Linux temporary directory. On WSL, use Linux storage for temporary files.");
  }
}

// The CLI remains the trusted account broker. No repository path or configuration
// is exposed to it. Administrator-managed host policy still applies to the CLI.
function environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {DISABLE_AUTOUPDATER: "1"};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

async function execute(args: string[], input: string, signal: AbortSignal, timeout: number, runtime: ClaudeRuntime): Promise<string> {
  signal.throwIfAborted();
  let cwd: string | undefined;
  try {
    cwd = await mkdtemp(join(tmpdir(), "perry-claude-"));
    await chmod(cwd, 0o700);
    await (runtime.verifyDirectory ?? privateDirectory)(cwd);
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      const child = runtime.spawn("claude", args, {cwd, env: environment(runtime.env), detached: true,
        shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true});
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (mode: NodeJS.Signals) => {
        if (child.pid) {try {runtime.kill(-child.pid, mode);} catch {}}
      };
      const stop = (reason: string) => {
        if (failure) return;
        failure = new NativeClaudeUnavailable(reason);
        child.stdin?.destroy();
        kill("SIGTERM");
        escalation = setTimeout(() => kill("SIGKILL"), 250);
      };
      const abort = () => stop("The native Claude request was cancelled.");
      const deadline = setTimeout(() => stop("The native Claude request exceeded its deadline."), runtime.deadline ?? timeout);
      signal.addEventListener("abort", abort, {once: true});
      const collect = (data: Buffer, stdout: boolean) => {
        bytes += data.length;
        if (bytes > outputLimit) stop("The native Claude response exceeded its output limit.");
        else if (stdout) chunks.push(data);
      };
      child.stdout?.on("data", (data: Buffer) => collect(data, true));
      child.stderr?.on("data", (data: Buffer) => collect(data, false));
      child.stdin?.on("error", () => stop("The native Claude input was not accepted."));
      child.on("error", () => stop("Claude Code is unavailable. Install the tested CLI version " + version + "."));
      child.once("close", code => {
        clearTimeout(deadline);
        if (escalation) clearTimeout(escalation);
        signal.removeEventListener("abort", abort);
        // Kill any surviving descendants, including after the main process exits.
        kill("SIGKILL");
        if (failure) reject(failure);
        else if (code !== 0) reject(new NativeClaudeUnavailable("The native Claude command failed. Check its native login and account access."));
        else {
          try {resolve(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks)));}
          catch {reject(new NativeClaudeUnavailable("The native Claude response was not valid UTF-8."));}
        }
      });
      if (signal.aborted) abort();
      else child.stdin?.end(input);
    });
  } catch (error) {
    if (error instanceof NativeClaudeUnavailable) throw error;
    throw new NativeClaudeUnavailable(signal.aborted ? "The native Claude request was cancelled." : "The native Claude process could not start safely.");
  } finally {
    if (cwd) {
      try {await rm(cwd, {recursive: true, force: true});}
      catch {throw new NativeClaudeUnavailable("The native Claude temporary directory could not be removed.");}
    }
  }
}

export function nativeClaudeBackend(model: string, signal = new AbortController().signal,
  runtime: ClaudeRuntime = {platform: process.platform, env: process.env, spawn, kill: (pid, mode) => {process.kill(pid, mode);}}) {
  let checked: Promise<void> | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  const preflight = () => checked ??= (async () => {
    if (runtime.platform !== "linux") throw new NativeClaudeUnavailable("Native Claude requires Linux or Linux files inside WSL. Windows and other platforms are not verified.");
    if (!/^claude-[a-z0-9][a-z0-9.-]{0,119}$/.test(model)) throw new NativeClaudeUnavailable("Select an explicit canonical Claude model ID for the native CLI.");
    const reported = await execute(["--version"], "", signal, 10_000, runtime);
    if (reported.trim() !== version + " (Claude Code)") throw new NativeClaudeUnavailable("Native Claude requires the tested Claude Code version " + version + ".");
    let status: unknown;
    try {status = JSON.parse(await execute(["--safe-mode", "--restricted", "auth", "status"], "", signal, 10_000, runtime));}
    catch (error) {
      if (error instanceof NativeClaudeUnavailable) throw error;
      throw new NativeClaudeUnavailable("The native Claude login status could not be verified.");
    }
    if (!record(status) || status.authMethod !== "claude.ai" || status.loggedIn !== true) {
      throw new NativeClaudeUnavailable("Native Claude needs your own Claude account login. Run claude auth login separately; API and third-party routes are not used in this mode.");
    }
  })();
  return {
    preflight,
    metadata: () => calls ? ["Native Claude Code " + version + " used " + model + " through the native Claude account. CLI-reported main model tokens across "
      + calls + " calls: " + inputTokens + " input and " + outputTokens + " output. Subscription consumption has no inferred dollar cost."] : [],
    async complete(system: string, payload: string): Promise<string> {
      if (Buffer.byteLength(system) + Buffer.byteLength(payload) > inputLimit) throw new NativeClaudeUnavailable("The native Claude input exceeded its input limit.");
      await preflight();
      signal.throwIfAborted();
      const args = ["--safe-mode", "--restricted", "--print", "--output-format", "json", "--no-session-persistence",
        "--tools", "", "--disallowedTools", "*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--permission-prompts", "none", "--max-turns", "1", "--model", model, "--system-prompt", system,
        "--settings", '{"disableAllHooks":true}', "--no-chrome"];
      let reply: unknown;
      try {reply = JSON.parse(await execute(args, payload, signal, 60_000, runtime));}
      catch (error) {
        if (error instanceof NativeClaudeUnavailable) throw error;
        throw new NativeClaudeUnavailable("The native Claude response was not complete JSON.");
      }
      if (!record(reply) || reply.type !== "result" || reply.subtype !== "success" || reply.is_error !== false
        || !Number.isSafeInteger(reply.num_turns) || Number(reply.num_turns) !== 1 || reply.stop_reason !== "end_turn"
        || typeof reply.result !== "string" || !reply.result.trim() || Buffer.byteLength(reply.result) > replyLimit
        || !record(reply.modelUsage) || Object.keys(reply.modelUsage).length !== 1) {
        throw new NativeClaudeUnavailable("The native Claude response was incomplete or unsupported.");
      }
      const usage = Object.values(reply.modelUsage)[0];
      if (!record(usage) || usage.canonicalModel !== model || usage.provider !== "firstParty"
        || !Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0
        || !Number.isSafeInteger(usage.outputTokens) || Number(usage.outputTokens) < 1) {
        throw new NativeClaudeUnavailable("The native Claude model or billing route did not match the selected native account route.");
      }
      signal.throwIfAborted();
      calls++;
      inputTokens += Number(usage.inputTokens);
      outputTokens += Number(usage.outputTokens);
      return reply.result;
    },
  };
}
