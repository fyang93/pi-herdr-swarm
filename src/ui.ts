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

export function agentRow(agent: Pick<LiveAgent, "name" | "pane_id" | "agent_status">, theme: Theme): string {
  const status = agent.agent_status || "unknown";
  const color = status === "working" ? "accent" : ["idle", "done"].includes(status) ? "dim" : "warning";
  const icon = status === "working" ? "●" : ["idle", "done"].includes(status) ? "○" : "⚠";
  return `${theme.fg("accent", theme.bold(agent.name || "(unnamed)"))}  ${theme.fg(color, `${icon} ${status}`)}  ${theme.fg("dim", agent.pane_id)}`;
}

export function waitingView(names: string[], statuses: Map<string, string>, theme: Theme): Component {
  return {
    invalidate() {},
    render(width) {
      if (width < 1) return [];
      const shown: string[] = [];
      for (const name of names) {
        const label = theme.fg(statuses.get(name) === "blocked" ? "warning" : "accent", name);
        const remaining = names.length - shown.length - 1;
        const line = `Waiting: ${[...shown, label].join(", ")}${remaining ? ` (+${remaining})` : ""}`;
        if (shown.length && visibleWidth(line) > width) break;
        shown.push(label);
      }
      // The count of hidden peers stays visible: truncate the names, not the "(+N)".
      const more = names.length > shown.length ? ` (+${names.length - shown.length})` : "";
      const room = width - visibleWidth(more);
      if (room < visibleWidth("Waiting: xx...")) {
        const total = `Waiting: ${names.length}`;
        return [truncateToWidth(visibleWidth(total) <= width ? total : String(names.length), width)];
      }
      return [truncateToWidth(`Waiting: ${shown.join(", ")}`, room) + more];
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
  const data = result.details as { deliveries: Delivery[]; discovery?: Omit<Delivery, "to"> } | undefined;
  if (!Array.isArray(data?.deliveries)) return textLines(theme.fg(context.isError ? "error" : "toolOutput", output(result)), width);
  const count = (status: Delivery["status"]) => data.deliveries.filter(d => d.status === status).length;
  const lines = textLines(theme.fg("dim", `${data.deliveries.length} recipients · ${count("submitted")} submitted · ${count("rejected")} rejected · ${count("unknown")} unknown`), width);
  for (const delivery of data.deliveries) {
    const color = delivery.status === "submitted" ? "success" : delivery.status === "rejected" ? "error" : "warning";
    const icon = delivery.status === "submitted" ? "✓" : delivery.status === "rejected" ? "✗" : "?";
    lines.push(...textLines(`${theme.fg(color, `${icon} ${delivery.status}`)} → ${theme.fg("accent", delivery.to)}${delivery.code ? theme.fg("dim", ` [${delivery.code}]`) : ""}`, width));
    if (delivery.error) lines.push(...textLines(theme.fg(color, delivery.error), width));
  }
  if (data.discovery) lines.push(...textLines(theme.fg("warning", `Recipient discovery ${data.discovery.status}${data.discovery.code ? ` [${data.discovery.code}]` : ""}: ${data.discovery.error}`), width));
  else if (!data.deliveries.length) lines.push(...textLines(theme.fg("warning", "No matching named agents to notify."), width));
  return lines;
});
export const listResult: Renderer = (result, options, theme, context) => resultView(options.expanded, context.isPartial, theme, width => {
  if (context.isError) return textLines(theme.fg("error", output(result)), width);
  const data = result.details as { agents: LiveAgent[]; presets: { name: string; description: string; model?: string }[]; self?: string; parent?: string } | undefined;
  if (!data) return textLines(theme.fg("toolOutput", output(result)), width);
  const identity = [data.self && theme.fg("dim", "self ") + theme.fg("accent", data.self), data.parent && theme.fg("dim", "parent ") + theme.fg("accent", data.parent)].filter(Boolean).join(theme.fg("dim", " · "));
  const lines = [...(identity ? textLines(identity, width) : []), ...textLines(theme.fg("dim", `${data.agents.length} agents · ${data.presets.length} presets`), width)];
  for (const agent of data.agents) lines.push(...textLines(agentRow(agent, theme), width));
  if (data.presets.length) {
    lines.push(...textLines(theme.fg("toolTitle", "Presets"), width));
    for (const preset of data.presets) lines.push(...textLines(theme.fg("accent", theme.bold(preset.name)) + theme.fg("dim", `${preset.model ? ` [${preset.model}]` : ""} · ${preset.description}`), width));
  }
  return lines;
});

export function resultMessageView(content: string, details: { name: string; session: string; status: string } | undefined, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, line => theme.bg("customMessageBg", line));
  box.addChild({ invalidate() {}, render(width) {
    if (width < 1) return [];
    const color = details?.status === "error" || details?.status === "unreadable" ? "error" : details?.status === "reply" ? "dim" : "warning";
    const header = theme.fg("toolTitle", theme.bold("result ")) + theme.fg("accent", details?.name || "peer") + theme.fg(color, ` · ${details?.status || "unknown"}`);
    const body = details ? content.split("\n").slice(2).join("\n") : content;
    return bounded([...textLines(header, width), ...new Markdown(body, 0, 0, getMarkdownTheme(), { color: text => theme.fg("toolOutput", text) }).render(width), ...textLines(theme.fg("dim", details?.session || ""), width)], width, expanded);
  } });
  return box;
}

export function noticeView(text: string, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, line => theme.bg("customMessageBg", line));
  box.addChild({ invalidate() {}, render: width => width < 1 ? [] : bounded(textLines(theme.fg("warning", text), width), width, expanded) });
  return box;
}
