/**
 * TV kilidi (ebeveyn denetimi): kilitli TV açılamaz.
 *  - Kumandanın ve zamanlayıcının açma komutları hiç uygulanmaz (Tv.kilitDenetle → 423).
 *  - TV kendi kumandasıyla (ya da Apple TV'nin CEC'iyle) açılırsa bekçi birkaç saniye içinde görür: ekranda
 *    "🔒 Bu TV şu an kilitli" yazar ve TV'yi kapatır. Her deneme olay olarak kaydedilir (panel telefona bildirir).
 * Kilit süreli (`bitis`, ms) ya da süresiz (`bitis: null`); süre dolunca kendiliğinden kalkar.
 * Kayıt <dizin>/kilit.json — ajanın durum dizininde, kişisel veri.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const KILIT_MESAJI = '🔒 Bu TV şu an kilitli';
const EN_COK_DK = 30 * 24 * 60;
const EN_COK_OLAY = 200;

export class KilitHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

export class TvKilidi {
  constructor({ dizin, simdi = Date.now, log = () => {} }) {
    Object.assign(this, { dosya: join(dizin, 'kilit.json'), simdi, log });
    this.veri = { kilitler: {}, olaylar: [] };
    this.yaziliyor = Promise.resolve();
  }

  async yukle() {
    try {
      const j = JSON.parse(await readFile(this.dosya, 'utf8'));
      this.veri = { kilitler: j.kilitler && typeof j.kilitler === 'object' ? j.kilitler : {}, olaylar: Array.isArray(j.olaylar) ? j.olaylar : [] };
    } catch { /* yok — kilit yok */ }
  }

  /** TV kilitliyse { bitis, zaman }, değilse null. Süresi dolan kilit burada kalkar. */
  bilgi(tvId) {
    const k = this.veri.kilitler[tvId];
    if (!k) return null;
    if (k.bitis != null && k.bitis <= this.simdi()) {
      delete this.veri.kilitler[tvId];
      this.log(`[kilit] ${tvId}: süre doldu, kilit kalktı`);
      this._kaydet();
      return null;
    }
    return k;
  }

  durum() {
    const kilitler = {};
    for (const id of Object.keys(this.veri.kilitler)) { const k = this.bilgi(id); if (k) kilitler[id] = k; }
    return { kilitler, olaylar: this.veri.olaylar.slice(-50).reverse() };
  }

  /** `dk` null → süresiz; aksi halde 1 dk – 30 gün. */
  async kilitle(tvId, dk = null) {
    if (dk != null && !(Number.isInteger(dk) && dk >= 1 && dk <= EN_COK_DK)) throw new KilitHata(400, `süre 1 dk – ${EN_COK_DK / 1440} gün ya da süresiz olmalı`);
    const zaman = this.simdi();
    this.veri.kilitler[tvId] = { bitis: dk == null ? null : zaman + dk * 60000, zaman };
    await this._kaydet();
    return this.veri.kilitler[tvId];
  }

  async ac(tvId) {
    delete this.veri.kilitler[tvId];
    await this._kaydet();
  }

  async olayEkle(olay) {
    this.veri.olaylar.push({ id: randomUUID().slice(0, 8), zaman: this.simdi(), ...olay });
    if (this.veri.olaylar.length > EN_COK_OLAY) this.veri.olaylar = this.veri.olaylar.slice(-EN_COK_OLAY);
    await this._kaydet();
  }

  _kaydet() {
    const metin = JSON.stringify(this.veri);
    this.yaziliyor = this.yaziliyor.then(async () => {
      await writeFile(`${this.dosya}.tmp`, metin);
      await rename(`${this.dosya}.tmp`, this.dosya);
    }).catch((e) => this.log(`[kilit] yazılamadı: ${e.message}`));
    return this.yaziliyor;
  }
}

/**
 * Bekçi: her `aralikMs`'de yalnız KİLİTLİ TV'lere "açık mısın" diye sorar; açıksa uyarı + kapat.
 * TV nesnesinden beklenen: `acikMi()`, `toast(mesaj)`, `kapat()`.
 */
export class KilitBekcisi {
  constructor({ tvler, kilit, aralikMs = 3000, bekle = (ms) => new Promise((r) => setTimeout(r, ms)), simdi = Date.now, log = () => {} }) {
    Object.assign(this, { tvler, kilit, aralikMs, bekle, simdi, log });
    this.mesgul = new Set();
    this.zamanlayici = null;
  }

  baslat() {
    if (this.zamanlayici) return;
    const dongu = async () => {
      await Promise.all(this.tvler.map((tv) => this.denetle(tv).catch(() => {})));
      this.zamanlayici = setTimeout(dongu, this.aralikMs);
      this.zamanlayici.unref?.();
    };
    dongu();
  }

  durdur() { clearTimeout(this.zamanlayici); this.zamanlayici = null; }

  /** Kilitli ve açıksa kapatır; ne yapıldığını döner ('kapatildi' | 'kapali' | null = kilitli değil). */
  async denetle(tv) {
    if (!this.kilit.bilgi(tv.id) || this.mesgul.has(tv.id)) return null;
    this.mesgul.add(tv.id);
    try {
      if (!(await tv.acikMi())) return 'kapali';
      this.log(`[kilit] ${tv.id} kilitliyken açıldı — kapatılıyor`);
      await tv.toast(KILIT_MESAJI).catch(() => {});
      await this.bekle(2000);   // mesaj okunsun
      try { await tv.kapat(); } catch (e) { this.log(`[kilit] ${tv.id} kapatılamadı: ${e.message}`); }
      await this.kilit.olayEkle({ tv: tv.id, ne: 'kapatildi' });
      await this.bekle(4000);   // kapanma sürerken yeniden "açık" görüp ikinci kez kapatmasın
      return 'kapatildi';
    } finally {
      this.mesgul.delete(tv.id);
    }
  }
}
