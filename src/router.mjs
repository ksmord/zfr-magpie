// zfr-magpie/router.mjs — execute_chat / send_upstream_once.
// Port of zfr-core src/router.rs (198-466 read verbatim).
import {
  applyFingerprint, deriveConversationSeed, encodeV2ChatBody, gatewayHeaders,
} from "./fingerprint.mjs";
import { resolveModel, failoverChain, laneConfig } from "./catalog.mjs";
import { FailureClass, classifyHttpFailure, extractErrorMessage } from "./egress.mjs";
import { filteredSseStream, aggregateSseToJson } from "./sse.mjs";
import { OPENCODE_CLIENT_UA, DEFAULT_PROJECT_ID, Lane } from "./constants.mjs";

/** send_upstream_once() — router.rs 292-466.
 *  Returns {resp, plan} or throws RoutedFailure. Relay wrapping lives in transport.mjs. */
async function sendUpstreamOnce(exit, lane, modelId, convSeed, rawBody, pool, opts) {
  const body = structuredClone(rawBody);
  body.model = modelId;

  let url, headers, plan, payload;
  if (lane === Lane.OPENCODE_ZEN) {
    plan = applyFingerprint(body);
    const sid = pool.sessions.sessionForExit(convSeed, exit.id);
    headers = gatewayHeaders(sid, DEFAULT_PROJECT_ID);
    const cfg = laneConfig(lane, opts.env);
    const base = opts.baseOverrides?.[lane] ?? cfg.base;
    url = `${base}/chat/completions`;
    payload = encodeV2ChatBody(body);
  } else {
    plan = { downstream_wants_stream: rawBody?.stream === true, drop_placeholder_tool_calls: false, aliased_client_tools: false };
    body.stream = true;
    const cfg = laneConfig(lane, opts.env);
    const base = opts.baseOverrides?.[lane] ?? cfg.base;
    url = `${base}/chat/completions`;
    headers = [
      ["Authorization", cfg.auth],
      ["Content-Type", "application/json"],
      ["Accept", "text/event-stream"],
      ["User-Agent", OPENCODE_CLIENT_UA],
      ...(cfg.extra ?? []),
    ];
    payload = JSON.stringify(body);
  }

  let resp;
  try {
    resp = await exit.send(url, headers, payload, { signal: opts.signal });
  } catch (e) {
    const f = new Error(`transport error via ${exit.id}: ${e?.message ?? e}`);
    f.routed = { status: 502, class: FailureClass.TRANSPORT, detail: f.message, retryAfter: null };
    throw f;
  }

  if (resp.status >= 400) {
    const raRaw = resp.headers.get("retry-after");
    const retryAfter = raRaw != null && /^\d+$/.test(raRaw.trim()) ? Number(raRaw.trim()) : null;
    let errText = "";
    try { errText = await resp.text(); } catch {}
    const cls = classifyHttpFailure(resp.status, errText);
    const detail = extractErrorMessage(errText, retryAfter);
    const f = new Error(detail);
    f.routed = { status: resp.status, class: cls, detail, retryAfter };
    throw f;
  }
  return { resp, plan };
}

/** execute_chat() — router.rs 198-290. */
export async function executeChat(pool, rawBody, opts = {}) {
  const requestedModel = typeof rawBody?.model === "string" ? rawBody.model : "beam-free";
  const convSeed = deriveConversationSeed(rawBody);
  const allowFailover = opts.allowModelFailover !== false;
  const chain = allowFailover ? failoverChain(requestedModel, opts.env ?? process.env) : [resolveModel(requestedModel)];

  let lastErr = { status: 502, detail: "no upstream candidates" };
  const anyHealthy = chain.length > 1 && chain.some(([, m]) => pool.modelHasHealthyExit(m));

  for (const [lane, modelId] of chain) {
    if (anyHealthy && !pool.modelHasHealthyExit(modelId)) continue;
    const exits = pool.candidatesFor(convSeed, modelId, pool.maxExitRetries);
    for (const exit of exits) {
      try {
        const { resp, plan } = await sendUpstreamOnce(exit, lane, modelId, convSeed, rawBody, pool, opts);
        pool.revive(exit.id, modelId);
        if (plan.downstream_wants_stream) {
          return {
            kind: "stream", served_model: modelId, exit_id: exit.id,
            body: filteredSseStream(resp, plan, opts.signal),
          };
        }
        return {
          kind: "json", served_model: modelId, exit_id: exit.id,
          body: await aggregateSseToJson(resp, modelId, plan),
        };
      } catch (e) {
        const r = e.routed ?? { status: 502, class: FailureClass.TRANSPORT, detail: e.message, retryAfter: null };
        pool.reportFailure(exit.id, modelId, r.class, r.retryAfter, r.detail);
        // router.rs 259-274: an OpenCodeZen free-usage-limit 429 also cools the
        // same exit for every other OpenCodeZen model in this chain.
        if (lane === Lane.OPENCODE_ZEN && r.class === FailureClass.QUOTA_429
            && String(r.detail).toLowerCase().includes("free usage limit")) {
          for (const [otherLane, otherModel] of chain) {
            if (otherLane === Lane.OPENCODE_ZEN && otherModel !== modelId) {
              pool.reportFailure(exit.id, otherModel, r.class, r.retryAfter, r.detail);
            }
          }
        }
        lastErr = { status: Math.max(400, r.status), detail: r.detail };
      }
    }
  }
  const f = new Error(lastErr.detail);
  f.routed = {
    status: lastErr.status,
    body: { error: { type: "upstream_error", message: lastErr.detail } },
  };
  throw f;
}