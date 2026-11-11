// zfr-magpie/test-integration.mjs — end-to-end via auth.loader.fetch + Bun.serve mock upstream.
// This is the REAL effect test, not a chain self-check: it exercises actual HTTP requests
// through the plugin's fetch hook into a live upstream stub.
import assert from "node:assert/strict";
import { ZfrMagpiePlugin } from "../index.mjs";
import { Lane } from "../src/constants.mjs";

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; console.log("FAIL", name, "::", e.message); }
};

const SSE = (lines) => lines.map((x) => `data: ${typeof x === "string" ? x : JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n";
const delta = (content, extra = {}) => ({ choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] });

/** Mock upstream server. handler(req, {seq, port}) -> Response */
function mockUpstream(handler) {
  const seen = [];
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.text();
      const rec = { url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body, at: Date.now() };
      seen.push(rec);
      return handler(rec, seen.length) ?? new Response(SSE([delta("ok"), { choices: [], usage: { total_tokens: 7 } }]), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { srv, seen, base: `http://127.0.0.1:${srv.port}` };
}

const chatBody = (extra = {}) => JSON.stringify({
  model: "beam-free",
  messages: [{ role: "user", content: "hello" }],
  ...extra,
});

async function pluginFetch(options, input, init) {
  const plugin = await ZfrMagpiePlugin({}, options);
  const { fetch: f } = await plugin.auth.loader(async () => ({ type: "api", key: "public" }));
  return f(input, init);
}

// ---------------------------------------------------------------------------------------------
await t("plugin contract: named function, config declares provider+models, loader returns fetch", async () => {
  const p = await ZfrMagpiePlugin({}, {});
  assert.equal(typeof p.config, "function");
  assert.equal(typeof p.auth.loader, "function");
  assert.ok(Array.isArray(p.auth.methods) && p.auth.methods[0].type === "api");
  const cfg = { provider: {} };
  await p.config(cfg);
  assert.ok(cfg.provider.zfr);
  assert.ok(cfg.provider.zfr.models["beam-free"]);
  const o = await p.auth.loader(async () => ({}));
  assert.equal(typeof o.fetch, "function");
  assert.equal(typeof o.baseURL, "string");
});

await t("non-chat request passes through untouched", async () => {
  const m = mockUpstream(() => new Response("MODEL_LIST", { status: 200 }));
  try {
    const r = await fetch(`${m.base}/v1/models`);
    assert.equal(await r.text(), "MODEL_LIST");
    assert.equal(m.seen.length, 1);
    // plugin's own fetch should pass it through as well
    const p = await ZfrMagpiePlugin({}, {});
    const { fetch: f } = await p.auth.loader(async () => ({}));
    const r2 = await f(`${m.base}/v1/models`, { method: "GET" });
    assert.equal(await r2.text(), "MODEL_LIST");
  } finally { m.srv.stop(true); }
});

await t("non-stream chat: SSE aggregated to OpenAI JSON + fingerprint headers", async () => {
  const m = mockUpstream(() => new Response(SSE([
    delta("Hello "), delta("world", { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":' } }] }),
    delta(null, { tool_calls: [{ index: 0, function: { arguments: '"/tmp"}' } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const r = await pluginFetch({ baseOverrides: { [Lane.OPENCODE_ZEN]: m.base } },
      `${m.base}/chat/completions`, { method: "POST", body: chatBody({ tools: [{ type: "function", function: { name: "mytool", description: "custom" } }] }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type").startsWith("application/json"), true);
    const j = await r.json();
    assert.equal(j.object, "chat.completion");
    assert.equal(j.choices[0].message.content, "Hello world");
    assert.equal(j.choices[0].finish_reason, "stop");
    assert.equal(j.usage.total_tokens, 5);
    assert.equal(j.choices[0].message.tool_calls[0].function.arguments, '{"path":"/tmp"}');
    assert.equal(m.seen.length, 1);
    const up = JSON.parse(m.seen[0].body);
    assert.equal(up.stream, true);
    assert.equal(up.max_completion_tokens, 32000);
    assert.equal(up.tools.length, 3);  // 1 caller tool + 2 injected placeholders
    assert.equal(m.seen[0].headers["authorization"], "Bearer public");
    assert.equal(m.seen[0].headers["user-agent"], "opencode/latest/2.1.3/cli");
    assert.equal(m.seen[0].headers["x-opencode-client"], "cli");
    assert.equal(m.seen[0].headers["x-opencode-project"], "global");
    assert.match(m.seen[0].headers["x-opencode-session"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(m.seen[0].headers["x-session-affinity"], m.seen[0].headers["x-opencode-session"]);
    assert.equal(m.seen[0].headers["accept"], "text/event-stream");
    assert.ok(m.seen[0].headers["x-zfr-relay-key"] === undefined);
    // V2 key order: model first
    assert.ok(m.seen[0].body.startsWith('{"model":"beam-free"'));
  } finally { m.srv.stop(true); }
});

// ---- streaming + failover: the actual core behaviour --------------------------------------
await t("stream:true returns SSE with aliased tool names restored", async () => {
  const m = mockUpstream(() => new Response(SSE([
    delta("hi"),
    delta(null, { tool_calls: [{ index: 0, id: "c1", function: { name: "shell_client", arguments: "{}" } }] }),
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const r = await pluginFetch({ baseOverrides: { [Lane.OPENCODE_ZEN]: m.base } },
      `${m.base}/chat/completions`, { method: "POST", body: chatBody({ stream: true, tools: [
        { type: "function", function: { name: "shell", description: "custom shell" } },
      ] }) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    const text = await r.text();
    assert.match(text, /"name":"shell"/);
    assert.ok(!text.includes("shell_client"));
    assert.match(text, /\[DONE\]/);
    // upstream body got the ALIASED tool name, not the original
    const up = JSON.parse(m.seen[0].body);
    assert.ok(up.tools.some((x) => x.function.name === "shell_client"));
    assert.equal(up.stream, true);
  } finally { m.srv.stop(true); }
});

await t("429 -> cooldown -> second request avoids that exit (multi-egress rotation)", async () => {
  // Three separate upstream stubs acting as three exits; ALL of them 429 on the
  // first attempt so we can observe the cooldown-driven rotation on the next call.
  const m1 = mockUpstream(() => new Response('{"error":{"message":"usage limit"}}',
    { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } }));
  const m2 = mockUpstream(() => new Response(SSE([delta("OK2")]),
    { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    // Use the SAME plugin instance across two fetches so the pool keeps its bans.
    const plugin = await ZfrMagpiePlugin({}, {
      egress: ["direct"],
      baseOverrides: { [Lane.OPENCODE_ZEN]: m1.base, [Lane.KILO_FREE]: m2.base },
      allowModelFailover: false,
    });
    const { fetch: f } = await plugin.auth.loader(async () => ({}));
    const url = `${m1.base}/chat/completions`;
    const init = { method: "POST", body: chatBody() };
    const r1 = await f(url, init);
    // primary + its exits all failed; the failover chain is disabled -> error
    assert.equal(r1.status, 429);
    assert.equal(m1.seen.length, 1);
    const cd = plugin._zfr.activeCooldowns();
    assert.ok(cd.length >= 1);
    assert.equal(cd[0].class, "quota429");
    assert.ok(cd[0].remaining_secs > 0 && cd[0].remaining_secs <= 60);
    // The (exit,model) pair is now cooled: a second identical request must NOT
    // hit m1 again (single cold exit is only used as a one-shot probe).
    const r2 = await f(url, init);
    assert.equal(r2.status, 429);
    assert.equal(m1.seen.length, 2); // exactly one single-shot probe, not a full retry loop
  } finally { m1.srv.stop(true); m2.srv.stop(true); }
});

await t("model failover: primary 429 -> Kilo twin serves success", async () => {
  const zen = mockUpstream(() => new Response('{"error":{"message":"usage limit"}}',
    { status: 429, headers: { "content-type": "application/json" } }));
  const kilo = mockUpstream(() => new Response(SSE([delta("FROM_KILO")]),
    { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const plugin = await ZfrMagpiePlugin({}, {
      egress: ["direct"],
      baseOverrides: { [Lane.OPENCODE_ZEN]: zen.base, [Lane.KILO_FREE]: kilo.base },
    });
    const { fetch: f } = await plugin.auth.loader(async () => ({}));
    const r = await f(`${zen.base}/chat/completions`, { method: "POST", body: chatBody() });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.choices[0].message.content, "FROM_KILO");
    assert.ok(zen.seen.length >= 1);
    assert.ok(kilo.seen.length >= 1);
    // Kilo lane uses anonymous auth + forced stream, no opencode session headers
    assert.equal(kilo.seen[0].headers["authorization"], "Bearer anonymous");
    assert.equal(kilo.seen[0].headers["x-opencode-client"], undefined);
    assert.equal(JSON.parse(kilo.seen[0].body).stream, true);
    assert.equal(r.headers.get("x-zfr-model"), "reflection/beam-free");
  } finally { zen.srv.stop(true); kilo.srv.stop(true); }
});

await t("relay:// exit wraps request into JSON envelope with x-zfr-relay-key", async () => {
  const relay = mockUpstream((rec) => {
    // The relay stub echoes back a normal SSE body; the ENVELOPE is what we assert.
    return new Response(SSE([delta("VIA_RELAY")]), { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  try {
    const plugin = await ZfrMagpiePlugin({}, {
      egress: [`relay://${relay.base}#key=SECRET123`],
      baseOverrides: { [Lane.OPENCODE_ZEN]: "https://opencode.ai/inference/openai/v1" },
      allowModelFailover: false,
    });
    const { fetch: f } = await plugin.auth.loader(async () => ({}));
    const r = await f("https://opencode.ai/inference/openai/v1/chat/completions", { method: "POST", body: chatBody() });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, "VIA_RELAY");
    const env = JSON.parse(relay.seen[0].body);
    assert.equal(env.method, "POST");
    assert.match(env.url, /opencode\.ai/);
    assert.match(env.url, /chat\/completions/);
    assert.equal(env.headers["Authorization"], "Bearer public");
    assert.equal(relay.seen[0].headers["x-zfr-relay-key"], "SECRET123");
    assert.equal(relay.seen[0].url, `${relay.base}/`);
    // key never leaks into the node diagnostics spec
    const nodes = plugin._zfr.nodes();
    assert.ok(!nodes[0].spec.includes("SECRET123"));
    assert.ok(nodes[0].spec.startsWith("relay://"));
    assert.equal(nodes[0].relay, true);
  } finally { relay.srv.stop(true); }
});

await t("session header stable per (conv,exit) and distinct across exits", async () => {
  const m = mockUpstream(() => new Response(SSE([delta("ok")]),
    { status: 200, headers: { "content-type": "text/event-stream" } }));
  try {
    const plugin = await ZfrMagpiePlugin({}, {
      egress: ["direct"], allowModelFailover: false,
      baseOverrides: { [Lane.OPENCODE_ZEN]: m.base },
    });
    const { fetch: f } = await plugin.auth.loader(async () => ({}));
    await f(`${m.base}/chat/completions`, { method: "POST", body: chatBody() });
    await f(`${m.base}/chat/completions`, { method: "POST", body: chatBody() });
    assert.equal(m.seen[0].headers["x-opencode-session"], m.seen[1].headers["x-opencode-session"]);
    await f(`${m.base}/chat/completions`, { method: "POST", body: chatBody({ messages: [{ role: "user", content: "DIFFERENT" }] }) });
    assert.notEqual(m.seen[0].headers["x-opencode-session"], m.seen[2].headers["x-opencode-session"]);
  } finally { m.srv.stop(true); }
});

console.log(`\n[INTEGRATION] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);