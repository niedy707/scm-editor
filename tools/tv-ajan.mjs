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
 *   POST /isaretci {tv, dx, dy} | {tv, tikla: true} → Magic Remote imleci (kumandadaki dokunmatik yüzey)
 *   POST /tus      {tv, tus, cihaz: "apple"}  → tuş Apple TV'ye (pyatv, Companion)
 *   POST /metin    {tv, metin}      → Apple TV'de odaktaki yazı alanına metin
 *   POST /kanal    {tv, ad | no}    → kanala geç — TV kapalıysa ÖNCE AÇAR (kullanıcı, 16.10.2026)
 *   POST /ac       {tv}             → TV'yi aç (Wake-on-LAN, açılana kadar bekler)
 *   POST /giris    {tv, hedef}      → kaynak menüsü: "canli", "apple" (HDMI girişi), "netflix" / "prime" / "disney" (TV uygulaması)
 *   POST /ekran-guc {tv, kapali}    → ekranı kapat / aç (ses devam eder)
 *   POST /bildirim {tv, mesaj, sureSn} → TV ekranına mesaj (sureSn boyunca yenilenerek)
 *   GET  /ekran-akis?tv=&sn=&fps=   → canlı önizleme: art arda JPEG (multipart); TV başına tek çekim, çok izleyici
 *   POST /akis     {adlar[], saat}  → kanalların yayın akışı (şu andan `saat` saat ileri; rehberden)
 *   GET  /zamanlayici               → geri dön sayaçları + program görevleri + geçmiş
 *   POST /zamanlayici {islem, …}    → geri-don | ekle | uzat | sil | etkin | hemen (bkz. net/zamanlayici.mjs)
 *   POST /cozumle  {tv, adlar[]}    → adları o TV'deki kanal numaralarına çevir
 *   POST /epg      {tv, adlar[]}    → bu kanallarda şu an ve sonra ne var (rehberden)
 *   POST /kapat    {tv}             → TV'yi kapat
 *   GET  /ses?tv=  · POST /ses {tv, seviye 0-100}  → ses düzeyi (Ch / Vol penceresindeki şerit)
 *   GET  /izleme?tv=&gun=YYYY-MM-DD&gunSayisi=N    → izleme geçmişi + özet (TV_AJAN_IZLEME=1 ise); YouTube
 *                                                     kesitlerinde bulunabildiyse `youtube` = video kimliği
 *   GET  /kilit  · POST /kilit {tv, dk?, kapsam?}  · DELETE /kilit?tv=  · POST /kilit/ayar {mesaj}
 *                                                   → TV kilidi (dk yok → süresiz; kapsam tv | tv+apple) — net/kilit.mjs
 *   GET  /engel  · POST /engel {metin, tur?}  · DELETE /engel?id=  · POST /engel/ayar {acik}
 *                                                   → YouTube engelleri (kurallar, son engellenenler) — net/engel.mjs
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
import { Zamanlayici } from './net/zamanlayici.mjs';
import { AppleTvKopru } from './net/atv-kopru.mjs';
import { IzlemeKaydi, ozetle, trGun } from './net/izleme.mjs';
import { YoutubeBulucu, ayir, anahtar as ytAnahtar } from './net/youtube-bul.mjs';
import { EngelListesi, EngelBekcisi } from './net/engel.mjs';
import { TvKilidi, KilitBekcisi } from './net/kilit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TOKEN = process.env.TV_AJAN_TOKEN || '';
const HOST = process.env.TV_AJAN_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_AJAN_PORT || 3027);
const TVLER_YOLU = process.env.TV_AJAN_TVLER || resolve(ROOT, 'tv-ajan.tvler.json');
// Apple TV (pyatv): kurulu Python ve yardımcı betik. Kimlik dosyası DURUM_DIZINI/pyatv.conf (eşleştirme yazar).
const PYATV_PYTHON = process.env.TV_AJAN_PYATV || '/opt/pyatv/bin/python3';
const ATV_YARDIMCI = resolve(ROOT, 'tools/atv-yardimci.py');
const ANAHTAR_YOLU = process.env.TV_AJAN_ANAHTARLAR || resolve(ROOT, '.lgtv-clients.json');
const DURUM_DIZINI = process.env.TV_AJAN_DURUM || process.env.STATE_DIRECTORY || resolve(ROOT, 'data/yerel/rehber');

/** Kumandadan gönderilebilecek tuşlar. Liste dışı ad reddedilir. */
export const IZINLI_TUSLAR = new Set([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'EXIT', 'HOME', 'MENU', 'INFO', 'GUIDE', 'LIST',
  'CHANNELUP', 'CHANNELDOWN', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE',
  'RED', 'GREEN', 'YELLOW', 'BLUE',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'PLAY', 'PAUSE', 'REWIND', 'FASTFORWARD',   // uygulama kumandası (Netflix vb., 17.10.2026)
]);

/** Giriş geçişinin hedefleri — keyfi uygulama başlatılamaz. */
// Kaynak menüsü (kullanıcı, 17.10.2026): canlı yayın, Apple TV girişi ve üç uygulama. Uygulamalar bugün
// TV'nin kendi uygulamasıyla açılır (kimlikler salon TV'sinin listLaunchPoints'inden, 17.10.2026).
// Apple TV eşleştirilmişse (pyatv) uygulama Apple TV'de açılır (kullanıcı: "Apple TV işlemcisi daha iyi");
// kimlikler salon Apple TV'sinin app_list'inden (17.10.2026). Apple TV'ye ulaşılamazsa TV'nin uygulaması.
export const UYGULAMALAR = {
  netflix: { ad: 'Netflix', lg: 'netflix', atv: 'com.netflix.Netflix' },
  prime: { ad: 'Amazon Prime', lg: 'amazon', atv: 'com.amazon.aiv.AIVApp' },
  disney: { ad: 'Disney+', lg: 'com.disney.disneyplus-prod', atv: 'com.disney.disneyplus' },
};
// Uygulama kumandası Apple TV girişindeyken tuşları Apple TV'ye gönderir (LG adı → pyatv tuşu).
export const ATV_TUSLARI = {
  UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right', ENTER: 'select', BACK: 'menu', HOME: 'home',
  PLAY: 'play', PAUSE: 'pause', REWIND: 'skip_backward', FASTFORWARD: 'skip_forward',
};
const LG_KAYNAK = Object.fromEntries(Object.entries(UYGULAMALAR).map(([k, u]) => [u.lg, k]));
export const GIRIS_HEDEFLERI = new Set(['canli', 'apple', ...Object.keys(UYGULAMALAR)]);
const CANLI_TV = 'com.webos.app.livetv';

const LISTE_OMRU_MS = 10 * 60 * 1000;
// TV bildirimi (toast) ekranda ~4-5 sn kalıyor (17.10.2026, salon: 3,4 sn'de var, 5,8 sn'de yok) →
// daha uzun gösterim için bu aralıkla yenilenir.
const BILDIRIM_TAZELEME_MS = 4500;
const AKIS_EN_UZUN_SN = 180;
const AKIS_VARSAYILAN_FPS = 1;   // kullanıcı, 17.10.2026: "1 kare/sn" (ölçüm: kare ~100-170 KB → ~8,5 MB/dk)
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
/**
 * LG güç durumları: kapatılan TV ağ bağlantısını açık tutan beklemeye geçer ("Active Standby"; webOS 26
 * salon, 17.10.2026). O hâldeyken AÇIK KALAN SSAP oturumu yanıt vermeyi sürdürür (ön planda hâlâ
 * "livetv" der), yeni oturumu ise TV kapatır. Yalnız "Screen Off"a bakan ilk sürüm bekleyen TV'yi açık
 * sandı: kanal düğmesi uyandırmadan kanal değiştirdi, ekran kapalı kaldı. "Screen Off" (ekran kapalı,
 * ses açık — bizim düğmemiz) ve "Screen Saver" AÇIK sayılır.
 */
const KAPALI_GUC = /standby|suspend|power ?off/i;
export const gucKapaliMi = (r) => !!r && (KAPALI_GUC.test(String(r.state || '')) || KAPALI_GUC.test(String(r.processing || '')));

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
  constructor({ id, ad, ip, mac, appletv }, anahtar, { rehber = null, wol = wolGonder, uyanma = {}, teshisDizini = null, log = () => {}, atv = null } = {}) {
    this.id = id;
    this.ad = ad;
    this.ip = ip;
    this.mac = mac || null;
    this.appletv = appletv || null;  // { ip, id } — bu TV'ye bağlı Apple TV (pyatv)
    this.atv = atv;                  // AppleTvKopru (tüm TV'ler için tek)
    this.kilit = null;               // TvKilidi (net/kilit.mjs) — ana akışta bağlanır
    this.appleSon = null;            // Apple TV'de en son açtırılan uygulama (netflix…), girişten çıkınca silinir
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
    // Apple TV'nin bağlı olduğu HDMI girişinin uygulama kimliği. Yapılandırmada `appletv.giris` verilmişse o;
    // yoksa LG'nin giriş adından ("Apple TV", "Apple OTT") bulunur.
    this.appleUygulama = (appletv && appletv.giris) || null;
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
    try { await this.baglan(); } catch (e) {
      if (e instanceof HttpHata && e.kod === 409) throw e;   // anahtar yok: uyandırmak çözmez
      return false;
    }
    // Bağlantı kurulu olabilir ama TV beklemede (yukarıdaki not): o zaman hazır değil, bağlantı bırakılır.
    if (gucKapaliMi(await this.gucDurumu())) { this.birak(); return false; }
    return true;
  }

  /** getPowerState yanıtı; uç yoksa (eski webOS) ya da hata olursa null — o zaman güç bilinmiyor sayılır. */
  async gucDurumu() {
    try { return await this.iste('ssap://com.webos.service.tvpower/power/getPowerState', null, 2000); } catch { return null; }
  }

  /**
   * TV kilitliyse (ebeveyn denetimi, net/kilit.mjs) açmaya yol açabilecek her komut burada durur: 423.
   * Kumandanın kanal/giriş/açma uçları ve zamanlayıcı `uyan()`dan, Apple TV komutları buradan geçer.
   */
  kilitDenetle() {
    const k = this.kilit?.bilgi(this.id);
    if (!k) return;
    const saat = k.bitis ? new Date(k.bitis + 3 * 3600e3).toISOString().slice(11, 16) : null;
    throw new HttpHata(423, `${this.ad} kilitli${saat ? ` (${saat}'e kadar)` : ''} — açılamaz. Kilidi "Engeller" sayfasından açabilirsiniz.`);
  }

  /** Kilit bekçisi için: TV şu an açık mı. Beklemede ya da ulaşılamıyorsa false. Güç durumu ucu olmayan TV'de ön uygulamaya bakılır. */
  async acikMi() {
    const g = await this.gucDurumu();
    if (g) return !gucKapaliMi(g);
    try { return !!(await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo', null, 2000)).appId; } catch { return false; }
  }

  /** TV kapalıysa açar ve kumandaya hazır olana kadar bekler; açıksa hemen döner. */
  async uyan() {
    this.kilitDenetle();
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
    const d = await this._durum();
    this._sonDurum = { zaman: Date.now(), acik: !!d.acik, cihaz: d.cihaz || null };   // engel bekçisi okur
    return d;
  }

  async _durum() {
    try {
      const guc = await this.gucDurumu();
      if (gucKapaliMi(guc)) {   // kapatılmış ama ağda bekliyor: kapalı göster, açmak uyandırma ister
        this.birak();
        return { id: this.id, ad: this.ad, acik: false, acilabilir: !!this.mac, sebep: `${this.ad}: beklemede (${guc.state || guc.processing})` };
      }
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
      const appleda = !!on.appId && on.appId === this.appleUygulama;
      if (!appleda) this.appleSon = null;
      const kaynak = on.appId === CANLI_TV ? 'canli' : (appleda ? (this.appleSon || 'apple') : (LG_KAYNAK[on.appId] || 'diger'));
      const cihaz = appleda ? 'apple' : 'lg';
      const oynayan = appleda ? await this.appleOynayan() : null;
      const ekranKapali = guc ? guc.state === 'Screen Off' : null;
      return { id: this.id, ad: this.ad, acik: true, uygulama: on.appId || null, uygulamaAdi: adlar.get(on.appId) || null, kaynak, cihaz, appleTv: this.appleTvVar(), ...(oynayan ? { oynayan } : {}), kanal, ekranKapali };
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
  async kanalAc({ ad, no, dogrula = false }) {
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
        // Zamanlanmış geçişte (dogrula) kimse ekrana bakmıyor: kanalın tuttuğu her durumda denetlenir.
        if (!uyanma.uyandirildi && !dogrula) return { no: k.no, ad: k.ad, acildi: false };
        const d = await this.kanalTuttuMu(k);
        this.log(`[tv] ${this.id} uyanma sonrası kanal ${d.tuttu ? 'tuttu' : 'TUTMADI'} · iz ${d.iz} · yineleme ${d.yineleme}${d.goruntu ? ` · görüntü ${d.goruntu}` : ''}`);
        if (!d.tuttu) throw new HttpHata(502, `${this.ad}: ${k.ad} ekrana gelmedi (TV'de: ${d.son || 'bilinmiyor'}). Bir kez daha basın.`);
        return { no: k.no, ad: k.ad, acildi: uyanma.uyandirildi, yineleme: d.yineleme };
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

  /** Kaynak menüsü: canlı yayın, Apple TV ya da bir uygulama (kumanda tasarımı, 17.10.2026). TV kapalıysa önce açılır. */
  async girisDegistir(hedef) {
    if (!GIRIS_HEDEFLERI.has(hedef)) throw new HttpHata(400, `geçersiz giriş: ${hedef}`);
    await this.uyan();
    let uygulama = CANLI_TV;
    let not = null;
    this.appleSon = null;
    if (UYGULAMALAR[hedef]?.atv && this.appleTvVar()) {
      const u = UYGULAMALAR[hedef];
      try {
        await this.atv.iste(this.appletv, 'uygulama', { uygulama: u.atv });   // Apple TV uykudaysa uyanır
        await this.adlar();
        if (this.appleUygulama) await this.iste('ssap://system.launcher/launch', { id: this.appleUygulama });
        this.appleSon = hedef;
        return { kaynak: hedef, cihaz: 'apple', uygulama: u.atv };
      } catch (e) {
        this.log(`[tv] ${this.id}: Apple TV'de ${u.ad} açılamadı (${e.message}) — TV'nin uygulamasıyla açılıyor`);
        not = `Apple TV'ye ulaşılamadı — TV'nin ${u.ad} uygulaması açıldı`;
      }
    }
    if (hedef === 'apple') {
      await this.adlar();
      uygulama = this.appleUygulama;
      if (!uygulama) throw new HttpHata(404, `${this.ad}: Apple TV girişi bulunamadı (TV'nin giriş adlarında "Apple" yok)`);
    } else if (UYGULAMALAR[hedef]) {
      const u = UYGULAMALAR[hedef];
      const adlar = await this.adlar();
      if (adlar.size && !adlar.has(u.lg)) throw new HttpHata(404, `${this.ad}: ${u.ad} bu TV'de yüklü değil`);
      uygulama = u.lg;
    }
    await this.iste('ssap://system.launcher/launch', { id: uygulama });
    return { kaynak: hedef, uygulama, ...(UYGULAMALAR[hedef] ? { cihaz: 'lg' } : {}), ...(not ? { not } : {}) };
  }

  /**
   * Apple TV'de şu an oynayan (uygulama, başlık, kanal/sanatçı, dizi-sezon-bölüm, konum). AirPlay eşleşmesi
   * gerekir. Yalnız TV Apple TV girişindeyken sorulur — her soru Apple TV'yi uyandırır. 10 sn önbellek.
   */
  async appleOynayan() {
    if (!this.appleTvVar()) return null;
    const simdi = Date.now();
    if (this._oynayan && simdi - this._oynayan.zaman < 10000) return this._oynayan.veri;
    let veri = null;
    try {
      const { no, ok, ...v } = await this.atv.iste(this.appletv, 'oynayan', {}, 6000);
      veri = v;
    } catch { /* eşleşme yok ya da Apple TV yanıt vermedi */ }
    this._oynayan = { zaman: simdi, veri };
    return veri;
  }

  /**
   * Engel bekçisi için: TV açık ve Apple TV girişindeyse Apple TV'de oynayan (önbelleksiz), değilse null.
   * Apple TV'ye ancak LG "açık, Apple TV girişinde" derse sorulur — kapalı TV'nin Apple TV'sine giden soru
   * Apple TV'yi, o da CEC ile TV'yi uyandırabilir. LG durumu açıkken 8 sn, kapalıyken 30 sn'de bir tazelenir.
   */
  async appledaOynayan() {
    if (!this.appleTvVar()) return null;
    const son = this._sonDurum;
    if (!son || Date.now() - son.zaman > (son.acik ? 8000 : 30000)) await this.durum();
    if (!this._sonDurum?.acik || this._sonDurum.cihaz !== 'apple') return null;
    const on = await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo');
    if (!on.appId || on.appId !== this.appleUygulama) return null;
    this._oynayan = null;
    return this.appleOynayan();
  }

  /** Apple TV'yi uyutur (kilit bekçisi, kapsam "TV + Apple TV"). */
  async appleUyut() {
    if (!this.appleTvVar()) return;
    await this.atv.iste(this.appletv, 'uyku', {}, 10000);
  }

  /**
   * Ekranın ortasında uyarı penceresi (LG createAlert — köşedeki bildirim satır sonunu yutuyor, bu göstermiyor):
   * `satirlar` alt alta, `sureMs` sonra kapatılır. Pencere açılamazsa köşe bildirimine düşer.
   */
  async uyariGoster(satirlar, sureMs = 5000) {
    const kacir = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let alertId = null;
    try {
      alertId = (await this.iste('ssap://system.notifications/createAlert', { message: satirlar.map(kacir).join('<br>').slice(0, 300), buttons: [{ label: 'Tamam' }] })).alertId || null;
    } catch {
      await this.toast(satirlar.join(' — ')).catch(() => {});
    }
    await sleep(sureMs);
    if (alertId) await this.iste('ssap://system.notifications/closeAlert', { alertId }).catch(() => {});
  }

  /** Apple TV'ye pyatv tuşu ('pause', 'menu' …) — engel bekçisi kullanır. */
  async appleKomut(tus) {
    if (!this.appleTvVar()) throw new HttpHata(409, `${this.ad}: Apple TV bağlı değil`);
    await this.atv.iste(this.appletv, 'tus', { tus });
  }

  appleTvVar() {
    return !!(this.appletv && this.atv && this.atv.hazirMi());
  }

  /** Uygulama kumandası Apple TV girişindeyken: tuş Apple TV'ye (Companion). */
  async appleTus(ad) {
    const tus = ATV_TUSLARI[ad];
    if (!tus) throw new HttpHata(400, `Apple TV'de karşılığı olmayan tuş: ${ad}`);
    if (!this.appleTvVar()) throw new HttpHata(409, `${this.ad}: Apple TV bağlı değil`);
    this.kilitDenetle();   // Apple TV tuşu Apple TV'yi, o da CEC ile TV'yi uyandırır
    await this.atv.iste(this.appletv, 'tus', { tus });
  }

  /** Apple TV'de odaktaki yazı alanına metin (arama kutusu). */
  async appleMetin(metin) {
    if (!this.appleTvVar()) throw new HttpHata(409, `${this.ad}: Apple TV bağlı değil`);
    this.kilitDenetle();
    await this.atv.iste(this.appletv, 'metin', { metin });
  }

  async cozumle(adlar) {
    const liste = await this.kanallar();
    return adlar.map((ad) => {
      const k = kanalBul(liste, ad);
      return { ad, no: k ? k.no : null, kanalAdi: k ? k.ad : null };
    });
  }

  /** Dokunmatik yüzey (kumanda → Ayarlar, 17.10.2026): imleci oynat ya da tıkla. */
  async isaretci({ dx = 0, dy = 0, tikla = false }) {
    const gonder = async () => {
      const k = await this.kumanda();
      if (tikla) k.click(); else k.move(dx, dy);
    };
    try { await gonder(); } catch { this.birak(); await gonder(); }   // soket sessizce düşmüş olabilir
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

  /** Canlı yayında açık kanal — "geri dön" sayacının varsayılan hedefi. */
  async simdikiKanal() {
    const on = await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo');
    if (on.appId !== CANLI_TV) throw new HttpHata(409, `${this.ad} canlı yayında değil — geri dönülecek kanal yok`);
    const c = await this.iste('ssap://tv/getCurrentChannel');
    return { no: Number(c.channelNumber), ad: c.channelName };
  }

  /**
   * Ses düzeyi (Ch / Vol penceresindeki şerit). webOS'ta yanıt iki biçimde gelebiliyor: düz
   * { volume, muted } ya da { volumeStatus: { volume, muteStatus, soundOutput } }. Harici ses çıkışında
   * (soundbar/ARC) düzey -1 döner — o zaman şerit gösterilmez.
   */
  async sesOku() {
    const r = await this.iste('ssap://audio/getVolume');
    const v = r.volumeStatus || r;
    const seviye = Number(v.volume);
    return {
      seviye: Number.isFinite(seviye) && seviye >= 0 ? seviye : null,
      sessiz: !!(v.muteStatus ?? v.muted ?? r.mute),
      cikis: v.soundOutput || r.scenario || null,
    };
  }

  async sesAyarla(seviye) {
    const n = Number(seviye);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpHata(400, 'ses 0-100 arasında tam sayı olmalı');
    await this.iste('ssap://audio/setVolume', { volume: n });
    return { seviye: n };
  }

  /** Ekranı kapat / aç, ses devam eder (17.10.2026, salon webOS 26'da ölçüldü: ~40 ms). webOS < 4.5 eski uç. */
  async ekranAyarla(kapali) {
    const u = kapali ? 'turnOffScreen' : 'turnOnScreen';
    try {
      await this.iste(`ssap://com.webos.service.tvpower/power/${u}`);
    } catch (e) {
      if (!/404|no such/i.test(String(e.message))) throw e;
      await this.iste(`ssap://com.webos.service.tv.power/${u}`);
    }
    return { ekranKapali: !!kapali };
  }

  async toast(mesaj) {
    await this.iste('ssap://system.notifications/createToast', { message: String(mesaj).slice(0, 160) });
  }

  /** Mesajı `sureSn` boyunca ekranda tutar (TV bildirimi ~5 sn'de kapatıyor → yenilenir). Yenisi eskisini keser. */
  async bildirimGoster(mesaj, sureSn) {
    clearInterval(this._bildirimT);
    await this.toast(mesaj);                       // ilki beklenir: TV kapalıysa hata kullanıcıya döner
    const bitis = Date.now() + sureSn * 1000;
    if (sureSn * 1000 <= BILDIRIM_TAZELEME_MS + 500) return;
    this._bildirimT = setInterval(() => {
      if (Date.now() + 1000 >= bitis) { clearInterval(this._bildirimT); return; }
      this.toast(mesaj).catch(() => clearInterval(this._bildirimT));
    }, BILDIRIM_TAZELEME_MS);
    this._bildirimT.unref?.();
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

/**
 * YouTube kesitlerine video kimliği ekler (`k.youtube`). Önbellekte olan hemen; yeniler en çok `butceMs`
 * beklenir, yetişmeyenler arka planda çözülür ve sonraki istekte gelir. Bulunamayan kesit kimliksiz kalır.
 */
export async function youtubeEkle(kesitler, youtube, butceMs = 6000) {
  if (!youtube) return;
  const yt = kesitler.filter((k) => /youtube/i.test(k.uygulama || '') && k.program);
  const sorulacak = new Map();
  for (const k of yt) {
    const v = ayir(k.program);
    const id = youtube.onbellekte(v.baslik, v.kanal);
    if (id) k.youtube = id;
    else if (id === undefined) sorulacak.set(ytAnahtar(v.baslik, v.kanal), v);
  }
  if (!sorulacak.size) return;
  const bulunan = new Map();
  const isler = [...sorulacak].map(([a, v]) => youtube.bul(v).then((id) => { if (id) bulunan.set(a, id); }));
  let zaman;
  await Promise.race([Promise.allSettled(isler), new Promise((r) => { zaman = setTimeout(r, butceMs); })]);
  clearTimeout(zaman);
  for (const k of yt) {
    if (k.youtube) continue;
    const v = ayir(k.program);
    const id = bulunan.get(ytAnahtar(v.baslik, v.kanal));
    if (id) k.youtube = id;
  }
}

export function sunucuKur(tvler, { token = TOKEN, log = console.log, rehber = null, zamanlayici = null, izleme = null, youtube = null, engel = null, kilit = null } = {}) {
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
        json(res, 200, { tvler: durumlar.map((d) => ({ ...d, kilit: kilit?.bilgi(d.id) || null })) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ekran-akis') {
        // Canlı önizleme (kullanıcı, 17.10.2026: "ekran açık olduğu süre boyunca", hız 1 kare/sn).
        // TV başına TEK kare çekim döngüsü; kareler o TV'yi izleyen BÜTÜN bağlantılara dağıtılır. (İlk sürüm
        // "TV başına tek akış" diyordu: iki ekran açıkken akışlar birbirini kesip duruyordu — ölçüldü.)
        // Her izleyici kendi hızını ister (fps); döngü en hızlı isteğe göre çeker, TV'nin sınırı ~2,5 kare/sn.
        const t = tvAl(url.searchParams.get('tv'));
        const sureMs = Math.min(Math.max(Number(url.searchParams.get('sn')) || 120, 5), AKIS_EN_UZUN_SN) * 1000;
        const fps = Math.min(Math.max(Number(url.searchParams.get('fps')) || AKIS_VARSAYILAN_FPS, 0.1), 3);
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=kare', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const izleyici = { res, aralikMs: 1000 / fps, son: 0, bekliyor: false, bitis: Date.now() + sureMs, kare: 0, bayt: 0, bas: Date.now() };
        t.izleyiciler ||= new Set();
        t.izleyiciler.add(izleyici);
        const ayril = () => {
          if (!t.izleyiciler.delete(izleyici)) return;
          const sn = (Date.now() - izleyici.bas) / 1000;
          log(`[tv] ${t.id} canlı önizleme: ${izleyici.kare} kare / ${sn.toFixed(0)} sn (${(izleyici.kare / Math.max(sn, 1)).toFixed(1)} kare/sn), ${(izleyici.bayt / 1e6).toFixed(1)} MB · kalan izleyici ${t.izleyiciler.size}`);
        };
        izleyici.ayril = ayril;
        req.on('close', ayril);
        if (!t.akisDongusu) {
          t.akisDongusu = (async () => {
            while (t.izleyiciler.size) {
              const simdi = Date.now();
              for (const z of [...t.izleyiciler]) if (simdi >= z.bitis) { z.res.end(); z.ayril(); }
              const vadeli = [...t.izleyiciler].filter((z) => simdi - z.son >= z.aralikMs - 50 && !z.bekliyor);
              if (!vadeli.length) {
                const bekle = Math.min(...[...t.izleyiciler].map((z) => Math.max(z.son + z.aralikMs - simdi, 50)), 1000);
                await sleep(Number.isFinite(bekle) ? bekle : 200);
                continue;
              }
              let jpeg;
              try { jpeg = await t.ekran(); } catch { await sleep(1000); continue; }
              const bas = `--kare\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`;
              for (const z of vadeli) {
                if (!t.izleyiciler.has(z)) continue;
                const yazildi = z.res.write(bas) & z.res.write(jpeg) & z.res.write('\r\n');
                z.son = Date.now();
                z.kare++;
                z.bayt += jpeg.length;
                // Yavaş istemci: tampon boşalana kadar ona kare gönderilmez (okunmayan kare birikmez).
                if (!yazildi) { z.bekliyor = true; z.res.once('drain', () => { z.bekliyor = false; }); }
              }
            }
            t.akisDongusu = null;
          })();
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/akis') {
        if (!rehber) throw new HttpHata(503, 'rehber yok');
        const g = await govdeOku(req);
        const saat = Math.min(Math.max(Number(g.saat) || 30, 1), 48);
        const kanallar = await Promise.all(adListesi(g, 20).map(async (ad) => {
          let programlar = [];
          try { programlar = await zamanAsimi(rehber.akis(ad, { saat }), 25000, 'rehber'); } catch { /* yok */ }
          return { ad, programlar };
        }));
        json(res, 200, { simdi: Date.now(), kanallar });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ses') {
        const t = tvAl(url.searchParams.get('tv'));
        json(res, 200, await t.sirayla(() => t.sesOku()));
        return;
      }
      // İzleme geçmişi (kişisel veri: yalnız belirteçle). gun = İstanbul günü (YYYY-MM-DD), gunSayisi 1-31.
      if (req.method === 'GET' && url.pathname === '/izleme') {
        if (!izleme) throw new HttpHata(503, 'izleme kaydı kapalı (TV_AJAN_IZLEME=1)');
        const gun = url.searchParams.get('gun') || trGun(Date.now());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(gun)) throw new HttpHata(400, 'gün YYYY-AA-GG olmalı');
        const gunSayisi = Math.min(Math.max(Number(url.searchParams.get('gunSayisi')) || 1, 1), 31);
        const tv = url.searchParams.get('tv') || null;
        if (tv) tvAl(tv);
        const bit = Date.UTC(...gun.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))) - 3 * 3600e3 + 24 * 3600e3;
        const bas = bit - gunSayisi * 24 * 3600e3;
        const kesitler = await izleme.kesitler({ bas, bit, tv });
        await youtubeEkle(kesitler, youtube);
        json(res, 200, { bas, bit, kesitler, ozet: ozetle(kesitler, { bas, bit }) });
        return;
      }
      // TV kilidi (ebeveyn denetimi): kilitli TV açılamaz, açılırsa kapatılır. dk yoksa/null → süresiz.
      if (url.pathname === '/kilit' || url.pathname === '/kilit/ayar') {
        if (!kilit) throw new HttpHata(503, 'kilit kurulu değil');
        const kilitYaniti = () => ({ ...kilit.durum(), tvler: tvler.map((t) => ({ id: t.id, ad: t.ad })) });
        if (req.method === 'GET') { json(res, 200, kilitYaniti()); return; }
        if (req.method === 'POST' && url.pathname === '/kilit/ayar') {
          await kilit.mesajAyarla((await govdeOku(req)).mesaj);
          log('[kilit] mesaj değişti');
          json(res, 200, { ok: true, ...kilitYaniti() });
          return;
        }
        if (req.method === 'POST') {
          const g = await govdeOku(req);
          const t = tvAl(g.tv);
          await kilit.kilitle(t.id, g.dk ?? null, g.kapsam || (t.appletv ? 'tv+apple' : 'tv'));
          log(`[kilit] ${t.id} kilitlendi (${g.dk ? `${g.dk} dk` : 'süresiz'})`);
          json(res, 200, { ok: true, ...kilitYaniti() });
          return;
        }
        if (req.method === 'DELETE') {
          const t = tvAl(url.searchParams.get('tv'));
          await kilit.ac(t.id);
          log(`[kilit] ${t.id} kilidi açıldı`);
          json(res, 200, { ok: true, ...kilitYaniti() });
          return;
        }
        throw new HttpHata(405, 'yöntem desteklenmiyor');
      }
      // YouTube engelleri (ebeveyn denetimi): kurallar + son engellenenler; ekle/sil/aç-kapat.
      if (url.pathname === '/engel' || url.pathname === '/engel/ayar') {
        if (!engel) throw new HttpHata(503, 'engelleme kurulu değil (Apple TV yok ya da izleme kapalı)');
        if (req.method === 'GET' && url.pathname === '/engel') { json(res, 200, engel.durum()); return; }
        if (req.method === 'DELETE' && url.pathname === '/engel') {
          await engel.sil(String(url.searchParams.get('id') || ''));
          log('[engel] kural silindi');
          json(res, 200, { ok: true, ...engel.durum() });
          return;
        }
        if (req.method === 'POST') {
          const g = await govdeOku(req);
          if (url.pathname === '/engel/ayar') { json(res, 200, { ok: true, ...(await engel.ayarla({ acik: g.acik })) }); return; }
          const { kural, varmis } = await engel.ekle({ metin: g.metin, tur: g.tur || null });
          log(`[engel] kural ${varmis ? 'zaten vardı' : 'eklendi'}: ${kural.tur}`);
          json(res, varmis ? 200 : 201, { ok: true, kural, varmis, ...engel.durum() });
          return;
        }
        throw new HttpHata(405, 'yöntem desteklenmiyor');
      }
      if (req.method === 'GET' && url.pathname === '/zamanlayici') {
        if (!zamanlayici) throw new HttpHata(503, 'zamanlayıcı kurulu değil');
        json(res, 200, zamanlayici.liste());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/zamanlayici') {
        if (!zamanlayici) throw new HttpHata(503, 'zamanlayıcı kurulu değil');
        const g = await govdeOku(req);
        const islem = String(g.islem || '');
        let sonuc;
        if (islem === 'geri-don') {
          const t = tvAl(g.tv);
          const kanal = await t.sirayla(() => t.simdikiKanal());
          sonuc = await zamanlayici.geriDon({ tv: t.id, dk: g.dk, kanal });
        } else if (islem === 'ekle') {
          const t = tvAl(g.tv);
          sonuc = await zamanlayici.ekle({ tv: t.id, kanal: g.kanal, mesaj: g.mesaj ?? null, zaman: g.zaman, tvKapaliysa: g.tvKapaliysa, etiket: g.etiket ?? null });
        } else if (islem === 'uzat') sonuc = await zamanlayici.uzat(g.id, g.dk ?? 1);
        else if (islem === 'sil') sonuc = await zamanlayici.sil(g.id);
        else if (islem === 'etkin') sonuc = await zamanlayici.etkin(g.id, g.acik);
        else if (islem === 'hemen') sonuc = await zamanlayici.hemen(g.id);
        else throw new HttpHata(400, 'bilinmeyen işlem');
        log(`[tv] zamanlayıcı ${islem}${g.tv ? ` ${g.tv}` : ''}${g.id ? ` ${g.id}` : ''}`);
        json(res, 200, { ok: true, sonuc, ...zamanlayici.liste() });
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
          if (g.cihaz === 'apple') {   // uygulama kumandası, Apple TV girişi
            await t.appleTus(tus);
            json(res, 200, { ok: true });
            return;
          }
          await t.sirayla(() => t.tus(tus));
          log(`[tv] ${t.id} tuş ${tus}`);
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/metin') {
          const metin = typeof g.metin === 'string' ? g.metin : '';
          if (metin.length > 100) throw new HttpHata(400, 'metin en çok 100 karakter');
          await t.appleMetin(metin);
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/isaretci') {
          const tikla = g.tikla === true;
          const dx = Number(g.dx ?? 0), dy = Number(g.dy ?? 0);
          if (!tikla && (![dx, dy].every((v) => Number.isInteger(v) && Math.abs(v) <= 2000) || (!dx && !dy))) throw new HttpHata(400, 'dx/dy tam sayı olmalı (en çok ±2000)');
          await t.sirayla(() => t.isaretci({ dx, dy, tikla }));
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
        if (url.pathname === '/ses') {
          json(res, 200, { ok: true, ...(await t.sirayla(() => t.sesAyarla(g.seviye))) });
          return;
        }
        if (url.pathname === '/ekran-guc') {
          const r = await t.sirayla(() => t.ekranAyarla(!!g.kapali));
          log(`[tv] ${t.id} ekran ${r.ekranKapali ? 'kapatıldı' : 'açıldı'}`);
          json(res, 200, { ok: true, ...r });
          return;
        }
        if (url.pathname === '/bildirim') {
          const mesaj = String(g.mesaj || '').trim();
          const sureSn = Number(g.sureSn ?? 5);
          if (!mesaj || mesaj.length > 160) throw new HttpHata(400, 'mesaj 1-160 karakter olmalı');
          if (!Number.isInteger(sureSn) || sureSn < 5 || sureSn > 120) throw new HttpHata(400, 'süre 5-120 sn olmalı');
          await t.bildirimGoster(mesaj, sureSn);
          log(`[tv] ${t.id} bildirim (${sureSn} sn)`);
          json(res, 200, { ok: true });
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
      const kod = Number.isInteger(e?.kod) ? e.kod : 502;   // HttpHata ve ZamanlayiciHata
      if (res.headersSent) { res.end(); return; }
      json(res, kod, { hata: String(e.message || e).slice(0, 200) });
    }
  });
}

function tvleriYukle(rehber, teshisDizini, atv = null) {
  if (!existsSync(TVLER_YOLU)) throw new Error(`TV listesi yok: ${TVLER_YOLU}`);
  const liste = JSON.parse(readFileSync(TVLER_YOLU, 'utf8'));
  const anahtarlar = existsSync(ANAHTAR_YOLU) ? JSON.parse(readFileSync(ANAHTAR_YOLU, 'utf8')) : {};
  return liste.map((t) => {
    if (!/^[a-z0-9-]{1,20}$/.test(t.id || '') || !t.ip) throw new Error(`geçersiz TV kaydı: ${JSON.stringify(t)}`);
    if (t.mac && !MAC_KALIBI.test(t.mac)) throw new Error(`geçersiz MAC (${t.id}): ${t.mac}`);
    if (t.appletv && (!/^[\d.]{7,15}$/.test(t.appletv.ip || '') || !/^[A-Za-z0-9:-]{6,40}$/.test(t.appletv.id || ''))) {
      throw new Error(`geçersiz Apple TV kaydı (${t.id})`);
    }
    if (t.appletv?.giris && !/^com\.webos\.app\.hdmi\d$/.test(t.appletv.giris)) throw new Error(`geçersiz Apple TV girişi (${t.id}): ${t.appletv.giris}`);
    return new Tv(t, anahtarlar[t.ip] || null, { rehber, teshisDizini, log: console.log, atv });
  });
}

// Doğrudan çalıştırıldığında sunucuyu başlat (testler içe aktarınca başlatmaz).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (TOKEN.length < 32) {
    console.error('TV_AJAN_TOKEN tanımlı değil ya da kısa (≥ 32 karakter). Üretmek için: openssl rand -hex 32');
    process.exit(1);
  }
  const rehber = new Rehber({ dizin: DURUM_DIZINI, log: console.log });
  const atv = new AppleTvKopru({ python: PYATV_PYTHON, betik: ATV_YARDIMCI, depo: join(DURUM_DIZINI, 'pyatv.conf'), log: console.log });
  const tvler = tvleriYukle(rehber, join(DURUM_DIZINI, 'teshis'), atv);
  const tvBul = (id) => tvler.find((t) => t.id === id);
  // "Geri dön" + Program görevleri (kullanıcı, 17.10.2026). Görev kanalın gerçekten ekrana geldiğini
  // doğrular (dogrula); "geri dön" TV o arada kapatıldıysa açmaz (tvKapaliysa: atla).
  const zamanlayici = new Zamanlayici({
    dosya: join(DURUM_DIZINI, 'zamanlayici.json'),
    log: console.log,
    calistir: async (g) => {
      const t = tvBul(g.tv);
      if (!t) return { sonuc: 'hata', neden: 'bilinmeyen TV' };
      if (g.mesaj) {   // ekranda mesaj (ör. her gün 22:00 uyku saati) — TV kapalıysa atla, asla açma
        if (!(await t.hazirMi())) return { sonuc: 'atlandi', neden: 'TV kapalıydı' };
        await t.bildirimGoster(g.mesaj.metin, g.mesaj.sureSn);
        return { sonuc: 'ok', neden: 'mesaj gösterildi' };
      }
      if (g.tvKapaliysa === 'atla' && !(await t.hazirMi())) return { sonuc: 'atlandi', neden: 'TV kapalıydı' };
      const hedef = g.kanal.no != null ? { no: g.kanal.no } : { ad: g.kanal.ad };
      const k = await t.sirayla(() => t.kanalAc({ ...hedef, dogrula: true }));
      return { sonuc: 'ok', neden: `${k.no} · ${k.ad}${k.acildi ? ' (TV açılarak)' : ''}` };
    },
    // 1 dk ve 10 sn önce TV'de bildirim (tara Ö-58). TV kapalıysa gösterilecek ekran yok.
    uyar: async (g, sn) => {
      const t = tvBul(g.tv);
      if (!t || !(await t.hazirMi())) return;
      if (g.mesaj) return;
      const ne = g.kanal.ad || `Kanal ${g.kanal.no}`;
      await t.toast(`${sn >= 60 ? `${Math.round(sn / 60)} dk` : `${sn} sn`} sonra ${ne} açılacak${g.tur === 'geri-don' ? ' (geri dön)' : ''}`);
    },
  });
  await zamanlayici.yukle();
  zamanlayici.baslat();
  // İzleme kaydı (kumanda → İzleme geçmişi): yalnız açıkça istenirse — kişisel veri, ajanın durum dizininde kalır.
  let izleme = null;
  let youtube = null;
  if (process.env.TV_AJAN_IZLEME === '1') {
    // İzlenen YouTube videosunun bağlantısı için (Apple TV video kimliği vermiyor) — önbellek izleme dizininde.
    youtube = new YoutubeBulucu({ dizin: join(DURUM_DIZINI, 'izleme'), log: console.log });
    await youtube.yukle();
    izleme = new IzlemeKaydi({ dizin: join(DURUM_DIZINI, 'izleme'), tvler, log: console.log });
    await izleme.yukle();
    izleme.baslat();
    console.log('[izleme] kayıt açık (30 sn\'de bir, 365 gün saklanır)');
  }
  // YouTube engelleri: kurallar durum dizininde; bekçi yalnız kural varken ve TV Apple TV girişindeyken sorar.
  let engel = null;
  if (tvler.some((t) => t.appletv)) {
    engel = new EngelListesi({ dizin: DURUM_DIZINI, log: console.log });
    await engel.yukle();
    const bekci = new EngelBekcisi({ tvler, liste: engel, youtube, log: console.log });
    bekci.baslat();
    console.log(`[engel] bekçi açık (${engel.durum().kurallar.length} kural${engel.veri.acik ? '' : ', engelleme KAPALI'})`);
  }
  // TV kilidi: kilitli TV'ye açma komutu gitmez (Tv.kilitDenetle); kendi kumandasıyla açılırsa bekçi kapatır.
  const kilit = new TvKilidi({ dizin: DURUM_DIZINI, log: console.log });
  await kilit.yukle();
  for (const t of tvler) t.kilit = kilit;
  new KilitBekcisi({ tvler, kilit, log: console.log }).baslat();
  const kilitli = Object.keys(kilit.durum().kilitler);
  console.log(`[kilit] bekçi açık${kilitli.length ? ` · kilitli: ${kilitli.join(', ')}` : ''}`);
  const sunucu = sunucuKur(tvler, { rehber, zamanlayici, izleme, youtube, engel, kilit });
  sunucu.listen(PORT, HOST, () => {
    const ozet = tvler.map((t) => `${t.id}${t.anahtar ? '' : ' (anahtarsız!)'}${t.mac ? '' : ' (MAC yok — açılamaz)'}`).join(', ');
    console.log(`[tv-ajan] ${HOST}:${PORT} dinleniyor · TV'ler: ${ozet} · rehber: ${DURUM_DIZINI}`);
  });
  // Rehberi önceden ısıt: panelin ilk isteği 3,3 MB'lık sayfayı beklemesin. 3 saatte bir tazele.
  const isit = () => rehber.gun(trGunu(Date.now())).catch(() => {});
  isit();
  setInterval(isit, 3 * 60 * 60 * 1000);
  const kapan = () => { zamanlayici.durdur(); izleme?.durdur(); for (const t of tvler) t.birak(); sunucu.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', kapan);
  process.on('SIGINT', kapan);
}
