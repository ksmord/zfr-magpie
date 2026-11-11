// zfr-magpie/netutil.mjs — node socket helpers for egress transports.
// Verified on device: net.connect/tls.connect/https.request({family,localAddress}) all work in Bun 1.4.4.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export const combineSignal = (signal, timeoutMs) => {
  const sigs = [];
  if (signal) sigs.push(signal);
  if (timeoutMs > 0) sigs.push(AbortSignal.timeout(timeoutMs));
  if (!sigs.length) return undefined;
  return sigs.length === 1 ? sigs[0] : AbortSignal.any(sigs);
};

export const headerObject = (headers) => {
  const out = {};
  for (const [k, v] of headers ?? []) out[String(k)] = String(v);
  return out;
};

/** Node IncomingMessage -> standard Response (resp.body is a ReadableStream). */
export function nodeResToWeb(res) {
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (v == null) continue;
    if (Array.isArray(v)) for (const x of v) { try { h.append(k, String(x)); } catch {} }
    else { try { h.set(k, String(v)); } catch {} }
  }
  const noBody = [204, 205, 304].includes(res.statusCode);
  const body = noBody ? null : new ReadableStream({
    start(controller) {
      res.on("data", (c) => {
        try {
          controller.enqueue(Buffer.isBuffer(c)
            ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength)
            : new Uint8Array(c));
        } catch {}
      });
      res.on("end", () => { try { controller.close(); } catch {} });
      res.on("error", (e) => { try { controller.error(e); } catch {} });
      res.on("aborted", () => { try { controller.error(new Error("upstream aborted")); } catch {} });
    },
    cancel() { try { res.destroy(); } catch {} },
  });
  return new Response(body, { status: res.statusCode || 502, headers: h });
}

export function nodeRequest(url, { method = "POST", headers = {}, body = null, family, localAddress, agent, signal }) {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const opts = {
      hostname: u.hostname,
      port: Number(u.port || (isHttps ? 443 : 80)),
      path: `${u.pathname}${u.search}`,
      method, headers,
      ...(family ? { family } : {}),
      ...(localAddress ? { localAddress } : {}),
      ...(agent ? { agent } : {}),
    };
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    let req;
    try { req = mod.request(opts, (res) => { settled = true; resolve(nodeResToWeb(res)); }); }
    catch (e) { fail(e); return; }
    req.on("error", fail);
    if (signal) {
      if (signal.aborted) { req.destroy(); fail(new Error("aborted")); return; }
      const onAbort = () => { req.destroy(); fail(new Error("aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => { try { signal.removeEventListener("abort", onAbort); } catch {} });
    }
    if (body != null) req.write(body);
    req.end();
  });
}

function guardSocket(sock, signal, timeoutMs) {
  if (timeoutMs > 0) sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`socket timeout ${timeoutMs}ms`)));
  if (signal) {
    const onAbort = () => sock.destroy(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    sock.once("close", () => { try { signal.removeEventListener("abort", onAbort); } catch {} });
  }
}

/** Serial readN / readUntil over a socket data stream (for CONNECT/SOCKS5 handshakes). */
function attachReader(sock) {
  let buf = Buffer.alloc(0), waiter = null;
  const pump = () => {
    if (!waiter) return;
    const w = waiter;
    if (w.until) {
      const i = buf.indexOf(w.until);
      if (i < 0) return;
      waiter = null;
      const out = buf.subarray(0, i + w.until.length);
      buf = buf.subarray(i + w.until.length);
      w.resolve(out);
    } else if (buf.length >= w.n) {
      waiter = null;
      const out = buf.subarray(0, w.n);
      buf = buf.subarray(w.n);
      w.resolve(out);
    }
  };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
  sock.on("error", (e) => { if (waiter) { const w = waiter; waiter = null; w.reject(e); } });
  sock.on("close", () => {
    if (waiter) { const w = waiter; waiter = null; w.reject(new Error("socket closed during handshake")); }
  });
  return {
    readN: (n) => new Promise((resolve, reject) => { waiter = { n, resolve, reject }; pump(); }),
    readUntil: (d) => new Promise((resolve, reject) => { waiter = { until: Buffer.from(d), resolve, reject }; pump(); }),
  };
}

const connected = (sock) => new Promise((resolve, reject) => {
  sock.once("connect", resolve);
  sock.once("error", reject);
});

export async function tunnelHttpConnect(proxyUrl, host, port, signal, timeoutMs) {
  const pu = new URL(proxyUrl);
  const sock = net.connect({ host: pu.hostname, port: Number(pu.port || 80) });
  guardSocket(sock, signal, timeoutMs);
  const r = attachReader(sock);
  await connected(sock);
  let auth = "";
  if (pu.username) {
    const raw = `${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`;
    auth = `Proxy-Authorization: Basic ${Buffer.from(raw).toString("base64")}\r\n`;
  }
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const head = (await r.readUntil("\r\n\r\n")).toString("latin1");
  if (!/^HTTP\/1\.[01] 2\d\d /.test(head)) {
    sock.destroy();
    throw new Error(`proxy CONNECT refused: ${head.split("\r\n")[0]}`);
  }
  return sock;
}

export async function tunnelSocks5(proxyUrl, host, port, signal, timeoutMs) {
  const pu = new URL(proxyUrl);
  const sock = net.connect({ host: pu.hostname, port: Number(pu.port || 1080) });
  guardSocket(sock, signal, timeoutMs);
  const r = attachReader(sock);
  await connected(sock);
  const user = pu.username ? decodeURIComponent(pu.username) : "";
  const pass = pu.password ? decodeURIComponent(pu.password) : "";
  sock.write(user ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
  const greeting = await r.readN(2);
  if (greeting[0] !== 0x05) throw new Error("socks5: bad greeting");
  if (greeting[1] === 0x02) {
    const ub = Buffer.from(user, "utf8"), pb = Buffer.from(pass, "utf8");
    sock.write(Buffer.concat([Buffer.from([0x01, ub.length]), ub, Buffer.from([pb.length]), pb]));
    const ar = await r.readN(2);
    if (ar[1] !== 0x00) throw new Error("socks5: auth failed");
  } else if (greeting[1] !== 0x00) {
    throw new Error(`socks5: unsupported method 0x${greeting[1].toString(16)}`);
  }
  const hb = Buffer.from(host, "utf8");
  if (hb.length > 255) throw new Error("socks5: hostname too long");
  sock.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]));
  const rep = await r.readN(4);
  if (rep[0] !== 0x05 || rep[1] !== 0x00) throw new Error(`socks5: connect failed rep=0x${rep[1].toString(16)}`);
  let need;
  if (rep[3] === 0x01) need = 4 + 2;
  else if (rep[3] === 0x04) need = 16 + 2;
  else if (rep[3] === 0x03) need = (await r.readN(1))[0] + 2;
  else throw new Error("socks5: bad atyp");
  await r.readN(need);
  return sock;
}

/** A node http(s).Agent whose createConnection tunnels through the proxy socket. */
export function proxyAgent(proxySpec, targetUrl, isHttps, signal, timeoutMs) {
  const u = new URL(targetUrl);
  const host = u.hostname;
  const port = Number(u.port || (isHttps ? 443 : 80));
  const Agent = isHttps ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (_o, callback) => {
    (async () => {
      let sock = /^socks5/i.test(proxySpec)
        ? await tunnelSocks5(proxySpec, host, port, signal, timeoutMs)
        : await tunnelHttpConnect(proxySpec, host, port, signal, timeoutMs);
      if (isHttps) {
        sock = tls.connect({ socket: sock, servername: host });
        await new Promise((resolve, reject) => {
          sock.once("secureConnect", resolve);
          sock.once("error", reject);
        });
      }
      callback(null, sock);
    })().catch((e) => callback(e instanceof Error ? e : new Error(String(e))));
  };
  return agent;
}
