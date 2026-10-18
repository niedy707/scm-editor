/**
 * Netflix başlığı TV ekranından: Apple TV'nin "şu an oynayan" bilgisinde Netflix başlık/bölüm/süre VERMİYOR
 * (yalnız uygulama + oynuyor/duraklatıldı — ölçüldü, 18.10.2026), ama oynatıcı görünürken (duraklatınca,
 * oynatma başında) ekranda yazıyor: sağ üstte "Dizi adı" + "S1: B1 “Bölüm adı”", sol üstte "SEÇENEKLER",
 * altta geçen ve kalan süre. TV ekran görüntüsü tools/ekran-yazi.py (Tesseract) ile okunur.
 *
 * OCR toleransı (ölçülen okumalar): "S" → "$"/"5", "B" → "8", "1. Bölüm" → "1, Bolum". Köşe bildirimi başlığın
 * üstüne binebiliyor → bir başlık ancak İKİ ayrı okumada aynı çıkarsa kabul edilir.
 */
import { spawn } from 'node:child_process';

const SURE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g;
const sn = (m) => (m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]));
const tirnak = /[“”"„«»]/g;

/** OCR bölgelerinden { baslik, sezon?, bolum?, bolumAdi?, gecenSn?, kalanSn? } ya da null (oynatıcı görünmüyor). */
export function netflixAyikla({ sag_ust: sag = [], sol_ust: sol = [], alt = [] } = {}) {
  const isaret = sol.some((s) => /se[cç]enek|options/i.test(s));
  let sezon = null;
  let bolum = null;
  let bolumAdi = null;
  let i = sag.findIndex((s) => /^[S$5]\s?\d{1,2}\s*[:;.]\s*[B8]\s?\d{1,3}\b/.test(s));
  if (i >= 0) {
    const m = /^[S$5]\s?(\d{1,2})\s*[:;.]\s*[B8]\s?(\d{1,3})\s*(.*)$/.exec(sag[i]);
    sezon = Number(m[1]);
    bolum = Number(m[2]);
    bolumAdi = m[3].replace(tirnak, '').replace(/^(\d+),\s/, '$1. ').trim() || null;
  }
  if (i < 0 && !isaret) return null;            // ne bölüm satırı ne oynatıcı işareti: oynatıcı ekranda değil
  const baslikSatiri = i > 0 ? sag[i - 1] : (i < 0 ? sag[0] : null);
  const baslik = baslikSatiri ? baslikSatiri.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}!?.)]+$/gu, '').trim() : '';
  if (!baslik || baslik.length > 70) return null;
  const sureler = [...alt.join(' ').matchAll(SURE)];
  const r = { baslik, sezon, bolum, bolumAdi };
  if (sureler.length >= 2) { r.gecenSn = sn(sureler[0]); r.kalanSn = sn(sureler[sureler.length - 1]); }
  return r;
}

/** Aynı içerik mi (iki okumanın tutması için): başlık + sezon + bölüm. */
export const ayniOkuma = (a, b) => !!a && !!b && a.baslik.toLocaleLowerCase('tr') === b.baslik.toLocaleLowerCase('tr') && a.sezon === b.sezon && a.bolum === b.bolum;

/** ekran-yazi.py'yi çalıştırır: JPEG stdin'den, bölgeler JSON stdout'tan. */
export function ekranYazisi(jpeg, { python = 'python3', betik, zamanAsimiMs = 45000 } = {}) {
  return new Promise((ok, red) => {
    const c = spawn(python, ['-I', betik, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let cikti = '';
    let hata = '';
    const t = setTimeout(() => { c.kill('SIGKILL'); red(new Error('ekran yazısı zaman aşımı')); }, zamanAsimiMs);
    c.stdout.on('data', (d) => { cikti += d; });
    c.stderr.on('data', (d) => { hata += d; });
    c.on('error', (e) => { clearTimeout(t); red(e); });
    c.on('close', (kod) => {
      clearTimeout(t);
      if (kod !== 0) return red(new Error(`ekran-yazi.py çıkış ${kod}: ${hata.trim().split('\n').pop() || ''}`));
      try { ok(JSON.parse(cikti)); } catch (e) { red(e); }
    });
    c.stdin.end(jpeg);
  });
}

/**
 * TV başına Netflix okuyucu. `tazele(oynayan)` her "şu an oynayan" sorgusunda çağrılır: gerekiyorsa arka planda
 * ekranı okutur (beklemez); bilinen başlığı oynayana işler (dizi/sezon/bolum/baslik, konum/sure).
 *  - Duraklatılmışken oynatıcı ekranda: başlık yoksa 8 sn'de bir, varsa 2 dk'da bir (bölüm değişmiş olabilir).
 *  - Oynarken: başlık yoksa 45 sn'de bir (oynatma başında oynatıcı görünür); varsa okunmaz.
 *  - Netflix'ten çıkılınca ya da oynayanın `hash`'i değişince bilinen başlık düşer (yeni içerik).
 */
export class NetflixOkuyucu {
  constructor({ ekranAl, oku, simdi = Date.now, log = () => {} }) {
    Object.assign(this, { ekranAl, oku, simdi, log });
    this.bilinen = null;   // { ...okuma, zaman, hash }
    this.aday = null;
    this.hash = null;
    this.sonDeneme = 0;
    this.calisiyor = false;
  }

  tazele(o) {
    if (!o || !/netflix/i.test(o.uygulama || '')) { this.sifirla(); return o; }
    if (o.baslik) return o;   // uygulama başlığı kendisi veriyorsa ekrana gerek yok
    if (o.hash && this.hash && o.hash !== this.hash) { this.bilinen = null; this.aday = null; }
    if (o.hash) this.hash = o.hash;
    const simdi = this.simdi();
    const duraklatildi = o.durum === 'paused';
    const ara = this.bilinen ? (duraklatildi ? 120000 : Infinity) : (duraklatildi ? 8000 : 45000);
    if (!this.calisiyor && simdi - this.sonDeneme >= ara) this._oku();
    return this.bilinen ? this.uygula(o) : o;
  }

  sifirla() { this.bilinen = null; this.aday = null; this.hash = null; }

  uygula(o) {
    const b = this.bilinen;
    const r = { ...o, ekrandan: true };
    if (b.sezon != null) { r.dizi = b.baslik; r.sezon = b.sezon; r.bolum = b.bolum; r.baslik = b.bolumAdi || `${b.bolum}. bölüm`; } else r.baslik = b.baslik;
    if (b.gecenSn != null && b.kalanSn != null) {
      const gecen = b.gecenSn + (o.durum === 'playing' ? (this.simdi() - b.zaman) / 1000 : 0);
      r.sure = b.gecenSn + b.kalanSn;
      r.konum = Math.min(Math.round(gecen), r.sure);
    }
    return r;
  }

  async _oku() {
    this.calisiyor = true;
    this.sonDeneme = this.simdi();
    try {
      const okuma = netflixAyikla(await this.oku(await this.ekranAl()));
      if (!okuma) return;
      if (ayniOkuma(okuma, this.aday) || ayniOkuma(okuma, this.bilinen)) {
        if (!ayniOkuma(okuma, this.bilinen)) this.log(`[netflix] ekrandan okundu: ${okuma.baslik}${okuma.sezon != null ? ` S${okuma.sezon}B${okuma.bolum}` : ''}`);
        this.bilinen = { ...okuma, zaman: this.simdi() };
        this.aday = null;
      } else {
        this.aday = okuma;
        this.sonDeneme -= 6000;   // teyit için kısa süre sonra yeniden oku
      }
    } catch (e) {
      this.log(`[netflix] ekran okunamadı: ${e.message}`);
    } finally {
      this.calisiyor = false;
    }
  }
}
