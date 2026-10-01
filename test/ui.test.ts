import { test, after } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import { initTheme, keyHint, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Box, visibleWidth, KeybindingsManager, type Component } from "@earendil-works/pi-tui";
import swarm from "../src/index.ts";
import { agentRow, noticeView, waitingView } from "../src/ui.ts";
import { formatNote, type Note } from "../src/board.ts";

initTheme("dark", false);
// Configure the host's instance (npm can install a separate peer copy for local tests).
const hostTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
const originalKeys = hostTui.getKeybindings();
hostTui.setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle output" } }, { "app.tools.expand": "ctrl+e" }));
after(() => hostTui.setKeybindings(originalKeys));
const palette: Record<string, number> = { toolTitle: 33, accent: 39, dim: 244, success: 40, warning: 214, error: 196, toolOutput: 252, customMessageBg: 236 };
const backgrounds: string[] = [];
const theme: any = {
  fg: (color: string, text: string) => `\x1b[38;5;${palette[color]}m${text}\x1b[39m`,
  bg: (color: string, text: string) => { backgrounds.push(color); return `\x1b[48;5;${palette[color]}m${text}\x1b[49m`; },
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));
const tools = new Map<string, any>();
const messages = new Map<string, Function>();
swarm({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool), registerMessageRenderer: (name: string, renderer: Function) => messages.set(name, renderer) } as any);
const context = (args: any = {}, extra: any = {}) => ({ args, expanded: false, isError: false, isPartial: false, ...extra });
const result = (text: string, details?: any) => ({ content: [{ type: "text" as const, text }], details });
const now = Date.now();
const note: Note = { from: "researcher", to: "reviewer", kind: "result", tags: ["auth"], created: now - 180_000, expires: now + 23 * 3600_000, message: "Short summary.\n\n## Detail\n\n- First finding\n- Second finding" };
const rendered = (value: any, expanded = false, flags: any = {}, tool = "swarm_board"): Component => tools.get(tool).renderResult(value, { expanded, isPartial: false }, theme, context({}, flags) as any);

test("each tool call names its action and objects; only expanded calls show full body", () => {
  const cases: [string, any, RegExp][] = [
    ["swarm_spawn", { agent: "worker", name: "auth-review", task: "First preview\nSECOND_FULL_LINE" }, /spawn worker → auth-review/],
    ["swarm_send", { to: "*news*", message: "First preview\nSECOND_FULL_LINE" }, /send → \*news\*/],
    ["swarm_list", {}, /list · agents \+ presets/],
    ["swarm_send", { message: "First preview\nSECOND_FULL_LINE" }, /send · board only/],
    ["swarm_spawn", { task: "First preview\nSECOND_FULL_LINE", detach: true }, /spawn inherited → … · detached/],
    ["swarm_board", { from: "peer", tag: "auth", limit: 5 }, /board read · from=peer · tag=auth · limit=5/],
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
  assert.equal(new Set([...tools.values()].map(t => t.renderResult)).size, 4);
  for (const tool of ["swarm_spawn", "swarm_send", "swarm_list", "swarm_board"]) {
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

test("board uses structured notes, separates narrow metadata, shows type and renders relative time anew", () => {
  const component = rendered(result("DO_NOT_RENDER_WIRE_TEXT", { notes: [note] }), true);
  const before = plain(component.render(120));
  assert.match(before, /researcher → reviewer · \[result\]/);
  assert.match(before, /#auth · 3m ago · expires in (22|23)h/);
  assert.doesNotMatch(before, /DO_NOT_RENDER_WIRE_TEXT/);
  const narrow = component.render(35);
  assert.ok(narrow.every(line => visibleWidth(line) <= 35));
  assert.ok(stripVTControlCharacters(narrow[1]).includes("researcher → reviewer"));
  assert.doesNotMatch(stripVTControlCharacters(narrow[1]), /#auth/);
  assert.match(plain(narrow), /#auth/);
  const originalNow = Date.now;
  try {
    Date.now = () => now + 120_000;
    assert.match(plain(component.render(120)), /5m ago/);
  } finally { Date.now = originalNow; }
  assert.doesNotMatch(formatNote(note), /\x1b/);
  assert.match(plain(rendered(result("wire", { notes: [{ ...note, kind: "message" }] }), true).render(120)), /\[message\]/);
});

test("send distinguishes submitted/rejected/unknown, source board, board-only and relative expiry", () => {
  const component = rendered(result("wire", { board: "/source/board.sqlite", note, deliveries: [
    { to: "a", status: "submitted" }, { to: "b", status: "rejected", code: "agent_blocked", error: "herdr agent_blocked: approval dialog" },
    { to: "c", status: "unknown", code: "timeout", error: "herdr timeout" },
  ] }), true, { isError: true }, "swarm_send");
  const lines = component.render(100);
  const output = plain(lines);
  assert.match(output, /3 recipients · 1 submitted · 1 rejected · 1 unknown/);
  assert.match(output, /submitted → a/); assert.match(output, /rejected → b \[agent_blocked\]/); assert.match(output, /unknown → c \[timeout\]/);
  assert.match(lines.join(""), /\x1b\[38;5;40m✓ submitted/);
  assert.match(lines.join(""), /\x1b\[38;5;214m\? unknown/);
  assert.match(lines.join(""), /\x1b\[38;5;196mherdr agent_blocked/);
  assert.match(output, /expires in (22|23)h/); assert.match(output, /Board: \/source\/board.sqlite/);
  assert.doesNotMatch(output, /read|acknowledged|\d{4}-\d\d-\d\d/);
  const only = rendered(result("wire", { board: "/source/board.sqlite", note, deliveries: [], boardOnly: true }), false, {}, "swarm_send");
  assert.match(plain(only.render(80)), /posted · board only/);
  assert.doesNotMatch(plain(only.render(80)), /No matching|recipients/);
});

test("list preserves actual statuses; waiting widget is a single warning-aware line", () => {
  for (const [status, icon, color] of [["working", "●", 39], ["idle", "○", 244], ["blocked", "⚠", 214], ["done", "○", 244], ["unknown", "⚠", 214], ["unlisted", "⚠", 214]] as const) {
    const row = agentRow({ name: "peer", pane_id: "w1:p9", agent_status: status }, theme);
    assert.match(stripVTControlCharacters(row), new RegExp(`${icon} ${status}`));
    assert.ok(row.includes(`\x1b[38;5;${color}m${icon} ${status}`));
    assert.match(row, /\x1b\[1mpeer/);
    assert.match(row, /\x1b\[38;5;244mw1:p9/);

  }
  const list = rendered(result("wire", { agents: [{ name: "peer", pane_id: "w1:p9", agent_status: "blocked" }], presets: [{ name: "worker", description: "Code review", model: "provider/model" }] }), true, {}, "swarm_list");
  assert.match(plain(list.render(100)), /1 agents · 1 presets/);
  assert.match(plain(list.render(100)), /⚠ blocked/);
  assert.match(plain(list.render(100)), /worker \[provider\/model\] · Code review/);
  assert.doesNotMatch(plain(list.render(100)), /Unlisted does not prove/);
  const widget = waitingView(["研究员", "reviewer", "writer", "another"], new Map([["研究员", "blocked"]]), theme);
  assert.match(widget.render(80)[0], /\x1b\[38;5;214m研究员/);
  assert.match(plain(widget.render(24)), /Waiting: 研究员 \(\+3\)/);
  for (const width of [1, 4, 8, 20, 80]) { const lines = widget.render(width); assert.equal(lines.length, 1); assert.ok(visibleWidth(lines[0]) <= width); }
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
