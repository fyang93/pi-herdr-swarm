// Scripted model and harmless controls for the isolated herdr demo; no external requests.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export default function demo(pi: ExtensionAPI) {
  if (process.env.PI_SWARM_E2E !== "1") throw new Error("This fixture requires PI_SWARM_E2E=1 in an isolated workspace.");
  const faux = fauxProvider({ provider: "swarm-e2e", models: [{ id: "scripted", contextWindow: 1_000_000 }] });
  const respond: Parameters<typeof faux.setResponses>[0][number] = context => {
    let index = -1; let plan: { steps: { tool: string; args: Record<string, any> }[] } | undefined;
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const message = context.messages[i];
      if (message.role !== "user") continue;
      const text = typeof message.content === "string" ? message.content : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      const match = text.match(/SWARM_TEST:(\{[^\n]+\})/);
      if (match) { plan = JSON.parse(match[1]); index = i; break; }
    }
    if (!plan) return fauxAssistantMessage("noted");
    const completed = context.messages.slice(index + 1).filter(m => m.role === "toolResult").length;
    const step = plan.steps[completed];
    if (step) return fauxAssistantMessage(fauxToolCall(step.tool, step.args));
    return fauxAssistantMessage(context.messages.at(-1)?.role === "user" ? "noted" : "done");
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider(faux.provider);
  pi.registerTool({ name: "e2e_wait", label: "Demo wait", description: "Wait for an isolated demo barrier.", parameters: Type.Object({ file: Type.String() }),
    async execute(_id, args, signal, _update, ctx) {
      const file = resolve(ctx.cwd, args.file);
      if (!file.startsWith(`${resolve(ctx.cwd)}${sep}`)) throw new Error("Barrier must be inside the demo cwd.");
      while (!existsSync(file)) await sleep(50, undefined, { signal });
      return { content: [{ type: "text", text: "barrier released" }], details: undefined };
    },
  });
  pi.registerTool({ name: "e2e_question", label: "Demo question", description: "Display a harmless isolated test dialog.", parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      pi.events.emit("herdr:blocked", { active: true, label: "Demo question" });
      try { await ctx.ui.select("Demo question (Escape cancels)", ["Continue"]); return { content: [{ type: "text", text: "dialog closed" }], details: undefined }; }
      finally { pi.events.emit("herdr:blocked", { active: false }); }
    },
  });
  pi.registerTool({ name: "e2e_state", label: "Demo state", description: "Inspect local pending work.", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: String((globalThis as any)[Symbol.for("pi-herdr-swarm/pending-count")]?.() ?? 0) }], details: undefined }; },
  });
  pi.registerCommand("e2e-no-reply", { description: "End this isolated session without another assistant reply.", handler: async (_args, ctx) => { ctx.shutdown(); } });
}
