// Spider Panel — VLESS Worker (ESM Module)
// ══════════════════════════════════════════════════════════════════════════════
// Deployed by the panel to Cloudflare Workers. Serves VLESS/WS/TLS configs with
// country-based routing and manages users (UUID → traffic/expiry) in KV.
//
// Route handling:
//   /{uuid}          → direct VLESS WS tunnel (user's assigned proxy_ip)
//   /route/{code}    → multi-location: looks up country proxy from KV, authenticates
//                       user from the VLESS header UUID
//
// Injected at deploy time:
//   __PANEL_TOKEN__   → random control token (JSON string)
//   __PANEL_DOMAIN__  → panel public domain (JSON string)
// ══════════════════════════════════════════════════════════════════════════════

import { connect } from "cloudflare:sockets";

const PANEL_TOKEN = __PANEL_TOKEN__;
const PANEL_DOMAIN = __PANEL_DOMAIN__;
const WORKER_DOMAIN = __WORKER_DOMAIN__;
const BUF = 64 * 1024;

// ── Utility ─────────────────────────────────────────────────────────────────
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}
function authorized(request) {
  return (request.headers.get('Authorization') || '') === 'Bearer ' + PANEL_TOKEN;
}
function uuidRe() { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; }

// ── KV Helpers ──────────────────────────────────────────────────────────────
// User record: {uuid, remark, limit_bytes, expire, used_bytes, proxy_ip, concurrent_connections}
async function getUser(env, uuid) {
  uuid = (uuid || '').toLowerCase();
  if (!uuidRe().test(uuid)) return null;
  try {
    const raw = await env.SPIDER_KV.get('user:' + uuid);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (u.expire && Date.now() / 1000 > u.expire) return null;
    if (u.limit_bytes > 0 && (u.used_bytes || 0) >= u.limit_bytes) return null;
    return u;
  } catch (e) { return null; }
}
async function setUser(env, uuid, u) {
  await env.SPIDER_KV.put('user:' + uuid, JSON.stringify(u));
}

// ── Batched Traffic Accounting ───────────────────────────────────────────────
// Flushed to KV only every ~1 MiB to stay within KV write limits.
async function addUsage(env, uuid, n, holder) {
  holder.p = (holder.p || 0) + n;
  if (holder.p < 1048576) return true;
  const p = holder.p; holder.p = 0;
  const u = await getUser(env, uuid);
  if (!u) return false;
  u.used_bytes = (u.used_bytes || 0) + p;
  await setUser(env, uuid, u);
  return !(u.limit_bytes > 0 && u.used_bytes >= u.limit_bytes);
}
async function flushUsage(env, uuid, holder) {
  if (!holder.p || !uuid) return;
  const p = holder.p; holder.p = 0;
  const u = await getUser(env, uuid);
  if (!u) return;
  u.used_bytes = (u.used_bytes || 0) + p;
  await setUser(env, uuid, u);
}

// ── Per-User Concurrent-IP Limit ────────────────────────────────────────────
const IP_TTL = 900;
const IP_HEARTBEAT_MS = 300000;

async function getIpList(env, uuid) {
  try {
    const raw = await env.SPIDER_KV.get('ips:' + uuid);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
async function setIpList(env, uuid, rec) {
  try { await env.SPIDER_KV.put('ips:' + uuid, JSON.stringify(rec)); } catch (e) {}
}
async function touchIp(env, uuid, ip, maxIp) {
  if (!ip || ip === 'unknown' || ip === '127.0.0.1') return true;
  if (!maxIp || maxIp < 1) return true;
  const now = Date.now() / 1000;
  const rec = (await getIpList(env, uuid)) || { ips: [] };
  const live = rec.ips.filter(x => x && x.exp > now);
  const existing = live.find(x => x.ip === ip);
  if (existing) {
    existing.exp = now + IP_TTL;
  } else if (live.length >= maxIp) {
    return false;
  } else {
    live.push({ ip, exp: now + IP_TTL });
  }
  await setIpList(env, uuid, { ips: live });
  return true;
}
async function removeIp(env, uuid, ip) {
  if (!ip || ip === 'unknown' || !uuid) return;
  const rec = await getIpList(env, uuid);
  if (!rec) return;
  const now = Date.now() / 1000;
  rec.ips = rec.ips.filter(x => x && x.ip !== ip && x.exp > now);
  await setIpList(env, uuid, rec);
}

// ── Client IP ───────────────────────────────────────────────────────────────
function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return 'unknown';
}

// ── VLESS Protocol Parsing ──────────────────────────────────────────────────
function formatUuid(b) {
  if (!b || b.length !== 16) return '';
  const hex = [];
  for (let i = 0; i < 16; i++) hex.push((b[i] < 16 ? '0' : '') + b[i].toString(16));
  return hex.slice(0,4).join('') + '-' + hex.slice(4,6).join('') + '-' +
         hex.slice(6,8).join('') + '-' + hex.slice(8,10).join('') + '-' + hex.slice(10).join('');
}

function parseVlessHeader(data) {
  if (data.length < 24) return null;
  let pos = 1;
  const userId = formatUuid(data.subarray(pos, pos + 16)); pos += 16;
  const addonLen = data[pos]; pos += 1 + addonLen;
  pos += 1; // command (1 = TCP)
  const port = (data[pos] << 8) | data[pos + 1]; pos += 2;
  const atype = data[pos]; pos += 1;
  let address;
  if (atype === 1) { address = data.slice(pos, pos + 4).join('.'); pos += 4; }
  else if (atype === 2) { const dlen = data[pos]; pos += 1; address = new TextDecoder().decode(data.subarray(pos, pos + dlen)); pos += dlen; }
  else if (atype === 3) { const b = data.subarray(pos, pos + 16); pos += 16; const hex=[]; for(let i=0;i<16;i+=2) hex.push(((b[i]<<8)|b[i+1]).toString(16)); address=hex.join(':'); }
  else return null;
  return { userId, address, port, payload: data.subarray(pos) };
}

// ── Country Proxy Lookup ────────────────────────────────────────────────────
async function getCountryProxy(env, code) {
  try {
    const raw = await env.SPIDER_KV.get('proxies') || '[]';
    const list = JSON.parse(raw);
    const loc = list.find(x => String(x.code || '').toLowerCase() === code);
    if (!loc) return '';
    return String(loc.proxy || ((loc.proxies || [])[0]) || '');
  } catch (e) { return ''; }
}

// ── Outbound Connection ─────────────────────────────────────────────────────
// connect() comes from the cloudflare:sockets module import at the top.
function getConnector() {
  return typeof connect === 'function' ? connect : null;
}
function parseProxyEntry(entry) {
  if (!entry) return null;
  let e = String(entry).trim();
  let protocol = 'http';
  const m = e.match(/^(socks5|socks4|http|https):\/\//i);
  if (m) { protocol = m[1].toLowerCase(); e = e.slice(m[0].length); }
  e = e.split('#')[0].trim();
  let username = '', password = '';
  const at = e.lastIndexOf('@');
  if (at >= 0) {
    const auth = e.slice(0, at);
    e = e.slice(at + 1);
    const ai = auth.indexOf(':');
    if (ai >= 0) { username = decodeURIComponent(auth.slice(0, ai)); password = decodeURIComponent(auth.slice(ai + 1)); }
    else username = decodeURIComponent(auth);
  }
  let hostname = e, port = 80;
  if (e.startsWith('[')) {
    const j = e.indexOf(']');
    if (j > 0) { hostname = e.slice(1, j); if (e[j+1] === ':') port = parseInt(e.slice(j+2)) || 80; }
  } else {
    const j = e.lastIndexOf(':');
    if (j > 0 && e.indexOf(':') === j) { hostname = e.slice(0, j); port = parseInt(e.slice(j+1)) || 80; }
  }
  if (!hostname) return null;
  return { protocol, hostname, port, username, password };
}
async function openSocket(hostname, port) {
  const connector = getConnector();
  if (!connector) return null;
  try {
    const sock = await connector({ hostname, port });
    if (!sock || !sock.readable || !sock.writable) return null;
    return { socket: sock, reader: sock.readable.getReader(), writer: sock.writable.getWriter() };
  } catch (e) { return null; }
}
async function httpConnect(proxy, targetHost, targetPort) {
  const conn = await openSocket(proxy.hostname, proxy.port);
  if (!conn) return null;
  try {
    let authority = targetHost.indexOf(':') >= 0 ? `[${targetHost}]` : targetHost;
    authority += ':' + targetPort;
    let auth = '';
    if (proxy.username) {
      const raw = new TextEncoder().encode(proxy.username + ':' + (proxy.password || ''));
      let bin = ''; for (const b of raw) bin += String.fromCharCode(b);
      auth = 'Proxy-Authorization: Basic ' + btoa(bin) + '\r\n';
    }
    const req = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}Connection: keep-alive\r\n\r\n`;
    await conn.writer.write(new TextEncoder().encode(req));
    let buf = new Uint8Array(0);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const r = await Promise.race([
        conn.reader.read(),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('proxy timeout')),2500))
      ]);
      if (r.done) throw new Error('proxy closed');
      const merged = new Uint8Array(buf.length + r.value.length); merged.set(buf); merged.set(r.value,buf.length); buf=merged;
      const txt = new TextDecoder().decode(buf);
      const idx = txt.indexOf('\r\n\r\n');
      if (idx >= 0) {
        const first = txt.slice(0, idx).split('\r\n')[0];
        if (!/HTTP\/\d\.\d\s+2\d\d/.test(first)) throw new Error('HTTP CONNECT failed: '+first);
        return conn;
      }
    }
    throw new Error('proxy header timeout');
  } catch (e) {
    try { conn.socket.close(); } catch (_) {}
    return null;
  }
}
async function socks5Connect(proxy, targetHost, targetPort) {
  const conn = await openSocket(proxy.hostname, proxy.port);
  if (!conn) return null;
  const enc = new TextEncoder();
  try {
    let hello = proxy.username ? new Uint8Array([5,2,0,2]) : new Uint8Array([5,1,0]);
    await conn.writer.write(hello);
    const h = await conn.reader.read();
    if (h.done || h.value.length < 2 || h.value[0] !== 5) throw new Error('bad socks5 hello');
    let off = 0;
    if (h.value[1] === 2) {
      if (!proxy.username) throw new Error('socks auth required');
      const u = enc.encode(proxy.username), pw = enc.encode(proxy.password || '');
      const msg = new Uint8Array(3 + u.length + pw.length); msg[0]=1; msg[1]=u.length; msg.set(u,2); msg[2+u.length]=pw.length; msg.set(pw,3+u.length);
      await conn.writer.write(msg);
      const a = await conn.reader.read(); if (a.done || a.value[1] !== 0) throw new Error('socks auth failed');
    } else if (h.value[1] !== 0) throw new Error('socks method rejected');
    const hostBytes = enc.encode(targetHost);
    const req = new Uint8Array(7 + hostBytes.length);
    req[0]=5; req[1]=1; req[2]=0; req[3]=3; req[4]=hostBytes.length; req.set(hostBytes,5); req[5+hostBytes.length]=(targetPort>>8)&255; req[6+hostBytes.length]=targetPort&255;
    await conn.writer.write(req);
    const r = await conn.reader.read();
    if (r.done || r.value.length < 2 || r.value[1] !== 0) throw new Error('socks connect failed');
    return conn;
  } catch (e) { try { conn.socket.close(); } catch(_){} return null; }
}
async function connectViaProxy(proxyEntry, targetHost, targetPort) {
  const proxy = parseProxyEntry(proxyEntry);
  if (!proxy) return null;
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks4') return socks5Connect(proxy,targetHost,targetPort);
  return httpConnect(proxy,targetHost,targetPort);
}

async function getAnyProxy(env) {
  try {
    const raw = await env.SPIDER_KV.get('proxies') || '[]';
    const list = JSON.parse(raw);
    for (const loc of list) {
      const p = String(loc.proxy || ((loc.proxies || [])[0]) || '').trim();
      if (p) return p;
    }
  } catch (e) {}
  return '';
}

// ── VLESS WebSocket Tunnel ──────────────────────────────────────────────────
async function handleVlessWs(request, env, country, preUser) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  server.binaryType = 'arraybuffer';
  const connIp = clientIp(request);
  const usage = { p: 0 };

  server.addEventListener('message', async (ev) => {
    const data = new Uint8Array(ev.data);
    if (!server.__h) {
      // First message: parse VLESS header to get target address + user UUID
      const h = parseVlessHeader(data);
      if (!h) { try { server.close(4002, 'bad header'); } catch(e){} return; }
      server.__h = h;

      // Resolve user: preUser for /{uuid} paths, or from VLESS header for /route/{code}
      let user = preUser;
      if (!user && h.userId) {
        user = await getUser(env, h.userId.toLowerCase());
      }
      if (!user) { try { server.close(4030, 'unauthorized'); } catch(e){} return; }
      server.__user = user;

      // Enforce per-user concurrent-IP limit
      if (!await touchIp(env, user.uuid, connIp, user.concurrent_connections)) {
        try { server.close(4031, 'ip limit reached'); } catch(e){}
        return;
      }

      // Heartbeat: renew IP entry every 5 min while connection stays open
      if (!server.__hb) {
        server.__hb = setInterval(async () => {
          await touchIp(env, user.uuid, connIp, user.concurrent_connections);
        }, IP_HEARTBEAT_MS);
      }

      // The Worker is the public VLESS endpoint. The VLESS target is commonly
      // the same Worker domain, so connecting directly would loop back into the
      // Worker. Always use a real outbound proxy/relay when available.
      let proxy = '';
      if (country) proxy = await getCountryProxy(env, country);
      if (!proxy) proxy = user.proxy_ip;
      if (!proxy) proxy = await getAnyProxy(env);

      let conn = null;
      if (proxy) conn = await connectViaProxy(proxy, h.address, h.port);
      if (!conn) {
        // Only permit direct mode when the target is not the Worker itself.
        const targetHost = String(h.address || '').toLowerCase();
        if (targetHost && targetHost !== String(WORKER_DOMAIN || '').toLowerCase()) {
          conn = await openSocket(targetHost, h.port);
        }
      }
      if (!conn) {
        try { server.close(4001, 'outbound connect failed'); } catch(e){}
        return;
      }

      server.__conn = conn;
      server.__wsToTcp = async (chunk) => {
        try { await conn.writer.write(chunk); } catch(e){ try{server.close(4003);}catch(_){} }
      };

      // Send any leftover payload from the first message
      if (h.payload.length) {
        try { await conn.writer.write(h.payload); } catch(e){}
        addUsage(env, user.uuid, h.payload.length, usage);
      }

      // Start reading from TCP → WebSocket
      pumpTcpToWs(conn, server);
      return;
    }

    // Subsequent messages: forward raw data to TCP
    if (server.__wsToTcp) {
      server.__wsToTcp(data);
      addUsage(env, server.__user.uuid, data.length, usage);
    }
  });

  server.addEventListener('close', async () => {
    if (server.__hb) clearInterval(server.__hb);
    try { server.__conn && server.__conn.socket.close(); } catch(e){}
    await flushUsage(env, server.__user && server.__user.uuid, usage);
    await removeIp(env, server.__user && server.__user.uuid, connIp);
  });
  server.addEventListener('error', async () => {
    if (server.__hb) clearInterval(server.__hb);
    try { server.__conn && server.__conn.socket.close(); } catch(e){}
    await flushUsage(env, server.__user && server.__user.uuid, usage);
    await removeIp(env, server.__user && server.__user.uuid, connIp);
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ── TCP → WebSocket Pump ────────────────────────────────────────────────────
async function pumpTcpToWs(conn, server) {
  let sentVlessResponseHeader = false;
  try {
    while (true) {
      const { done, value } = await conn.reader.read();
      if (done) break;
      if (value && value.length) {
        let frame = value;
        if (!sentVlessResponseHeader) {
          // VLESS response header is sent once. Prefixing every TCP chunk with
          // 00 00 corrupts TLS/HTTP streams and was the primary reason Worker
          // configs appeared connected but never transferred data.
          frame = new Uint8Array(value.length + 2);
          frame[0] = 0; frame[1] = 0; frame.set(value, 2);
          sentVlessResponseHeader = true;
        }
        try { server.send(frame); } catch(e){ break; }
      }
    }
  } catch (e) { /* silent close */ }
  try { server.close(1000); } catch(e){}
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Handler
// ══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Health / Debug ──
    if (path === '/health' || path === '/') {
      return new Response('Spider VLESS Worker online', { headers: { 'content-type': 'text/plain' } });
    }
    if (path === '/debug-socket') {
      const info = { global_connect: typeof connect === 'function' };
      if (info.global_connect) {
        try {
          const sock = await connect({ hostname: 'www.google.com', port: 443, tls: true, serverName: 'www.google.com' });
          info.tls_works = true;
          await sock.close();
        } catch (e) { info.tls_error = e.message; }
      }
      return json(info);
    }

    
function workerConfigsForUser(u) {
  const out = [];
  const countries = Array.isArray(u.countries) && u.countries.length ? u.countries : [''];
  for (const code of countries) {
    const path = code ? `/route/${encodeURIComponent(String(code).toLowerCase())}` : `/${u.uuid}`;
    const remark = `${u.remark || 'user'}${code ? ' ' + String(code).toUpperCase() : ''}`;
    const q = `encryption=none&security=tls&sni=${encodeURIComponent(WORKER_DOMAIN)}&host=${encodeURIComponent(WORKER_DOMAIN)}&fp=chrome&type=ws&path=${encodeURIComponent(path)}`;
    out.push(`vless://${u.uuid}@${WORKER_DOMAIN}:443?${q}#${encodeURIComponent(remark)}`);
  }
  return out;
}

// ── Admin API (Bearer PANEL_TOKEN) ──
    // Remote control: the panel pushes the full config (users + routes +
    // settings) in one call; the worker stores it in its dedicated KV and
    // answers with a summary. GET /panel/status returns live counters.
    if (path === '/panel/config' && request.method === 'POST') {
      if (!authorized(request)) return json({ error: 'Forbidden' }, 403);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
      const users = Array.isArray(body.users) ? body.users : [];
      let written = 0, traffic = 0, online = 0;
      const now = Date.now() / 1000;
      // Replace the user set with exactly what the panel sent (disabled users
      // are dropped so the worker stops authenticating them).
      const existing = await env.SPIDER_KV.list({ prefix: 'user:' });
      const keep = new Set();
      for (const u of users) {
        const uuid = String(u.uuid || '').toLowerCase();
        if (!uuidRe().test(uuid)) continue;
        if (u.disabled) continue;
        const rec = {
          uuid,
          remark: String(u.remark || 'user'),
          limit_bytes: Number(u.limit_bytes) || 0,
          expire: Number(u.expire) || 0,
          used_bytes: Number(u.used_bytes) || 0,
          proxy_ip: String(u.proxy_ip || ''),
          concurrent_connections: Number(u.concurrent_connections) || 0,
          countries: Array.isArray(u.countries) ? u.countries.map(x => String(x).toLowerCase()).filter(Boolean) : [],
          created: Date.now(),
        };
        rec.configs = workerConfigsForUser(rec);
        keep.add('user:' + uuid);
        await env.SPIDER_KV.put('user:' + uuid, JSON.stringify(rec));
        written++;
        traffic += rec.used_bytes || 0;
        if (rec.expire && now > rec.expire) continue;
        if (rec.limit_bytes > 0 && rec.used_bytes >= rec.limit_bytes) continue;
        online++;
      }
      for (const k of existing.keys) {
        if (!keep.has(k.name)) await env.SPIDER_KV.delete(k.name);
      }
      if (body.routes && typeof body.routes === 'object') {
        const locations = Array.isArray(body.routes.locations) ? body.routes.locations : [];
        await env.SPIDER_KV.put('proxies', JSON.stringify(locations));
      }
      if (body.settings && typeof body.settings === 'object') {
        await env.SPIDER_KV.put('settings', JSON.stringify(body.settings));
      }
      await env.SPIDER_KV.put('heartbeat', JSON.stringify({ at: Date.now(), users: written }));
      return json({ ok: true, users: written, traffic, online });
    }

    if (path === '/panel/status' && request.method === 'GET') {
      if (!authorized(request)) return json({ error: 'Forbidden' }, 403);
      let users = 0, traffic = 0, online = 0;
      const list = await env.SPIDER_KV.list({ prefix: 'user:' });
      const now = Date.now() / 1000;
      for (const k of list.keys) {
        try {
          const u = JSON.parse(await env.SPIDER_KV.get(k.name));
          if (!u) continue;
          users++;
          traffic += u.used_bytes || 0;
          if (u.expire && now > u.expire) continue;
          if (u.limit_bytes > 0 && (u.used_bytes || 0) >= u.limit_bytes) continue;
          online++;
        } catch (e) {}
      }
      return json({ ok: true, users, traffic, online });
    }

    if (path.startsWith('/api/')) {
      if (!authorized(request)) return json({ error: 'Forbidden' }, 403);

      // GET /api/users — list all users
      if (path === '/api/users' && request.method === 'GET') {
        const out = [];
        const list = await env.SPIDER_KV.list({ prefix: 'user:' });
        for (const k of list.keys) {
          const raw = await env.SPIDER_KV.get(k.name);
          if (raw) out.push(JSON.parse(raw));
        }
        return json({ ok: true, users: out });
      }

      // POST /api/users — create/update a user
      if (path === '/api/users' && request.method === 'POST') {
        const body = await request.json();
        const uuid = String(body.uuid || '').toLowerCase();
        if (!uuidRe().test(uuid)) return json({ error: 'bad uuid' }, 400);
        const u = {
          uuid,
          remark: String(body.remark || 'user'),
          limit_bytes: Number(body.limit_bytes) || 0,
          expire: Number(body.expire) || 0,
          used_bytes: Number(body.used_bytes) || 0,
          proxy_ip: String(body.proxy_ip || ''),
          concurrent_connections: Number(body.concurrent_connections) || 0,
          countries: Array.isArray(body.countries) ? body.countries.map(x => String(x).toLowerCase()).filter(Boolean) : [],
          created: Date.now(),
        };
        u.configs = workerConfigsForUser(u);
        await setUser(env, uuid, u);
        return json({ ok: true, user: u });
      }

      // GET/DELETE /api/user/{uuid}
      if (path.startsWith('/api/user/')) {
        const uuid = path.split('/').pop().toLowerCase();
        if (request.method === 'DELETE') {
          await env.SPIDER_KV.delete('user:' + uuid);
          return json({ ok: true });
        }
        const u = await getUser(env, uuid);
        if (!u) return json({ error: 'not found' }, 404);
        return json({ ok: true, user: u });
      }

      // GET /api/locations — list country proxy locations
      if (path === '/api/locations' && request.method === 'GET') {
        const raw = await env.SPIDER_KV.get('proxies') || '[]';
        try { return json({ ok: true, locations: JSON.parse(raw) }); } catch(e){ return json({ ok: true, locations: [] }); }
      }

      // POST /api/proxies — update proxy map
      if (path === '/api/proxies' && request.method === 'POST') {
        const body = await request.json();
        await env.SPIDER_KV.put('proxies', JSON.stringify(body.locations || []));
        return json({ ok: true });
      }

      return json({ error: 'Not Found' }, 404);
    }

    // ── VLESS WS Tunnel ──
    // Supported paths:
    //   /{uuid}          → direct tunnel (user's proxy_ip from KV)
    //   /route/{code}    → country-based routing (proxy from KV 'proxies' map)
    const seg = path.split('/').filter(Boolean);
    const first = (seg[0] || '').toLowerCase();

    // Route: /route/{code} — multi-location with country proxy lookup
    if (first === 'route' && seg[1]) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'websocket upgrade required' }, 400);
      }
      return handleVlessWs(request, env, seg[1].toLowerCase(), null);
    }

    // Direct: /{uuid} — user authenticated by UUID in path
    if (uuidRe().test(first)) {
      const u = await getUser(env, first);
      if (!u) return json({ error: 'unauthorized' }, 403);
      if (request.headers.get('Upgrade') === 'websocket') {
        return handleVlessWs(request, env, '', u);
      }
      return json({ error: 'websocket upgrade required' }, 400);
    }

    return json({ error: 'Not Found' }, 404);
  },
};
