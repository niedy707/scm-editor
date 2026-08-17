/* eslint-env browser, node */
/**
 * Frekans doğrulama motoru — üç kaynağı çapraz karşılaştırır.
 *
 *   A) TV'nin kendi taraması   (ağdan SSAP ile okunur — TV bugün neye inanıyor)
 *   B) Türksat resmî tablosu   (bugün doğru olan)
 *   C) Düzenlenen .TLL dosyası (TV'ye geri yazılacak olan)
 *
 * DÜRÜSTLÜK SINIRI — "aktif" ne demek, ne demek değil:
 * Bu araç sinyal ÖLÇMEZ. Bir transponderin havada gerçekten yayın yapıp
 * yapmadığını uzaktan doğrulayamayız; ne SSAP'ta sinyal gücü ucu var, ne de
 * tarayıcıdan uyduya bakılabilir. "Aktif" burada şu anlama gelir:
 *   • operatörün (Türksat) BUGÜNKÜ resmî tablosunda o frekansta listeleniyor, VE
 *   • TV'nin kendi taraması da o kanalı bulmuş.
 * İkisi ayrışıyorsa bunu gizlemek yerine ayrı ayrı raporlarız.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Verify = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const FREQ_TOL = 2; // MHz — Türksat'ın duyurusu 12380 derken tablosu 12379 yazıyor

  const DURUM = {
    GUNCEL: 'guncel',           // TV frekansı resmî tabloyla uyuşuyor
    ESKI_FREKANS: 'eski',       // kanal taşınmış, TV hâlâ eski frekansta
    TP_TANINDI: 'tp-tanindi',   // frekans resmî bir transponder, ama bu ad tabloda yok
    TABLODA_YOK: 'tabloda-yok', // ne ad ne frekans tanınıyor
    SUPHELI_UYDU: 'supheli',    // resmî tablo emekli uyduyu (T3A) gösteriyor
    TARAMADA_YOK: 'taramada-yok', // tabloda var ama TV bulmamış
  };

  const ETIKET = {
    [DURUM.GUNCEL]: 'güncel',
    [DURUM.ESKI_FREKANS]: 'eski frekans',
    [DURUM.TP_TANINDI]: 'transponder tanındı',
    [DURUM.TABLODA_YOK]: 'tabloda yok',
    [DURUM.SUPHELI_UYDU]: 'şüpheli uydu',
    [DURUM.TARAMADA_YOK]: 'taramada yok',
  };

  /** Eşleşmenin hangi yolla kurulduğu — sayıların neden o sayı olduğunu açıklar. */
  const ESLESME = {
    AD: 'ad',
    AD_KOKU: 'ad-kökü',     // "ATV" ↔ "ATV HD"
    TRANSPONDER: 'transponder',
    YOK: 'yok',
  };

  function normName(s) {
    if (!s) return '';
    return String(s)
      .toLocaleUpperCase('tr')
      .replace(/İ/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
      .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
      .replace(/[^A-Z0-9]/g, '');
  }

  const QUALITY = /(UHD|FHD|4K|HD|SD)$/;
  /**
   * Kalite son ekini atar: TV "ATV" derken resmî tablo "ATV HD" diyor. Yalnız
   * ada bakan bir karşılaştırma bunu "tabloda yok" sayar ve sayıyı şişirir.
   */
  function nameRoot(s) {
    let n = normName(s);
    while (QUALITY.test(n)) n = n.replace(QUALITY, '');
    return n;
  }

  const near = (a, b, tol = FREQ_TOL) =>
    a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;

  /** Resmî tabloyu ad, ad kökü ve frekans üzerinden indeksler. */
  function indexOfficial(table) {
    const byName = new Map();
    const byRoot = new Map();
    const byFreq = new Map();
    const push = (map, k, r) => {
      if (!k && k !== 0) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    };
    for (const r of table.satirlar || []) {
      push(byName, normName(r.kanal), r);
      push(byRoot, nameRoot(r.kanal), r);
      if (r.frekans != null) push(byFreq, r.frekans, r);
    }
    return { byName, byRoot, byFreq };
  }

  /** Frekansı toleransla arar (12380 ↔ 12379 farkı sessizce kaybetmesin). */
  function rowsAtFreq(idx, freq) {
    if (freq == null) return [];
    const exact = idx.byFreq.get(freq);
    if (exact) return exact;
    for (const [f, rows] of idx.byFreq) if (near(f, freq)) return rows;
    return [];
  }

  /**
   * Kanal listesini resmî tabloyla karşılaştırır.
   * @param {Array} channels  {name, frequency} taşıyan kanallar
   * @param {object} table    fetch-turksat.mjs çıktısı
   */
  function verifyChannels(channels, table) {
    if (!table || !table.satirlar) return null;
    const idx = indexOfficial(table);
    const supheli = new Set(table.supheliUydular || []);
    const rows = [];

    for (const c of channels) {
      // 1) Birebir ad → 2) ad kökü ("ATV" ↔ "ATV HD")
      let cands = idx.byName.get(normName(c.name));
      let eslesme = ESLESME.AD;
      if (!cands || !cands.length) {
        cands = idx.byRoot.get(nameRoot(c.name));
        eslesme = ESLESME.AD_KOKU;
      }

      if (cands && cands.length) {
        const hit = cands.find((r) => near(r.frekans, c.frequency));
        const ref = hit || cands[0];
        const durum = hit
          ? (supheli.has(ref.uydu) ? DURUM.SUPHELI_UYDU : DURUM.GUNCEL)
          : DURUM.ESKI_FREKANS;
        rows.push({ ...c, durum, resmi: ref, eslesme, adaylar: cands.length });
        continue;
      }

      // 3) Ad hiç tanınmadı ama frekans resmî bir transponder mi?
      //    (Türksat'ın transponderlerinde tabloya girmemiş yabancı/bölgesel
      //     kanallar taşınıyor — bunlar "tabloda yok" ile aynı şey değil.)
      const tpRows = rowsAtFreq(idx, c.frequency);
      if (tpRows.length) {
        const ref = tpRows[0];
        rows.push({
          ...c,
          durum: supheli.has(ref.uydu) ? DURUM.SUPHELI_UYDU : DURUM.TP_TANINDI,
          resmi: ref,
          eslesme: ESLESME.TRANSPONDER,
          tpKanalSayisi: tpRows.length,
        });
        continue;
      }

      rows.push({ ...c, durum: DURUM.TABLODA_YOK, resmi: null, eslesme: ESLESME.YOK });
    }
    return rows;
  }

  /** Resmî tabloda olup TV'nin hiç bulamadığı kanallar. */
  function missingFromScan(channels, table, { onlyCoverage = null } = {}) {
    if (!table || !table.satirlar) return [];
    // Ad kökü de kontrol edilir: TV'de "ATV" varken tablodaki "ATV HD"
    // "bulunamadı" sayılmamalı.
    const have = new Set(channels.map((c) => normName(c.name)));
    const haveRoot = new Set(channels.map((c) => nameRoot(c.name)));
    const seen = new Set();
    const out = [];
    for (const r of table.satirlar) {
      const k = normName(r.kanal);
      const root = nameRoot(r.kanal);
      if (!k || have.has(k) || haveRoot.has(root) || seen.has(root)) continue;
      if ((table.supheliUydular || []).includes(r.uydu)) continue; // emekli uydu sayılmaz
      if (onlyCoverage && !onlyCoverage.includes(r.kapsama)) continue;
      seen.add(root);
      out.push(r);
    }
    return out;
  }

  /**
   * Transponder düzeyinde özet. Kullanıcıya asıl anlamlı olan bu: "şu 12 çarpan
   * taşınmış" demek, "231 kanal eski" demekten daha eyleme dönüktür, çünkü
   * yeniden tarama transponder bazında düzelir.
   */
  function transponderReport(channels, table) {
    const tvTps = new Map();
    for (const c of channels) {
      if (c.frequency == null) continue;
      const k = c.frequency;
      if (!tvTps.has(k)) tvTps.set(k, { frekans: k, kanallar: [] });
      tvTps.get(k).kanallar.push(c.name);
    }
    const resmiTps = new Map();
    for (const r of table?.satirlar || []) {
      if (r.frekans == null) continue;
      if (!resmiTps.has(r.frekans)) {
        resmiTps.set(r.frekans, { frekans: r.frekans, pol: r.pol, sr: r.sr, fec: r.fec, uydu: r.uydu, kanalSayisi: 0 });
      }
      resmiTps.get(r.frekans).kanalSayisi++;
    }

    const eslesen = [];
    const yalnizTv = [];
    const yalnizResmi = [];
    for (const [f, tp] of tvTps) {
      const m = [...resmiTps.values()].find((r) => near(r.frekans, f));
      if (m) eslesen.push({ ...tp, resmi: m });
      else yalnizTv.push(tp);
    }
    for (const [f, r] of resmiTps) {
      if (![...tvTps.keys()].some((t) => near(t, f))) yalnizResmi.push(r);
    }
    return {
      tvToplam: tvTps.size,
      resmiToplam: resmiTps.size,
      eslesen,
      yalnizTv: yalnizTv.sort((a, b) => a.frekans - b.frekans),
      yalnizResmi: yalnizResmi.sort((a, b) => a.frekans - b.frekans),
    };
  }

  /** Tek bakışta özet + kullanıcıya ne yapması gerektiğini söyleyen tavsiye. */
  function summarize(rows, tpRapor, table) {
    const say = {};
    for (const d of Object.values(DURUM)) say[d] = 0;
    for (const r of rows || []) say[r.durum] = (say[r.durum] || 0) + 1;

    const toplam = (rows || []).length;
    const eski = say[DURUM.ESKI_FREKANS];
    const oran = toplam ? eski / toplam : 0;

    let tavsiye;
    if (!toplam) {
      tavsiye = { seviye: 'info', metin: 'Karşılaştırılacak kanal yok.' };
    } else if (oran >= 0.25) {
      tavsiye = {
        seviye: 'error',
        metin:
          `Kanalların %${Math.round(oran * 100)}'i resmî tabloda başka frekansta görünüyor ` +
          `(${eski} kanal, ${tpRapor.yalnizTv.length} transponder). Listen büyük olasılıkla ` +
          `Türksat geçişinden ÖNCE tarandı. Önce TV'de operatörsüz tam tarama yap, sonra ` +
          `sıranı bu araçla geri yükle — aksi hâlde eski sırayı ölü frekanslara uygularsın.`,
      };
    } else if (eski > 0) {
      tavsiye = {
        seviye: 'warn',
        metin: `${eski} kanal resmî tabloda başka frekansta. Bunlar taşınmış olabilir; ` +
          `yeniden tarama bu kanalları düzeltir, sıran korunur.`,
      };
    } else {
      tavsiye = { seviye: 'ok', metin: 'Tüm eşleşen kanalların frekansı resmî tabloyla uyuşuyor.' };
    }

    return {
      toplam,
      say,
      etiketler: ETIKET,
      veriTarihi: table?.cekilmeTarihi || null,
      transponder: tpRapor,
      tavsiye,
    };
  }

  /** Tam rapor — arayüzün tek çağrısı. */
  function run(channels, table, opts = {}) {
    const rows = verifyChannels(channels, table);
    if (!rows) return null;
    const tp = transponderReport(channels, table);
    const eksik = missingFromScan(channels, table, opts);
    return { satirlar: rows, eksik, ozet: summarize(rows, tp, table) };
  }

  return { run, verifyChannels, missingFromScan, transponderReport, summarize, normName, nameRoot, DURUM, ETIKET, ESLESME, FREQ_TOL };
});
