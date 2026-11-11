// zfr-magpie/test-unit.mjs — pure-function unit tests. Run: magpie-bun test-unit.mjs
import assert from "node:assert/strict";
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("PASS", name); } catch (e) { fail++; console.log("FAIL", name, "::", e.message); } };

import {
  mintSessionId, decodeSessionTimestampMs, deriveConversationSeed,
  gatewayHeaders, applyFingerprint, encodeV2ChatBody, unaliasToolName, SessionLedger,
} from "../src/fingerprint.mjs";
import {
  resolveModel, failoverChain, kiloEquivalent, opencodeEquivalent, laneConfig,
} from "../src/catalog.mjs";
import {
  EgressPool, FailureClass, classifyHttpFailure, extractErrorMessage,
} from "../src/egress.mjs";
import { rewriteSseLine, aggregateSseToJson } from "../src/sse.mjs";
import { makeNodes, expandSpecs, parseRelaySpec } from "../src/transport.mjs";
import { Lane, REAL_READ_DESC, REAL_SHELL_DESC, FINGERPRINT_READ_TOOL } from "../src/constants.mjs";

// ---- fingerprint --------------------------------------------------------------------------
t("mintSessionId format + timestamp roundtrip (48-bit wrap)", () => {
  // Rust: inv = (!((ms<<12)|seq)) & 0xffff_ffff_ffff. Only the LOW 48 bits survive,
  // so decode() can only recover ms & 0xffff_ffff_f (36 bits, ~2.18y wrap). This is
  // the original's behaviour, not a JS porting bug.
  const now = 1792728000123;
  const sid = mintSessionId(now);
  assert.match(sid, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(decodeSessionTimestampMs(sid), now % (2 ** 36));
  // A timestamp that genuinely fits in 36 bits round-trips exactly (2^36 ~ 6.87e10).
  const small = 1_000_000_000;
  assert.equal(decodeSessionTimestampMs(mintSessionId(small)), small);
  assert.notEqual(mintSessionId(now), mintSessionId(now)); // seq differs
});
t("decodeSessionTimestampMs rejects junk", () => {
  assert.equal(decodeSessionTimestampMs("nope"), null);
  assert.equal(decodeSessionTimestampMs("ses_zz"), null);
});
t("SessionLedger stable per (seed,exit)", () => {
  const l = new SessionLedger();
  const a = l.sessionForExit("seed1", "direct");
  assert.equal(l.sessionForExit("seed1", "direct"), a);
  assert.notEqual(l.sessionForExit("seed1", "ipv6"), a);
  assert.notEqual(l.sessionForExit("", "direct"), l.sessionForExit("", "direct"));
});
t("deriveConversationSeed stable + content-sensitive", () => {
  const b = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(deriveConversationSeed(b), deriveConversationSeed(structuredClone(b)));
  assert.notEqual(deriveConversationSeed(b), deriveConversationSeed({ messages: [{ role: "user", content: "bye" }] }));
  assert.match(deriveConversationSeed(b), /^[0-9a-f]{64}$/);
});
t("gatewayHeaders exact", () => {
  const h = Object.fromEntries(gatewayHeaders("ses_ABC", ""));
  assert.equal(h["Authorization"], "Bearer public");
  assert.equal(h["User-Agent"], "opencode/latest/2.1.3/cli");
  assert.equal(h["x-opencode-project"], "global");
  assert.equal(h["x-opencode-session"], "ses_ABC");
  assert.equal(h["x-session-affinity"], "ses_ABC");
  assert.equal(h["Accept"], "text/event-stream");
});
t("applyFingerprint: force stream, tool_choice none, tokens, tools injected", () => {
  const body = { model: "beam-free", messages: [{ role: "user", content: "hi" }], tool_choice: "none", max_tokens: 100, stream: false };
  const plan = applyFingerprint(body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal("tool_choice" in body, false);
  assert.equal(body.max_completion_tokens, 100);
  assert.equal("max_tokens" in body, false);
  assert.equal(body.tools.length, 2);
  assert.equal(body.tools[0].function.name, "read");
  assert.equal(body.tools[1].function.name, "shell");
  assert.equal(body.messages[0].role, "system");
  assert.equal(plan.downstream_wants_stream, false);
  assert.equal(plan.drop_placeholder_tool_calls, true);
  assert.equal(plan.aliased_client_tools, false);
});
t("applyFingerprint: alias custom read/shell + historical tool_calls", () => {
  const body = {
    model: "m", stream: true,
    messages: [
      { role: "assistant", tool_calls: [{ function: { name: "read", arguments: "{}" } }] },
      { role: "user", content: "go" },
    ],
    tools: [
      { type: "function", function: { name: "read", description: "custom" } },
      { type: "function", function: { name: "shell", description: "custom" } },
    ],
  };
  const plan = applyFingerprint(body);
  assert.equal(body.tools[0].function.name, "read_client");
  assert.equal(body.tools[1].function.name, "shell_client");
  assert.equal(body.tools[0].function.strict, false);
  assert.equal(body.messages[1].tool_calls[0].function.name, "read_client");
  assert.equal(body.tools.length, 4); // 2 aliased + 2 exact injected
  assert.equal(plan.aliased_client_tools, true);
  assert.equal(plan.drop_placeholder_tool_calls, false);
  assert.match(body.messages[0].content, /read_client/);
});
t("applyFingerprint: exact read/shell NOT aliased", () => {
  const body = { model: "m", messages: [{ role: "user", content: "x" }], tools: [
    { type: "function", function: { name: "read", description: REAL_READ_DESC } },
    { type: "function", function: { name: "shell", description: REAL_SHELL_DESC } },
  ] };
  const plan = applyFingerprint(body);
  assert.equal(body.tools.length, 2);
  assert.equal(plan.aliased_client_tools, false);
});
t("encodeV2ChatBody key order + no HTML escaping", () => {
  const s = encodeV2ChatBody({ zzz: 1, messages: [], model: "m", stream: true, tools: [], aaa: "<&>" });
  const keys = [...s.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
  assert.deepEqual(keys.slice(0, 4), ["model", "messages", "tools", "stream"]);
  assert.ok(s.includes("<&>"));
  assert.ok(s.indexOf('"aaa"') > s.indexOf('"stream"'));
});
t("unaliasToolName", () => {
  assert.equal(unaliasToolName("read_client"), "read");
  assert.equal(unaliasToolName("shell_client"), "shell");
  assert.equal(unaliasToolName("bash"), "bash");
});

// ---- catalog ------------------------------------------------------------------------------
t("resolveModel prefixes + aliases", () => {
  assert.deepEqual(resolveModel("opencode/beam-free"), [Lane.OPENCODE_ZEN, "beam-free"]);
  assert.deepEqual(resolveModel("kilo/reflection/beam-free"), [Lane.KILO_FREE, "reflection/beam-free"]);
  assert.deepEqual(resolveModel("nvidia/foo:free"), [Lane.KILO_FREE, "nvidia/foo:free"]);
  assert.deepEqual(resolveModel("nvidia/foo"), [Lane.NVIDIA_FREE, "foo"]);
  assert.deepEqual(resolveModel("openrouter/free"), [Lane.KILO_FREE, "openrouter/free"]);
  assert.deepEqual(resolveModel("auto"), [Lane.OPENCODE_ZEN, "beam-free"]);
  assert.deepEqual(resolveModel("vision"), [Lane.KILO_FREE, "nvidia/nemotron-3.5-super-vl:free"]);
  assert.deepEqual(resolveModel("foo/bar"), [Lane.KILO_FREE, "foo/bar"]);
  assert.deepEqual(resolveModel("beam-free (free)"), [Lane.OPENCODE_ZEN, "beam-free"]);
});
t("cross-lane equivalents inverse", () => {
  const k = kiloEquivalent("beam-free");
  assert.equal(k, "reflection/beam-free");
  assert.equal(opencodeEquivalent(k), "beam-free");
  assert.equal(kiloEquivalent("nemotron-3-ultra-free"), "nvidia/nemotron-3-ultra-550b-a55b:free");
});
t("failoverChain: primary + twin + defaults, no dup, env-gated", () => {
  const c = failoverChain("beam-free", {});
  assert.deepEqual(c[0], [Lane.OPENCODE_ZEN, "beam-free"]);
  assert.deepEqual(c[1], [Lane.KILO_FREE, "reflection/beam-free"]);
  assert.ok(c.some(([l, m]) => m === "kilo-auto/free"));
  assert.equal(new Set(c.map((x) => x.join("|"))).size, c.length);
  const c2 = failoverChain("beam-free", { GROQ_API_KEY: "x" });
  assert.ok(c2.some(([l, m]) => l === Lane.GROQ_FREE && m === "openai/gpt-oss-120b"));
});
t("laneConfig bases + auth", () => {
  assert.equal(laneConfig(Lane.KILO_FREE).auth, "Bearer anonymous");
  assert.equal(laneConfig(Lane.OPENCODE_ZEN).auth, "Bearer public");
  assert.deepEqual(laneConfig(Lane.OPENROUTER_FREE).extra, [["X-Title", "ZFR Core"]]);
});

// ---- egress -------------------------------------------------------------------------------
t("expandSpecs / makeNodes ids + relay key strip", () => {
  assert.deepEqual(expandSpecs(["auto"]), ["ipv6", "ipv4"]);
  assert.deepEqual(expandSpecs([]), ["direct"]);
  const n = makeNodes(["direct", "http://127.0.0.1:1", "relay://https://r.example#key=SECRET"]);
  assert.equal(n[0].id, "direct");
  assert.equal(n[1].id, "exit-1:http://127.0.0.1:1");
  assert.equal(n[2].storedSpec, "relay://https://r.example");
  assert.ok(!n[2].storedSpec.includes("SECRET"));
  assert.equal(parseRelaySpec("relay://https://r.example#key=SECRET").key, "SECRET");
});
t("classifyHttpFailure + extractErrorMessage", () => {
  assert.equal(classifyHttpFailure(429, ""), FailureClass.QUOTA_429);
  assert.equal(classifyHttpFailure(200, '{"error":{"message":"FreeUsageLimitError"}}'), FailureClass.QUOTA_429);
  assert.equal(classifyHttpFailure(403, "freetiererror"), FailureClass.FREE_TIER_403);
  assert.equal(classifyHttpFailure(403, ""), FailureClass.REGION_BLOCK);
  assert.equal(classifyHttpFailure(500, "region blocked"), FailureClass.REGION_BLOCK);
  assert.equal(classifyHttpFailure(500, ""), FailureClass.UPSTREAM_5XX);
  assert.equal(extractErrorMessage('{"error":{"message":"boom"}}', 30), "boom (Retry-After: 30s)");
  assert.equal(extractErrorMessage("rawtext", null), "rawtext");
});
t("EgressPool candidates stable by seed + cooldown + revive", () => {
  const p = new EgressPool(["direct", "ipv6", "ipv4"]);
  const a = p.candidatesFor("seedA", "m", 3).map((x) => x.id);
  const b = p.candidatesFor("seedA", "m", 3).map((x) => x.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  const first = a[0];
  p.reportFailure(first, "m", FailureClass.QUOTA_429, 60, "limit");
  assert.ok(!p.candidatesFor("seedA", "m", 3).map((x) => x.id).includes(first));
  assert.equal(p.modelHasHealthyExit("m"), true);
  p.revive(first, "m");
  assert.ok(p.candidatesFor("seedA", "m", 3).map((x) => x.id).includes(first));
});
t("EgressPool cooldown TTLs + relay 90s + backoff", () => {
  const p = new EgressPool(["direct", "relay://https://r.example"]);
  p.reportFailure("direct", "m", FailureClass.UPSTREAM_5XX, null, "5xx");
  assert.equal(p.activeCooldowns()[0].remaining_secs, 45);
  p.reportFailure("direct", "m", FailureClass.UPSTREAM_5XX, null, "5xx again");
  assert.equal(p.activeCooldowns()[0].remaining_secs, 90); // 45 * 2^1
  const relayId = p.nodes[1].id;
  p.reportFailure(relayId, "m", FailureClass.QUOTA_429, 1800, "quota");
  const rc = p.activeCooldowns().find((x) => x.exit_id === relayId);
  assert.equal(rc.remaining_secs, 90); // relay ignores Retry-After
});

// ---- sse ----------------------------------------------------------------------------------
t("rewriteSseLine: passthrough / [DONE] / drop / unalias", () => {
  const planDrop = { drop_placeholder_tool_calls: true, aliased_client_tools: false };
  const planAlias = { drop_placeholder_tool_calls: false, aliased_client_tools: true };
  assert.equal(rewriteSseLine("event: ping\n\n", planDrop), "event: ping\n\n");
  assert.equal(rewriteSseLine("data: [DONE]\n\n", planDrop), "data: [DONE]\n\n");
  const dropped = rewriteSseLine('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"read_client"}}]}}]}\n', planDrop);
  assert.ok(!JSON.parse(dropped.slice(6)).choices[0].delta.tool_calls);
  const unaliased = rewriteSseLine('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"shell_client"}}]}}]}\n', planAlias);
  assert.equal(JSON.parse(unaliased.slice(6)).choices[0].delta.tool_calls[0].function.name, "shell");
});

console.log(`\n[UNIT] pass=${pass} fail=${fail}`);
if (fail) process.exit(1);