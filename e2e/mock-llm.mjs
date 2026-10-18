// Minimal OpenAI-compatible chat-completions server that replays scripted tool calls.
// It stands in for the LLM only; OpenCode, its `read` tool and the plugin are all real.
import http from "node:http";

const SCRIPTS = {
  "SCENARIO-A": [
    ["read", { path: "AGENTS.md" }],
    ["read", { path: ".ai/architecture.md", offset: 10, limit: 20 }],
    ["read", { path: ".ai/architecture.md", offset: 10, limit: 20 }],
    ["read", { path: ".ai/architecture.md", offset: 30, limit: 10 }],
    ["read", { path: ".ai/missing.md" }],
    ["read", { path: "src/app.ts" }],
    ["read", { path: "AGENTS.md" }],
  ],
  // Edge cases: empty file, offset past the end (fails), whole file longer than the 2000-line page, last page, offset 0.
  "SCENARIO-C": [
    ["read", { path: ".ai/empty.md" }],
    ["read", { path: ".ai/short.md", offset: 5 }],
    ["read", { path: ".ai/long.md" }],
    ["read", { path: ".ai/long.md", offset: 2400, limit: 500 }],
    ["read", { path: ".ai/long.md", offset: 0 }],
  ],
  // Answers without any tool call: a session that reads nothing.
  "SCENARIO-D": [],
  // Delegates to a subagent (SCENARIO-S), then reads on its own.
  "SCENARIO-E": [
    ["subagent", { agent: "general", description: "Read context", prompt: "SCENARIO-S read the context" }],
    ["read", { path: ".ai/style.md", limit: 3 }],
  ],
  // The subagent's own reads. (OpenCode's stock subagents cannot delegate further, so nesting is unit-tested only.)
  "SCENARIO-S": [
    ["read", { path: "AGENTS.md" }],
    ["read", { path: ".ai/architecture.md", offset: 1, limit: 10 }],
  ],
  "SCENARIO-B": [
    ["read", { path: ".ai/style.md", limit: 5 }],
    ["read", { path: "AGENTS.md", offset: 2 }],
  ],
};

const port = Number(process.env.PORT ?? 18080);

function text(msg) {
  return typeof msg.content === "string"
    ? msg.content
    : (msg.content ?? []).map((p) => p.text ?? "").join("");
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url.endsWith("/chat/completions")) return res.writeHead(404).end();
      const payload = JSON.parse(body);
      const messages = payload.messages ?? [];
      const prompt = messages.filter((m) => m.role === "user").map(text).join("\n");
      const key = Object.keys(SCRIPTS).find((k) => prompt.includes(k));
      const step = messages.filter((m) => m.role === "tool").length;
      const script = key && payload.tools?.length ? SCRIPTS[key] : undefined;
      const call = script?.[step];

      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "cmpl-mock",
            object: "chat.completion.chunk",
            created: 0,
            model: "scripted",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      if (call) {
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${key}_${step}`,
              type: "function",
              function: { name: call[0], arguments: JSON.stringify(call[1]) },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: script ? "Done reading." : "Context run" });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock llm on ${port}`));
