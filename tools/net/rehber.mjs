/**
 * Yayın akışı (EPG) — "şu an ne var" bilgisini TV'den değil, yayın rehberinden alır.
 *
 * NEDEN TV'DEN DEĞİL: 55SM8000PLA başka kanallar için ertesi günün akışını veriyor, salon
 * TV'si (webOS 26) canlı yayında değilken hiç vermiyor (ölçüldü, 15.10.2026 — COZUMLER.md).
 * Rehber kanala bağlı; TV kapalıyken de çalışır.
 *
 * KAYNAKLAR (yöntem açık kaynak iptv-org/epg yapılandırmalarından öğrenildi, kod yazıldı):
 *   1. digiturk.com.tr — günün TÜM kanallarını tek HTML sayfasında verir (~3,3 MB). Asıl kaynak.
 *      Türkiye'deki bir bağlantıdan çalışıyor; veri merkezi IP'sine (VPS) 403 dönüyor → ev
 *      ağındaki ajan (pi63) çeker.
 *   2. tvplus.com.tr — kanal başına JSON. Yedek. ⚠️ 16.10.2026'da evden denenemedi (ölçülen
 *      ağda sunucuya bağlantı kurulamadı); ilk gerçek çalışmada doğrulanmalı.
 *
 * Saatler İstanbul saatidir (UTC+3, yaz saati yok — 2016'dan beri sabit).
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { anaAd } from './kanal-bul.mjs';

const TR_OFSET_MS = 3 * 60 * 60 * 1000;
const GUN_MS = 24 * 60 * 60 * 1000;
const TAZELIK_MS = 6 * 60 * 60 * 1000;   // bir günün sayfası en çok 6 saatte bir yeniden çekilir
const HATA_BEKLEME_MS = 15 * 60 * 1000;  // başarısız çekişten sonra 3,3 MB'ı hemen yeniden isteme
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** tvplus kanal kimlikleri (iptv-org/epg `tvplus.com.tr.channels.xml`). Anahtar: anaAd. */
export const TVPLUS_KIMLIK = { KANALD: '88', STAR: '89', SHOW: '130', HABERTURK: '87', CNNTURK: '158' };

/** İstanbul takvim günü: { y, m, d } ve ISO anahtarı. */
export function trGunu(ms) {
  const t = new Date(ms + TR_OFSET_MS);
  const g = { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  g.anahtar = `${g.y}-${String(g.m).padStart(2, '0')}-${String(g.d).padStart(2, '0')}`;
  return g;
}

const trAn = (g, saat, dakika) => Date.UTC(g.y, g.m - 1, g.d, saat, dakika) - TR_OFSET_MS;

function varlikCoz(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * digiturk günlük rehber sayfası → Map(anaAd → { ad, programlar: [{ ad, bas, bit }] }).
 * Sayfa sırası zaman sırasıdır; bir program öncekinden erken saatte başlıyorsa gece yarısı geçilmiştir.
 */
export function digiturkAyristir(html, gun) {
  const sonuc = new Map();
  const bloklar = String(html).split(/class="[^"]*\bchannelContent\b[^"]*"/).slice(1);
  for (const b of bloklar) {
    const adM = /id="channelID"[^>]*value="([^"]*)"/.exec(b) || /value="([^"]*)"[^>]*id="channelID"/.exec(b);
    if (!adM) continue;
    const kanalAdi = varlikCoz(adM[1]);
    const programlar = [];
    let gunEk = 0;
    let onceki = -1;
    for (const p of b.split(/class="[^"]*\bchannelDetail\b[^"]*"/).slice(1)) {
      const saat = /time-hour">\s*(\d{1,2}):(\d{2})\s*</.exec(p);
      const sure = /totalMinute">[^<\d]*(\d+)\s*dk/i.exec(p);
      const baslik = /wholeDates-title"[^>]*title="([^"]*)"/.exec(p) || /wholeDates-title"[^>]*>([^<]*)</.exec(p);
      if (!saat || !sure || !baslik) continue;
      const dk = Number(saat[1]) * 60 + Number(saat[2]);
      if (dk < onceki) gunEk++;
      onceki = dk;
      const bas = trAn(gun, 0, 0) + gunEk * GUN_MS + dk * 60000;
      programlar.push({ ad: varlikCoz(baslik[1]), bas, bit: bas + Number(sure[1]) * 60000 });
    }
    if (!programlar.length) continue;
    const anahtar = anaAd(kanalAdi);
    if (!sonuc.has(anahtar)) sonuc.set(anahtar, { ad: kanalAdi, programlar });
  }
  return sonuc;
}

/** tvplus PlayBillList yanıtı → [{ ad, bas, bit }]. Saat biçimi: "2026-10-16 20:00:00 UTC+03:00". */
export function tvplusAyristir(json) {
  const liste = (json && Array.isArray(json.playbilllist)) ? json.playbilllist : [];
  const zaman = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC([+-])(\d{2}):?(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const ofset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60000;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - ofset;
  };
  return liste
    .map((p) => ({ ad: varlikCoz(p.name || ''), bas: zaman(p.starttime), bit: zaman(p.endtime) }))
    .filter((p) => p.ad && p.bas != null && p.bit != null && p.bit > p.bas)
    .sort((a, b) => a.bas - b.bas);
}

/** Şu an süren program ve sonraki. Saatler ekran için İstanbul saatiyle biçimlenir. */
export function simdiSonraki(programlar, an = Date.now()) {
  const p = [...(programlar || [])].sort((a, b) => a.bas - b.bas);
  const saat = (ms) => { const t = new Date(ms + TR_OFSET_MS); return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`; };
  const bicim = (x) => (x ? { ad: x.ad, bas: saat(x.bas), bit: saat(x.bit), bitis: x.bit } : null);
  const i = p.findIndex((x) => x.bas <= an && an < x.bit);
  if (i >= 0) return { simdi: bicim(p[i]), sonraki: bicim(p[i + 1]) };
  return { simdi: null, sonraki: bicim(p.find((x) => x.bas > an)) };
}

/**
 * Rehber: günlük digiturk sayfalarını çeker, ayrıştırılmış hâlini diskte saklar (yeniden
 * başlatmada 3,3 MB'ı tekrar indirmemek için), kanal adıyla sorgulanır.
 */
export class Rehber {
  constructor({ dizin, fetchFn = globalThis.fetch, log = () => {}, simdi = () => Date.now() } = {}) {
    this.dizin = dizin;
    this.fetchFn = fetchFn;
    this.log = log;
    this.simdi = simdi;
    this.gunler = new Map();      // anahtar → { zaman, kanallar: Map }
    this.suren = new Map();       // anahtar → yükleme sözü (aynı gün iki kez çekilmesin)
    this.hatalar = new Map();     // anahtar → { zaman, hata } — kısa süre yeniden denenmez
    this.tvplusOnbellek = new Map();
    this.tvplusHata = -Infinity;  // tvplus ulaşılamazsa 15 dk denenmez (her istekte 10 sn beklenmesin)
  }

  async _diskOku(g) {
    if (!this.dizin) return null;
    try {
      const j = JSON.parse(await readFile(join(this.dizin, `digiturk-${g.anahtar}.json`), 'utf8'));
      return { zaman: j.zaman, kanallar: new Map(j.kanallar) };
    } catch { return null; }
  }

  async _diskYaz(g, kayit) {
    if (!this.dizin) return;
    try {
      await mkdir(this.dizin, { recursive: true });
      const yol = join(this.dizin, `digiturk-${g.anahtar}.json`);
      await writeFile(yol + '.tmp', JSON.stringify({ zaman: kayit.zaman, kanallar: [...kayit.kanallar] }));
      await rename(yol + '.tmp', yol);
    } catch (e) { this.log(`[rehber] diske yazılamadı: ${e.message}`); }
  }

  async _digiturkCek(g) {
    const gunStr = `${String(g.m).padStart(2, '0')}/${String(g.d).padStart(2, '0')}/${g.y}`;
    const url = `https://www.digiturk.com.tr/Ajax/GetTvGuideFromDigiturk?Day=${encodeURIComponent(gunStr)}+00%3A00%3A00`;
    const r = await this.fetchFn(url, { headers: { 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`digiturk HTTP ${r.status}`);
    const kanallar = digiturkAyristir(await r.text(), g);
    // Sözleşme: sayfa geldi ama hiç kanal çıkmadıysa biçim değişmiştir — sessizce boş dönme.
    if (kanallar.size < 10) throw new Error(`digiturk sayfasından yalnız ${kanallar.size} kanal çıktı (biçim değişmiş olabilir)`);
    return kanallar;
  }

  /**
   * Bir günün digiturk verisi (bellek → disk → ağ).
   * `agdan: false` — yalnız önbellek. digiturk GEÇMİŞ günler için boş sayfa döndürüyor (ölçüldü:
   * dünün sayfası 0 kanal); dün ancak dün çekilip diske yazılmışsa vardır.
   */
  async gun(g, { agdan = true } = {}) {
    const simdi = this.simdi();
    let bellek = this.gunler.get(g.anahtar);
    if (!bellek) {
      const disk = await this._diskOku(g);
      if (disk) { this.gunler.set(g.anahtar, disk); bellek = disk; }
    }
    if (bellek && (simdi - bellek.zaman < TAZELIK_MS || !agdan)) return bellek.kanallar;
    if (!agdan) return new Map();
    const h = this.hatalar.get(g.anahtar);
    if (h && simdi - h.zaman < HATA_BEKLEME_MS) {
      if (bellek) return bellek.kanallar;
      throw h.hata;
    }
    if (!this.suren.has(g.anahtar)) {
      const soz = this._digiturkCek(g)
        .then(async (kanallar) => {
          this.hatalar.delete(g.anahtar);
          const kayit = { zaman: this.simdi(), kanallar };
          this.gunler.set(g.anahtar, kayit);
          await this._diskYaz(g, kayit);
          this.log(`[rehber] digiturk ${g.anahtar}: ${kanallar.size} kanal`);
          return kanallar;
        })
        .finally(() => this.suren.delete(g.anahtar));
      this.suren.set(g.anahtar, soz);
    }
    try {
      return await this.suren.get(g.anahtar);
    } catch (e) {
      if (!this.hatalar.has(g.anahtar)) this.log(`[rehber] ${g.anahtar}: ${e.message}`);
      this.hatalar.set(g.anahtar, { zaman: this.simdi(), hata: e });
      // Ağ hatasında bayat veri boş veriden iyidir.
      const eski = this.gunler.get(g.anahtar);
      if (eski) return eski.kanallar;
      throw e;
    }
  }

  async _tvplus(anahtar, g) {
    const kimlik = TVPLUS_KIMLIK[anahtar];
    if (!kimlik) return [];
    const ok = `${kimlik}:${g.anahtar}`;
    const o = this.tvplusOnbellek.get(ok);
    if (o && this.simdi() - o.zaman < TAZELIK_MS) return o.programlar;
    const taban = 'https://izmaottvsc14.tvplus.com.tr:33207/EPG/JSON';
    const kimlikR = await this.fetchFn(`${taban}/Authenticate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ terminaltype: 'webtv', terminalvendor: UA, osversion: 'Win32', userType: '3', utcEnable: '1', timezone: 'Europe/Istanbul' }),
    });
    const cerez = (kimlikR.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    const z = (ms) => { const t = new Date(ms + TR_OFSET_MS); const p = (n) => String(n).padStart(2, '0'); return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}00`; };
    const bas = trAn(g, 0, 0);
    const r = await this.fetchFn(`${taban}/PlayBillList`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cerez }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ type: '2', channelid: kimlik, begintime: z(bas), endtime: z(bas + GUN_MS), isFillProgram: 1 }),
    });
    if (!r.ok) throw new Error(`tvplus HTTP ${r.status}`);
    const programlar = tvplusAyristir(await r.json());
    this.tvplusOnbellek.set(ok, { zaman: this.simdi(), programlar });
    return programlar;
  }

  /**
   * Kanal adına göre şu an/sonraki. Dün de istenir: gece yarısından sonra hâlâ süren program
   * dünün sayfasındadır.
   * @returns {{ simdi, sonraki, kaynak } | null}
   */
  async kanal(ad) {
    const anahtar = anaAd(ad);
    if (!anahtar) return null;
    const an = this.simdi();
    const bugun = trGunu(an);
    const dun = trGunu(an - GUN_MS);
    let programlar = [];
    // Her gün ayrı: dünün eksikliği bugünü engellemesin. Dün yalnız önbellekten (yukarıya bkz.).
    for (const [g, agdan] of [[dun, false], [bugun, true]]) {
      try {
        const k = (await this.gun(g, { agdan })).get(anahtar);
        if (k) programlar = programlar.concat(k.programlar);
      } catch { /* digiturk yok → tvplus denenir */ }
    }
    let sec = simdiSonraki(programlar, an);
    if (sec.simdi) return { ...sec, kaynak: 'digiturk' };
    if (TVPLUS_KIMLIK[anahtar] && an - this.tvplusHata >= HATA_BEKLEME_MS) {
      try {
        const tp = await this._tvplus(anahtar, bugun);
        const s2 = simdiSonraki(tp, an);
        if (s2.simdi) return { ...s2, kaynak: 'tvplus' };
      } catch (e) {
        this.tvplusHata = an;
        this.log(`[rehber] tvplus: ${e.message}`);
      }
    }
    return sec.sonraki ? { ...sec, kaynak: 'digiturk' } : null;
  }
}
