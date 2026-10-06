import { test, after } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import { initTheme, keyHint, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth, KeybindingsManager, type Component } from "@earendil-works/pi-tui";
import swarm from "../src/index.ts";
import { agentRow, noticeView, runningView, resultMessageView } from "../src/ui.ts";

initTheme("dark", false);
// Configure the host's instance (npm can install a separate peer copy for local tests).
const hostTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
const originalKeys = hostTui.getKeybindings();
hostTui.setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle output" } }, { "app.tools.expand": "ctrl+e" }));
after(() => hostTui.setKeybindings(originalKeys));
const palette: Record<string, number> = { toolTitle: 33, accent: 39, dim: 244, success: 40, warning: 214, error: 196, toolOutput: 252, customMessageBg: 236, toolSuccessBg: 22, toolErrorBg: 52 };
const backgrounds: string[] = [];
const theme: any = {
  fg: (color: string, text: string) => `\x1b[38;5;${palette[color]}m${text}\x1b[39m`,
  bg: (color: string, text: string) => { backgrounds.push(color); return `\x1b[48;5;${palette[color]}m${text}\x1b[49m`; },
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));
const tools = new Map<string, any>();
const messages = new Map<string, Function>();
swarm({ on() {}, registerFlag() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer: (name: string, renderer: Function) => messages.set(name, renderer) } as any);
const context = (args: any = {}, extra: any = {}) => ({ args, expanded: false, isError: false, isPartial: false, ...extra });
const result = (text: string, details?: any) => ({ content: [{ type: "text" as const, text }], details });
const rendered = (value: any, expanded = false, flags: any = {}, tool = "swarm_send"): Component => tools.get(tool).renderResult(value, { expanded, isPartial: false }, theme, context({}, flags) as any);

test("each tool call names its action and objects; only expanded calls show full body", () => {
  const cases: [string, any, RegExp][] = [
    ["swarm_spawn", { agent: "worker", name: "auth-review", task: "First preview\nSECOND_FULL_LINE" }, /spawn worker → auth-review/],
    ["swarm_send", { to: ["researcher", "reviewer"], message: "First preview\nSECOND_FULL_LINE" }, /send → researcher, reviewer/],
    ["swarm_list", {}, /list · agents \+ presets/],
    ["swarm_send", {}, /send → …/],
    ["swarm_spawn", { task: "First preview\nSECOND_FULL_LINE" }, /spawn inherited → …/],
  ];
  for (const [name, args, expected] of cases) {
    const tool = tools.get(name);
    const collapsed = tool.renderCall(args, theme, context(args));
    const expanded = tool.renderCall(args, theme, context(args, { expanded: true }));
    assert.match(plain(collapsed.render(100)), expected);
    assert.doesNotMatch(plain(collapsed.render(100)), /SECOND_FULL_LINE/);
    if (args.task || args.message) assert.match(plain(expanded.render(100)), /SECOND_FULL_LINE/);
    for (const width of [1, 4, 8, 20, 80]) {
      const lines = collapsed.render(width);
      assert.ok(lines.length <= 2);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
    }
  }
});

test("result flags come from the fourth context argument; tools never add an inner Box", () => {
  backgrounds.length = 0;
  assert.equal(new Set(["swarm_spawn", "swarm_send", "swarm_list"].map(name => tools.get(name).renderResult)).size, 3);
  for (const tool of ["swarm_spawn", "swarm_send", "swarm_list"]) {
    const failed = rendered(result("Explicit failure"), false, { isError: true }, tool);
    assert.ok(!(failed instanceof Box));
    assert.match(failed.render(80).join(""), /\x1b\[38;5;196m/);
    const partial = rendered(result("Old failure"), false, { isPartial: true, isError: true }, tool);
    assert.match(plain(partial.render(80)), /● working/);
    assert.doesNotMatch(plain(partial.render(80)), /Old failure/);
  }
  const ignoredFlag = rendered({ ...result("ordinary output"), isError: true });
  assert.doesNotMatch(ignoredFlag.render(80).join(""), /\x1b\[38;5;196m/);
  assert.deepEqual(backgrounds, []);
});

test("native pi tool shell passes errors and partial status to our renderer without fallback", () => {
  let calls = 0;
  const original = tools.get("swarm_send");
  const definition: any = { ...original, renderResult: (...args: any[]) => { calls++; return original.renderResult(...args); } };
  const shell = new ToolExecutionComponent("swarm_send", "ui-test", { to: "peer", message: "hello" }, {}, definition, { requestRender() {} } as any, process.cwd());
  shell.updateResult({ ...result("native explicit failure"), isError: true });
  assert.match(plain(shell.render(60)), /send → peer/);
  assert.match(plain(shell.render(60)), /native explicit failure/);
  shell.updateResult({ ...result("not a finished result"), isError: false }, true);
  assert.match(plain(shell.render(60)), /● working/);
  assert.ok(calls >= 2);
});

test("collapsed output is bounded by display rows and uses the configured expansion key", () => {
  const long = rendered(result("这是一行很长的中文正文".repeat(150)));
  for (const width of [1, 4, 8, 20, 80]) {
    const lines = long.render(width);
    assert.ok(lines.length <= 8);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  }
  assert.match(plain(long.render(40)), /ctrl\+e to expand/);
  assert.ok(plain(long.render(40)).includes(stripVTControlCharacters(keyHint("app.tools.expand", "to expand"))));
  assert.ok(rendered(result("这是一行很长的中文正文".repeat(150)), true).render(40).length > 8);
});

test("send distinguishes submitted/resumed/rejected/unknown", () => {
  const component = rendered(result("wire", { deliveries: [
    { to: "a", status: "submitted" }, { to: "b", status: "resumed" }, { to: "c", status: "rejected", code: "agent_blocked", error: "herdr agent_blocked: approval dialog" },
    { to: "d", status: "unknown", code: "timeout", error: "herdr timeout" },
  ] }), true, { isError: true }, "swarm_send");
  const lines = component.render(100);
  const output = plain(lines);
  assert.match(output, /4 recipients · 1 submitted · 1 resumed · 1 rejected · 1 unknown/);
  assert.match(output, /submitted → a/); assert.match(output, /resumed → b/); assert.match(output, /rejected → c \[agent_blocked\]/); assert.match(output, /unknown → d \[timeout\]/);
  assert.match(lines.join(""), /\x1b\[38;5;40m✓ submitted/);
  assert.match(lines.join(""), /\x1b\[38;5;40m✓ resumed/); assert.match(lines.join(""), /\x1b\[38;5;214m\? unknown/);
  assert.match(lines.join(""), /\x1b\[38;5;196mherdr agent_blocked/);
  assert.doesNotMatch(output, /read|acknowledged/, "submission is not acknowledgement");
  const waiting = rendered(result("wire", { deliveries: [{ to: "peer", status: "submitted" }], wait: true }));
  assert.match(plain(waiting.render(80)), /Waiting for reply/);
  assert.match(waiting.render(80).join(""), /\x1b\[38;5;214mWaiting for reply/);
  const empty = rendered(result("wire", { deliveries: [] }));
  assert.match(plain(empty.render(80)), /No recipients/);
  for (const expanded of [false, true]) for (const width of [1, 4, 8, 20, 80]) {
    const lines = rendered(result("wire", { deliveries: [] }), expanded).render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (!expanded) assert.ok(lines.length <= 8);
  }
});

test("list preserves actual statuses", () => {
  for (const [status, icon, color] of [["working", "●", 39], ["idle", "○", 244], ["blocked", "⚠", 214], ["done", "○", 244], ["unknown", "⚠", 214], ["unlisted", "⚠", 214]] as const) {
    const row = agentRow({ name: "peer", pane_id: "w1:p9", agent_status: status }, theme);
    assert.match(stripVTControlCharacters(row), new RegExp(`${icon} ${status}`));
    assert.ok(row.includes(`\x1b[38;5;${color}m${icon} ${status}`));
    assert.match(row, /\x1b\[1mpeer/);
    assert.match(row, /\x1b\[38;5;244mw1:p9/);

  }
  const list = rendered(result("wire", { agents: [{ name: "peer", title: "worker · Check security", pane_id: "w1:p9", agent_status: "blocked" }], presets: [{ name: "worker", description: "Code review", model: "provider/model" }] }), true, {}, "swarm_list");
  assert.match(plain(list.render(100)), /1 agents · 1 presets/);
  assert.match(plain(list.render(100)), /peer · worker · Check security.*⚠ blocked.*w1:p9/);
  assert.match(plain(list.render(100)), /worker \[provider\/model\] · Code review/);
  assert.doesNotMatch(plain(list.render(100)), /Unlisted does not prove/);
  const emptyPresets = rendered(result("wire", { agents: [], presets: [] }), true, {}, "swarm_list");
  assert.doesNotMatch(plain(emptyPresets.render(100)), /Presets/);
  assert.match(plain(emptyPresets.render(100)), /0 agents · 0 presets/);
});

test("running widget ports bordered name, preset and warning status using the active theme", () => {
  const widget = runningView([
    { name: "研究员", agent: "researcher", status: "working" },
    { name: "reviewer", status: "waiting" },
  ], theme);
  const lines = widget.render(80);
  assert.match(plain(lines), /Swarm.*2 running/);
  assert.match(plain(lines), /研究员 \(researcher\).*working/);
  assert.match(lines.join("\n"), /\x1b\[38;5;214mwaiting/);
  assert.ok(lines.every(line => visibleWidth(line) === 80));
  for (const width of [0, 1, 3, 4, 8, 20]) {
    assert.ok(widget.render(width).every(line => visibleWidth(line) <= width));
  }
  assert.deepEqual(runningView([], theme).render(80), []);
  const oldAccent = palette.accent;
  palette.accent = 99;
  widget.invalidate();
  assert.match(widget.render(80).join(""), /\x1b\[38;5;99m/);
  palette.accent = oldAccent;
});

test("running widget shows the run clock, role and tool only while working, with bounded Unicode rows", () => {
  const now = Date.parse("2026-01-01T00:02:05Z");
  const agents = [
    { name: "研究员", agent: "researcher", status: "working", tool: "bash", started: "2026-01-01T00:01:00Z" },
    { name: "reviewer", agent: "reviewer", status: "blocked", tool: "read", started: "2026-01-01T00:00:00Z" },
    { name: "peer", status: "starting", started: "invalid" },
  ];
  const component = runningView(agents, theme, now);
  assert.match(plain(component.render(100)), /01:05\s+研究员 \(researcher\).*working · bash/);
  assert.match(plain(component.render(100)), /02:05\s+reviewer.*blocked/);
  assert.match(plain(component.render(100)), /00:00\s+peer.*starting/);
  assert.doesNotMatch(plain(component.render(100)), / · read|reviewer \(reviewer\)/);
  for (let width = 0; width <= 100; width++) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
});

test("result messages retain full Markdown on expansion and truthful status colors", () => {
  for (const [status, bg, icon] of [["reply", "toolSuccessBg", "✓"], ["error", "toolErrorBg", "✗"], ["aborted", "customMessageBg", "⚠"], ["unreadable", "toolErrorBg", "✗"]]) {
    backgrounds.length = 0;
    const component = resultMessageView("[swarm result] peer\nSession: /tmp/session\n**Answer**\n" + "正文\n".repeat(20), { name: "peer", session: "/tmp/session", status }, false, theme);
    assert.match(plain(component.render(80)), new RegExp(`${icon} peer · ${status}`));
    assert.ok(backgrounds.includes(bg));
    assert.match(plain(component.render(80)), /ctrl\+e to expand/);
    for (const width of [0, 1, 4, 8, 20, 80]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
  }
  assert.match(plain(resultMessageView("Do not drop\nthese lines\nAnswer", { name: "peer", session: "", status: "reply" }, true, theme).render(80)), /Do not drop\s+these lines/);
});

test("native validation details are not mistaken for delivery details", () => {
  const value = result("message exceeds 4000 characters", { validationErrors: [{ path: "/message" }] });
  assert.match(plain(rendered(value, true, { isError: true }).render(60)), /message exceeds 4000/);
  assert.match(plain(rendered(value, true).render(60)), /message exceeds 4000/);
});

test("unknown notices use custom-message background and warning, never success", () => {
  backgrounds.length = 0;
  const notice = messages.get("swarm_notice")!({ content: "peer is unlisted; outcome unknown" }, { expanded: false }, theme);
  const lines = notice.render(50);
  assert.match(plain(lines), /unlisted; outcome unknown/);
  assert.ok(backgrounds.includes("customMessageBg"));
  assert.ok(backgrounds.every(color => color === "customMessageBg"));
  assert.match(lines.join(""), /\x1b\[38;5;214m/);
  assert.doesNotMatch(lines.join(""), /\x1b\[38;5;40m/);
  for (const width of [4, 8, 20]) {
    const long = noticeView("Unlisted and unknown ".repeat(100), false, theme).render(width);
    assert.ok(long.length <= 10);
    assert.ok(long.every(line => visibleWidth(line) <= width));
  }
});
