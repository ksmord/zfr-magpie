// zfr-magpie/index.mjs — Magpie provider plugin entry.
// Contract verified against on-device magpie plugin-host (host-*.js 3100-3130) and
// magpie-sensenova/auth.loader:
//   config(cfg) declares provider + models
//   auth.loader(getAuth) -> { baseURL, apiKey, fetch(input, init) }
//   host calls f(url, { method, headers, body, signal }) and consumes res.status/headers/body
//   options() only calls loader when a stored auth exists -> declare a type:"api" method
import { EgressPool } from "./egress.mjs";
import { executeChat } from "./router.mjs";
import { BUILTIN_CATALOG } from "./catalog.mjs";
import { OPENCODE_ZEN_BASE } from "./constants.mjs";

const PROVIDER_ID = "zfr";
const NPM = "@ai-sdk/openai-compatible";

const modelEntry = (m) => ({
  id: m.id,
  name: m.id,
  api: { id: m.id, url: `${OPENCODE_ZEN_BASE}/chat/completions`, npm: NPM },
  status: "active",
  headers: {},
  options: {},
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: m.context_window, output: m.max_output },
  capabilities: {
    temperature: true,
    reasoning: m.reasoning,
    attachment: !!m.vision,
    toolcall: true,
    input: { text: true, image: !!m.vision, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
});

const modelsAsConfig = () => Object.fromEntries(BUILTIN_CATALOG.map((m) => [m.id, modelEntry(m)]));

/** Parse the host's fetch arguments into one chat body.
 *  Verified call shape: f(url, {method, headers, body: <string>, signal}).
 *  Also supports Request input (sensenova test covers both). */
async function readChatBody(input, init) {
  let raw, signal;
  if (input instanceof Request) {
    raw = await input.clone().text();
    signal = init?.signal ?? input.signal;
  } else {
    raw = init?.body;
    signal = init?.signal;
  }
  if (raw == null) return null;
  if (typeof raw !== "string") {
    if (raw instanceof Uint8Array || raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      raw = new TextDecoder().decode(raw);
    } else if (typeof raw.text === "function") raw = await raw.text();
    else raw = String(raw);
  }
  try { return { body: JSON.parse(raw), signal }; } catch { return null; }
}

const errorResponse = (status, message) => new Response(
  JSON.stringify({ error: { type: "upstream_error", message } }),
  { status, headers: { "content-type": "application/json" } },
);

/** Single named async plugin function, exactly like RaccoonAuthPlugin / SenseNovaPlugin. */
export const ZfrMagpiePlugin = async ({ client } = {}, options = {}) => {
  const specs = Array.isArray(options.egress) && options.egress.length ? options.egress : ["direct"];
  const allowModelFailover = options.allowModelFailover !== false;
  const maxExitRetries = Number(options.maxExitRetries) > 0 ? Number(options.maxExitRetries) : 3;
  const pool = new EgressPool(specs, { maxExitRetries });

  const log = (level, message) => {
    try { client?.app?.log?.({ body: { service: "zfr", level, message } }); } catch {}
  };

  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const was = cfg.provider[PROVIDER_ID] ?? {};
      cfg.provider[PROVIDER_ID] = {
        name: "ZFR Core (multi-egress)",
        npm: NPM,
        api: OPENCODE_ZEN_BASE,
        ...was,
        models: { ...modelsAsConfig(), ...(was.models ?? {}) },
      };
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        return provider?.models ?? modelsAsConfig();
      },
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(_getAuth) {
        return {
          baseURL: OPENCODE_ZEN_BASE,
          apiKey: "public", // upstream keyless; a value keeps the host's account row populated
          async fetch(input, init) {
            const parsed = await readChatBody(input, init);
            // Only /chat/completions with a JSON body is ours; anything else is passed
            // through untouched so models/usage/health probes in the host keep working.
            const url = input instanceof Request ? input.url : String(input);
            const isChat = /\/chat\/completions(\?|$)/.test(url) || (parsed && Array.isArray(parsed.body?.messages));
            if (!isChat || !parsed) {
              const src = input instanceof Request ? new Request(input, init) : input;
              return fetch(src, init);
            }
            try {
              const out = await executeChat(pool, parsed.body, {
                env: process.env,
                allowModelFailover,
                signal: parsed.signal,
                baseOverrides: options.baseOverrides,
              });
              if (out.kind === "stream") {
                return new Response(out.body, {
                  status: 200,
                  headers: {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-cache",
                    "x-zfr-exit": out.exit_id,
                    "x-zfr-model": out.served_model,
                  },
                });
              }
              return new Response(JSON.stringify(out.body), {
                status: 200,
                headers: {
                  "content-type": "application/json",
                  "x-zfr-exit": out.exit_id,
                  "x-zfr-model": out.served_model,
                },
              });
            } catch (e) {
              log("warn", `zfr: ${e?.message ?? e}`);
              const r = e.routed;
              return errorResponse(r?.status ?? 502, r?.body?.error?.message ?? e.message ?? "upstream error");
            }
          },
        };
      },

      // The host only calls loader() for a stored account. zfr is keyless, so this
      // is a placeholder credential to let the account row exist; no token is used.
      methods: [{
        type: "api",
        label: "ZFR Core (keyless)",
        placeholder: "public",
        prompts: [{
          type: "text", key: "note",
          message: "No key needed. Enter anything (e.g. public) to create the account.",
        }],
      }],
    },

    // Diagnostics hook: same shape as /v1/egress in the Rust server.
    _zfr: {
      activeCooldowns: () => pool.activeCooldowns(),
      nodes: () => pool.nodes.map((n) => ({ id: n.id, spec: n.storedSpec, relay: !!n.relay })),
    },
  };
};

export default ZfrMagpiePlugin;