// zfr-magpie/fingerprint.mjs
// Port of zfr-core src/fingerprint.rs (OpenCode v2.1.3 wire protocol compatibility).
// All constants/strings transcribed verbatim before the .rs sources were removed.
import { createHash } from "node:crypto";
import {
  BASE62, DEFAULT_PROJECT_ID, OPENCODE_CLIENT_UA, NOTE_NO_TOOLS, NOTE_PLACEHOLDER_TOOLS,
  NOTE_ALIASED_BOTH, NOTE_ALIASED_READ_ONLY, NOTE_ALIASED_SHELL_ONLY,
  REAL_READ_DESC, REAL_SHELL_DESC, FINGERPRINT_READ_TOOL, FINGERPRINT_SHELL_TOOL, V2_KEY_ORDER,
} from "./constants.mjs";

const MASK48 = 0xffffffffffffn;
const MASK64 = 0xffffffffffffffffn;
let SESSION_SEQ = 1n;

/** Rust: `d.as_nanos() as u64` — epoch nanos. JS has no epoch-nanos clock, so this is
 *  a millisecond clock with a monotonic sub-ms tail. Affects only the random 14-char
 *  tail of the session id, never the embedded timestamp or any routing decision. */
function epochNanos() {
  return BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
}

/** mint_session_id() — fingerprint.rs 35-54, verbatim semantics via BigInt.
 *  `ses_<12hex-inv-ts><14base62>`; 12 hex = ~((ms<<12)|seq) & 0xffff_ffff_ffff. */
export function mintSessionId(nowMsOverride) {
  const nowMs = BigInt(nowMsOverride ?? Date.now());
  const seq = ((SESSION_SEQ++ & 0xfffn) || 1n); // Rust: (fetch_add & 0xfff).max(1)
  const r = (nowMs << 12n) | seq;
  const inv = (~r) & MASK48;

  let state = (epochNanos() ^ ((seq * 0x9e3779b97f4a7c15n) & MASK64) ^ nowMs) & MASK64;
  if (state === 0n) state = 0xdeadbeefcafebaben;
  let tail = "";
  for (let i = 0; i < 14; i++) {
    state = (state ^ ((state << 13n) & MASK64)) & MASK64;
    state = (state ^ (state >> 7n)) & MASK64;
    state = (state ^ ((state << 17n) & MASK64)) & MASK64;
    tail += BASE62[Number(state % 62n)];
  }
  return `ses_${inv.toString(16).padStart(12, "0")}${tail}`;
}

/** decode_session_timestamp_ms() — fingerprint.rs 57-..., verbatim. */
export function decodeSessionTimestampMs(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.startsWith("ses_")) return null;
  const rest = sessionId.slice(4);
  if (rest.length !== 26) return null;
  const hex = rest.slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  const inv = BigInt("0x" + hex);
  const raw = (~inv) & MASK48;
  return Number(raw >> 12n);
}

/** SessionLedger — fingerprint.rs 73-109, verbatim (6-day remint, 4096 capacity, clear on full). */
export class SessionLedger {
  constructor({ remintAfterSecs = 6 * 24 * 3600, capacity = 4096 } = {}) {
    this.inner = new Map();
    this.remintAfterMs = remintAfterSecs * 1000;
    this.capacity = capacity;
  }
  sessionForExit(convSeed, exitKey) {
    const seed = String(convSeed ?? "").trim();
    if (seed === "") return mintSessionId();
    const composite = `${seed}\0exit\0${exitKey}`;
    const hit = this.inner.get(composite);
    const now = Date.now();
    if (hit && now - hit.mintedAt < this.remintAfterMs) return hit.id;
    if (this.inner.size >= this.capacity) this.inner.clear();
    const id = mintSessionId();
    this.inner.set(composite, { id, mintedAt: now });
    return id;
  }
}

/** derive_conversation_seed() — fingerprint.rs 112-126.
 *  Rust `content.to_string()` is serde_json Value's compact JSON Display; JS
 *  JSON.stringify is the equivalent compact serialization. Note: serde_json's Map
 *  ordering (BTreeMap by default) may differ from JS insertion order for object
 *  keys, which only changes WHICH exit is picked — never correctness. */
export function deriveConversationSeed(body) {
  const h = createHash("sha256");
  const msgs = Array.isArray(body?.messages) ? body.messages.slice(0, 2) : [];
  for (const m of msgs) {
    if (typeof m?.role === "string") h.update(m.role, "utf8");
    if (m && Object.prototype.hasOwnProperty.call(m, "content")) {
      h.update(JSON.stringify(m.content), "utf8");
    }
  }
  return h.digest("hex");
}

/** gateway_headers() — fingerprint.rs 129-147, verbatim. */
export function gatewayHeaders(sessionId, projectId = DEFAULT_PROJECT_ID) {
  const proj = String(projectId ?? "").trim() || DEFAULT_PROJECT_ID;
  return [
    ["Authorization", "Bearer public"],
    ["Content-Type", "application/json"],
    ["Accept", "text/event-stream"],
    ["User-Agent", OPENCODE_CLIENT_UA],
    ["x-opencode-client", "cli"],
    ["x-opencode-project", proj],
    ["x-opencode-session", sessionId],
    ["x-opencode-session-id", sessionId],
    ["x-session-affinity", sessionId],
    ["x-session-id", sessionId],
  ];
}

/** unalias_tool_name() — fingerprint.rs 353-359, verbatim. */
export function unaliasToolName(name) {
  if (name === "read_client") return "read";
  if (name === "shell_client") return "shell";
  return name;
}

/** apply_fingerprint() — fingerprint.rs 204-350, verbatim. Mutates `body` in place
 *  (Rust takes &mut Value) and returns a FingerprintPlan. Router clones per attempt. */
export function applyFingerprint(body) {
  const downstreamWantsStream = body.stream === true;

  // 1. Force stream: true upstream; default stream_options.
  body.stream = true;
  if (!("stream_options" in body)) body.stream_options = { include_usage: true };

  // 2. tool_choice "none" is not supported upstream.
  if (body.tool_choice === "none") delete body.tool_choice;

  // 3. Tool schema inspection / aliasing.
  const existingTools = Array.isArray(body.tools) ? body.tools : [];
  const callerHadNoTools = existingTools.length === 0;
  let aliasedRead = false, aliasedShell = false;
  const outTools = [];
  for (const t of existingTools) {
    const fn = t?.function;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (name === "read" || name === "shell") {
      const desc = typeof fn?.description === "string" ? fn.description : "";
      const isExact = (name === "read" && desc === REAL_READ_DESC) || (name === "shell" && desc === REAL_SHELL_DESC);
      if (!isExact) {
        if (name === "read") aliasedRead = true; else aliasedShell = true;
        fn.name = `${name}_client`;
      }
    }
    if (fn && typeof fn === "object" && !("strict" in fn)) fn.strict = false;
    outTools.push(t);
  }
  const hasExactRead = outTools.some((t) => t?.function?.name === "read");
  const hasExactShell = outTools.some((t) => t?.function?.name === "shell");
  if (!hasExactRead) outTools.push(structuredClone(FINGERPRINT_READ_TOOL));
  if (!hasExactShell) outTools.push(structuredClone(FINGERPRINT_SHELL_TOOL));
  body.tools = outTools;

  // 3b. max_tokens -> max_completion_tokens, default 32000.
  if ("max_tokens" in body) {
    if (!("max_completion_tokens" in body)) body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  if (!("max_completion_tokens" in body)) body.max_completion_tokens = 32000;

  const aliased = aliasedRead || aliasedShell;

  // 4. Alias historical assistant tool_calls too.
  if (aliased && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!Array.isArray(msg?.tool_calls)) continue;
      for (const tc of msg.tool_calls) {
        const n = tc?.function?.name;
        if ((n === "read" && aliasedRead) || (n === "shell" && aliasedShell)) {
          tc.function.name = `${n}_client`;
        }
      }
    }
  }

  // 5. System guidance so the model never calls the inert placeholders.
  let note;
  if (callerHadNoTools) note = NOTE_NO_TOOLS;
  else if (aliasedRead && aliasedShell) note = NOTE_ALIASED_BOTH;
  else if (aliasedRead) note = NOTE_ALIASED_READ_ONLY;
  else if (aliasedShell) note = NOTE_ALIASED_SHELL_ONLY;
  else note = NOTE_PLACEHOLDER_TOOLS;

  if (!Array.isArray(body.messages)) body.messages = [];
  const msgs = body.messages;
  if (msgs.length === 0) {
    msgs.push({ role: "system", content: note });
  } else if (msgs[0]?.role === "system" && typeof msgs[0].content === "string") {
    msgs[0].content = `${note}\n\n${msgs[0].content}`;
  } else {
    msgs.unshift({ role: "system", content: note });
  }

  return {
    downstream_wants_stream: downstreamWantsStream,
    drop_placeholder_tool_calls: callerHadNoTools,
    aliased_client_tools: aliased,
  };
}

/** encode_v2_chat_body() — fingerprint.rs 365-409, verbatim key order.
 *  No HTML escaping: JSON.stringify keeps <, >, & as-is. */
export function encodeV2ChatBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return JSON.stringify(body ?? {});
  const parts = [];
  const seen = new Set();
  for (const k of V2_KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      parts.push(`${JSON.stringify(k)}:${JSON.stringify(body[k])}`);
      seen.add(k);
    }
  }
  const rest = Object.keys(body).filter((k) => !seen.has(k)).sort();
  for (const k of rest) parts.push(`${JSON.stringify(k)}:${JSON.stringify(body[k])}`);
  return `{${parts.join(",")}}`;
}

export const _internal = { mintSessionId, decodeSessionTimestampMs, unaliasToolName };