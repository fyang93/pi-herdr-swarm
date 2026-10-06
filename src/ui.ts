import { keyHint, getMarkdownTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text, Markdown, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Delivery, LiveAgent } from "./herdr.ts";

const preview = (text: string) => text.split(/\r?\n/).find(line => line.trim())?.trim() || "";
const textLines = (text: string, width: number) => new Text(text, 0, 0).render(width);

function bounded(lines: string[], width: number, expanded: boolean): string[] {
  if (width < 1) return [];
  if (!expanded && lines.length > 8) lines = [...lines.slice(0, 7), keyHint("app.tools.expand", "to expand")];
  return lines.map(line => truncateToWidth(line, width));
}

export function callView(title: string, body: string, expanded: boolean, theme: Theme): Component {
  return {
    invalidate() {},
    render(width) {
      if (width < 1) return [];
      return expanded
        ? bounded([...textLines(title, width), ...(body ? textLines(theme.fg("toolOutput", body), width) : [])], width, true)
        : [truncateToWidth(title, width), ...(body ? [truncateToWidth(theme.fg("dim", preview(body)), width)] : [])];
    },
  };
}

export function agentRow(agent: Pick<LiveAgent, "name" | "title" | "pane_id" | "agent_status">, theme: Theme): string {
  const status = agent.agent_status || "unknown";
  const color = status === "working" ? "accent" : ["idle", "done"].includes(status) ? "dim" : "warning";
  const icon = status === "working" ? "●" : ["idle", "done"].includes(status) ? "○" : "⚠";
  const separator = agent.title ? " · " : "  ";
  return `${theme.fg("accent", theme.bold(agent.name || "(unnamed)"))}${agent.title ? theme.fg("dim", ` · ${agent.title}`) : ""}${separator}${theme.fg(color, `${icon} ${status}`)}${separator}${theme.fg("dim", agent.pane_id)}`;
}

export function runningView(agents: { name: string; agent?: string; pane?: string; status?: string; tool?: string; started?: string }[], theme: Theme, now = Date.now()): Component {
  return {
    invalidate() {},
    render(width) {
      if (width < 4 || !agents.length) return [];
      const inner = width - 2;
      const border = (text: string) => theme.fg("accent", text);
      const title = "─ Swarm ";
      const count = ` ${agents.length} running ─`;
      const top = visibleWidth(title + count) <= inner ? title + "─".repeat(inner - visibleWidth(title + count)) + count : truncateToWidth(`${agents.length} running`, inner, "").padEnd(inner, "─");
      const lines = [border(`╭${top}╮`)];
      for (const agent of agents) {
        const status = agent.status || "starting";
        const color = ["blocked", "waiting", "waiting for reply"].includes(status) ? "warning" : ["working", "running"].includes(status) ? "accent" : "dim";
        const right = ` ${theme.fg(color, status)}${status === "working" && agent.tool ? ` · ${agent.tool}` : ""} `;
        const seconds = Math.max(0, Math.floor((now - Date.parse(agent.started || "")) / 1000)) || 0;
        const clock = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
        const left = truncateToWidth(` ${theme.fg("dim", clock)}  ${theme.bold(agent.name)}${agent.agent && agent.agent !== agent.name ? ` (${agent.agent})` : ""}`, Math.max(0, inner - visibleWidth(right)));
        const row = truncateToWidth(left + " ".repeat(Math.max(0, inner - visibleWidth(left) - visibleWidth(right))) + right, inner);
        lines.push(border("│") + row + " ".repeat(Math.max(0, inner - visibleWidth(row))) + border("│"));
      }
      return [...lines, border(`╰${"─".repeat(inner)}╯`)];
    },
  };
}

type Renderer = NonNullable<ToolDefinition["renderResult"]>;
type Result = Parameters<Renderer>[0];
const output = (result: Result) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
// pi owns the tool shell/background. Only wrapping, partial state and row bounds are shared.
function resultView(expanded: boolean, partial: boolean, theme: Theme, lines: (width: number) => string[]): Component {
  return { invalidate() {}, render: width => width < 1 ? [] : bounded(partial ? textLines(theme.fg("accent", "● working…"), width) : lines(width), width, expanded) };
}

export const spawnResult: Renderer = (result, options, theme, context) => resultView(options.expanded, context.isPartial, theme, width => {
  if (context.isError) return textLines(theme.fg("error", output(result)), width);
  const data = result.details as { name: string; pane: string; resumed?: boolean } | undefined;
  return textLines(data ? theme.fg("accent", theme.bold(data.name)) + theme.fg("dim", ` · ${data.resumed ? "resumed" : "started"} · ${data.pane}`) : theme.fg("toolOutput", output(result)), width);
});
export const sendResult: Renderer = (result, options, theme, context) => resultView(options.expanded, context.isPartial, theme, width => {
  const data = result.details as { deliveries: Delivery[]; wait?: boolean } | undefined;
  if (!Array.isArray(data?.deliveries)) return textLines(theme.fg(context.isError ? "error" : "toolOutput", output(result)), width);
  const count = (status: Delivery["status"]) => data.deliveries.filter(d => d.status === status).length;
  const lines = textLines(theme.fg("dim", `${data.deliveries.length} recipients · ${count("submitted")} submitted · ${count("rejected")} rejected · ${count("unknown")} unknown`), width);
  if (data.wait) lines.push(...textLines(theme.fg("warning", "Waiting for reply"), width));
  for (const delivery of data.deliveries) {
    const color = delivery.status === "submitted" ? "success" : delivery.status === "rejected" ? "error" : "warning";
    const icon = delivery.status === "submitted" ? "✓" : delivery.status === "rejected" ? "✗" : "?";
    lines.push(...textLines(`${theme.fg(color, `${icon} ${delivery.status}`)} → ${theme.fg("accent", delivery.to)}${delivery.code ? theme.fg("dim", ` [${delivery.code}]`) : ""}`, width));
    if (delivery.error) lines.push(...textLines(theme.fg(color, delivery.error), width));
  }
  if (!data.deliveries.length) lines.push(...textLines(theme.fg("warning", "No recipients to notify."), width));
  return lines;
});
export const listResult: Renderer = (result, options, theme, context) => resultView(options.expanded, context.isPartial, theme, width => {
  if (context.isError) return textLines(theme.fg("error", output(result)), width);
  const data = result.details as { agents: LiveAgent[]; presets: { name: string; description: string; model?: string }[]; self?: string } | undefined;
  if (!data) return textLines(theme.fg("toolOutput", output(result)), width);
  const identity = data.self && theme.fg("dim", "self ") + theme.fg("accent", data.self);
  const lines = [...(identity ? textLines(identity, width) : []), ...textLines(theme.fg("dim", `${data.agents.length} agents · ${data.presets.length} presets`), width)];
  for (const agent of data.agents) lines.push(...textLines(agentRow(agent, theme), width));
  if (data.presets.length) {
    lines.push(...textLines(theme.fg("toolTitle", "Presets"), width));
    for (const preset of data.presets) lines.push(...textLines(theme.fg("accent", theme.bold(preset.name)) + theme.fg("dim", `${preset.model ? ` [${preset.model}]` : ""} · ${preset.description}`), width));
  }
  return lines;
});

// Box padding can overflow at one column; keep custom messages safe on tiny terminals.
function fitBox(box: Box): Component {
  return { invalidate: () => box.invalidate(), render: width => width < 1 ? [] : box.render(width).map(line => truncateToWidth(line, width)) };
}

export function resultMessageView(content: string, details: { name: string; session: string; status: string } | undefined, expanded: boolean, theme: Theme): Component {
  const failed = details?.status === "error" || details?.status === "unreadable";
  const replied = details?.status === "reply";
  const box = new Box(1, 1, line => theme.bg(failed ? "toolErrorBg" : replied ? "toolSuccessBg" : "customMessageBg", line));
  box.addChild({ invalidate() {}, render(width) {
    if (width < 1) return [];
    const color = failed ? "error" : replied ? "success" : "warning";
    const header = theme.fg(color, failed ? "✗ " : replied ? "✓ " : "⚠ ") + theme.fg("toolTitle", theme.bold(details?.name || "peer")) + theme.fg(color, ` · ${details?.status || "unknown"}`);
    const body = details && content.startsWith("[swarm result] ") ? content.split("\n").slice(2).join("\n") : content;
    return bounded([...textLines(header, width), ...new Markdown(body, 0, 0, getMarkdownTheme(), { color: text => theme.fg("toolOutput", text) }).render(width), ...textLines(theme.fg("dim", details?.session || ""), width)], width, expanded);
  } });
  return fitBox(box);
}

export function noticeView(text: string, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, line => theme.bg("customMessageBg", line));
  box.addChild({ invalidate() {}, render: width => width < 1 ? [] : bounded(textLines(theme.fg("warning", text), width), width, expanded) });
  return fitBox(box);
}
