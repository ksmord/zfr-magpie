// zfr-magpie/transport.mjs — per-exit sender.
// Device-verified (Bun 1.4.4, 2026-11-08):
//   fetch({proxy:"http://..."})      works (dead proxy -> ECONNREFUSED)
//   fetch({proxy:"socks5://..."})    UnsupportedProxyProtocol -> manual tunnel via proxyAgent
//   https.request({family,localAddress}) 200 (EINVAL fixed by forcing family)
//   Bun's proxy option applies even to loopback -> never attach proxy to "direct"
import {
  combineSignal, headerObject, nodeRequest, proxyAgent,
} from "./netutil.mjs";
import { RELAY_QUOTA_COOLDOWN_SECS } from "./constants.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const RELAY_TIMEOUT_MS = 60_000;

/** parse_relay_spec() — egress.rs 316-326 verbatim: #key= stripped from stored spec. */
export function parseRelaySpec(spec) {
  if (!spec.startsWith("relay://")) return null;
  const rest = spec.slice("relay://".length);
  const i = rest.indexOf("#key=");
  const url = (i >= 0 ? rest.slice(0, i) : rest).trim();
  const key = i >= 0 ? rest.slice(i + "#key=".length).trim() : "";
  if (!url) return null;
  return { url, key: key || null };
}

/** egress.rs 102-112: "auto" -> ipv6+ipv4; empty specs -> direct. */
export function expandSpecs(specs) {
  const out = [];
  for (const raw of specs ?? []) {
    const s = String(raw).trim();
    if (s.toLowerCase() === "auto") out.push("ipv6", "ipv4");
    else if (s) out.push(s);
  }
  return out.length ? out : ["direct"];
}

/** egress.rs 113-140: node id rules, relay spec never leaks #key=. */
export function makeNodes(specs) {
  return expandSpecs(specs).map((spec, idx) => {
    const relay = parseRelaySpec(spec);
    const storedSpec = relay ? `relay://${relay.url}` : spec;
    const id = ["direct", "ipv6", "ipv4"].includes(storedSpec) ? storedSpec : `exit-${idx}:${storedSpec}`;
    return { id, spec, storedSpec, relay, idx, isRelayQuotaCooldown: !!relay };
  });
}

/** send(url, headers[], body, {signal}) -> Promise<Response>.
 *  Every branch returns a standard Response so router.mjs consumes resp.body uniformly. */
export function makeSender(node) {
  return async (url, headers, body, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? (node.relay ? RELAY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const sig = combineSignal(opts.signal, timeoutMs);
    const hdrObj = headerObject(headers);

    // relay:// — JSON envelope (router.rs 472-483 verbatim). Relay performs the real
    // upstream request from its own freshly-booted IP; status/headers/body stream back.
    if (node.relay) {
      const envelope = JSON.stringify({
        method: "POST", url, headers: hdrObj,
        body: typeof body === "string" ? body : String(body ?? ""),
      });
      const rh = { "content-type": "application/json" };
      if (node.relay.key) rh["x-zfr-relay-key"] = node.relay.key;
      return fetch(node.relay.url, { method: "POST", headers: rh, body: envelope, signal: sig });
    }

    const spec = node.spec;

    // http:// proxy — Bun native proxy option.
    if (/^https?:\/\//i.test(spec)) {
      return fetch(url, { method: "POST", headers: hdrObj, body, signal: sig, proxy: spec });
    }

    // socks5:// — manual SOCKS5 tunnel + node http(s).Agent.
    if (/^socks5/i.test(spec)) {
      const isHttps = new URL(url).protocol === "https:";
      const agent = proxyAgent(spec, url, isHttps, sig, timeoutMs);
      return nodeRequest(url, { method: "POST", headers: hdrObj, body, agent, signal: sig });
    }

    // direct / ipv6 / ipv4 / bind:// / interface:// — node http(s).request with
    // family + localAddress. Forcing family avoids the EINVAL seen when DNS returns
    // IPv6 but localAddress is IPv4 (device-verified fix).
    let family, localAddress;
    if (spec === "ipv6") { family = 6; localAddress = "::"; }
    else if (spec === "ipv4") { family = 4; localAddress = "0.0.0.0"; }
    else if (/^(bind|interface):\/\//i.test(spec)) {
      const ip = spec.replace(/^(bind|interface):\/\//i, "").trim();
      localAddress = ip;
      family = ip.includes(":") ? 6 : 4;
    }
    return nodeRequest(url, { method: "POST", headers: hdrObj, body, family, localAddress, signal: sig });
  };
}

export { RELAY_QUOTA_COOLDOWN_SECS, DEFAULT_TIMEOUT_MS, RELAY_TIMEOUT_MS };