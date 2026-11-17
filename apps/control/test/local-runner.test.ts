import assert from "node:assert/strict";
import { execFile, spawnSync, type ExecFileOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { MentionRequest } from "../src/intake.ts";
import { approvedCheck, approvedModel, runLocal } from "../src/local-runner.ts";

const request: MentionRequest = {
  installationId: "101", repoId: "202", owner: "example", repo: "demo", number: 1,
  commentId: "55", sender: "developer", senderId: "7", kind: "review", text: "review", isPR: true,
};
const refs = {base: "a".repeat(40), head: "b".repeat(40), sameRepository: true};
const env: NodeJS.ProcessEnv = {
  PATH: "fixture-path", SystemRoot: "fixture-system", HOME: "fixture-home", USER: "fixture-user",
  XDG_RUNTIME_DIR: "fixture-runtime", DBUS_SESSION_BUS_ADDRESS: "fixture-bus",
  ANTHROPIC_API_KEY: "fixture-anthropic", OPENAI_API_KEY: "fixture-openai", OPENCODE_API_KEY: "fixture-opencode",
  PERRY_WEBHOOK_SECRET: "fixture-signing", DATABASE_URL: "fixture-database", NODE_OPTIONS: "fixture-options",
  ANTHROPIC_AUTH_TOKEN: "fixture-auth", CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth", CLAUDE_CONFIG_DIR: "fixture-config",
  XDG_CONFIG_HOME: "fixture-xdg", XDG_DATA_HOME: "fixture-data", LOGNAME: "fixture-user",
};
const modelCases = [
  {setting: "PERRY_ANTHROPIC_MODEL", provider: "anthropic", flag: "--anthropic-model", key: "ANTHROPIC_API_KEY"},
  {setting: "PERRY_OPENAI_MODEL", provider: "openai", flag: "--openai-model", key: "OPENAI_API_KEY"},
  {setting: "PERRY_OPENCODE_CHAT_MODEL", provider: "opencode-chat", flag: "--opencode-chat-model", key: "OPENCODE_API_KEY"},
] as const;

function capture(response: unknown) {
  let call: {args: string[]; options: ExecFileOptions} | undefined;
  const execute = ((_file: string, args: string[], options: ExecFileOptions,
    callback: (error: null, output: string) => void) => {
    call = {args, options};
    callback(null, JSON.stringify(response));
  }) as typeof execFile;
  return {runtime: {env, execute}, get: () => {
    assert.ok(call);
    return call;
  }};
}

test("model configuration permits static mode or one explicit provider", () => {
  assert.equal(approvedModel({}), undefined);
  for (const item of modelCases) {
    assert.deepEqual(approvedModel({[item.setting]: "fixture-model.1:review"}), {
      provider: item.provider, model: "fixture-model.1:review",
    });
  }
});

test("ambiguous, empty and invalid model configuration fails without exposing its values", () => {
  for (const config of [
    {PERRY_ANTHROPIC_MODEL: "first-fixture", PERRY_OPENAI_MODEL: "second-fixture"},
    {PERRY_OPENAI_MODEL: "first-fixture", PERRY_OPENCODE_CHAT_MODEL: "second-fixture"},
    {PERRY_ANTHROPIC_MODEL: "first-fixture", PERRY_OPENCODE_CHAT_MODEL: "second-fixture"},
    {PERRY_CLAUDE_CLI_MODEL: "first-fixture", PERRY_ANTHROPIC_MODEL: "second-fixture"},
    {PERRY_CLAUDE_CLI_MODEL: "first-fixture", PERRY_OPENAI_MODEL: "second-fixture"},
    {PERRY_CLAUDE_CLI_MODEL: "first-fixture", PERRY_OPENCODE_CHAT_MODEL: "second-fixture"},
    {PERRY_CLAUDE_CLI_MODEL: ""},
    ...modelCases.flatMap(item => ["", "private model value", "bad\nvalue", "-option", "a".repeat(129)].map(value => ({[item.setting]: value}))),
  ]) {
    assert.throws(() => approvedModel(config), error => error instanceof Error
      && error.message.startsWith("Configure PERRY_")
      && !Object.values(config).filter(Boolean).some(value => error.message.includes(value)));
  }
});

for (const item of modelCases) {
  test(item.provider + " forwards its own model flag and only its matching key", async () => {
    const child = capture({summary: "summary", findings: "findings", score: 4, recommendation: "HOLD"});
    const signal = new AbortController().signal;
    const result = await runLocal("fixture-repo", request, refs, signal,
      approvedModel({[item.setting]: "fixture-model"}), undefined, child.runtime);
    assert.deepEqual(result, {summary: "summary", findings: "findings"});
    const call = child.get();
    assert.equal(call.args[call.args.indexOf(item.flag) + 1], "fixture-model");
    assert.equal(call.args.filter(arg => modelCases.some(model => model.flag === arg)).length, 1);
    assert.deepEqual(call.options.env, {PATH: env.PATH, SystemRoot: env.SystemRoot, [item.key]: env[item.key]});
    assert.equal(call.options.signal, signal);
    assert.equal(call.options.timeout, 150_000);
  });
}

test("existing Anthropic string and approved runtime check keep their behavior", async () => {
  const child = capture({summary: "summary", findings: "findings", score: 4, recommendation: "DO NOT MERGE"});
  await runLocal("fixture-repo", request, refs, new AbortController().signal,
    "fixture-anthropic-model", approvedCheck("tests/total.test.mjs", "total.mjs"), child.runtime);
  const call = child.get();
  assert.ok(call.args.includes("--anthropic-model"));
  assert.ok(call.args.includes("--test=tests/total.test.mjs"));
  assert.ok(call.args.includes("--module=total.mjs"));
  assert.equal(call.options.timeout, 250_000);
  assert.deepEqual(call.options.env, {
    PATH: env.PATH, SystemRoot: env.SystemRoot, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    HOME: env.HOME, USER: env.USER, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
  });
});

test("question and static routes exclude unused provider access and execution settings", async () => {
  const child = capture({answer: "answer"});
  const question = {...request, kind: "question" as const, text: "where is total?"};
  await runLocal("fixture-repo", question, refs, new AbortController().signal,
    undefined, approvedCheck("tests/total.test.mjs", "total.mjs"), child.runtime);
  const call = child.get();
  assert.equal(call.args[1], "ask");
  assert.ok(call.args.includes("--question=where is total?"));
  assert.ok(!call.args.some(arg => arg.startsWith("--test") || arg.startsWith("--module")));
  assert.deepEqual(call.options.env, {PATH: env.PATH, SystemRoot: env.SystemRoot});
});

test("ambiguous provider selection fails control startup before App or database access", () => {
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const child = spawnSync(process.execPath, [entry], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      PERRY_INSTALLATION_ID: "101", PERRY_REPOSITORY_ID: "202",
      PERRY_OPENAI_MODEL: "private-fixture-one", PERRY_OPENCODE_CHAT_MODEL: "private-fixture-two"},
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Configure PERRY_ANTHROPIC_MODEL, PERRY_OPENAI_MODEL, PERRY_OPENCODE_CHAT_MODEL or PERRY_CLAUDE_CLI_MODEL with exactly one model/);
  assert.doesNotMatch(child.stderr + child.stdout, /private-fixture/);
});

test("native model forwards native account paths and excludes API or routing credentials", async () => {
  for (const kind of ["review", "question"] as const) {
    const child = capture(kind === "review" ? {summary: "summary", findings: "findings", score: 4, recommendation: "HOLD"} : {answer: "answer"});
    const selected = approvedModel({PERRY_CLAUDE_CLI_MODEL: "claude-sonnet-5-5"});
    assert.deepEqual(selected, {provider: "claude-cli", model: "claude-sonnet-5-5"});
    await runLocal("fixture-repo", {...request, kind}, refs, new AbortController().signal, selected, undefined, child.runtime);
    const call = child.get();
    assert.equal(call.args[call.args.indexOf("--claude-cli-model") + 1], "claude-sonnet-5-5");
    assert.deepEqual(call.options.env, {
      PATH: env.PATH, SystemRoot: env.SystemRoot, HOME: env.HOME, USER: env.USER, LOGNAME: env.LOGNAME,
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_DATA_HOME: env.XDG_DATA_HOME,
      XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
    });
  }
});
