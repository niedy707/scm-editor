/**
 * Netflix izleme geçmişinden başlık — izleme kaydında başlığı EKSİK kalan Netflix kesitlerini doldurur.
 *
 * Apple TV Netflix'te başlık vermiyor; ekran okuma (netflix-ekran.mjs) yalnız oynatıcı görünürken çalışıyor.
 * Netflix'in profil "izleme etkinliği" (belgelenmemiş aui `viewingActivity` ucu — Universal Trakt Scrobbler'ın
 * kullandığı, 2026'da çalışıyor) dizi/bölüm adını ve SON izleme anını (dk duyarlıkla) verir; oturum çerezleri
 * ajanın durum dizininde `netflix.cerez` (kullanıcı tools/tv-ajan/netflix-cerez.sh ile koyar; kod okumaz/yazdırmaz).
 *  - Çerezin oturumundaki ETKİN profil okunur (başka profilin guid'i boş liste döndürüyor — ölçüldü 18.10.2026).
 *  - Liste tarihe göre sıralı gelmiyor (ölçüldü) → birkaç sayfa alınıp sıralanır.
 *  - Sorgu yalnız Netflix izlenirken/izlendiyse ve başlık eksikse (kullanıcı, 18.10.2026): ilk kontrol hemen; veri
 *    yoksa 15 dk sonra, yine yoksa 30 dk sonra, sonra 60 dk'da bir. Başlık bulununca sıra sıfırlanır. İki sorgu
 *    arası en az 10 dk (sık duraklat/devam sorgu yağdırmasın) — kayıt gecikmeli
 *    düşebilir; kesit bitişinden `vazgecMs` sonra hâlâ yoksa bırakılır. Netflix kullanım koşulları otomatik erişimi
 *    yasaklıyor: seyrek tutulur (kullanıcı riski kabul etti).
 */
import { readFile, stat } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const YONLENDIRME = '{"path":"/nq/aui/endpoint/%5E1.0.0-web/pathEvaluator","control_tag":"auinqweb"}';

/** Geçmiş kaydı → { zaman, dizi, sezon, bolumAdi, baslik } */
export function ogeyiCoz(o) {
  const sezon = Number(/(\d+)/.exec(o.seasonDescriptor || '')?.[1]) || null;
  return o.seriesTitle
    ? { zaman: o.date, dizi: o.seriesTitle, sezon, bolumAdi: o.episodeTitle || o.title || null, baslik: null }
    : { zaman: o.date, dizi: null, sezon: null, bolumAdi: null, baslik: o.title || null };
}

/** İzleme kaydındaki program metni (kesitAnahtari ile aynı biçim): "Dizi S2 — Bölüm" ya da "Film". */
export const programMetni = (g) => (g.dizi ? `${g.dizi}${g.sezon ? ` S${g.sezon}` : ''}${g.bolumAdi ? ` — ${g.bolumAdi}` : ''}` : g.baslik);

/**
 * Kesitin süresine düşen geçmiş kayıtları (son izleme anı kesit içinde, ufak payla) → program metni ya da null.
 * Bir kesitte birden çok bölüm izlendiyse aynı dizinin bölümleri " · " ile birleştirilir.
 */
export function eslestir(kesit, gecmis, { oncePay = 2 * 60000, sonraPay = 20 * 60000 } = {}) {
  const uygun = gecmis.filter((g) => g.zaman >= kesit.bas - oncePay && g.zaman <= kesit.bit + sonraPay).sort((a, b) => a.zaman - b.zaman);
  if (!uygun.length) return null;
  const metinler = [...new Set(uygun.map(programMetni).filter(Boolean))];
  const diziler = new Set(uygun.map((g) => g.dizi));
  if (diziler.size === 1 && uygun[0].dizi && metinler.length > 1) {
    const g = uygun[0];
    return `${g.dizi}${g.sezon ? ` S${g.sezon}` : ''} — ${[...new Set(uygun.map((x) => x.bolumAdi).filter(Boolean))].join(' · ')}`;
  }
  return metinler.join(' · ') || null;
}

export class NetflixGecmisi {
  constructor({ cerezDosyasi, getir = fetch, log = () => {} }) {
    Object.assign(this, { cerezDosyasi, getir, log });
    this.gecersizMtime = null;   // geçersiz bulunan çerez dosyası değişmedikçe yeniden denenmez
  }

  async _cerez() {
    let m;
    try { m = (await stat(this.cerezDosyasi)).mtimeMs; } catch { return null; }
    if (this.gecersizMtime === m) return null;
    const satirlar = (await readFile(this.cerezDosyasi, 'utf8')).trim().split('\n');
    const d = Object.fromEntries(satirlar.map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
    if (!d.NETFLIX_ID || !d.SECURE_NETFLIX_ID) return null;
    return { baslik: `NetflixId=${d.NETFLIX_ID}; SecureNetflixId=${d.SECURE_NETFLIX_ID}`, mtime: m };
  }

  /** Etkin profilin son ~`sayfa`×20 kaydı, en yeniden eskiye. Çerez yok/geçersizse null. */
  async oku({ sayfa = 2 } = {}) {
    const c = await this._cerez();
    if (!c) return null;
    const ortak = { Cookie: c.baslik, 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9' };
    const r = await this.getir('https://www.netflix.com/settings/viewed/', { headers: ortak, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    const html = r.status === 200 ? await r.text() : '';
    const guid = /"userInfo":\{"data":\{[^}]*"userGuid":"(.*?)"/.exec(html)?.[1];
    if (!guid) {
      this.gecersizMtime = c.mtime;
      this.log(`[netflix-geçmiş] çerez geçersiz ya da süresi dolmuş (HTTP ${r.status}) — tools/tv-ajan/netflix-cerez.sh ile yenileyin`);
      return null;
    }
    const tum = [];
    for (let s = 0; s < sayfa; s++) {
      const y = await this.getir(`https://www.netflix.com/api/aui/pathEvaluator/web/%5E2.0.0?method=call&callPath=${encodeURIComponent(`["aui","viewingActivity",${s},20]`)}&falcor_server=0.1.0`, {
        method: 'POST',
        headers: { ...ortak, 'Content-Type': 'application/x-www-form-urlencoded', 'x-netflix.request.routing': YONLENDIRME },
        body: `param=${encodeURIComponent(JSON.stringify({ guid }))}`,
        signal: AbortSignal.timeout(20000),
      });
      if (!y.ok) throw new Error(`viewingActivity HTTP ${y.status}`);
      const ogeler = (await y.json())?.jsonGraph?.aui?.viewingActivity?.value?.viewedItems || [];
      tum.push(...ogeler.map(ogeyiCoz));
      if (ogeler.length < 20) break;
    }
    return tum.filter((g) => Number.isFinite(g.zaman)).sort((a, b) => b.zaman - a.zaman);
  }
}

/**
 * Doldurucu: dakikada bir YEREL izleme kaydına bakar (Netflix'e gitmeden). Başlığı eksik, gerçekten oynayan (pasif
 * değil) ve en az `enKisaMs` süren bir Netflix kesiti varsa geçmişi sorgular; eşleşen başlıkları (pasif ve kısa
 * kesitler dahil) kayda "ek" olarak yazar. Bulunamazsa sonraki deneme `adimlarMs` sırasıyla (15 → 30 → 60 → 60 … dk).
 */
export class NetflixDoldurucu {
  constructor({ izleme, gecmis, adimlarMs = [15, 30, 60].map((dk) => dk * 60000), enAzMs = 10 * 60000, enKisaMs = 2 * 60000, yoklamaMs = 60000, vazgecMs = 6 * 3600e3, simdi = Date.now, log = () => {} }) {
    Object.assign(this, { izleme, gecmis, adimlarMs, enAzMs, enKisaMs, yoklamaMs, vazgecMs, simdi, log });
    this.zamanlayici = null;
    this.deneme = 0;          // art arda başarısız sorgu
    this.sonraki = 0;         // bir sonraki sorgunun en erken anı
    this.sonSorgu = -Infinity;
  }

  baslat() {
    if (this.zamanlayici) return;
    const dongu = async () => {
      try { await this.tur(); } catch (e) { this.log(`[netflix-geçmiş] okunamadı: ${e.message}`); this._ertele(); }
      this.zamanlayici = setTimeout(dongu, this.yoklamaMs);
      this.zamanlayici.unref?.();
    };
    this.zamanlayici = setTimeout(dongu, this.yoklamaMs);   // açılışta hemen değil: kayıt yüklensin
    this.zamanlayici.unref?.();
  }

  durdur() { clearTimeout(this.zamanlayici); this.zamanlayici = null; }

  _ertele() {
    this.sonraki = this.simdi() + this.adimlarMs[Math.min(this.deneme, this.adimlarMs.length - 1)];
    this.deneme++;
  }

  /** Bir tur. Dönen: doldurulan kesit sayısı; sorgu yapılmadıysa null. */
  async tur() {
    const t = this.simdi();
    const eksik = (await this.izleme.kesitler({ bas: t - 24 * 3600e3, bit: t + 1 }))
      .filter((k) => /netflix/i.test(`${k.uygulama || ''} ${k.kaynak || ''}`) && !k.program && t - k.bit < this.vazgecMs);
    const tetik = eksik.filter((k) => !k.pasif && k.bit - k.bas >= this.enKisaMs);   // izlenen, başlıksız
    if (!tetik.length) { this.deneme = 0; this.sonraki = 0; return null; }
    if (t < this.sonraki || t - this.sonSorgu < this.enAzMs) return null;
    this.sonSorgu = t;
    const gecmis = await this.gecmis.oku();
    if (!gecmis) { this._ertele(); return null; }   // çerez yok/geçersiz
    let dolan = 0;
    const dolanlar = new Set();
    for (const k of eksik) {
      const program = eslestir(k, gecmis);
      if (program) { await this.izleme.ekYaz(k, { program, kaynak: 'netflix-gecmis' }); dolan++; dolanlar.add(k); }
    }
    const kalan = tetik.filter((k) => !dolanlar.has(k)).length;
    if (kalan) this._ertele(); else { this.deneme = 0; this.sonraki = 0; }
    this.log(`[netflix-geçmiş] ${eksik.length} eksik Netflix kesiti · ${dolan} dolduruldu${kalan ? ` · sonraki deneme ${Math.round((this.sonraki - t) / 60000)} dk sonra` : ''}`);
    return dolan;
  }
}
