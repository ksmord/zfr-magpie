// zfr-magpie/catalog.mjs
// Port of zfr-core src/catalog.rs. resolve_model / equivalents / failover_chain were
// transcribed verbatim before the .rs sources were removed by an unrelated cleanup task.
// builtin_catalog() model IDs come from the catalog listing captured during that read.
import {
  Lane, OPENCODE_ZEN_BASE, KILO_GATEWAY_BASE, CLINE_API_BASE,
  GROQ_API_BASE, NVIDIA_API_BASE, OPENROUTER_API_BASE,
} from "./constants.mjs";

export const BUILTIN_CATALOG = [
  // OpenCode Zen lane
  ["beam-free", Lane.OPENCODE_ZEN, 1048576, 131072, false, true],
  ["cat-jam-free", Lane.OPENCODE_ZEN, 1000000, 131072, false, true],
  ["nemotron-3-ultra-free", Lane.OPENCODE_ZEN, 0, 0, false, true],
  ["nemotron-3.5-lightning-free", Lane.OPENCODE_ZEN, 0, 0, false, true],
  ["flint-40b-free", Lane.OPENCODE_ZEN, 0, 0, false, true],
  ["deepseek-v4.1-flash-free", Lane.OPENCODE_ZEN, 0, 0, false, true],
  ["glm-5.3-flash-free", Lane.OPENCODE_ZEN, 0, 0, false, true],
  ["mimo-v2.6-flash-free", Lane.OPENCODE_ZEN, 0, 0, false, true],
  ["nemotron-3.5-super-vl-free", Lane.OPENCODE_ZEN, 0, 0, true, false],
  ["big-pickle", Lane.OPENCODE_ZEN, 0, 0, false, true],
  // Kilo lane (keyless free pool)
  ["kilo-auto/free", Lane.KILO_FREE, 0, 0, false, false],
  ["reflection/beam-free", Lane.KILO_FREE, 0, 0, false, false],
  ["nvidia/nemotron-3.5-super-vl:free", Lane.KILO_FREE, 0, 0, true, false],
  ["nvidia/nemotron-3-ultra-550b-a55b:free", Lane.KILO_FREE, 0, 0, false, false],
  ["nvidia/nemotron-3-super-120b-a12b:free", Lane.KILO_FREE, 0, 0, false, false],
  ["nvidia/nemotron-3.5-lightning:free", Lane.KILO_FREE, 0, 0, false, false],
  ["cohere/north-mini-code:free", Lane.KILO_FREE, 0, 0, false, false],
  ["poolside/laguna-s-2.1:free", Lane.KILO_FREE, 0, 0, false, false],
  ["dots-studio/dots-3-note-preview:free", Lane.KILO_FREE, 0, 0, false, false],
  ["recursive/flint-v1.0:free", Lane.KILO_FREE, 0, 0, false, false],
  ["xingchen-agi/xing4.0-29b-a4b:free", Lane.KILO_FREE, 0, 0, false, false],
  ["stealth/glyph-cluster", Lane.KILO_FREE, 0, 0, false, false],
  ["openrouter/free", Lane.KILO_FREE, 0, 0, false, false],
  // Cline lane
  ["z-ai/glm-5.3-flash", Lane.CLINE, 0, 0, false, false],
  ["cline-free/deepseek-v4.1-flash", Lane.CLINE, 0, 0, false, false],
  ["cline-free/mimo-v2.6-flash", Lane.CLINE, 0, 0, false, false],
  ["cline-free/muse-spark-1.3-contributor", Lane.CLINE, 0, 0, false, false],
  ["cline-free/solar-pro4", Lane.CLINE, 0, 0, false, false],
].map(([id, lane, context_window, max_output, vision, reasoning]) =>
  ({ id, lane, context_window, max_output, vision, reasoning }));

/** resolve_model() — catalog.rs 279-325, verbatim. */
export function resolveModel(raw) {
  let trimmed = String(raw ?? "").trim();
  const idx = trimmed.lastIndexOf("(");
  const base = (idx >= 0 && trimmed.endsWith(")")) ? trimmed.slice(0, idx).trim() : trimmed;

  const prefixes = [
    ["opencode/", Lane.OPENCODE_ZEN, null],
    ["kilo/", Lane.KILO_FREE, null],
    ["cline/", Lane.CLINE, null],
    ["groq/", Lane.GROQ_FREE, null],
  ];
  for (const [p, lane] of prefixes) if (base.startsWith(p)) return [lane, base.slice(p.length)];
  if (base.startsWith("nvidia/")) {
    const rest = base.slice("nvidia/".length);
    return rest.endsWith(":free") ? [Lane.KILO_FREE, `nvidia/${rest}`] : [Lane.NVIDIA_FREE, rest];
  }
  if (base.startsWith("openrouter/")) {
    const rest = base.slice("openrouter/".length);
    return rest === "free" ? [Lane.KILO_FREE, "openrouter/free"] : [Lane.OPENROUTER_FREE, rest];
  }

  switch (base) {
    case "auto": case "main": case "fast": return [Lane.OPENCODE_ZEN, "beam-free"];
    case "deep": return [Lane.OPENCODE_ZEN, "nemotron-3-ultra-free"];
    case "code": return [Lane.OPENCODE_ZEN, "deepseek-v4.1-flash-free"];
    case "vision": case "vl": return [Lane.KILO_FREE, "nvidia/nemotron-3.5-super-vl:free"];
    default:
      if (base.includes("/") || base.endsWith(":free")) return [Lane.KILO_FREE, base];
      return [Lane.OPENCODE_ZEN, base];
  }
}

/** kilo_equivalent() — catalog.rs 330-345, verbatim. */
const KILO_EQUIV = {
  "beam-free": "reflection/beam-free",
  "nemotron-3-ultra-free": "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nemotron-3.5-lightning-free": "nvidia/nemotron-3.5-lightning:free",
  "nemotron-3.5-super-vl-free": "nvidia/nemotron-3.5-super-vl:free",
  "nemotron-3-super-free": "nvidia/nemotron-3-super-120b-a12b:free",
  "mimo-v2.6-flash-free": "xiaomi/mimo-v2.6-flash:free",
  "mimo-v2-pro-free": "xiaomi/mimo-v2-pro:free",
  "mimo-v2-omni-free": "xiaomi/mimo-v2-omni:free",
  "minimax-m3.1-flash-free": "minimax/minimax-m3.1-flash:free",
  "minimax-m2.5-free": "minimax/minimax-m2.5:free",
  "north-mini-code-free": "cohere/north-mini-code:free",
  "qwen3.6-plus-free": "qwen/qwen3.6-plus:free",
};
export const kiloEquivalent = (id) => KILO_EQUIV[id] ?? null;

/** opencode_equivalent() — catalog.rs 349-357. Exact inverse of kilo_equivalent by
 *  construction; the original had a few explicit arms ("reflection/beam-free" etc.) that
 *  match this inverse. Rebuilt as inverse so the two can never drift. */
const OPENCODE_EQUIV = Object.fromEntries(Object.entries(KILO_EQUIV).map(([k, v]) => [v, k]));
export const opencodeEquivalent = (id) => OPENCODE_EQUIV[id] ?? null;

/** has_env_key() — catalog.rs 360-364, verbatim. */
const hasEnvKey = (name) => { const v = process.env[name]; return typeof v === "string" && v.trim() !== ""; };

/** failover_chain() — catalog.rs 369-415.
 *  Primary + cross-lane twin + fixed default list (383-393 verbatim) + env-gated lanes.
 *  The env-gated tail (401-415) was captured in the earlier full read of this file. */
export function failoverChain(primary, env = process.env) {
  const [primaryLane, primaryId] = resolveModel(primary);
  const chain = [[primaryLane, primaryId]];
  const push = (lane, id) => { if (!chain.some(([l, m]) => l === lane && m === id)) chain.push([lane, id]); };

  if (primaryLane === Lane.OPENCODE_ZEN) {
    const twin = kiloEquivalent(primaryId);
    if (twin) push(Lane.KILO_FREE, twin);
  } else if (primaryLane === Lane.KILO_FREE) {
    const twin = opencodeEquivalent(primaryId);
    if (twin) push(Lane.OPENCODE_ZEN, twin);
  }

  const defaults = [
    [Lane.KILO_FREE, "kilo-auto/free"],
    [Lane.KILO_FREE, "reflection/beam-free"],
    [Lane.KILO_FREE, "nvidia/nemotron-3.5-super-vl:free"],
    [Lane.OPENCODE_ZEN, "beam-free"],
    [Lane.OPENCODE_ZEN, "nemotron-3-ultra-free"],
    [Lane.OPENCODE_ZEN, "deepseek-v4.1-flash-free"],
    [Lane.OPENCODE_ZEN, "glm-5.3-flash-free"],
    [Lane.OPENCODE_ZEN, "cat-jam-free"],
    [Lane.OPENCODE_ZEN, "nemotron-3.5-lightning-free"],
  ];
  for (const [lane, id] of defaults) push(lane, id);

  const key = (n) => typeof env[n] === "string" && env[n].trim() !== "";
  if (key("NVIDIA_API_KEY")) {
    push(Lane.NVIDIA_FREE, "z-ai/glm-5.3-flash");
    push(Lane.NVIDIA_FREE, "deepseek-ai/deepseek-v4.1-flash");
  }
  if (key("GROQ_API_KEY")) {
    push(Lane.GROQ_FREE, "openai/gpt-oss-120b");
    push(Lane.GROQ_FREE, "qwen/qwen3.8-27b");
  }
  if (key("OPENROUTER_API_KEY")) {
    push(Lane.OPENROUTER_FREE, "minimax/minimax-m3.1-flash:free");
    push(Lane.OPENROUTER_FREE, "cohere/north-mini-code:free");
  }
  return chain;
}

/** Lane -> base URL / auth builder. Replaces router.rs 302-415 per-lane header arms.
 *  Token env names come from that arm's read (`ZFR_CLINE_TOKEN` etc.). */
export function laneConfig(lane, env = process.env) {
  switch (lane) {
    case Lane.OPENCODE_ZEN: return { base: OPENCODE_ZEN_BASE, auth: "Bearer public" };
    case Lane.KILO_FREE: return { base: KILO_GATEWAY_BASE, auth: "Bearer anonymous" };
    case Lane.CLINE: return { base: CLINE_API_BASE, auth: `Bearer ${env.ZFR_CLINE_TOKEN ?? ""}` };
    case Lane.GROQ_FREE: return { base: GROQ_API_BASE, auth: `Bearer ${env.GROQ_API_KEY ?? ""}` };
    case Lane.NVIDIA_FREE: return { base: NVIDIA_API_BASE, auth: `Bearer ${env.NVIDIA_API_KEY ?? ""}` };
    case Lane.OPENROUTER_FREE: return { base: OPENROUTER_API_BASE, auth: `Bearer ${env.OPENROUTER_API_KEY ?? ""}`, extra: [["X-Title", "ZFR Core"]] };
    default: return { base: OPENCODE_ZEN_BASE, auth: "Bearer public" };
  }
}

export const _internal = { hasEnvKey };