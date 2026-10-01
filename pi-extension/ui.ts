import { keyHint, getMarkdownTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text, Markdown, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Note } from "./board.ts";
import type { Delivery, LiveAgent } from "./herdr.ts";

const preview = (text: string) => text.split(/\r?\n/).find(line => line.trim())?.trim() || "";
const textLines = (text: string, width: number) => new Text(text, 0, 0).render(width);

/** Count wrapped display rows, not source lines; leave one row for the current keybinding. */
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

export function frame(title: string, rows: string[], theme: Theme): Component {
  return {
    invalidate() {},
    render(width) {
      if (width < 4) return [];
      const inner = width - 2;
      const edge = (s: string) => theme.fg("accent", s);
      const header = truncateToWidth(`─ ${title} `, inner);
      return [edge(`╭${header}${"─".repeat(Math.max(0, inner - visibleWidth(header)))}╮`),
        ...rows.map(row => {
          const line = truncateToWidth(` ${row}`, inner);
          return edge("│") + line + " ".repeat(Math.max(0, inner - visibleWidth(line))) + edge("│");
        }), edge(`╰${"─".repeat(inner)}╯`)];
    },
  };
}

function duration(ms: number): string {
  const seconds = Math.floor(Math.abs(ms) / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86_400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86_400)}d`;
}

function noteLines(note: Note, width: number, expanded: boolean, theme: Theme): string[] {
  const now = Date.now();
  const head = theme.fg("accent", `${theme.bold(note.from)} → ${theme.bold(note.to)}`) + theme.fg("dim", ` · [${note.kind}]`);
  const age = note.created > now ? `in ${duration(note.created - now)}` : `${duration(now - note.created)} ago`;
  const expiry = note.expires > now ? theme.fg("dim", `expires in ${duration(note.expires - now)}`) : theme.fg("warning", `expired ${duration(now - note.expires)} ago`);
  const meta = theme.fg("dim", [...note.tags.map(tag => `#${tag}`), age].join(" · ")) + theme.fg("dim", " · ") + expiry;
  const header = visibleWidth(`${head} · ${meta}`) <= width ? `${head}${theme.fg("dim", " · ")}${meta}` : `${head}\n${meta}`;
  return [...textLines(header, width), ...(expanded
    ? new Markdown(note.message, 0, 0, getMarkdownTheme(), { color: text => theme.fg("toolOutput", text) }).render(width)
    : [truncateToWidth(theme.fg("toolOutput", preview(note.message)), width)])];
}

interface Details {
  name?: string;
  pane?: string;
  notes?: Note[];
  note?: Note;
  deliveries?: Delivery[];
  agents?: LiveAgent[];
  definitions?: { name: string; description: string; model?: string }[];
}

/** No inner Box: pi supplies tool framing, backgrounds and the authoritative error/partial flags. */
export const renderToolResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, context) => ({
  invalidate() {},
  render(width) {
    if (width < 1) return [];
    const { expanded } = options;
    const details = result.details as Details | undefined;
    const output = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    let lines: string[];
    if (context.isPartial) lines = textLines(theme.fg("accent", "● working…"), width);
    else if (details?.deliveries) {
      const submitted = details.deliveries.filter(d => d.submitted).length;
      lines = textLines(theme.fg("dim", `${details.deliveries.length} recipients · ${submitted} submitted · ${details.deliveries.length - submitted} unconfirmed`), width);
      for (const delivery of details.deliveries) {
        const status = theme.fg(delivery.submitted ? "success" : "warning", delivery.submitted ? "✓ submitted" : "⚠ unconfirmed");
        lines.push(...textLines(`${status} → ${theme.fg("accent", delivery.to)}`, width));
        if (delivery.error) lines.push(...textLines(theme.fg("error", delivery.error), width));
      }
      if (!details.deliveries.length) lines.push(...textLines(theme.fg("warning", "No matching named agents to notify."), width));
      if (details.note) lines.push(...textLines(theme.fg("dim", `persisted · expires ${new Date(details.note.expires).toISOString()}`), width));
    } else if (context.isError) lines = textLines(theme.fg("error", output), width);
    else if (details?.notes) {
      lines = textLines(theme.fg("dim", `${details.notes.length} ${details.notes.length === 1 ? "note" : "notes"}`), width);
      for (const note of details.notes) lines.push(...noteLines(note, width, expanded, theme));
      if (!details.notes.length) lines.push(...textLines(theme.fg("dim", "No unexpired messages."), width));
    } else if (details?.agents) {
      lines = textLines(theme.fg("dim", `${details.agents.length} agents · ${details.definitions?.length ?? 0} definitions`), width);
      for (const agent of details.agents) lines.push(...textLines(agentRow(agent, theme), width));
      lines.push(...textLines(theme.fg("toolTitle", "Definitions"), width));
      for (const definition of details.definitions ?? []) {
        lines.push(...textLines(theme.fg("accent", theme.bold(definition.name)) + theme.fg("dim", `${definition.model ? ` [${definition.model}]` : ""} · ${definition.description}`), width));
      }
      lines.push(...textLines(theme.fg("warning", "Unlisted does not prove completion or a crash."), width));
    } else if (details?.name && details.pane) {
      lines = textLines(theme.fg("accent", theme.bold(details.name)) + theme.fg("dim", ` · started · ${details.pane}`), width);
    } else lines = textLines(theme.fg("toolOutput", output), width);
    return bounded(lines, width, expanded);
  },
});

export function noticeView(text: string, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, line => theme.bg("customMessageBg", line));
  box.addChild({
    invalidate() {},
    render: width => width < 1 ? [] : bounded(textLines(theme.fg("warning", text), width), width, expanded),
  });
  return box;
}
