#!/usr/bin/env node
/**
 * TV ajanı — evdeki LG TV'leri ev paneline ("TV kumandaları" sayfası) açan
 * küçük HTTP servisi.
 *
 * NEDEN AYRI BİR AJAN: TV'ler yalnız ev ağından konuşuyor (`wss://<ip>:3001`), panel ise
 * VPS'te. Ev ağında 7/24 açık duran pi63 bu ajanı çalıştırır; panel ona Tailscale
 * üzerinden, bearer belirteciyle istek atar. Aynı kalıp pi63'teki WiZ/Meross ajanlarında da
 * var (`Network/NAS-Sync/ev-ajani/`); farkı bu ajanın panelden KOMUT alması.
 *
 * YALNIZ İZİNLİ İŞLER: durum, ekran görüntüsü, izinli kumanda tuşları, kanal değiştirme,
 * kapatma. Ham SSAP geçişi YOK — panel ele geçirilse bile TV'ye keyfi istek gönderilemez.
 * Kanal sıralama bilerek dışarıda: TV'yi dakikalarca meşgul eden bir iş, ayrı karar.
 *
 * KALICI BAĞLANTI: her tuşta yeniden TLS + eşleşme yapmak ~0,2-0,4 sn. Bağlantı açık
 * tutulur, koparsa ilk istekte yeniden kurulur. TV bekleme modundayken bağlantıyı kabul
 * edip ilk mesajda kapatıyor (ölçüldü, 13.10.2026) — bu "kapalı" sayılır.
 *
 * Ortam:
 *   TV_AJAN_TOKEN       zorunlu, ≥ 32 karakter (panelde de aynısı)
 *   TV_AJAN_HOST        dinlenecek adres (varsayılan 127.0.0.1; pi63'te Tailscale IP'si)
 *   TV_AJAN_PORT        varsayılan 3027 (PORTS_REGISTRY.md)
 *   TV_AJAN_TVLER       TV listesi (varsayılan <kök>/tv-ajan.tvler.json — git'e girmez)
 *   TV_AJAN_ANAHTARLAR  eşleşme anahtarları (varsayılan <kök>/.lgtv-clients.json)
 *
 * TV listesi biçimi: [{ "id": "oturma", "ad": "Oturma odası", "ip": "…" }, …]
 *
 * Uçlar (hepsi `Authorization: Bearer <belirteç>` ister):
 *   GET  /tvler                     → her TV'nin durumu
 *   GET  /ekran?tv=<id>             → JPEG
 *   POST /tus      {tv, tus}        → kumanda tuşu
 *   POST /kanal    {tv, ad | no}    → kanala geç
 *   POST /cozumle  {tv, adlar[]}    → adları o TV'deki kanal numaralarına çevir
 *   POST /epg      {tv, adlar[]}    → bu kanallarda şu an ve sonra ne var (yayın akışı)
 *   POST /kapat    {tv}             → TV'yi kapat
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LgSsap } from './net/lg-ssap.mjs';
import { LgInput } from './net/lg-input.mjs';
import { captureScreen } from './net/lg-screen.mjs';
import { kanalBul } from './net/kanal-bul.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TOKEN = process.env.TV_AJAN_TOKEN || '';
const HOST = process.env.TV_AJAN_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_AJAN_PORT || 3027);
const TVLER_YOLU = process.env.TV_AJAN_TVLER || resolve(ROOT, 'tv-ajan.tvler.json');
const ANAHTAR_YOLU = process.env.TV_AJAN_ANAHTARLAR || resolve(ROOT, '.lgtv-clients.json');

/** Kumandadan gönderilebilecek tuşlar. Liste dışı ad reddedilir. */
export const IZINLI_TUSLAR = new Set([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'EXIT', 'HOME', 'MENU', 'INFO', 'GUIDE', 'LIST',
  'CHANNELUP', 'CHANNELDOWN', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE',
  'RED', 'GREEN', 'YELLOW', 'BLUE',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

const LISTE_OMRU_MS = 10 * 60 * 1000;
const EPG_OMRU_MS = 60 * 1000;

/** "2026,10,16,16,00,00" (UTC) → ms. LG yayın akışı saatleri bu biçimde. */
function lgZaman(s) {
  const p = String(s || '').split(',').map(Number);
  return p.length >= 5 && p.every(Number.isFinite) ? Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5] || 0) : null;
}

/**
 * Yayın akışından "şimdi" ve "sonraki"yi seçer. Saatler UTC alanlarından okunur;
 * ekrandaki saat (`localStartTime`) TV'nin kendi saat dilimidir, ajanınkine güvenilmez.
 */
export function programSec(liste, simdi = Date.now()) {
  const p = (liste || [])
    .map((x) => ({ ad: x.programName || null, bas: lgZaman(x.startTime), bit: lgZaman(x.endTime), yerelBas: x.localStartTime, yerelBit: x.localEndTime }))
    .filter((x) => x.ad && x.bas != null && x.bit != null)
    .sort((a, b) => a.bas - b.bas);
  const saat = (yerel) => { const q = String(yerel || '').split(','); return q.length >= 5 ? `${q[3].padStart(2, '0')}:${q[4].padStart(2, '0')}` : null; };
  // DİKKAT — tarih kaydırma YAPILMAZ. 55SM8000PLA 15.10.2026 akşamı başka kanalların akışını
  // 16.10 tarihiyle verdi; TV'nin saati doğruydu (15.10 20:04). Veri gerçekten ERTESİ GÜNÜN
  // akışıydı: "Beyaz'la Joker 20:00" cumaya alınmış bir programdı, o saatte Kanal D'de başka
  // bir dizi yayındaydı (ekran görüntüsüyle görüldü). Günün saatine göre eşleştirmek yanlış
  // programı "şimdi" diye gösterirdi. Yalnız gerçek ana uyan kayıt kabul edilir.
  const bicim = (x) => (x ? { ad: x.ad, bas: saat(x.yerelBas), bit: saat(x.yerelBit), bitis: x.bit } : null);
  const i = p.findIndex((x) => x.bas <= simdi && simdi < x.bit);
  if (i >= 0) return { simdi: bicim(p[i]), sonraki: bicim(p[i + 1]) };
  return { simdi: null, sonraki: bicim(p.find((x) => x.bas > simdi)) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

function zamanAsimi(soz, ms, ne) {
  let t;
  return Promise.race([
    soz,
    new Promise((_, red) => { t = setTimeout(() => red(new Error(`${ne}: ${ms / 1000} sn içinde yanıt yok`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

class Tv {
  constructor({ id, ad, ip }, anahtar) {
    this.id = id;
    this.ad = ad;
    this.ip = ip;
    this.anahtar = anahtar;
    this.ssap = null;
    this.input = null;
    this.kuyruk = Promise.resolve();
    this.liste = null;
    this.listeZamani = 0;
    this.uygulamaAdlari = null;
  }

  /** Aynı TV'ye işler sırayla gider: iki tuş birbirinin ortasına girmez. */
  sirayla(is) {
    const soz = this.kuyruk.then(is, is);
    this.kuyruk = soz.catch(() => {});
    return soz;
  }

  birak() {
    try { this.input?.close(); } catch { /* yok say */ }
    try { this.ssap?.close(); } catch { /* yok say */ }
    this.input = null;
    this.ssap = null;
  }

  async baglan() {
    if (this.ssap?.ws && !this.ssap.ws.closed) return this.ssap;
    this.birak();
    if (!this.anahtar) throw new HttpHata(409, `${this.ad}: eşleşme anahtarı yok`);
    const s = new LgSsap(this.ip);
    await s.connect({ timeoutMs: 4000 });
    // Anahtar varken TV onay sormaz. Sorarsa (anahtar geçersiz) beklemeyiz: zaman aşımı.
    await zamanAsimi(s.register(this.anahtar, { timeoutMs: 6000 }), 7000, 'eşleşme');
    s.ws.on('close', () => { if (this.ssap === s) this.birak(); });
    this.ssap = s;
    return s;
  }

  async iste(uri, payload, ms = 5000) {
    const s = await this.baglan();
    return s.request(uri, payload, { timeoutMs: ms });
  }

  async kumanda() {
    if (this.input && !this.input.conn.closed) return this.input;
    const s = await this.baglan();
    this.input = await zamanAsimi(LgInput.open(s, { timeoutMs: 4000 }), 5000, 'kumanda soketi');
    return this.input;
  }

  async adlar() {
    if (this.uygulamaAdlari) return this.uygulamaAdlari;
    const m = new Map();
    try {
      const r = await this.iste('ssap://com.webos.applicationManager/listLaunchPoints');
      for (const lp of r.launchPoints || []) if (lp.id && lp.title) m.set(lp.id, lp.title);
    } catch { /* adsız da çalışır */ }
    try {
      // HDMI girişlerinin kullanıcının verdiği adı ("Apple TV 1") burada.
      const r = await this.iste('ssap://tv/getExternalInputList');
      for (const d of r.devices || []) if (d.appId && d.label) m.set(d.appId, d.label);
    } catch { /* yok say */ }
    this.uygulamaAdlari = m;
    return m;
  }

  async durum() {
    try {
      const on = await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo');
      const adlar = await this.adlar();
      let kanal = null;
      if (on.appId === 'com.webos.app.livetv') {
        try {
          const c = await this.iste('ssap://tv/getCurrentChannel');
          kanal = { no: Number(c.channelNumber), ad: c.channelName, program: null };
          try {
            const r = await this.iste('ssap://tv/getChannelProgramInfo', { channelId: c.channelId }, 4000);
            kanal.program = programSec(r.programList).simdi;
          } catch { /* akış yok */ }
        } catch { /* kanal okunamadı */ }
      }
      return { id: this.id, ad: this.ad, acik: true, uygulama: on.appId || null, uygulamaAdi: adlar.get(on.appId) || null, kanal };
    } catch (e) {
      this.birak();
      return { id: this.id, ad: this.ad, acik: false, sebep: String(e.message || e).slice(0, 120) };
    }
  }

  /** Uydu TV kanalları (radyo hariç), numara sırasıyla. 10 dk önbellekli. */
  async kanallar({ taze = false } = {}) {
    if (!taze && this.liste && Date.now() - this.listeZamani < LISTE_OMRU_MS) return this.liste;
    const r = await this.iste('ssap://tv/getChannelList', null, 15000);
    this.liste = (r.channelList || [])
      .filter((c) => !c.Radio)
      .map((c) => ({ no: Number(c.channelNumber), ad: c.channelName, channelId: c.channelId }))
      .sort((a, b) => a.no - b.no);
    this.listeZamani = Date.now();
    return this.liste;
  }

  async kanalAc({ ad, no }) {
    const bul = (liste) => (no != null ? liste.find((k) => k.no === Number(no)) : kanalBul(liste, ad));
    let k = bul(await this.kanallar());
    if (!k) throw new HttpHata(404, `${this.ad}: "${ad ?? no}" kanalı bulunamadı`);
    try {
      await this.iste('ssap://tv/openChannel', { channelId: k.channelId });
    } catch (e) {
      // Kanal kimliği numarayı içerir; sıralamadan sonra önbellek bayatlamış olabilir.
      k = bul(await this.kanallar({ taze: true }));
      if (!k) throw new HttpHata(404, `${this.ad}: "${ad ?? no}" kanalı bulunamadı`);
      await this.iste('ssap://tv/openChannel', { channelId: k.channelId });
    }
    return { no: k.no, ad: k.ad };
  }

  /**
   * Kanalların yayın akışı. TV canlı yayında değilken (HDMI, uygulama) akış boş gelebiliyor
   * (salon, webOS 26, ölçüldü) — boş dönen kanal çağıran tarafta başka TV'den denenir.
   */
  async epg(adlar) {
    const liste = await this.kanallar();
    const simdi = Date.now();
    this.epgOnbellek = this.epgOnbellek || new Map();
    const sonuc = [];
    for (const ad of adlar) {
      const k = kanalBul(liste, ad);
      if (!k) { sonuc.push({ ad, no: null, simdi: null, sonraki: null }); continue; }
      const o = this.epgOnbellek.get(k.channelId);
      if (o && simdi - o.zaman < EPG_OMRU_MS && (!o.veri.simdi || o.veri.simdi.bitis > simdi)) {
        sonuc.push({ ad, no: k.no, ...o.veri });
        continue;
      }
      try {
        const r = await this.iste('ssap://tv/getChannelProgramInfo', { channelId: k.channelId }, 6000);
        const veri = programSec(r.programList, simdi);
        this.epgOnbellek.set(k.channelId, { zaman: simdi, veri });
        sonuc.push({ ad, no: k.no, ...veri });
      } catch {
        sonuc.push({ ad, no: k.no, simdi: null, sonraki: null });
      }
    }
    return sonuc;
  }

  async cozumle(adlar) {
    const liste = await this.kanallar();
    return adlar.map((ad) => {
      const k = kanalBul(liste, ad);
      return { ad, no: k ? k.no : null, kanalAdi: k ? k.ad : null };
    });
  }

  async tus(ad) {
    if (!IZINLI_TUSLAR.has(ad)) throw new HttpHata(400, `izinli olmayan tuş: ${ad}`);
    try {
      await (await this.kumanda()).button(ad, { settleMs: 0 });
    } catch {
      // Kumanda soketi sessizce düşmüş olabilir: bir kez baştan kur.
      this.birak();
      await (await this.kumanda()).button(ad, { settleMs: 0 });
    }
  }

  async ekran() {
    return captureScreen(await this.baglan(), { timeoutMs: 8000 });
  }

  async kapat() {
    await this.iste('ssap://system/turnOff');
    await sleep(300);
    this.birak();
  }
}

// ───────────────────────────────────────────────────────────── HTTP

function yetkili(req, token) {
  const h = String(req.headers.authorization || '');
  if (!token || !h.startsWith('Bearer ')) return false;
  const a = Buffer.from(h.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, kod, govde) {
  const s = JSON.stringify(govde);
  res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

async function govdeOku(req, sinir = 4096) {
  const parcalar = [];
  let n = 0;
  for await (const p of req) {
    n += p.length;
    if (n > sinir) throw new HttpHata(413, 'istek gövdesi çok büyük');
    parcalar.push(p);
  }
  if (!parcalar.length) return {};
  try { return JSON.parse(Buffer.concat(parcalar).toString('utf8')); } catch { throw new HttpHata(400, 'gövde JSON değil'); }
}

export function sunucuKur(tvler, { token = TOKEN, log = console.log } = {}) {
  const byId = new Map(tvler.map((t) => [t.id, t]));
  const tvAl = (id) => {
    const t = byId.get(String(id || ''));
    if (!t) throw new HttpHata(404, 'bilinmeyen TV');
    return t;
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://ajan');
    if (!yetkili(req, token)) { json(res, 401, { hata: 'yetkisiz' }); return; }
    try {
      if (req.method === 'GET' && url.pathname === '/tvler') {
        const durumlar = await Promise.all(tvler.map((t) => t.sirayla(() => t.durum())));
        json(res, 200, { tvler: durumlar });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ekran') {
        const t = tvAl(url.searchParams.get('tv'));
        const jpeg = await t.sirayla(() => t.ekran());
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': jpeg.length });
        res.end(jpeg);
        return;
      }
      if (req.method === 'POST') {
        const g = await govdeOku(req);
        const t = tvAl(g.tv);
        if (url.pathname === '/tus') {
          const tus = String(g.tus || '').toUpperCase();
          await t.sirayla(() => t.tus(tus));
          log(`[tv] ${t.id} tuş ${tus}`);
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/kanal') {
          if (g.no == null && !g.ad) throw new HttpHata(400, 'ad ya da no gerekli');
          if (g.no != null && !/^\d{1,5}$/.test(String(g.no))) throw new HttpHata(400, 'geçersiz kanal numarası');
          if (g.ad != null && String(g.ad).length > 60) throw new HttpHata(400, 'kanal adı çok uzun');
          const k = await t.sirayla(() => t.kanalAc({ ad: g.ad, no: g.no }));
          log(`[tv] ${t.id} kanal ${k.no} ${k.ad}`);
          json(res, 200, { ok: true, kanal: k });
          return;
        }
        if (url.pathname === '/cozumle') {
          const adlar = Array.isArray(g.adlar) ? g.adlar.slice(0, 30).map((a) => String(a).slice(0, 60)) : [];
          json(res, 200, { kanallar: await t.sirayla(() => t.cozumle(adlar)) });
          return;
        }
        if (url.pathname === '/epg') {
          const adlar = Array.isArray(g.adlar) ? g.adlar.slice(0, 20).map((a) => String(a).slice(0, 60)) : [];
          const sonuc = await t.sirayla(() => t.epg(adlar));
          const eksik = sonuc.filter((x) => !x.simdi).map((x) => x.ad);
          for (const diger of tvler) {
            if (diger === t || !eksik.length) continue;
            try {
              const ek = await diger.sirayla(() => diger.epg(eksik));
              for (const e of ek) {
                const hedef = sonuc.find((x) => x.ad === e.ad);
                if (hedef && !hedef.simdi && e.simdi) { hedef.simdi = e.simdi; hedef.sonraki = e.sonraki; hedef.kaynak = diger.id; }
              }
            } catch { /* diğer TV kapalı */ }
            eksik.splice(0, eksik.length, ...sonuc.filter((x) => !x.simdi).map((x) => x.ad));
          }
          json(res, 200, { kanallar: sonuc });
          return;
        }
        if (url.pathname === '/kapat') {
          await t.sirayla(() => t.kapat());
          log(`[tv] ${t.id} kapatıldı`);
          json(res, 200, { ok: true });
          return;
        }
      }
      json(res, 404, { hata: 'bilinmeyen uç' });
    } catch (e) {
      const kod = e instanceof HttpHata ? e.kod : 502;
      json(res, kod, { hata: String(e.message || e).slice(0, 200) });
    }
  });
}

function tvleriYukle() {
  if (!existsSync(TVLER_YOLU)) throw new Error(`TV listesi yok: ${TVLER_YOLU}`);
  const liste = JSON.parse(readFileSync(TVLER_YOLU, 'utf8'));
  const anahtarlar = existsSync(ANAHTAR_YOLU) ? JSON.parse(readFileSync(ANAHTAR_YOLU, 'utf8')) : {};
  return liste.map((t) => {
    if (!/^[a-z0-9-]{1,20}$/.test(t.id || '') || !t.ip) throw new Error(`geçersiz TV kaydı: ${JSON.stringify(t)}`);
    return new Tv(t, anahtarlar[t.ip] || null);
  });
}

// Doğrudan çalıştırıldığında sunucuyu başlat (testler içe aktarınca başlatmaz).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (TOKEN.length < 32) {
    console.error('TV_AJAN_TOKEN tanımlı değil ya da kısa (≥ 32 karakter). Üretmek için: openssl rand -hex 32');
    process.exit(1);
  }
  const tvler = tvleriYukle();
  const sunucu = sunucuKur(tvler);
  sunucu.listen(PORT, HOST, () => {
    console.log(`[tv-ajan] ${HOST}:${PORT} dinleniyor · TV'ler: ${tvler.map((t) => `${t.id}${t.anahtar ? '' : ' (anahtarsız!)'}`).join(', ')}`);
  });
  const kapan = () => { for (const t of tvler) t.birak(); sunucu.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', kapan);
  process.on('SIGINT', kapan);
}
