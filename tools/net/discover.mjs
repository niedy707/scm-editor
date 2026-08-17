/**
 * Ev ağındaki TV'leri bulur.
 *
 * İki yöntem birlikte kullanılır, çünkü tek başına ikisi de eksik kalıyor:
 *
 *   1) SSDP yayını — hızlı, ama TV'nin "Mobil TV Açık"/DIAL ayarı kapalıysa
 *      veya yönlendirici çoklu yayını (multicast) filtreliyorsa cevap gelmez.
 *   2) Alt ağ taraması — /24 ağdaki adreslerde TV portlarını dener. Yavaş
 *      görünür ama paralel çalıştığı için 2-3 saniyede biter ve SSDP'nin
 *      kaçırdığı cihazları yakalar.
 *
 * Marka, açık porttan ve cihazın kendi cevabından çıkarılır:
 *   LG webOS  → 3001/TLS (sertifika: O=LG Electronics) · 3000
 *   Samsung   → 8001/HTTP `/api/v2/` JSON cihaz bilgisi döner
 */

import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { discover as ssdpDiscover } from './lg-ssap.mjs';

const LG_PORTS = [3001, 3000];
const SAMSUNG_PORTS = [8001, 8002];

/** Makinenin bağlı olduğu IPv4 /24 ağlarını döndürür. */
export function localSubnets() {
  const out = [];
  for (const [ad, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const parts = ni.address.split('.').map(Number);
      if (parts.length !== 4) continue;
      out.push({ arayuz: ad, adres: ni.address, taban: `${parts[0]}.${parts[1]}.${parts[2]}` });
    }
  }
  return out;
}

function tcpOpen(host, port, timeoutMs = 700) {
  return new Promise((done) => {
    const s = net.createConnection({ host, port });
    let bitti = false;
    const kapat = (v) => { if (bitti) return; bitti = true; try { s.destroy(); } catch { /* yok say */ } done(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => kapat(true));
    s.once('timeout', () => kapat(false));
    s.once('error', () => kapat(false));
  });
}

/** LG cihaz sertifikasını okuyarak markayı kesinleştirir. */
function lgCertificate(host, timeoutMs = 2500) {
  return new Promise((done) => {
    const s = tls.connect({ host, port: 3001, rejectUnauthorized: false });
    let bitti = false;
    const kapat = (v) => { if (bitti) return; bitti = true; try { s.destroy(); } catch { /* yok say */ } done(v); };
    s.setTimeout(timeoutMs);
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate();
      kapat(c && c.subject ? { cn: c.subject.CN || null, org: c.subject.O || null } : null);
    });
    s.once('timeout', () => kapat(null));
    s.once('error', () => kapat(null));
  });
}

/** Samsung Tizen: http://<ip>:8001/api/v2/ cihaz bilgisi döndürür. */
async function samsungInfo(host, timeoutMs = 2500) {
  try {
    const r = await fetch(`http://${host}:8001/api/v2/`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j?.device || {};
    return { model: d.modelName || j?.name || null, ad: d.name || null, surum: d.version || null };
  } catch {
    return null;
  }
}

/** Tek bir adresin TV olup olmadığını belirler. */
export async function identify(ip, { timeoutMs = 700 } = {}) {
  const [lg3001, lg3000, sam8001] = await Promise.all([
    tcpOpen(ip, LG_PORTS[0], timeoutMs),
    tcpOpen(ip, LG_PORTS[1], timeoutMs),
    tcpOpen(ip, SAMSUNG_PORTS[0], timeoutMs),
  ]);

  if (lg3001 || lg3000) {
    const cert = lg3001 ? await lgCertificate(ip) : null;
    const lgDogrulandi = !!(cert && (/LG Electronics/i.test(cert.org || '') || /^LGE /i.test(cert.cn || '')));
    return {
      ip,
      marka: lgDogrulandi ? 'lg' : 'lg?',
      portlar: [lg3001 && 3001, lg3000 && 3000].filter(Boolean),
      sertifika: cert,
      dogrulandi: lgDogrulandi,
      okunabilir: true,
      not: lgDogrulandi ? null : 'Portlar açık ama sertifika LG cihaz sertifikası gibi görünmüyor.',
    };
  }

  if (sam8001) {
    const info = await samsungInfo(ip);
    return {
      ip,
      marka: 'samsung',
      portlar: [8001],
      model: info?.model || null,
      ad: info?.ad || null,
      dogrulandi: !!info,
      /**
       * Samsung Tizen'in ağ API'si uzaktan kumanda içindir; kanal listesini
       * ne okur ne yazar. Bu yüzden Samsung TV bulunsa bile ağdan liste
       * çekilemez — dosya yolu (USB ile .scm/.zip) kullanılmalı.
       */
      okunabilir: false,
      not: 'Samsung ağ API\'si kanal listesi vermiyor; USB ile alınan .scm/.zip dosyası gerekir.',
    };
  }

  return null;
}

/**
 * Ağı tarar. SSDP ve alt ağ taraması paralel koşar, sonuçlar birleştirilir.
 * @param {(o:object)=>void} onFound her bulunan cihaz için çağrılır (canlı liste)
 */
export async function scanNetwork({ subnet = null, concurrency = 64, timeoutMs = 700, onFound = () => {} } = {}) {
  const bulunan = new Map();
  const ekle = (o) => {
    if (!o) return;
    const eski = bulunan.get(o.ip);
    if (eski && eski.dogrulandi && !o.dogrulandi) return;
    bulunan.set(o.ip, { ...eski, ...o });
    onFound(bulunan.get(o.ip));
  };

  // 1) SSDP — hızlı yol
  const ssdpSozu = ssdpDiscover(3000)
    .then(async (list) => {
      for (const d of list) {
        const kimlik = await identify(d.ip, { timeoutMs: 1500 });
        ekle(kimlik || { ip: d.ip, marka: 'lg?', dogrulandi: false, okunabilir: true, kaynak: 'ssdp' });
      }
    })
    .catch(() => {});

  // 2) Alt ağ taraması
  const bases = subnet ? [{ taban: subnet }] : localSubnets();
  const hedefler = [];
  for (const b of bases) for (let i = 1; i <= 254; i++) hedefler.push(`${b.taban}.${i}`);

  let sira = 0;
  async function isci() {
    while (sira < hedefler.length) {
      const ip = hedefler[sira++];
      const k = await identify(ip, { timeoutMs });
      if (k) ekle(k);
    }
  }
  await Promise.all([ssdpSozu, ...Array.from({ length: concurrency }, isci)]);

  return [...bulunan.values()].sort((a, b) => {
    const n = (x) => x.ip.split('.').map(Number).reduce((s, v) => s * 256 + v, 0);
    return n(a) - n(b);
  });
}
