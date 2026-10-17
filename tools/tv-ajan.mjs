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
 * açma (Wake-on-LAN), kapatma. Ham SSAP geçişi YOK — panel ele geçirilse bile TV'ye keyfi
 * istek gönderilemez. Kanal sıralama bilerek dışarıda: TV'yi dakikalarca meşgul eden bir iş.
 *
 * KALICI BAĞLANTI: her tuşta yeniden TLS + eşleşme yapmak ~0,2-0,4 sn. Bağlantı açık
 * tutulur, koparsa ilk istekte yeniden kurulur. TV bekleme modundayken bağlantıyı kabul
 * edip ilk mesajda kapatıyor (ölçüldü, 13.10.2026) — bu "kapalı" sayılır.
 *
 * YAYIN AKIŞI TV'DEN DEĞİL: TV'lerin verdiği akış güvenilmez çıktı (ertesi günün akışı —
 * COZUMLER.md). "Şu an ne var" bilgisi rehberden gelir (`net/rehber.mjs`: digiturk, yedek tvplus);
 * ev ağındaki bu ajan çeker çünkü digiturk veri merkezi IP'lerine (VPS) 403 dönüyor.
 *
 * Ortam:
 *   TV_AJAN_TOKEN       zorunlu, ≥ 32 karakter (panelde de aynısı)
 *   TV_AJAN_HOST        dinlenecek adres (varsayılan 127.0.0.1; pi63'te Tailscale IP'si)
 *   TV_AJAN_PORT        varsayılan 3027 (PORTS_REGISTRY.md)
 *   TV_AJAN_TVLER       TV listesi (varsayılan <kök>/tv-ajan.tvler.json — git'e girmez)
 *   TV_AJAN_ANAHTARLAR  eşleşme anahtarları (varsayılan <kök>/.lgtv-clients.json)
 *   TV_AJAN_DURUM       rehber önbelleği dizini (varsayılan: systemd STATE_DIRECTORY, yoksa data/yerel/rehber)
 *
 * TV listesi biçimi: [{ "id": "oturma", "ad": "Oturma odası", "ip": "…", "mac": "aa:bb:…" }, …]
 * `mac` uzaktan açmak (Wake-on-LAN) için; yoksa kapalı TV açılamaz.
 *
 * Uçlar (hepsi `Authorization: Bearer <belirteç>` ister):
 *   GET  /tvler                     → her TV'nin durumu (+ açık kanalda şu an ne var)
 *   GET  /ekran?tv=<id>             → JPEG
 *   POST /tus      {tv, tus}        → kumanda tuşu
 *   POST /kanal    {tv, ad | no}    → kanala geç — TV kapalıysa ÖNCE AÇAR (kullanıcı, 16.10.2026)
 *   POST /ac       {tv}             → TV'yi aç (Wake-on-LAN, açılana kadar bekler)
 *   POST /giris    {tv, hedef}      → hedef "canli" ya da "apple": canlı yayın ↔ Apple TV'nin HDMI girişi
 *   POST /cozumle  {tv, adlar[]}    → adları o TV'deki kanal numaralarına çevir
 *   POST /epg      {tv, adlar[]}    → bu kanallarda şu an ve sonra ne var (rehberden)
 *   POST /kapat    {tv}             → TV'yi kapat
 */

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LgSsap } from './net/lg-ssap.mjs';
import { LgInput } from './net/lg-input.mjs';
import { captureScreen } from './net/lg-screen.mjs';
import { kanalBul } from './net/kanal-bul.mjs';
import { Rehber, trGunu } from './net/rehber.mjs';
import { wolGonder } from './net/wol.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TOKEN = process.env.TV_AJAN_TOKEN || '';
const HOST = process.env.TV_AJAN_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_AJAN_PORT || 3027);
const TVLER_YOLU = process.env.TV_AJAN_TVLER || resolve(ROOT, 'tv-ajan.tvler.json');
const ANAHTAR_YOLU = process.env.TV_AJAN_ANAHTARLAR || resolve(ROOT, '.lgtv-clients.json');
const DURUM_DIZINI = process.env.TV_AJAN_DURUM || process.env.STATE_DIRECTORY || resolve(ROOT, 'data/yerel/rehber');

/** Kumandadan gönderilebilecek tuşlar. Liste dışı ad reddedilir. */
export const IZINLI_TUSLAR = new Set([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'EXIT', 'HOME', 'MENU', 'INFO', 'GUIDE', 'LIST',
  'CHANNELUP', 'CHANNELDOWN', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE',
  'RED', 'GREEN', 'YELLOW', 'BLUE',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
]);

/** Giriş geçişinin hedefleri — keyfi uygulama başlatılamaz. */
export const GIRIS_HEDEFLERI = new Set(['canli', 'apple']);
const CANLI_TV = 'com.webos.app.livetv';

const LISTE_OMRU_MS = 10 * 60 * 1000;
const UYANMA_MS = 40 * 1000;            // açılış + ağın gelmesi + SSAP'ın hazır olması
const MAC_KALIBI = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

/**
 * TV'nin kumanda portu açık mı? Kapalı (fişte değil / ağda değil) TV'ye bağlanmaya çalışmak
 * zaman aşımlarını tek tek beklemek demek: varsayılan denemelerle ~41 sn sürdü ve panel
 * 15 sn'de vazgeçti (ölçüldü, 15.10.2026). Önce kısa bir TCP yoklaması yapılır.
 */
function portAcik(ip, port, ms = 800) {
  return new Promise((ok) => {
    const s = net.connect({ host: ip, port });
    const bitir = (v) => { s.destroy(); ok(v); };
    s.setTimeout(ms, () => bitir(false));
    s.once('connect', () => bitir(true));
    s.once('error', () => bitir(false));
  });
}

function zamanAsimi(soz, ms, ne) {
  let t;
  return Promise.race([
    soz,
    new Promise((_, red) => { t = setTimeout(() => red(new Error(`${ne}: ${ms / 1000} sn içinde yanıt yok`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Kapalı TV'yi uyandırma döngüsü (TV'den bağımsız, test edilebilir).
 * Hazırsa hiç paket göndermez. Değilse sihirli paketi gönderir, `araMs`'de bir hazır mı diye
 * bakar, `wolAraMs`'de bir paketi yineler (Wi-Fi uykusundaki kart ilk paketi kaçırabilir).
 */
export async function uyandir({ hazirMi, wol, sureMs = UYANMA_MS, araMs = 1500, wolAraMs = 5000, bekle = sleep, simdi = () => Date.now() }) {
  if (await hazirMi()) return { uyandirildi: false, wolSayisi: 0 };
  const bitis = simdi() + sureMs;
  let sonWol = -Infinity;
  let wolSayisi = 0;
  while (simdi() < bitis) {
    if (simdi() - sonWol >= wolAraMs) { await wol(); sonWol = simdi(); wolSayisi++; }
    await bekle(araMs);
    if (await hazirMi()) return { uyandirildi: true, wolSayisi };
  }
  return { uyandirildi: false, zamanAsimi: true, wolSayisi };
}

export class Tv {
  constructor({ id, ad, ip, mac }, anahtar, { rehber = null, wol = wolGonder, uyanma = {}, teshisDizini = null, log = () => {} } = {}) {
    this.id = id;
    this.ad = ad;
    this.ip = ip;
    this.mac = mac || null;
    this.anahtar = anahtar;
    this.rehber = rehber;
    this.wol = wol;
    this.uyanma = uyanma;           // testler için: { sureMs, araMs, wolAraMs, bekle, simdi }
    this.teshisDizini = teshisDizini; // uyanmada kanal tutmazsa ekran görüntüsü buraya
    this.log = log;
    this.ssap = null;
    this.input = null;
    this._baglaniyor = null;
    this.kuyruk = Promise.resolve();
    this.liste = null;
    this.listeZamani = 0;
    this.uygulamaAdlari = null;
    this.appleUygulama = null;      // Apple TV'nin bağlı olduğu HDMI girişinin uygulama kimliği
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

  /** Eşzamanlı çağrılar tek bağlantı kurar (durum sorgusu sıraya girmiyor, uyandırmayla yarışabilir). */
  baglan() {
    if (this.ssap?.ws && !this.ssap.ws.closed) return Promise.resolve(this.ssap);
    if (!this._baglaniyor) this._baglaniyor = this._baglan().finally(() => { this._baglaniyor = null; });
    return this._baglaniyor;
  }

  async _baglan() {
    this.birak();
    if (!this.anahtar) throw new HttpHata(409, `${this.ad}: eşleşme anahtarı yok`);
    if (!(await portAcik(this.ip, 3001))) throw new HttpHata(503, `${this.ad}: TV kapalı ya da ağda değil`);
    const s = new LgSsap(this.ip);
    await s.connect({ timeoutMs: 3000, retries: 0 });
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

  async hazirMi() {
    try { await this.baglan(); return true; } catch (e) {
      if (e instanceof HttpHata && e.kod === 409) throw e;   // anahtar yok: uyandırmak çözmez
      return false;
    }
  }

  /** TV kapalıysa açar ve kumandaya hazır olana kadar bekler; açıksa hemen döner. */
  async uyan() {
    const r = await uyandir({
      ...this.uyanma,
      hazirMi: () => this.hazirMi(),
      wol: () => {
        if (!this.mac) throw new HttpHata(409, `${this.ad}: MAC adresi tanımlı değil — uzaktan açılamaz`);
        return this.wol(this.mac, this.ip);
      },
    });
    if (r.zamanAsimi) {
      throw new HttpHata(504, `${this.ad} açılmadı (${r.wolSayisi} uyandırma paketi gönderildi). TV ayarlarında "Mobil TV Açık / Wi-Fi ile aç" açık olmalı.`);
    }
    return r;
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
      for (const d of r.devices || []) {
        if (d.appId && d.label) m.set(d.appId, d.label);
        // Apple TV hangi HDMI'da: kullanıcının girişe verdiği ad ("Apple OTT", "Apple TV 1").
        if (!this.appleUygulama && d.appId && /apple/i.test(d.label || '')) this.appleUygulama = d.appId;
      }
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
          if (this.rehber && kanal.ad) {
            try { kanal.program = (await zamanAsimi(this.rehber.kanal(kanal.ad), 5000, 'rehber'))?.simdi || null; } catch { /* rehber yok */ }
          }
        } catch { /* kanal okunamadı */ }
      }
      const kaynak = on.appId === CANLI_TV ? 'canli' : (on.appId && on.appId === this.appleUygulama ? 'apple' : 'diger');
      return { id: this.id, ad: this.ad, acik: true, uygulama: on.appId || null, uygulamaAdi: adlar.get(on.appId) || null, kaynak, kanal };
    } catch (e) {
      if (!this._baglaniyor) this.birak();
      return { id: this.id, ad: this.ad, acik: false, acilabilir: !!this.mac, sebep: String(e.message || e).split('\n')[0].slice(0, 120) };
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

  /**
   * "Her türlü o kanalı açsın" (kullanıcı, 16.10.2026): TV kapalıysa önce açılır. Açılan TV
   * son girişte (HDMI) başlayabilir — openChannel canlı yayına zaten geçirir. Yeni açılmış
   * TV'de canlı yayın birkaç saniye hazır olmayabilir, bu yüzden birkaç deneme.
   */
  async kanalAc({ ad, no }) {
    const uyanma = await this.uyan();
    const bekle = this.uyanma.bekle || sleep;
    const deneme = uyanma.uyandirildi ? 5 : 2;
    const bul = (liste) => (no != null ? liste.find((k) => k.no === Number(no)) : kanalBul(liste, ad));
    let liste = null;
    let son;
    for (let i = 0; i < deneme && !liste; i++) {
      try { liste = await this.kanallar(); } catch (e) { son = e; if (i < deneme - 1) await bekle(2000); }
    }
    if (!liste) throw son;
    let k = bul(liste);
    if (!k) throw new HttpHata(404, `${this.ad}: "${ad ?? no}" kanalı bulunamadı`);
    for (let i = 0; i < deneme; i++) {
      try {
        await this.iste('ssap://tv/openChannel', { channelId: k.channelId });
        if (!uyanma.uyandirildi) return { no: k.no, ad: k.ad, acildi: false };
        const d = await this.kanalTuttuMu(k);
        this.log(`[tv] ${this.id} uyanma sonrası kanal ${d.tuttu ? 'tuttu' : 'TUTMADI'} · iz ${d.iz} · yineleme ${d.yineleme}${d.goruntu ? ` · görüntü ${d.goruntu}` : ''}`);
        if (!d.tuttu) throw new HttpHata(502, `${this.ad} açıldı ama ${k.ad} ekrana gelmedi (TV'de: ${d.son || 'bilinmiyor'}). Bir kez daha basın.`);
        return { no: k.no, ad: k.ad, acildi: true, yineleme: d.yineleme };
      } catch (e) {
        if (e instanceof HttpHata) throw e;
        son = e;
        // Kanal kimliği numarayı içerir; sıralamadan sonra önbellek bayatlamış olabilir.
        if (i === 0) { const t = bul(await this.kanallar({ taze: true }).catch(() => [])); if (t) k = t; }
        if (i < deneme - 1) await bekle(2000);
      }
    }
    throw son;
  }

  /**
   * Yeni uyanmış TV kanal komutunu kabul edip ekrana getirmeyebiliyor: 16.10.2026'da saatlerce
   * kapalı kalan salon TV'si "açıldı" yanıtına rağmen Kanal D'ye geçmedi, ekranda bir pencere
   * vardı, kullanıcı ikinci kez basmak zorunda kaldı. 17.10'da 1 dk kapalı kalan TV'de sorun
   * çıkmadı (yarı uyku, 4 sn'de açıldı). Ajan yanıtla yetinmez: kanal `kararliMs` boyunca
   * ekranda kalana kadar TV'ye sorar, başka kanaldaysa komutu en çok 3 kez yineler. Tutmazsa
   * ekran görüntüsünü saklar — pencerenin ne olduğu bir sonraki derin uykuda böyle öğrenilecek.
   */
  async kanalTuttuMu(k, { sureMs = 20000, araMs = 1500, kararliMs = 4000 } = {}) {
    const bekle = this.uyanma.bekle || sleep;
    const simdi = this.uyanma.simdi || Date.now;
    const bitis = simdi() + sureMs;
    const iz = [];
    let tutmaBasi = null;
    let yineleme = 0;
    let son = null;
    while (simdi() < bitis) {
      await bekle(araMs);
      let c = null;
      let on = null;
      try { c = await this.iste('ssap://tv/getCurrentChannel', null, 3000); } catch { /* henüz yok */ }
      try { on = (await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo', null, 3000)).appId || null; } catch { /* yok */ }
      const tuttu = !!c && (on == null || on === 'com.webos.app.livetv') && (c.channelId === k.channelId || Number(c.channelNumber) === k.no);
      son = `${c ? `${Number(c.channelNumber)} ${c.channelName}` : 'kanal yok'}${on && on !== 'com.webos.app.livetv' ? ` · ön planda ${on}` : ''}`;
      const imi = `${c ? Number(c.channelNumber) : '-'}${on && on !== 'com.webos.app.livetv' ? `@${on}` : ''}`;
      if (iz.at(-1) !== imi) iz.push(imi);
      if (tuttu) {
        if (tutmaBasi == null) tutmaBasi = simdi();
        if (simdi() - tutmaBasi >= kararliMs) return { tuttu: true, yineleme, iz: iz.join('→'), son };
      } else {
        tutmaBasi = null;
        // Başka kanal ya da başka giriş (TV son HDMI girişinde açılmış olabilir): openChannel ikisini de düzeltir.
        if (yineleme < 3) {
          yineleme++;
          await this.iste('ssap://tv/openChannel', { channelId: k.channelId }).catch(() => {});
        }
      }
    }
    const goruntu = await this.teshisGoruntusu().catch(() => null);
    return { tuttu: tutmaBasi != null, yineleme, iz: iz.join('→'), son, goruntu };
  }

  /** Uyanma sorununu sonradan görebilmek için ekran görüntüsü (son 10'u tutulur). */
  async teshisGoruntusu() {
    if (!this.teshisDizini) return null;
    const jpeg = await this.ekran();
    await mkdir(this.teshisDizini, { recursive: true });
    const ad = `uyanma-${this.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    await writeFile(join(this.teshisDizini, ad), jpeg);
    const eski = (await readdir(this.teshisDizini)).filter((f) => f.startsWith(`uyanma-${this.id}-`)).sort().slice(0, -10);
    for (const f of eski) await unlink(join(this.teshisDizini, f)).catch(() => {});
    return ad;
  }

  /** Canlı yayın ↔ Apple TV (kumanda tasarımı, 17.10.2026). TV kapalıysa önce açılır. */
  async girisDegistir(hedef) {
    if (!GIRIS_HEDEFLERI.has(hedef)) throw new HttpHata(400, `geçersiz giriş: ${hedef}`);
    await this.uyan();
    let uygulama = CANLI_TV;
    if (hedef === 'apple') {
      await this.adlar();
      uygulama = this.appleUygulama;
      if (!uygulama) throw new HttpHata(404, `${this.ad}: Apple TV girişi bulunamadı (TV'nin giriş adlarında "Apple" yok)`);
    }
    await this.iste('ssap://system.launcher/launch', { id: uygulama });
    return { kaynak: hedef, uygulama };
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

const adListesi = (g, en) => (Array.isArray(g.adlar) ? g.adlar.slice(0, en).map((a) => String(a).slice(0, 60)) : []);

export function sunucuKur(tvler, { token = TOKEN, log = console.log, rehber = null } = {}) {
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
        // Sıraya GİRMEZ: bir TV uyandırılırken (≤40 sn) panelin durum sorgusu beklememeli.
        const durumlar = await Promise.all(tvler.map((t) => t.durum()));
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
          log(`[tv] ${t.id} kanal ${k.no} ${k.ad}${k.acildi ? ' (TV açılarak)' : ''}`);
          json(res, 200, { ok: true, kanal: k });
          return;
        }
        if (url.pathname === '/ac') {
          const r = await t.sirayla(() => t.uyan());
          log(`[tv] ${t.id} ${r.uyandirildi ? `açıldı (${r.wolSayisi} paket)` : 'zaten açık'}`);
          json(res, 200, { ok: true, uyandirildi: r.uyandirildi });
          return;
        }
        if (url.pathname === '/giris') {
          const hedef = String(g.hedef || '');
          if (!GIRIS_HEDEFLERI.has(hedef)) throw new HttpHata(400, 'geçersiz giriş');
          const r = await t.sirayla(() => t.girisDegistir(hedef));
          log(`[tv] ${t.id} giriş → ${hedef} (${r.uygulama})`);
          json(res, 200, { ok: true, ...r });
          return;
        }
        if (url.pathname === '/cozumle') {
          json(res, 200, { kanallar: await t.sirayla(() => t.cozumle(adListesi(g, 30))) });
          return;
        }
        if (url.pathname === '/epg') {
          // Rehber TV'den bağımsız: TV kapalıyken de çalışır. Numara yalnız önbellekteki listeden
          // (TV'ye bağlanılmaz — kapalı TV'yi bu yüzden uyandırmayız).
          // Kanallar paralel: hepsi aynı günlük sayfayı bekler (tek indirme), panel 30 sn'de vazgeçer.
          const sonuc = await Promise.all(adListesi(g, 20).map(async (ad) => {
            const k = t.liste ? kanalBul(t.liste, ad) : null;
            let p = null;
            if (rehber) { try { p = await zamanAsimi(rehber.kanal(ad), 25000, 'rehber'); } catch { /* yok */ } }
            return { ad, no: k ? k.no : null, simdi: p?.simdi || null, sonraki: p?.sonraki || null, kaynak: p?.kaynak || null };
          }));
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

function tvleriYukle(rehber, teshisDizini) {
  if (!existsSync(TVLER_YOLU)) throw new Error(`TV listesi yok: ${TVLER_YOLU}`);
  const liste = JSON.parse(readFileSync(TVLER_YOLU, 'utf8'));
  const anahtarlar = existsSync(ANAHTAR_YOLU) ? JSON.parse(readFileSync(ANAHTAR_YOLU, 'utf8')) : {};
  return liste.map((t) => {
    if (!/^[a-z0-9-]{1,20}$/.test(t.id || '') || !t.ip) throw new Error(`geçersiz TV kaydı: ${JSON.stringify(t)}`);
    if (t.mac && !MAC_KALIBI.test(t.mac)) throw new Error(`geçersiz MAC (${t.id}): ${t.mac}`);
    return new Tv(t, anahtarlar[t.ip] || null, { rehber, teshisDizini, log: console.log });
  });
}

// Doğrudan çalıştırıldığında sunucuyu başlat (testler içe aktarınca başlatmaz).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (TOKEN.length < 32) {
    console.error('TV_AJAN_TOKEN tanımlı değil ya da kısa (≥ 32 karakter). Üretmek için: openssl rand -hex 32');
    process.exit(1);
  }
  const rehber = new Rehber({ dizin: DURUM_DIZINI, log: console.log });
  const tvler = tvleriYukle(rehber, join(DURUM_DIZINI, 'teshis'));
  const sunucu = sunucuKur(tvler, { rehber });
  sunucu.listen(PORT, HOST, () => {
    const ozet = tvler.map((t) => `${t.id}${t.anahtar ? '' : ' (anahtarsız!)'}${t.mac ? '' : ' (MAC yok — açılamaz)'}`).join(', ');
    console.log(`[tv-ajan] ${HOST}:${PORT} dinleniyor · TV'ler: ${ozet} · rehber: ${DURUM_DIZINI}`);
  });
  // Rehberi önceden ısıt: panelin ilk isteği 3,3 MB'lık sayfayı beklemesin. 3 saatte bir tazele.
  const isit = () => rehber.gun(trGunu(Date.now())).catch(() => {});
  isit();
  setInterval(isit, 3 * 60 * 60 * 1000);
  const kapan = () => { for (const t of tvler) t.birak(); sunucu.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', kapan);
  process.on('SIGINT', kapan);
}
