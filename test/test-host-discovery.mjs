// host-discovery.test.mjs — replicate magpie plugin-host entries()/servers() verbatim (host-1c0053cbb85b.js 1388-1450)
// and execute the discovered plugin function the way the host does (config hook + auth.loader).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const D = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"];
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

// ---- host entries(target), copied (add/pick/Set dedupe) ----
function entries(target) {
  const out = [];
  const add = (v) => typeof v === "string" && v.trim() && out.push(path.resolve(target, v.trim()));
  const pick = (x) => (typeof x === "string" ? x : x?.import ?? x?.default);
  const pkg = readJSON(path.join(target, "package.json"));
  if (pkg) {
    const ex = pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports) ? pkg.exports : undefined;
    if (ex) add(pick(ex["./server"]));
    add(pkg.main);
    if (ex) add(pick(ex["."]));
    if (typeof pkg.exports === "string") add(pkg.exports);
  }
  for (const f of INDEX_FILES) {
    const p = path.join(target, f);
    if (fs.existsSync(p)) out.push(p);
  }
  if (out.length === 0) throw new Error("isn't an OpenCode or magpie plugin");
  return [...new Set(out)];
}

// ---- host servers(mod), copied verbatim ----
function servers(mod) {
  const d = mod.default;
  if (d && typeof d === "object" && ("server" in d || "id" in d || "tui" in d)) {
    return typeof d.server === "function" ? [d.server] : [];
  }
  const seen = new Set();
  const out = [];
  for (const v of Object.values(mod)) {
    if (seen.has(v)) continue;
    seen.add(v);
    if (typeof v === "function") out.push(v);
    else if (v && typeof v === "object" && typeof v.server === "function") out.push(v.server);
  }
  return out;
}

const files = entries(D);
console.log("HOST_ENTRIES", JSON.stringify(files.map((f) => path.basename(f))));
assert.equal(files.length, 1, "host must resolve exactly one entry file (path Set dedupe)");
assert.equal(path.basename(files[0]), "index.mjs");

const mod = await import(pathToFileURL(files[0]).href);
console.log("MODULE_EXPORTS", JSON.stringify(Object.keys(mod)));
console.log("default===ZfrMagpiePlugin", mod.default === mod.ZfrMagpiePlugin);
assert.equal(typeof mod.ZfrMagpiePlugin, "function", "named plugin fn must exist");
assert.equal(mod.default, mod.ZfrMagpiePlugin, "default must be the SAME reference (seen dedupe)");

const fns = servers(mod);
console.log("HOST_DISCOVERED_FNS", fns.length, fns.map((f) => f.name));
assert.equal(fns.length, 1, "exactly ONE plugin function; no duplicate registration");
assert.equal(fns[0], mod.ZfrMagpiePlugin);

// ---- host calls the discovered fn: plugin({client,...}, options) -> hooks object ----
const hooks = await fns[0]({}, { egress: ["auto"], allowModelFailover: true });
assert.ok(hooks && typeof hooks === "object", "plugin must return hooks object");
console.log("HOOK_KEYS", JSON.stringify(Object.keys(hooks)));

// config hook: host calls h.config(config) with the provider config
const cfg = { provider: {}, model: {} };
assert.equal(typeof hooks.config, "function", "config hook required");
await hooks.config(cfg);
console.log("CONFIG_PROVIDER_KEYS", JSON.stringify(Object.keys(cfg.provider)));
assert.ok(cfg.provider.zfr, "config must declare provider zfr");
assert.ok(cfg.provider.zfr.models && Object.keys(cfg.provider.zfr.models).length > 0, "models declared");

// auth hook: host registers h.auth into auths() map; methods()/options() read from it
assert.ok(hooks.auth && typeof hooks.auth === "object", "auth hook required");
console.log("AUTH_KEYS", JSON.stringify(Object.keys(hooks.auth)));
const methods = hooks.auth.methods;
console.log("AUTH_METHODS", JSON.stringify(methods));
assert.ok(Array.isArray(methods) && methods.some((m) => m.type === "api"), "must declare type:api so loader runs");

// options(provider,key): a.loader(getAuth, providerInfo) -> { baseURL, apiKey, fetch }
assert.equal(typeof hooks.auth.loader, "function", "auth.loader required");
const opts = await hooks.auth.loader(async () => ({ type: "api", key: "placeholder" }), cfg.provider.zfr);
console.log("LOADER_KEYS", JSON.stringify(Object.keys(opts)));
assert.equal(typeof opts.fetch, "function", "loader must return fetch hook");
assert.equal(typeof opts.baseURL, "string", "loader must return baseURL");

console.log("HOST_DISCOVERY_OK");