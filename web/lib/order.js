/* eslint-env browser, node */
/**
 * Sıra motoru — "eski sıramı yeni listeye uygula".
 *
 * Ürünün var oluş nedeni bu. TKGS zaten frekansları güncelliyor; çözmediği tek
 * şey kullanıcının kendi sıralaması. Yeniden tarama sonrası kanal listesi
 * karışıyor ve insanlar günlerce kumandayla kanal diziyor.
 *
 * EŞLEŞTİRME ANAHTARI SIRASI (frekans EN SONDA, ve asla tek başına değil):
 *   1. SVCID + TSID + ONID  — DVB'nin gerçek kimliği, en güvenilir
 *   2. Kanal adı (normalize) — yayıncı kimlikleri değiştirdiğinde çalışır
 *   3. V-PID + A-PID + frekans(±2 MHz)
 *   4. Frekans(±2 MHz) + servis tipi — son çare
 *
 * Frekans neden birincil anahtar DEĞİL: Türksat'ın kendi duyurusu 12380/12423
 * derken kendi frekans tablosu aynı transponderları 12379/12422 olarak yazıyor.
 * Tam eşitlikle eşleştiren bir araç bu 1 MHz'lik farkta SESSİZCE başarısız olur.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrderEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const FREQ_TOLERANCE = 2; // MHz
  const MAX_NUMBER = 0x4000 - 1; // 0x4000 biti radyo göstergesi, numara alt 14 bit

  /** Karşılaştırma için ad normalleştirme: Türkçe karakterler ve süsler atılır. */
  function normName(s) {
    if (!s) return '';
    return String(s)
      .toLocaleUpperCase('tr')
      .replace(/İ/g, 'I').replace(/I/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
      .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C')
      .replace(/[^A-Z0-9]/g, '');
  }

  const QUALITY = /(UHD|FHD|4K|HD|SD)$/;
  /** Kalite son ekini atar: "KANAL D HD" ve "KANAL D" aynı köke iner. */
  function nameRoot(s) {
    let n = normName(s);
    while (QUALITY.test(n)) n = n.replace(QUALITY, '');
    return n;
  }

  const near = (a, b) =>
    a != null && b != null && Math.abs(Number(a) - Number(b)) <= FREQ_TOLERANCE;

  const hasId = (c) => c && c.SVCID != null && c.TSID != null && c.ONID != null;
  const idKey = (c) => `${c.SVCID}/${c.TSID}/${c.ONID}`;

  /**
   * @param {Array} oldList  eski liste — {name, number, SVCID, TSID, ONID, frequency, videoPid, audioPid}
   * @param {Array} newList  yeni liste — parse edilmiş kanallar (idx alanı olmalı)
   */
  function match(oldList, newList) {
    const usedNew = new Set();
    const usedOld = new Set();
    const matched = [];

    const take = (oi, nc, method) => {
      usedOld.add(oi);
      usedNew.add(nc.idx);
      matched.push({
        oldIdx: oi,
        idx: nc.idx,
        method,
        oldNumber: Number(oldList[oi].number),
        oldName: oldList[oi].name,
        newName: nc.name,
      });
    };

    // ── 1. tur: DVB kimliği
    const byId = new Map();
    newList.forEach((c) => {
      if (!hasId(c)) return;
      const k = idKey(c);
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(c);
    });
    oldList.forEach((o, oi) => {
      if (!hasId(o)) return;
      const cands = byId.get(idKey(o));
      const c = cands && cands.find((x) => !usedNew.has(x.idx));
      if (c) take(oi, c, 'id');
    });

    // ── 2. tur: normalize edilmiş ad (birebir)
    const byName = new Map();
    newList.forEach((c) => {
      if (usedNew.has(c.idx)) return;
      const k = normName(c.name);
      if (!k) return;
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c);
    });
    oldList.forEach((o, oi) => {
      if (usedOld.has(oi)) return;
      const cands = byName.get(normName(o.name));
      const c = cands && cands.find((x) => !usedNew.has(x.idx));
      if (c) take(oi, c, 'name');
    });

    // ── 3. tur: PID + frekans(±2)
    oldList.forEach((o, oi) => {
      if (usedOld.has(oi)) return;
      if (o.videoPid == null && o.audioPid == null) return;
      const c = newList.find(
        (x) =>
          !usedNew.has(x.idx) &&
          x.videoPid != null &&
          x.videoPid === o.videoPid &&
          x.audioPid === o.audioPid &&
          (o.frequency == null || x.frequency == null || near(o.frequency, x.frequency))
      );
      if (c) take(oi, c, 'pid');
    });

    // ── 4. tur: frekans(±2) + servis tipi — son çare, yalnız tek aday varsa
    oldList.forEach((o, oi) => {
      if (usedOld.has(oi) || o.frequency == null) return;
      const cands = newList.filter(
        (x) =>
          !usedNew.has(x.idx) &&
          near(o.frequency, x.frequency) &&
          (o.serviceType == null || x.serviceType == null || o.serviceType === x.serviceType)
      );
      if (cands.length === 1) take(oi, cands[0], 'freq');
    });

    const onlyOld = oldList.map((o, i) => ({ ...o, oldIdx: i })).filter((_, i) => !usedOld.has(i));
    const onlyNew = newList.filter((c) => !usedNew.has(c.idx));

    /**
     * SD→HD önerileri. Türksat geçişinde Star TV, Kanal D, Show, NTV, CNN Türk
     * gibi kanallar SD yayını bıraktı; kullanıcı "kanalım kayboldu" diyor.
     * Bunlar OTOMATİK eşleştirilmez — yanlış eşleşme sessiz veri bozulmasıdır.
     * Kullanıcıya öneri olarak sunulur, onay ondan gelir.
     */
    const suggestions = [];
    for (const o of onlyOld) {
      const root = nameRoot(o.name);
      if (!root) continue;
      const cands = onlyNew.filter((c) => nameRoot(c.name) === root);
      for (const c of cands) {
        suggestions.push({
          reason: 'sd-hd',
          oldIdx: o.oldIdx,
          idx: c.idx,
          oldName: o.name,
          newName: c.name,
          oldNumber: Number(o.number),
        });
      }
    }

    return { matched, onlyOld, onlyNew, suggestions };
  }

  /**
   * Eşleşmelerden çakışmasız bir numara planı üretir.
   * Eşleşen kanallar eski numaralarını almaya çalışır; çakışma olursa ilk gelen
   * kazanır, diğerleri en küçük boş numaraya kayar. Eşleşmeyen (yeni gelen)
   * kanallar en sona eklenir — silinmez, gizlenmez, sadece sıralanır.
   */
  function buildPlan(matchResult, newList, opts = {}) {
    const target = new Map();
    for (const m of matchResult.matched) target.set(m.idx, m.oldNumber);
    for (const s of opts.acceptedSuggestions || []) target.set(s.idx, s.oldNumber);

    const entries = newList.map((c) => ({
      idx: c.idx,
      target: target.has(c.idx) ? Number(target.get(c.idx)) : null,
      current: Number(c.number) || 0,
      isNew: !target.has(c.idx),
    }));

    entries.sort((a, b) => {
      const at = a.target == null ? Infinity : a.target;
      const bt = b.target == null ? Infinity : b.target;
      if (at !== bt) return at - bt;
      return a.current - b.current || a.idx - b.idx;
    });

    const used = new Set();
    let cursor = 1;
    const nextFree = () => {
      while (used.has(cursor)) cursor++;
      return cursor;
    };

    const plan = [];
    for (const e of entries) {
      let n = e.target;
      if (n == null || !Number.isFinite(n) || n < 1 || n > MAX_NUMBER || used.has(n)) {
        n = nextFree();
      }
      if (n > MAX_NUMBER) throw new Error('Numara alanı taştı (>16383).');
      used.add(n);
      plan.push({ idx: e.idx, newNumber: n, wasNew: e.isNew, requested: e.target });
    }
    plan.sort((a, b) => a.newNumber - b.newNumber);
    return plan;
  }

  /** Eski listeyi taşınabilir "sıra tarifi" olarak dışa aktarır. */
  function toRecipe(channels) {
    return {
      tip: 'scm-editor-sira-tarifi',
      surum: 1,
      olusturma: new Date().toISOString(),
      kanallar: channels.map((c) => ({
        name: c.name,
        number: c.number,
        SVCID: c.SVCID ?? null,
        TSID: c.TSID ?? null,
        ONID: c.ONID ?? null,
        frequency: c.frequency ?? null,
        videoPid: c.videoPid ?? null,
        audioPid: c.audioPid ?? null,
        serviceType: c.serviceType ?? null,
      })),
    };
  }

  /** TV'den SSAP ile okunan JSON'u da aynı sıra tarifi biçimine çevirir. */
  function fromTvDump(dump) {
    const rows = dump.kanallar || [];
    return rows.map((c) => ({
      name: c.name,
      number: c.number ?? c.majorNumber,
      SVCID: c.SVCID ?? null,
      TSID: c.TSID ?? null,
      ONID: c.ONID ?? null,
      frequency: c.frequency ?? null,
      videoPid: c.videoPid ?? null,
      audioPid: c.audioPid ?? null,
      serviceType: null,
    }));
  }

  return { match, buildPlan, toRecipe, fromTvDump, normName, nameRoot, FREQ_TOLERANCE, MAX_NUMBER };
});
