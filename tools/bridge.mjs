#!/usr/bin/env node
/**
 * Köprü sunucusu — tarayıcı ile TV arasındaki tek geçit.
 *
 * NEDEN GEREKLİ: tarayıcı TV'ye doğrudan bağlanamaz. TV yalnız
 * `wss://<ip>:3001` konuşuyor ve kendi özel sertifikasını sunuyor; tarayıcılar
 * WebSocket için sertifika hatasını atlatmaya izin vermez. Node ise
 * doğrulamayı o tek bağlantı için gevşetip sertifikayı ad üzerinden
 * doğrulayabiliyor. Bu yüzden ağ işleri burada, arayüz tarayıcıda.
 *
 * Kullanım:
 *   node tools/bridge.mjs                 → http://127.0.0.1:8173
 *   node tools/bridge.mjs --lan           → ev ağına açar (telefondan girmek için)
 *   node tools/bridge.mjs --allow-origin https://alanadi.com
 *
 * GÜVENLİK: varsayılan olarak yalnız 127.0.0.1'e bağlanır. `--lan` verilirse
 * ev ağına açılır ve o durumda API çağrıları için bir erişim anahtarı zorunlu
 * olur (adres çubuğunda `#k=...` olarak gelir), böylece aynı ağdaki başka bir
 * cihaz köprüyü kendi başına kullanamaz.
 */

import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import { scanNetwork, identify } from './net/discover.mjs';
import { readTv } from './net/lg-ssap.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEYSTORE = resolve(ROOT, '.lgtv-clients.json');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const PORT = Number(opt('--port', process.env.PORT || 8173));
const LAN = flag('--lan');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const TOKEN = LAN ? crypto.randomBytes(9).toString('base64url') : null;
const EXTRA_ORIGIN = opt('--allow-origin', null);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.tll': 'application/octet-stream',
};

// ───────────────────────────────────────────────────────── anahtar deposu

function loadKeys() {
  if (!existsSync(KEYSTORE)) return {};
  try { return JSON.parse(readFileSync(KEYSTORE, 'utf8')); } catch { return {}; }
}
async function saveKey(ip, key) {
  const all = loadKeys();
  all[ip] = key;
  await writeFile(KEYSTORE, JSON.stringify(all, null, 2) + '\n');
}

// ─────────────────────────────────────────────────────────── yardımcılar

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function originAllowed(origin) {
  if (!origin) return true; // aynı köken (fetch Origin göndermeyebilir)
  if (EXTRA_ORIGIN && origin === EXTRA_ORIGIN) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) ||
    (LAN && /^https?:\/\/\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(origin));
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // Chrome'un Private Network Access ön kontrolü: public sayfa yerel adrese
  // istek atarken bu başlığı ister.
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function tokenOk(req, url) {
  if (!TOKEN) return true;
  return req.headers['x-bridge-token'] === TOKEN || url.searchParams.get('k') === TOKEN;
}

async function readBody(req, limit = 1_000_000) {
  const parts = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('istek gövdesi çok büyük');
    parts.push(c);
  }
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return {}; }
}

// ───────────────────────────────────────────────────────────────── API

/**
 * Okunan kanal listeleri burada tutulur.
 * Tarayıcının `sessionStorage`'ına koymak çalışmıyor: 600+ kanallık bir döküm
 * kota sınırını aşıyor ("The quota has been exceeded"). Veri zaten köprüden
 * geldiği için doğru yer burası.
 */
const dumps = new Map();

const api = {
  async health() {
    return {
      ok: true,
      surum: '0.2.0',
      lan: LAN,
      markalar: {
        lg: { agdanOku: true, agdanYaz: false, not: 'SSAP okuma; yazma ucu yok (14 aday gerçek cihazda 404 — kanıt: data/ssap-uc-kesfi.json).' },
        samsung: { agdanOku: false, agdanYaz: false, not: 'Tizen ağ API\'si kanal listesi vermiyor; USB dosyası gerekir.' },
      },
    };
  },

  async scan(body) {
    const cihazlar = await scanNetwork({ subnet: body?.subnet || null });
    const keys = loadKeys();
    return {
      cihazlar: cihazlar.map((d) => ({ ...d, eslesmis: !!keys[d.ip] })),
      tarama: new Date().toISOString(),
    };
  },

  async identify(body) {
    if (!body?.ip) throw new Error('ip gerekli');
    const d = await identify(body.ip, { timeoutMs: 2000 });
    return { cihaz: d };
  },

  async read(body) {
    const ip = body?.ip;
    if (!ip || !/^[\d.]+$/.test(ip)) throw new Error('geçerli bir ip gerekli');
    const keys = loadKeys();
    const durum = [];
    const { sonuc, clientKey } = await readTv(ip, {
      clientKey: keys[ip] || null,
      probe: !!body.probe,
      onStatus: (s) => durum.push(s),
    });
    if (clientKey && clientKey !== keys[ip]) await saveKey(ip, clientKey);
    dumps.set(ip, sonuc);

    // Yanıtı hafif tut: 600+ kanallık tam döküm ayrı uçtan (`/api/dump`) alınır.
    const eksikAlanlar = Object.entries(sonuc.alanKapsami || {})
      .filter(([, v]) => v < sonuc.kanallar.length)
      .map(([k, v]) => ({ alan: k, gelen: v, toplam: sonuc.kanallar.length }));

    return {
      ozet: {
        ip,
        model: sonuc.model,
        firmware: sonuc.firmware,
        kanalSayisi: sonuc.kanallar.length,
        baglanti: sonuc.baglanti,
        alanKapsami: sonuc.alanKapsami,
        eksikAlanlar,
      },
      durum,
      yeniEslesme: !keys[ip],
    };
  },

  /** Son okunan tam dökümü verir. */
  async dump(body) {
    const ip = body?.ip;
    if (!ip || !dumps.has(ip)) throw new Error('bu cihaz için kayıtlı okuma yok — önce "Kanal listesini oku"');
    return dumps.get(ip);
  },

  /** Bellekte hangi cihazların dökümü var. */
  async dumps() {
    return { ipler: [...dumps.keys()] };
  },
};

// ──────────────────────────────────────────────────────────── sunucu

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  cors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (url.pathname.startsWith('/api/')) {
    const ad = url.pathname.slice(5);
    if (!originAllowed(req.headers.origin)) { sendJson(res, 403, { hata: 'köken izinli değil' }); return; }
    if (!tokenOk(req, url)) { sendJson(res, 401, { hata: 'erişim anahtarı gerekli' }); return; }
    const fn = api[ad];
    if (!fn) { sendJson(res, 404, { hata: 'bilinmeyen uç: ' + ad }); return; }
    try {
      const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      sendJson(res, 200, await fn(body));
    } catch (e) {
      sendJson(res, 500, { hata: String(e.message || e) });
    }
    return;
  }

  // statik dosyalar
  try {
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '/web') { res.writeHead(302, { Location: '/web/' }).end(); return; }
    if (p === '/web/') p = '/web/home.html';
    const full = normalize(resolve(ROOT, '.' + p));
    if (!full.startsWith(ROOT + sep)) { res.writeHead(403).end('403'); return; }
    const st = await stat(full);
    if (st.isDirectory()) { res.writeHead(403).end('403'); return; }
    const buf = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(PORT, HOST, () => {
  const adres = `http://${LAN ? yerelAdres() : '127.0.0.1'}:${PORT}/web/`;
  console.log('\n  Köprü çalışıyor');
  console.log('  ' + adres + (TOKEN ? `#k=${TOKEN}` : ''));
  if (LAN) {
    console.log('\n  Ev ağına açık — telefondan da bu adrese girebilirsin.');
    console.log('  Erişim anahtarı zorunlu; adresteki #k=... kısmını da yaz.');
  }
  console.log('');
});

function yerelAdres() {
  const nets = Object.values(os.networkInterfaces()).flat();
  const v4 = nets.find((n) => n && n.family === 'IPv4' && !n.internal);
  return v4 ? v4.address : '127.0.0.1';
}
