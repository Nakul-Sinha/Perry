import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { SpawnOptions } from "node:child_process";
import { nativeClaudeBackend, type ClaudeRuntime } from "../src/native-claude.ts";

const model = "claude-sonnet-5-5";
const response = () => ({type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn",
  result: '{"candidates":[],"incomplete":false}',
  modelUsage: {[model]: {canonicalModel: model, provider: "firstParty", inputTokens: 25, outputTokens: 10}}});
type Invocation = {args: string[]; options: SpawnOptions; input: string; pid: number};

function fake(answer: (call: Invocation) => unknown = () => response()) {
  const calls: Invocation[] = [];
  const signals: {pid: number; mode: NodeJS.Signals}[] = [];
  const active = new Map<number, EventEmitter>();
  const spawn = ((_file: string, args: string[], options: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 30_000 + calls.length});
    active.set(child.pid, child);
    const call = {args, options, input: "", pid: child.pid};
    calls.push(call);
    child.stdin.on("data", data => {call.input += data.toString();});
    child.stdin.on("finish", () => setImmediate(() => {
      const value = args.includes("--version") ? "2.1.325 (Claude Code)" : args.includes("status")
        ? {authMethod: "claude.ai", loggedIn: true} : answer(call);
      if (value === undefined) return;
      const raw = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
      child.stdout.emit("data", raw);
      child.emit("close", 0);
      active.delete(child.pid);
    }));
    return child;
  }) as unknown as ClaudeRuntime["spawn"];
  const runtime: ClaudeRuntime = {
    platform: "linux", spawn, verifyDirectory: async () => {},
    env: {PATH: "/fixture/bin", HOME: "/fixture/home", USER: "fixture", XDG_CONFIG_HOME: "/fixture/config",
      ANTHROPIC_API_KEY: "not-forwarded", ANTHROPIC_AUTH_TOKEN: "not-forwarded", CLAUDE_CODE_OAUTH_TOKEN: "not-forwarded",
      ANTHROPIC_BASE_URL: "https://not-forwarded.invalid", CLAUDE_CONFIG_DIR: "/not-forwarded", OPENCODE_API_KEY: "not-forwarded",
      DATABASE_URL: "not-forwarded", PERRY_SOURCE_TOKEN: "not-forwarded", NODE_OPTIONS: "not-forwarded", NODE_EXTRA_CA_CERTS: "/not-forwarded"},
    kill(pid, mode) {
      signals.push({pid, mode});
      if (mode === "SIGTERM") setImmediate(() => active.get(-pid)?.emit("close", 143));
    },
  };
  return {runtime, calls, signals};
}

test("native calls use independent empty private directories and a restricted account environment", async () => {
  const child = fake(call => {
    assert.equal(call.options.detached, true);
    assert.equal(call.options.shell, false);
    assert.deepEqual(readdirSync(String(call.options.cwd)), []);
    if (process.platform !== "win32") assert.equal(statSync(String(call.options.cwd)).mode & 0o777, 0o700);
    assert.deepEqual(call.options.env, {PATH: "/fixture/bin", HOME: "/fixture/home", USER: "fixture",
      XDG_CONFIG_HOME: "/fixture/config", DISABLE_AUTOUPDATER: "1"});
    assert.equal(call.input, "fixture payload");
    for (const flag of ["--safe-mode", "--restricted", "--no-session-persistence", "--strict-mcp-config", "--no-chrome"]) assert.ok(call.args.includes(flag));
    for (const [flag, value] of [["--tools", ""], ["--disallowedTools", "*"], ["--permission-prompts", "none"],
      ["--max-turns", "1"], ["--output-format", "json"], ["--model", model], ["--system-prompt", "trusted system"]]) {
      assert.equal(call.args[call.args.indexOf(flag!) + 1], value);
    }
    assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--mcp-config") + 1]!), {mcpServers: {}});
    assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--settings") + 1]!), {disableAllHooks: true});
    assert.ok(!call.args.some(arg => ["--bare", "--continue", "--resume", "--json-schema", "--dangerously-skip-permissions"].includes(arg)));
    return response();
  });
  const backend = nativeClaudeBackend(model, undefined, child.runtime);
  await backend.preflight();
  assert.equal(await backend.complete("trusted system", "fixture payload"), response().result);
  await backend.complete("trusted system", "fixture payload");
  assert.equal(child.calls.length, 4);
  assert.equal(new Set(child.calls.map(call => call.options.cwd)).size, 4);
  assert.ok(child.calls.every(call => !existsSync(String(call.options.cwd))));
  assert.match(backend.metadata().join(), /2 calls: 50 input and 20 output/);
  assert.ok(child.signals.every(({pid}) => pid < 0));
});

test("unsupported platforms and model aliases fail before launching the CLI", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const child = fake();
    await assert.rejects(nativeClaudeBackend(model, undefined, {...child.runtime, platform}).preflight(), /requires Linux/);
    assert.equal(child.calls.length, 0);
  }
  const child = fake();
  await assert.rejects(nativeClaudeBackend("sonnet", undefined, child.runtime).preflight(), /canonical Claude model/);
  assert.equal(child.calls.length, 0);
});

test("a directory that cannot enforce private Linux permissions is removed before startup", async () => {
  const child = fake();
  let directory = "";
  await assert.rejects(nativeClaudeBackend(model, undefined, {...child.runtime, verifyDirectory: async path => {
    directory = path;
    throw new Error("simulated permissions failure");
  }}).preflight(), /could not start safely/);
  assert.ok(directory && !existsSync(directory));
  assert.equal(child.calls.length, 0);
});

test("preflight rejects incompatible versions, other authentication and malformed status", async () => {
  for (const [stage, output] of [["version", "2.1.324 (Claude Code)"], ["status", '{"authMethod":"api_key"}'],
    ["status", '{"authMethod":"oauth_token"}'], ["status", '{"authMethod":"claude.ai"}'],
    ["status", '{"authMethod":"claude.ai","loggedIn":false}'], ["status", "not JSON"]]) {
    const child = fake();
    const original = child.runtime.spawn;
    child.runtime.spawn = ((file: string, args: string[], opts: SpawnOptions) => {
      const proc = original(file, args, opts);
      const emit = proc.stdout!.emit.bind(proc.stdout);
      proc.stdout!.emit = ((event: string, ...values: unknown[]) => emit(event,
        ...(event === "data" && args.includes(stage === "version" ? "--version" : "status") ? [Buffer.from(output!)] : values))) as typeof emit;
      return proc;
    }) as ClaudeRuntime["spawn"];
    await assert.rejects(nativeClaudeBackend(model, undefined, child.runtime).preflight(), /version|login/);
    assert.ok(child.calls.every(call => !existsSync(String(call.options.cwd))));
  }
});

test("invalid, failed, truncated, zero-turn and mismatched model results are rejected", async () => {
  const cases: unknown[] = [
    "not JSON", Buffer.from([0xff]), {result: "text"}, {...response(), is_error: true}, {...response(), num_turns: 0},
    {...response(), num_turns: 2}, {...response(), stop_reason: "max_tokens"}, {...response(), subtype: "error_max_turns"},
    {...response(), result: ""}, {...response(), result: "x".repeat(16 * 1024 + 1)},
    {...response(), modelUsage: {}}, {...response(), modelUsage: {[model]: {canonicalModel: "claude-other", provider: "firstParty", inputTokens: 1, outputTokens: 1}}},
    {...response(), modelUsage: {[model]: {canonicalModel: model, provider: "gateway", inputTokens: 1, outputTokens: 1}}},
    {...response(), modelUsage: {[model]: {canonicalModel: model, provider: "firstParty", inputTokens: -1, outputTokens: 1}}},
  ];
  for (const value of cases) {
    const child = fake(() => value);
    await assert.rejects(nativeClaudeBackend(model, undefined, child.runtime).complete("system", "payload"), /native Claude/);
    assert.ok(child.calls.every(call => !existsSync(String(call.options.cwd))));
  }
});

test("input and output ceilings fail closed and dispose every directory", async () => {
  const tooLarge = fake();
  await assert.rejects(nativeClaudeBackend(model, undefined, tooLarge.runtime).complete("system", "x".repeat(256 * 1024)), /input limit/);
  assert.equal(tooLarge.calls.length, 0);
  const child = fake(() => "x".repeat(1024 * 1024 + 1));
  await assert.rejects(nativeClaudeBackend(model, undefined, child.runtime).complete("system", "payload"), /output limit/);
  assert.ok(child.signals.some(call => call.mode === "SIGTERM"));
  assert.ok(child.calls.every(call => !existsSync(String(call.options.cwd))));
});

test("deadlines and cancellation terminate process groups and prohibit another call", async () => {
  for (const cancelled of [false, true]) {
    const stop = new AbortController();
    const child = fake(() => {if (cancelled) stop.abort(); return undefined;});
    const backend = nativeClaudeBackend(model, stop.signal, {...child.runtime, deadline: 30});
    await assert.rejects(backend.complete("system", "payload"), cancelled ? /cancelled/ : /deadline/);
    assert.ok(child.signals.some(call => call.mode === "SIGTERM"));
    assert.ok(child.signals.some(call => call.mode === "SIGKILL"));
    assert.ok(child.calls.every(call => !existsSync(String(call.options.cwd))));
    if (cancelled) {
      const before = child.calls.length;
      await assert.rejects(backend.complete("system", "payload"));
      assert.equal(child.calls.length, before);
    }
  }
});

test("startup errors stay sanitized and stderr shares the output ceiling", async () => {
  const broken = fake();
  let directory = "";
  broken.runtime.spawn = ((_file: string, _args: string[], options: SpawnOptions) => {
    directory = String(options.cwd);
    throw new Error("private diagnostic that must stay internal");
  }) as unknown as ClaudeRuntime["spawn"];
  await assert.rejects(nativeClaudeBackend(model, undefined, broken.runtime).preflight(), error => {
    assert.ok(error instanceof Error && !error.message.includes("private diagnostic"));
    return true;
  });
  assert.ok(directory && !existsSync(directory));
  const loud = fake(() => undefined);
  const original = loud.runtime.spawn;
  loud.runtime.spawn = ((file: string, args: string[], options: SpawnOptions) => {
    const proc = original(file, args, options);
    if (args.includes("--print")) proc.stdin!.once("finish", () => setImmediate(() => proc.stderr!.emit("data", Buffer.alloc(1024 * 1024 + 1))));
    return proc;
  }) as ClaudeRuntime["spawn"];
  await assert.rejects(nativeClaudeBackend(model, undefined, loud.runtime).complete("system", "payload"), /output limit/);
  assert.ok(loud.calls.every(call => !existsSync(String(call.options.cwd))));
});
