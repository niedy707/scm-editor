#!/usr/bin/env node
/**
 * Adım 1 — Ağdan oku (temassız).
 *
 * LG webOS TV'ye WiFi üzerinden SSAP (WebSocket) ile bağlanır, kanal listesini
 * çeker ve JSON olarak kaydeder. Hiçbir şey YAZMAZ.
 *
 * Kullanım:
 *   node tools/lgtv-read.mjs 192.168.1.42
 *   node tools/lgtv-read.mjs 192.168.1.42 --out data/salon.json
 *   node tools/lgtv-read.mjs 192.168.1.42 --probe      # belgelenmemiş uçları YOKLA (salt okunur)
 *   node tools/lgtv-read.mjs --discover                # ağdaki TV'leri SSDP ile ara
 *
 * İlk bağlantıda TV ekranında bir eşleştirme onayı çıkar; kumandayla kabul et.
 * Kabul edilince alınan client-key `.lgtv-clients.json` dosyasına yazılır ve
 * sonraki çalıştırmalarda TV bir daha sormaz.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const HANDSHAKE = JSON.parse(readFileSync(resolve(HERE, 'ssap-handshake.json'), 'utf8'));
const KEYSTORE = resolve(ROOT, '.lgtv-clients.json');

const PORT_WS = 3000; // düz ws — wss (3001) kendinden imzalı sertifika kullanır

/** Salt okunur uçlar. Bunlar cihazda hiçbir şey değiştirmez. */
const READ_ENDPOINTS = {
  channelList: 'ssap://tv/getChannelList',
  currentChannel: 'ssap://tv/getCurrentChannel',
  systemInfo: 'ssap://system/getSystemInfo',
  swInfo: 'ssap://com.webos.service.update/getCurrentSWInformation',
};

/**
 * Belgelenmemiş ama eşleştirme manifestinde İZNİ bulunan uçlar.
 * Manifest şu yazma izinlerini ilan ediyor: SET_CHANNEL_SKIP, RELEASE_CHANNEL_SKIP,
 * CONTROL_CHANNEL_BLOCK, DELETE_SELECT_CHANNEL, CONTROL_CHANNEL_GROUP,
 * CONTROL_FAVORITE_GROUP, SCAN_TV_CHANNELS.
 *
 * Aşağıdakilerin HEPSİ "get" biçimindedir — yani var olup olmadıklarını
 * öğrenmek cihazda hiçbir değişiklik yapmaz. Yazan uçlar bilerek YOK.
 */
const PROBE_ENDPOINTS = [
  'ssap://tv/getChannelProgramInfo',
  'ssap://tv/getChannelCurrentProgramInfo',
  'ssap://tv/getFavoriteChannelList',
  'ssap://tv/getChannelGroupList',
  'ssap://tv/getSkipChannelList',
  'ssap://tv/getBlockChannelList',
  'ssap://tv/getSatelliteSettings',
  'ssap://tv/getTunerInfo',
  'ssap://tv/getChannelScanStatus',
  'ssap://settings/getSystemSettings',
];

// ---------------------------------------------------------------- yardımcılar

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const host = args.find((a) => !a.startsWith('-') && /^[\w.-]+$/.test(a) && args[args.indexOf(a) - 1] !== '--out');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

function loadKeys() {
  if (!existsSync(KEYSTORE)) return {};
  try {
    return JSON.parse(readFileSync(KEYSTORE, 'utf8'));
  } catch {
    return {};
  }
}
function saveKey(ip, key) {
  const all = loadKeys();
  all[ip] = key;
  writeFileSync(KEYSTORE, JSON.stringify(all, null, 2) + '\n');
}

// ------------------------------------------------------------ SSDP keşif

async function discover(timeoutMs = 4000) {
  const MSG = Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 2',
      'ST: urn:lge-com:service:webos-second-screen:1',
      '',
      '',
    ].join('\r\n')
  );
  return new Promise((done) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => {
      const txt = buf.toString();
      if (/webos|LG/i.test(txt)) found.set(rinfo.address, txt.split('\r\n')[0]);
    });
    sock.on('error', () => {});
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(MSG, 1900, '239.255.255.250');
    });
    setTimeout(() => {
      try { sock.close(); } catch {}
      done([...found.keys()]);
    }, timeoutMs);
  });
}

// ------------------------------------------------------------ SSAP istemcisi

class Ssap {
  constructor(ip) {
    this.ip = ip;
    this.seq = 0;
    this.pending = new Map();
    this.ws = null;
  }

  connect(timeoutMs = 8000) {
    return new Promise((ok, fail) => {
      const url = `ws://${this.ip}:${PORT_WS}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        fail(new Error(`Bağlanılamadı: ${url} (zaman aşımı). TV açık mı, IP doğru mu?`));
      }, timeoutMs);

      ws.onopen = () => { clearTimeout(timer); ok(); };
      ws.onerror = () => {
        clearTimeout(timer);
        fail(new Error(`Bağlanılamadı: ${url}. TV açık ve aynı ağda olmalı.`));
      };
      ws.onclose = () => {
        for (const { fail: f } of this.pending.values()) f(new Error('Bağlantı kapandı'));
        this.pending.clear();
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    if (msg.type === 'error') {
      this.pending.delete(msg.id);
      waiter.fail(new Error(msg.error || 'bilinmeyen hata'));
      return;
    }
    // register akışında önce "registered" gelmeden ara mesaj gelebilir
    if (waiter.until && msg.type !== waiter.until) return;
    this.pending.delete(msg.id);
    waiter.ok(msg.payload ?? {});
  }

  _send(obj, { until, timeoutMs = 15000 } = {}) {
    const id = obj.id || `req_${++this.seq}`;
    obj.id = id;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error('yanıt gelmedi (zaman aşımı)'));
      }, timeoutMs);
      this.pending.set(id, {
        until,
        ok: (v) => { clearTimeout(timer); ok(v); },
        fail: (e) => { clearTimeout(timer); fail(e); },
      });
      this.ws.send(JSON.stringify(obj));
    });
  }

  async register(clientKey) {
    const payload = structuredClone(HANDSHAKE);
    if (clientKey) payload['client-key'] = clientKey;
    const res = await this._send(
      { type: 'register', payload },
      { until: 'registered', timeoutMs: 90000 }
    );
    return res['client-key'];
  }

  request(uri, payload) {
    return this._send({ type: 'request', uri, ...(payload ? { payload } : {}) });
  }

  close() { try { this.ws.close(); } catch {} }
}

// ------------------------------------------------------------ normalleştirme

/**
 * TV'nin döndürdüğü ham kanal kaydını, editörün anladığı sade biçime çevirir.
 * Alan adları modelden modele değişebildiği için birden çok aday isim denenir;
 * hiçbiri tutmazsa alan `null` kalır ve ham kayıt `_raw` içinde saklanır.
 */
function normalizeChannel(c) {
  const pick = (...names) => {
    for (const n of names) if (c[n] !== undefined && c[n] !== null && c[n] !== '') return c[n];
    return null;
  };
  const num = (v) => (v === null ? null : Number(v));
  return {
    channelId: pick('channelId', 'channelID'),
    number: num(pick('channelNumber', 'majorNumber', 'displayChannelNumber')),
    majorNumber: num(pick('majorNumber')),
    minorNumber: num(pick('minorNumber')),
    name: pick('channelName', 'channelNameAlias'),
    type: pick('channelTypeName', 'channelType'),
    physicalNumber: num(pick('physicalNumber')),
    frequency: num(pick('frequency', 'Frequency')),
    satelliteName: pick('satelliteName', 'satelliteLcn'),
    SVCID: num(pick('SVCID', 'serviceId', 'programNum')),
    TSID: num(pick('TSID', 'transportStreamId')),
    ONID: num(pick('ONID', 'originalNetworkId')),
    scrambled: pick('scrambled', 'CASystemIDList') !== null ? Boolean(c.scrambled) : null,
    skipped: c.skipped ?? null,
    locked: c.locked ?? null,
    favorite: c.favoriteGroup ?? c.Favorite ?? null,
    _raw: c,
  };
}

/** Hangi tuner alanlarının gerçekten geldiğini raporlar (mimari kararı bu belirler). */
function fieldCoverage(rows) {
  const keys = ['SVCID', 'TSID', 'ONID', 'frequency', 'majorNumber', 'minorNumber', 'physicalNumber', 'satelliteName'];
  const out = {};
  for (const k of keys) out[k] = rows.filter((r) => r[k] !== null && r[k] !== undefined).length;
  return out;
}

// ------------------------------------------------------------------- ana akış

async function main() {
  if (flag('--discover') || !host) {
    if (!host) log('IP verilmedi — ağda LG TV aranıyor (SSDP, ~4 sn)...\n');
    const ips = await discover();
    if (!ips.length) {
      warn('Ağda LG TV bulunamadı.');
      warn('TV\'nin IP\'sini şuradan bakabilirsin: Ayarlar → Bağlantı → Ağ → Wi-Fi Bağlantısı → Gelişmiş');
      warn('Sonra: node tools/lgtv-read.mjs <IP>');
      process.exit(ips.length ? 0 : 1);
    }
    log('Bulunan TV(ler):');
    for (const ip of ips) log('  ' + ip);
    if (!host) { log('\nÇalıştır: node tools/lgtv-read.mjs ' + ips[0]); return; }
  }

  const tv = new Ssap(host);
  log(`→ ${host}:${PORT_WS} bağlanılıyor...`);
  await tv.connect();
  log('  bağlandı.');

  const keys = loadKeys();
  const existing = keys[host];
  if (!existing) {
    log('\n  ⚠️  TV EKRANINDA EŞLEŞTİRME ONAYI ÇIKACAK — kumandayla "Kabul Et" de.');
    log('     (bu bir kereliktir, sonra bir daha sormaz)\n');
  }
  const clientKey = await tv.register(existing);
  if (clientKey && clientKey !== existing) {
    saveKey(host, clientKey);
    log('  eşleştirildi, anahtar .lgtv-clients.json dosyasına kaydedildi.');
  } else {
    log('  kayıtlı anahtarla eşleşti.');
  }

  const result = { tv: host, okunmaZamani: new Date().toISOString(), kaynak: 'ssap' };

  for (const [key, uri] of Object.entries(READ_ENDPOINTS)) {
    try {
      const p = await tv.request(uri);
      result[key] = p;
      log(`  ✓ ${uri}`);
    } catch (e) {
      result[key] = { _hata: String(e.message || e) };
      warn(`  ✗ ${uri} → ${e.message || e}`);
    }
  }

  const rawList = result.channelList?.channelList || result.channelList?.channels || [];
  const channels = rawList.map(normalizeChannel);
  result.kanallar = channels;
  result.alanKapsami = fieldCoverage(channels);

  if (flag('--probe')) {
    log('\n  Belgelenmemiş uçlar yoklanıyor (hepsi salt okunur):');
    result.kesif = {};
    for (const uri of PROBE_ENDPOINTS) {
      try {
        const p = await tv.request(uri);
        result.kesif[uri] = { var: true, ornek: p };
        log(`    ✓ VAR   ${uri}`);
      } catch (e) {
        result.kesif[uri] = { var: false, hata: String(e.message || e) };
        log(`    ·  yok  ${uri}`);
      }
    }
  }

  tv.close();

  const outPath = resolve(ROOT, opt('--out', `data/tv-${host.replace(/\./g, '_')}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');

  log('\n──────────────────────────────────────────');
  log(`  Kanal sayısı : ${channels.length}`);
  const model = result.systemInfo?.modelName || result.swInfo?.model_name || '?';
  log(`  Model        : ${model}`);
  log(`  Firmware     : ${result.swInfo?.minor_ver ? result.swInfo.major_ver + '.' + result.swInfo.minor_ver : '?'}`);
  log('  Alan kapsamı :');
  for (const [k, v] of Object.entries(result.alanKapsami)) {
    const pct = channels.length ? Math.round((v / channels.length) * 100) : 0;
    log(`      ${k.padEnd(15)} ${String(v).padStart(5)} / ${channels.length}  (%${pct})`);
  }
  log(`\n  Kaydedildi   : ${outPath}`);
  log('──────────────────────────────────────────');
  log('\nSonraki adım: bu dosyayı web/index.html içindeki "TV\'den okunan liste" alanına yükle.');
}

main().catch((e) => {
  console.error('\nHATA: ' + (e.message || e));
  console.error('\nİpuçları:');
  console.error('  • TV açık ve bilgisayarla aynı ağda olmalı (uyku modunda SSAP kapalıdır).');
  console.error('  • Ayarlar → Bağlantı → "Mobil TV Açık" / "LG Connect Apps" açık olmalı.');
  console.error('  • IP\'yi bulmak için: node tools/lgtv-read.mjs --discover');
  process.exit(1);
});
