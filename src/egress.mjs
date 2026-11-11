// zfr-magpie/egress.mjs — EgressPool: candidate selection, failure cooldowns, revive.
// Port of zfr-core src/egress.rs (lines 79-289 read verbatim). All TTLs/classes verified.
import { SessionLedger } from "./fingerprint.mjs";
import { makeNodes, makeSender, RELAY_QUOTA_COOLDOWN_SECS } from "./transport.mjs";

export const FailureClass = Object.freeze({
  QUOTA_429: "quota429",
  FREE_TIER_403: "free_tier403",
  REGION_BLOCK: "region_block",
  UPSTREAM_5XX: "upstream5xx",
  TRANSPORT: "transport",
});

const keyOf = (exitId, model) => `${exitId}\0${model}`;

/** egress.rs report_failure(): base TTLs, relay 90s quota special case, exponential
 *  backoff on repeat failures (Quota429 never backs off). */
export class EgressPool {
  constructor(specs = ["direct"], { maxExitRetries = 3 } = {}) {
    this.nodes = makeNodes(specs).map((n) => ({ ...n, send: makeSender(n) }));
    this.cursor = 0;
    this.bans = new Map();
    this.sessions = new SessionLedger();
    this.maxExitRetries = maxExitRetries;
  }

  /** egress.rs 156-...: stable cursor from conv_seed hash (fold 31), else round-robin;
   *  healthy first, cold nodes as single-shot fallback probe. */
  candidatesFor(convSeed, model, maxCandidates = this.maxExitRetries) {
    const n = this.nodes.length;
    if (!n) return [];
    const start = convSeed
      ? (() => {
          let acc = 0;
          for (const b of Buffer.from(convSeed, "utf8")) acc = (Math.imul(acc, 31) + b) >>> 0;
          return acc % n;
        })()
      : (this.cursor++ % n);
    const now = Date.now();
    const healthy = [], fallback = [];
    for (let off = 0; off < n; off++) {
      const node = this.nodes[(start + off) % n];
      const rec = this.bans.get(keyOf(node.id, model));
      if (rec && rec.until > now) fallback.push(node);
      else healthy.push(node);
      if (healthy.length >= maxCandidates) break;
    }
    if (!healthy.length && fallback.length) return [fallback[0]]; // single probe
    return healthy.slice(0, maxCandidates);
  }

  /** egress.rs report_failure() 200-251 (TTL table + exponential backoff). */
  reportFailure(exitId, model, className, retryAfterSecs, detail = "") {
    const node = this.nodes.find((x) => x.id === exitId);
    let baseTtl;
    switch (className) {
      case FailureClass.QUOTA_429:
        baseTtl = node?.relay
          ? RELAY_QUOTA_COOLDOWN_SECS
          : Math.min(86400, Math.max(30, Number(retryAfterSecs) || 1800));
        break;
      case FailureClass.FREE_TIER_403:
      case FailureClass.REGION_BLOCK: baseTtl = 900; break;
      case FailureClass.UPSTREAM_5XX: baseTtl = 45; break;
      case FailureClass.TRANSPORT: baseTtl = 30; break;
      default: baseTtl = 30;
    }
    const k = keyOf(exitId, model);
    const prev = this.bans.get(k);
    const attempts = prev && prev.until > Date.now() ? prev.attempts + 1 : 0;
    // Quota429 always follows Retry-After / relay fixed 90s; no exponential backoff.
    const ttl = className === FailureClass.QUOTA_429
      ? baseTtl
      : Math.min(3600, baseTtl * Math.pow(2, Math.min(8, attempts)));
    this.bans.set(k, {
      until: Date.now() + ttl * 1000,
      class: className,
      detail: String(detail),
      attempts,
    });
  }

  /** egress.rs revive() 254-257. */
  revive(exitId, model) { this.bans.delete(keyOf(exitId, model)); }

  modelHasHealthyExit(model) {
    const now = Date.now();
    return this.nodes.some((n) => {
      const r = this.bans.get(keyOf(n.id, model));
      return !r || r.until <= now;
    });
  }

  /** active_cooldowns() 275-... — snapshot for diagnostics. */
  activeCooldowns() {
    const now = Date.now();
    const out = [];
    for (const [k, r] of this.bans) {
      if (r.until <= now) { this.bans.delete(k); continue; }
      const [exitId, model] = k.split("\0");
      out.push({
        exit_id: exitId, model, class: r.class,
        remaining_secs: Math.ceil((r.until - now) / 1000), detail: r.detail,
      });
    }
    return out;
  }
}

/** classify_http_failure() — router.rs 485-496 verbatim. */
export function classifyHttpFailure(status, body) {
  const lower = String(body ?? "").toLowerCase();
  if (status === 429 || lower.includes("freeusagelimiterror") || lower.includes("usage limit"))
    return FailureClass.QUOTA_429;
  if (status === 403 && lower.includes("freetiererror")) return FailureClass.FREE_TIER_403;
  if (status === 403 || lower.includes("region") || lower.includes("country"))
    return FailureClass.REGION_BLOCK;
  return FailureClass.UPSTREAM_5XX;
}

/** extract_error_message() — router.rs 498-513 verbatim. */
export function extractErrorMessage(raw, retryAfter) {
  let base;
  try {
    const v = JSON.parse(raw);
    const e = v?.error;
    const m = e && typeof e === "object" ? (e.message ?? e) : e;
    base = typeof m === "string" ? m : Array.from(String(raw)).slice(0, 160).join("");
  } catch {
    base = Array.from(String(raw)).slice(0, 160).join("");
  }
  return retryAfter != null ? `${base} (Retry-After: ${retryAfter}s)` : base;
}