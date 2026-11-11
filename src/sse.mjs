// zfr-magpie/sse.mjs — SSE line rewriting + aggregation (router.rs 515-731 verbatim).
import { unaliasToolName } from "./fingerprint.mjs";

/** rewrite_sse_line() — router.rs 553-588 verbatim.
 *  Blank SSE separator lines are dropped here; the rewritten data line already
 *  ends with "\n\n", which is the separator. */
export function rewriteSseLine(line, plan) {
  const trimmed = line.trim();
  if (trimmed === "") return "";
  if (!trimmed.startsWith("data:")) return line;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return "data: [DONE]\n\n";
  if (payload === "") return line;
  let v;
  try { v = JSON.parse(payload); } catch { return line; }
  if (Array.isArray(v?.choices)) {
    for (const ch of v.choices) {
      const delta = ch?.delta;
      if (!delta || typeof delta !== "object") continue;
      if (plan.drop_placeholder_tool_calls) {
        delete delta.tool_calls;
      } else if (plan.aliased_client_tools && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc?.function && typeof tc.function.name === "string") {
            tc.function.name = unaliasToolName(tc.function.name);
          }
        }
      }
    }
  }
  return `data: ${JSON.stringify(v)}\n\n`;
}

/** Build a filtered SSE ReadableStream from an upstream Response (streaming path).
 *  Uses start()+full drain instead of pull(): Bun's ReadableStream pull scheduling
 *  allowed unprocessed buffer tails to leak through unre-written. */
export function filteredSseStream(resp, plan) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let buf = "";
      const emit = (line) => {
        const out = rewriteSseLine(line, plan);
        if (out) controller.enqueue(enc.encode(out));
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let pos;
          while ((pos = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, pos + 1);
            buf = buf.slice(pos + 1);
            emit(line);
          }
        }
        buf += dec.decode();
        if (buf) emit(buf);
        controller.close();
      } catch (e) { controller.error(e); }
    },
    cancel() { try { reader.cancel(); } catch {} },
  });
}

/** aggregate_sse_to_json() — router.rs 596-731 verbatim: latest usage, tool_calls by
 *  index, reasoning merge, id chatcmpl-zfr-{unix_seconds}. */
export async function aggregateSseToJson(resp, servedModel, plan) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "", reasoning = "", finishReason = "stop";
  let latestUsage = null;
  const toolCallsByIdx = new Map();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let pos;
    while ((pos = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, pos).trim();
      buf = buf.slice(pos + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      let v;
      try { v = JSON.parse(payload); } catch { continue; }
      if (v.usage != null) latestUsage = v.usage;
      if (!Array.isArray(v.choices)) continue;
      for (const ch of v.choices) {
        if (typeof ch?.finish_reason === "string" && ch.finish_reason) finishReason = ch.finish_reason;
        const d = ch?.delta;
        if (!d || typeof d !== "object") continue;
        if (typeof d.content === "string") content += d.content;
        const r = d.reasoning_content ?? d.reasoning;
        if (typeof r === "string") reasoning += r;
        if (!plan.drop_placeholder_tool_calls && Array.isArray(d.tool_calls)) {
          d.tool_calls.forEach((tc, fallbackI) => {
            const idx = Number.isInteger(tc?.index) ? tc.index : fallbackI;
            if (!toolCallsByIdx.has(idx)) toolCallsByIdx.set(idx, { id: `call_${idx}`, name: "", arguments: "" });
            const e = toolCallsByIdx.get(idx);
            if (typeof tc?.id === "string" && tc.id) e.id = tc.id;
            const f = tc?.function;
            if (f && typeof f.name === "string" && f.name) {
              e.name = plan.aliased_client_tools ? unaliasToolName(f.name) : f.name;
            }
            if (typeof f?.arguments === "string") e.arguments += f.arguments;
          });
        }
      }
    }
  }
  const nowSecs = Math.floor(Date.now() / 1000);
  const msg = { role: "assistant", content };
  if (reasoning) msg.reasoning_content = reasoning;
  if (toolCallsByIdx.size) {
    msg.tool_calls = [...toolCallsByIdx.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, e]) => ({ id: e.id, type: "function", function: { name: e.name, arguments: e.arguments } }));
  }
  const out = {
    id: `chatcmpl-zfr-${nowSecs}`,
    object: "chat.completion",
    created: nowSecs,
    model: servedModel,
    choices: [{ index: 0, message: msg, finish_reason: finishReason }],
  };
  if (latestUsage != null) out.usage = latestUsage;
  return out;
}