/**
 * Ayar bekçisi: kapatılan reklam/izleme ayarlarının ve silinen uygulamaların bir yazılım güncellemesiyle
 * sessizce geri gelmesini yakalar (TODO "Ayar bekçisi", 29.10.2026 — Live Plus, ana ekran reklamı, Copilot).
 *  - TV AÇIKSA `aralikMs`'de bir (varsayılan 1 sa) okur: izlenen ayarlar, kullanıcı sözleşmeleri (eulaStatus),
 *    yüklü uygulamalar, yazılım sürümü. TV'yi asla açmaz, ekranda bir şey göstermez, hiçbir şey YAZMAZ.
 *  - Okuma bir öncekiyle karşılaştırılır; fark → olay + `bildir` (Bark). Bir TV'nin ilk okuması yalnız
 *    "son bilinen" olur. Okunamayan değer (500, zaman aşımı) değer sayılmaz: önceki korunur, sahte
 *    "değişti" üretmez — oturma odasında homePromotion genel uca hiç açık değil (500, ölçüldü).
 *  - TV açıkken HİÇBİR şey okunamadıysa bu da olaydır (KURALLAR § 7: "0 sonuç" hatadır) — TV başına günde bir bildirim.
 * Kayıt <dizin>/ayar.json — ajanın durum dizininde.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

/** 29.10.2026'da kapatılan tekil ayarlar. */
export const IZLENEN_AYARLAR = [
  { kategori: 'option', anahtar: 'livePlus', ad: 'Live Plus' },
  { kategori: 'general', anahtar: 'homePromotion', ad: 'Ana ekran reklamı' },
];

// Sözleşme bayrakları: yalnız anlamından emin olunanlara ad verildi; diğerleri bayrak adıyla yazılır.
const SOZLESME_ADLARI = {
  acrOnAllowed: 'Görüntüleme bilgisi',
  voiceAllowed: 'Ses bilgisi',
  marketingOnAllowed: 'Pazarlama',
  shoppingOnAllowed: 'Alışveriş',
};
const EN_COK_OLAY = 200;
const OKUNAMADI_ARASI_MS = 24 * 60 * 60 * 1000;

function anahtarAdi(k) {
  const [kat, ad] = k.split('.');
  if (kat === 'sozlesme') return SOZLESME_ADLARI[ad] ? `${SOZLESME_ADLARI[ad]} sözleşmesi` : `Sözleşme ${ad}`;
  return IZLENEN_AYARLAR.find((a) => `${a.kategori}.${a.anahtar}` === k)?.ad || k;
}
const bicim = (v) => (v === true || v === 'on' ? 'açık' : v === false || v === 'off' ? 'kapalı' : String(v));

/** TV'den bir tur okuma. `okunan` = başarıyla okunan kalem sayısı (ayar, sözleşme, uygulama listesi, sürüm). */
export async function ayarOku(tv, ms = 8000) {
  const degerler = {};
  let okunan = 0;
  for (const a of IZLENEN_AYARLAR) {
    try {
      const v = (await tv.iste('ssap://settings/getSystemSettings', { category: a.kategori, keys: [a.anahtar] }, ms))?.settings?.[a.anahtar];
      if (v != null) { degerler[`${a.kategori}.${a.anahtar}`] = v; okunan++; }
    } catch { /* bu TV'de bu ayar okunamıyor — atla */ }
  }
  try {
    const e = (await tv.iste('ssap://settings/getSystemSettings', { category: '', keys: ['eulaStatus'] }, ms))?.settings?.eulaStatus;
    if (e && typeof e === 'object') {
      for (const [k, v] of Object.entries(e)) if (typeof v === 'boolean') degerler[`sozlesme.${k}`] = v;
      okunan++;
    }
  } catch { /* yok say */ }
  let uygulamalar = null;
  try {
    const l = (await tv.iste('ssap://com.webos.applicationManager/listApps', null, Math.max(ms, 15000)))?.apps;
    if (Array.isArray(l) && l.length) { uygulamalar = Object.fromEntries(l.map((a) => [a.id, a.title || a.id])); okunan++; }
  } catch { /* yok say */ }
  // Sürüm: webOS 26'da getCurrentSWInformation 401 verir, sürüm tv.nyx yapılandırmasında (COZUMLER.md 29.10.2026).
  let surum = null;
  try {
    const r = await tv.iste('ssap://config/getConfigs', { configNames: ['tv.nyx.*'] }, ms);
    surum = (r?.configs || r)?.['tv.nyx.firmwareVersion'] || null;
  } catch { /* eski webOS */ }
  if (!surum) {
    try {
      const s = await tv.iste('ssap://com.webos.service.update/getCurrentSWInformation', null, ms);
      if (s?.major_ver) surum = `${s.major_ver}.${s.minor_ver}`;
    } catch { /* yok say */ }
  }
  if (surum) okunan++;
  return { degerler, uygulamalar, surum, okunan };
}

/** İki okuma arasındaki farklar, okunur cümleler olarak. Yalnız İKİ tarafta da okunmuş değerler karşılaştırılır. */
export function farklar(once, simdi) {
  const f = [];
  for (const [k, v] of Object.entries(simdi.degerler)) {
    if (k in once.degerler && once.degerler[k] !== v) f.push(`${anahtarAdi(k)}: ${bicim(once.degerler[k])} → ${bicim(v)}`);
  }
  if (once.uygulamalar && simdi.uygulamalar) {
    const yeni = Object.keys(simdi.uygulamalar).filter((id) => !(id in once.uygulamalar));
    const giden = Object.keys(once.uygulamalar).filter((id) => !(id in simdi.uygulamalar));
    if (yeni.length) f.push(`yeni uygulama: ${yeni.map((id) => simdi.uygulamalar[id]).join(', ')}`);
    if (giden.length) f.push(`kaldırılan uygulama: ${giden.map((id) => once.uygulamalar[id]).join(', ')}`);
  }
  if (once.surum && simdi.surum && once.surum !== simdi.surum) f.push(`yazılım ${once.surum} → ${simdi.surum}`);
  return f;
}

/**
 * Bark ile bildirim: pi63'teki bark.sh'a anahtar dosyası BARK_ENV olarak verilir (systemd LoadCredential —
 * 5levent/yagmur/pi63 kalıbı). Döner: true yalnız Bark `"code":200` dediyse.
 */
export function barkGonderici({ betik, ayar, log = () => {} }) {
  return (baslik, govde) => new Promise((ok) => {
    execFile(betik, [baslik, govde], { env: { ...process.env, BARK_ENV: ayar }, timeout: 30000 }, (e, cikti = '', hata = '') => {
      const basarili = !e && /"code"\s*:\s*200/.test(cikti);
      if (!basarili) log(`[ayar] Bark gönderilemedi: ${e ? e.message.split('\n')[0] : cikti.trim()}${hata ? ` · ${hata.trim()}` : ''}`);
      ok(basarili);
    });
  });
}

/**
 * TV nesnesinden beklenen: `id`, `ad`, `acikMi()`, `iste(uri, payload, ms)`.
 * `bildir(baslik, govde)` → Promise<boolean>; yoksa olay yalnız kayda (GET /ayar) düşer.
 */
export class AyarBekcisi {
  constructor({ tvler, dizin, bildir = null, aralikMs = 60 * 60 * 1000, ilkMs = 2 * 60 * 1000, istekMs = 8000, oku = ayarOku, simdi = Date.now, log = () => {} }) {
    Object.assign(this, { tvler, dosya: join(dizin, 'ayar.json'), bildir, aralikMs, ilkMs, istekMs, oku, simdi, log });
    this.veri = { tvler: {}, olaylar: [] };
    this.mesgul = new Set();
    this.zamanlayici = null;
    this.yaziliyor = Promise.resolve();
  }

  async yukle() {
    try {
      const j = JSON.parse(await readFile(this.dosya, 'utf8'));
      this.veri = { tvler: j.tvler && typeof j.tvler === 'object' ? j.tvler : {}, olaylar: Array.isArray(j.olaylar) ? j.olaylar : [] };
    } catch { /* yok — ilk okumalar "son bilinen" olur */ }
  }

  baslat() {
    if (this.zamanlayici) return;
    const dongu = async () => {
      await Promise.all(this.tvler.map((tv) => this.denetle(tv).catch((e) => this.log(`[ayar] ${tv.id}: ${e.message}`))));
      this.zamanlayici = setTimeout(dongu, this.aralikMs);
      this.zamanlayici.unref?.();
    };
    this.zamanlayici = setTimeout(dongu, this.ilkMs);   // açılışta TV bağlantıları kurulurken beklesin
    this.zamanlayici.unref?.();
  }

  durdur() { clearTimeout(this.zamanlayici); this.zamanlayici = null; }

  /** Döner: 'kapali' | 'ilk' | 'ayni' | 'degisti' | 'okunamadi' (ya da null — o TV zaten okunuyor). */
  async denetle(tv) {
    if (this.mesgul.has(tv.id)) return null;
    this.mesgul.add(tv.id);
    try {
      if (!(await tv.acikMi())) return 'kapali';
      const yeni = await this.oku(tv, this.istekMs);
      const once = this.veri.tvler[tv.id];
      const zaman = this.simdi();
      if (!yeni.okunan) {
        if (once?.okunamadiBildirim && zaman - once.okunamadiBildirim < OKUNAMADI_ARASI_MS) return 'okunamadi';
        this.veri.tvler[tv.id] = { ...(once || { degerler: {}, uygulamalar: null, surum: null }), okunamadiBildirim: zaman };
        await this._olay(tv, 'okunamadi', ['TV açık ama hiçbir ayar okunamadı — eşleşme izinleri değişmiş olabilir'],
          '⚠️ TV ayar bekçisi okuyamadı', `${tv.ad}: TV açık ama hiçbir ayar okunamadı`);
        return 'okunamadi';
      }
      const kayit = {
        zaman,
        degerler: { ...(once?.degerler || {}), ...yeni.degerler },
        uygulamalar: yeni.uygulamalar || once?.uygulamalar || null,
        surum: yeni.surum || once?.surum || null,
      };
      this.veri.tvler[tv.id] = kayit;
      if (!once?.zaman) {   // hiç okunmamış (yalnız "okunamadı" kaydı olabilir)
        this.log(`[ayar] ${tv.id}: ilk okuma (${Object.keys(yeni.degerler).length} değer, ${Object.keys(yeni.uygulamalar || {}).length} uygulama, sürüm ${yeni.surum || '?'})`);
        await this._kaydet();
        return 'ilk';
      }
      const f = farklar(once, yeni);
      if (!f.length) { await this._kaydet(); return 'ayni'; }
      this.log(`[ayar] ${tv.id} değişti: ${f.join(' · ')}`);
      await this._olay(tv, 'degisti', f, '⚙️ TV ayarı değişti', `${tv.ad}: ${f.join(' · ')}`);
      return 'degisti';
    } finally {
      this.mesgul.delete(tv.id);
    }
  }

  durum() {
    const tvler = {};
    for (const [id, k] of Object.entries(this.veri.tvler)) {
      tvler[id] = { zaman: k.zaman || null, surum: k.surum, degerler: k.degerler, uygulamaSayisi: Object.keys(k.uygulamalar || {}).length };
    }
    return { tvler, olaylar: this.veri.olaylar.slice(-50).reverse(), bildirim: !!this.bildir };
  }

  async _olay(tv, ne, ayrinti, baslik, govde) {
    const o = { id: randomUUID().slice(0, 8), zaman: this.simdi(), tv: tv.id, ne, ayrinti, bildirildi: false };
    if (this.bildir) o.bildirildi = await this.bildir(baslik, govde).catch(() => false);
    this.veri.olaylar.push(o);
    if (this.veri.olaylar.length > EN_COK_OLAY) this.veri.olaylar.splice(0, this.veri.olaylar.length - EN_COK_OLAY);
    await this._kaydet();
  }

  _kaydet() {
    const metin = JSON.stringify(this.veri);
    this.yaziliyor = this.yaziliyor.then(async () => {
      await writeFile(`${this.dosya}.tmp`, metin);
      await rename(`${this.dosya}.tmp`, this.dosya);
    }).catch((e) => this.log(`[ayar] yazılamadı: ${e.message}`));
    return this.yaziliyor;
  }
}
