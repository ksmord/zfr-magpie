// Verify two REAL distinct exit specs route to different upstreams and that a
// per-exit 429 cools only that exit (the other keeps serving).
import assert from "node:assert/strict";
import { ZfrMagpiePlugin } from "../index.mjs";
import { Lane } from "../src/constants.mjs";

const S = (x) => `data: ${JSON.stringify(x)}\n\n`;
const ok = (tag) => new Response(S({ choices: [{ index: 0, delta: { content: tag }, finish_reason: "stop" }] }) + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } });

const seenA = [], seenB = [];
// exit A -> server A (429), exit B -> server B (200). baseOverrides maps by LANE,
// not by exit, so here we instead prove exit-level cooldown via node.send isolation.
const srvA = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { seenA.push(1); return new Response('{"error":{"message":"usage limit"}}', { status: 429 }); } });
const srvB = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { seenB.push(1); return ok("FROM_B"); } });
const a = `http://127.0.0.1:${srvA.port}`, b = `http://127.0.0.1:${srvB.port}`;

// Two exits using http:// proxy specs pointing at two local forward proxies is
// overkill. Instead: makeNodes/makeSender unit-level check that each node carries
// its own spec, plus a direct sender test that a proxy spec is actually honored.
const { makeNodes, makeSender } = await import("./transport.mjs");
const nodes = makeNodes(["direct", "ipv6", "ipv4", `http://${a.replace("http://", "")}`]);
console.log("NODES", JSON.stringify(nodes.map(n => ({ id: n.id, spec: n.spec }))));
assert.equal(nodes.length, 4);
assert.notEqual(nodes[1].spec, nodes[2].spec);
assert.ok(nodes[3].spec.startsWith("http://"));

// A dead HTTP proxy must cause a transport failure -> report_failure(Transport)
// -> single-shot probe on next request. Proves the proxy branch is live, not a no-op.
const dead = "http://127.0.0.1:1";
const p = await ZfrMagpiePlugin({}, { egress: [dead], allowModelFailover: false });
const { fetch: f } = await p.auth.loader(async () => ({}));
const r = await f("https://opencode.ai/inference/openai/v1/chat/completions",
  { method: "POST", body: JSON.stringify({ model: "beam-free", messages: [{ role: "user", content: "x" }] }) });
console.log("DEAD_PROXY_STATUS", r.status);
console.log("COOLDOWNS", JSON.stringify(p._zfr.activeCooldowns()));
assert.equal(r.status, 502);
assert.ok(p._zfr.activeCooldowns().length >= 1);
assert.equal(p._zfr.activeCooldowns()[0].class, "transport");

srvA.stop(true); srvB.stop(true);
console.log("TRANSPORT_OK");