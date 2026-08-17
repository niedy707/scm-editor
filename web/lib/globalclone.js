/* eslint-env browser, node */
/**
 * LG GlobalClone (.TLL) okuyucu/yazıcı — byte-sadık.
 *
 * Üç LG kuşağı AYNI dosya adını (`GlobalClone00001.TLL`) kullanır, bu yüzden
 * format uzantıdan değil İÇERİKTEN tespit edilir:
 *
 *   <legacybroadcast> var  → webOS 5/6/7  : XML zarf + içinde JSON
 *   <TLLDATA> var          → webOS 2-4    : düz XML
 *   '<' ile başlamıyor     → NetCast      : bloklu binary (bu sürümde salt tanıma)
 *
 * TEMEL İLKE — byte-sadıklık:
 *   Dosya asla baştan üretilmez. Yalnızca değiştirilen alanın karakter aralığı
 *   yamalanır. Hiçbir değişiklik yapılmazsa çıktı girdiyle BİREBİR AYNIDIR.
 *   Bu, "dosyayı hiç değiştirmesem bile TV'ye geri koyunca liste bozuluyor"
 *   şikayet sınıfının tek yapısal çözümüdür.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GlobalClone = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ═══════════════════════════════════════════════════ korumalı alan politikası

  /**
   * webOS 5+ JSON'unda YAZILMASINA İZİN VERİLEN alanlar.
   * Liste dışındaki her şeye yazmak hatadır.
   */
  const WRITABLE_JSON = new Set([
    'majorNumber',
    'minorNumber',
    'channelName',
    'chNameBase64',
    'skipped',
    'locked',
    'Invisible',
  ]);

  /**
   * ASLA yazılmayacak alanlar — sebebi ChanSort kaynak kodundaki, yaşanmış
   * kazalara dayanan notlar:
   *   disableUpdate  → "No-Go! Bu tüm listeyi bloke etti ve fabrika ayarlarına
   *                     dönmeyi gerektirdi."
   *   userEditChNumber / userSelCHNo → TV menüsünden numara değiştirilince set
   *                     oluyor ve SONRAKİ import'ları engelliyor.
   *   deleted        → webOS 5+'ta gerçek silme TV'yi kararsızlaştırıyor;
   *                     silinen kanallar aynı transponderdaki başka bir kanala
   *                     geçince rastgele yerlere geri geliyor.
   */
  const FORBIDDEN_JSON = new Set([
    'disableUpdate',
    'factoryDefault',
    'deleted',
    'userEditChNumber',
    'userSelCHNo',
  ]);

  const WRITABLE_XML = new Set([
    'prNum',
    'vchName',
    'hexVchName',
    'lengthOfVchName',
    'notConvertedLengthOfVchName',
    'isSkipped',
    'isBlocked',
    'isInvisable', // yazım hatası XML'in parçası, düzeltilemez
  ]);

  class ProtectedFieldError extends Error {}

  function assertWritable(key, allowed, forbidden) {
    if (forbidden && forbidden.has(key)) {
      throw new ProtectedFieldError(
        `"${key}" korumalı bir alandır ve bu araç ona ASLA yazmaz. ` +
          `Bu alana yazmak televizyonun kanal listesini kilitleyebilir.`
      );
    }
    if (!allowed.has(key)) {
      throw new ProtectedFieldError(`"${key}" yazılabilir alanlar listesinde değil.`);
    }
  }

  // ═══════════════════════════════════════════════════ XML kaçış + konum eşlemi

  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  /**
   * XML kaçışlarını çözerken, çözülmüş metindeki HER konumun ham metindeki
   * karşılığını da kaydeder. Yamalar çözülmüş uzayda hesaplanır, ham uzayda
   * uygulanır — böylece dokunulmayan baytlar birebir korunur.
   */
  function unescapeWithMap(raw) {
    let out = '';
    const map = []; // map[i] = out[i]'nin raw içindeki başlangıcı
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '&') {
        const semi = raw.indexOf(';', i + 1);
        if (semi > i && semi - i <= 10) {
          const body = raw.slice(i + 1, semi);
          let decoded = null;
          if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
              ? parseInt(body.slice(2), 16)
              : parseInt(body.slice(1), 10);
            if (Number.isFinite(code)) decoded = String.fromCodePoint(code);
          } else if (NAMED[body] !== undefined) {
            decoded = NAMED[body];
          }
          if (decoded !== null) {
            for (const c of decoded) { map.push(i); out += c; }
            i = semi + 1;
            continue;
          }
        }
      }
      map.push(i);
      out += ch;
      i++;
    }
    map.push(raw.length); // bitiş sınırı
    return { text: out, map };
  }

  function escapeXml(s) {
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (ch === '&') out += '&amp;';
      else if (ch === '<') out += '&lt;';
      else if (ch === '>') out += '&gt;';
      else if (c < 0x20 && ch !== '\n' && ch !== '\r' && ch !== '\t') {
        out += '&#x' + c.toString(16).toUpperCase().padStart(2, '0') + ';';
      } else out += ch;
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════ JSON tarayıcı

  /** String literalinin sonunu (kapanış tırnağından sonrasını) döndürür. */
  function skipString(s, i) {
    i++; // açılış tırnağı
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue; }
      if (s[i] === '"') return i + 1;
      i++;
    }
    return i;
  }

  /** i konumundaki değerin bittiği yeri döndürür (obje/dizi/string/skaler). */
  function skipValue(s, i) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const c = s[i];
    if (c === '"') return skipString(s, i);
    if (c === '{' || c === '[') {
      const open = c, close = c === '{' ? '}' : ']';
      let depth = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '"') { i = skipString(s, i); continue; }
        if (ch === open) depth++;
        else if (ch === close) { depth--; if (depth === 0) return i + 1; }
        i++;
      }
      return i;
    }
    while (i < s.length && !/[,\}\]\s]/.test(s[i])) i++;
    return i;
  }

  /** `"key": [ ... ]` dizisinin elemanlarının [start,end) aralıklarını verir. */
  function arrayElementSpans(json, key, from = 0) {
    const needle = '"' + key + '"';
    let k = json.indexOf(needle, from);
    while (k >= 0) {
      let i = k + needle.length;
      while (i < json.length && /\s/.test(json[i])) i++;
      if (json[i] === ':') {
        i++;
        while (i < json.length && /\s/.test(json[i])) i++;
        if (json[i] === '[') {
          const spans = [];
          let j = i + 1;
          while (j < json.length) {
            while (j < json.length && /[\s,]/.test(json[j])) j++;
            if (json[j] === ']') break;
            const end = skipValue(json, j);
            spans.push({ start: j, end });
            j = end;
          }
          return spans;
        }
      }
      k = json.indexOf(needle, k + 1);
    }
    return [];
  }

  /** Bir objenin ÜST düzey üyelerini {key, valStart, valEnd} olarak verir. */
  function objectMembers(json, start, end) {
    const out = [];
    let i = start;
    while (i < end && json[i] !== '{') i++;
    i++;
    while (i < end) {
      while (i < end && /[\s,]/.test(json[i])) i++;
      if (json[i] === '}' || i >= end) break;
      if (json[i] !== '"') { i = skipValue(json, i); continue; }
      const keyEnd = skipString(json, i);
      const key = JSON.parse(json.slice(i, keyEnd));
      let v = keyEnd;
      while (v < end && /\s/.test(json[v])) v++;
      if (json[v] !== ':') { i = keyEnd; continue; }
      v++;
      while (v < end && /\s/.test(json[v])) v++;
      const valEnd = skipValue(json, v);
      out.push({ key, valStart: v, valEnd });
      i = valEnd;
    }
    return out;
  }

  // ═════════════════════════════════════════════════════════ format tespiti

  const FORMAT = {
    GC_JSON: 'gc-json',   // webOS 5/6/7
    GC_XML: 'gc-xml',     // webOS 2-4
    NETCAST: 'netcast',   // 2009-2014 binary
    UNKNOWN: 'unknown',
  };

  function detect(text) {
    if (typeof text !== 'string') return FORMAT.UNKNOWN;
    const head = text.slice(0, 4096);
    if (text.includes('<legacybroadcast>')) return FORMAT.GC_JSON;
    if (head.includes('<TLLDATA>')) return FORMAT.GC_XML;
    if (!head.trimStart().startsWith('<')) return FORMAT.NETCAST;
    return FORMAT.UNKNOWN;
  }

  // ═════════════════════════════════════════════ webOS 5/6/7 — JSON-in-XML

  const SOURCE_LABEL = {
    'SATELLITE DIGITAL': 'uydu',
    'CABLE DIGITAL': 'kablo',
    'ANTENNA DIGITAL': 'anten',
    'ANTENNA ANALOG': 'anten-analog',
    'CABLE ANALOG': 'kablo-analog',
  };

  const RADIO_BIT = 0x4000;

  function b64decode(s) {
    if (typeof atob === 'function') {
      const bin = atob(s);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  function b64encode(bytes) {
    if (typeof btoa === 'function') {
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    }
    return Buffer.from(bytes).toString('base64');
  }

  /**
   * Kanal adını DVB string'e çevirir. LG, adı İKİ ayrı alanda tutar
   * (`channelName` düz metin + `chNameBase64` ham DVB string) ve TV bazı
   * durumlarda ikincisini okur. Biri güncellenmezse TV eski adı gösterir —
   * bu yüzden ikisi de TEK işlemde yazılır.
   *
   * 0x15 ön eki DVB-SI'nin "bundan sonrası UTF-8" göstergesidir; ASCII dışı
   * karakter varsa (Türkçe ç/ğ/ı/ö/ş/ü dahil) eklenir.
   */
  function nameToBase64(name) {
    const utf8 = new TextEncoder().encode(name);
    const needsMarker = utf8.some((b) => b > 0x7f);
    const bytes = needsMarker ? Uint8Array.from([0x15, ...utf8]) : utf8;
    return b64encode(bytes);
  }

  function parseGcJson(text) {
    const OPEN = '<legacybroadcast>';
    const CLOSE = '</legacybroadcast>';
    const a = text.indexOf(OPEN);
    const b = text.indexOf(CLOSE, a);
    if (a < 0 || b < 0) {
      throw new Error(
        'Dosyada <legacybroadcast> bloğu bulunamadı. webOS 5+ dosyası bekleniyordu.'
      );
    }
    const innerStart = a + OPEN.length;
    const rawInner = text.slice(innerStart, b);
    const { text: json, map } = unescapeWithMap(rawInner);

    let doc;
    try {
      doc = JSON.parse(json);
    } catch (e) {
      throw new Error(
        'İç JSON ayrıştırılamadı: ' + e.message +
          '. Dosya bozuk olabilir — TV\'ye takılan USB belleği FAT32 olarak biçimlendirip yeniden dene.'
      );
    }

    const spans = arrayElementSpans(json, 'channelList');
    const channels = spans.map((sp, idx) => {
      const members = {};
      for (const m of objectMembers(json, sp.start, sp.end)) members[m.key] = m;
      const o = doc.channelList[idx] || {};
      const major = Number(o.majorNumber ?? 0);
      return {
        idx,
        span: sp,
        members,
        number: major & ~RADIO_BIT,
        isRadio: (major & RADIO_BIT) !== 0,
        majorNumber: major,
        minorNumber: o.minorNumber ?? null,
        name: o.channelName ?? '',
        nameB64: o.chNameBase64 ?? '',
        source: SOURCE_LABEL[o.sourceIndex] || o.sourceIndex || '?',
        SVCID: o.SVCID ?? o.programNum ?? null,
        TSID: o.TSID ?? null,
        ONID: o.ONID ?? null,
        frequency: o.frequency ?? null,
        satelliteId: o.satelliteId ?? null,
        tpId: o.tpId ?? null,
        videoPid: o.videoPid != null ? o.videoPid & 0x1fff : null,
        audioPid: o.audioPid != null ? o.audioPid & 0x1fff : null,
        scrambled: !!o.scrambled,
        skipped: !!o.skipped,
        locked: !!o.locked,
        invisible: !!o.Invisible,
        deleted: !!o.deleted,
        serviceType: o.serviceType ?? null,
      };
    });

    const satellites = [];
    for (const sp of arrayElementSpans(json, 'satelliteList')) {
      const satJson = json.slice(sp.start, sp.end);
      let sat;
      try { sat = JSON.parse(satJson); } catch { continue; }
      const tpSpans = arrayElementSpans(satJson, 'TransponderList');
      satellites.push({
        satelliteId: sat.satelliteId,
        satelliteName: sat.satelliteName,
        satLocation: sat.satLocation,
        tpListLoad: sat.tpListLoad,
        transponders: (sat.TransponderList || []).map((tp, i) => ({
          frequency: tp.frequency,
          symbolRate: tp.symbolRate,
          polarization: tp.polarization,
          TSID: tp.TSID,
          ONID: tp.ONID,
          codeRate: tp.codeRate,
          dvbsS2: tp.dvbsS2,
          satelliteId: tp.satelliteId,
          span: tpSpans[i] ? { start: sp.start + tpSpans[i].start, end: sp.start + tpSpans[i].end } : null,
        })),
      });
    }

    return {
      format: FORMAT.GC_JSON,
      raw: text,
      innerStart,
      rawInner,
      json,
      map,
      doc,
      model: doc.modelInfo?.modelName ?? null,
      cloneVersion: 200,
      channels,
      satellites,
      canDelete: false, // webOS 5+: gerçek silme TV'yi kararsızlaştırıyor
      capabilities: { rename: true, renumber: true, skip: true, lock: true, hide: true, favorites: false },
    };
  }

  /**
   * Değişiklikleri uygular ve YENİ dosya metnini döndürür.
   * `edits` = [{ idx, field, value }]  (field ∈ WRITABLE_JSON)
   * Hiç düzenleme yoksa girdinin ta kendisi döner (byte-sadıklık).
   */
  function serializeGcJson(parsed, edits) {
    if (!edits || !edits.length) return parsed.raw;

    // Çözülmüş JSON uzayında yama listesi topla
    const patches = [];
    for (const e of edits) {
      assertWritable(e.field, WRITABLE_JSON, FORBIDDEN_JSON);
      const ch = parsed.channels[e.idx];
      if (!ch) throw new Error(`Kanal bulunamadı: idx=${e.idx}`);
      const m = ch.members[e.field];
      if (!m) {
        throw new Error(
          `Bu dosyadaki kanal kaydında "${e.field}" alanı yok. ` +
            `Var olmayan alan EKLENMEZ — TV bilinmeyen alana beklenmedik tepki verebilir.`
        );
      }
      patches.push({ start: m.valStart, end: m.valEnd, text: JSON.stringify(e.value) });
    }

    patches.sort((a, b) => a.start - b.start);
    for (let i = 1; i < patches.length; i++) {
      if (patches[i].start < patches[i - 1].end) {
        throw new Error('İç hata: çakışan yama aralıkları.');
      }
    }

    // Çözülmüş konumları HAM (kaçışlı) konumlara çevir, değeri XML-kaçışla
    let outInner = '';
    let cursor = 0; // ham iç metinde
    for (const p of patches) {
      const rawStart = parsed.map[p.start];
      const rawEnd = parsed.map[p.end];
      outInner += parsed.rawInner.slice(cursor, rawStart);
      outInner += escapeXml(p.text);
      cursor = rawEnd;
    }
    outInner += parsed.rawInner.slice(cursor);

    const before = parsed.raw.slice(0, parsed.innerStart);
    const after = parsed.raw.slice(parsed.innerStart + parsed.rawInner.length);
    return before + outInner + after;
  }

  // ══════════════════════════════════════════════════ webOS 2-4 — düz XML

  const ITEM_RE = /<ITEM>([\s\S]*?)<\/ITEM>/g;

  function tagValue(itemText, tag) {
    const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(itemText);
    return m ? m[1] : null;
  }

  function parseGcXml(text) {
    if (!text.includes('<TLLDATA>')) throw new Error('Dosyada <TLLDATA> kökü yok.');
    const model = /<ModelName[^>]*>([\s\S]*?)<\/ModelName>/.exec(text);

    const channels = [];
    ITEM_RE.lastIndex = 0;
    let m;
    let idx = 0;
    while ((m = ITEM_RE.exec(text))) {
      const inner = m[1];
      const itemStart = m.index;
      const itemEnd = m.index + m[0].length;
      const num = (t) => { const v = tagValue(inner, t); return v === null || v === '' ? null : Number(v); };
      const major = num('prNum') ?? 0;
      const nameRaw = tagValue(inner, 'vchName');
      channels.push({
        idx: idx++,
        span: { start: itemStart, end: itemEnd },
        number: major & ~RADIO_BIT,
        isRadio: (major & RADIO_BIT) !== 0,
        majorNumber: major,
        minorNumber: num('minorNum'),
        name: nameRaw === null ? '' : unescapeWithMap(nameRaw).text,
        nameHex: tagValue(inner, 'hexVchName'),
        SVCID: num('service_id'),
        TSID: num('transport_id'),
        ONID: num('original_network_id'),
        frequency: num('frequency'),
        videoPid: null,
        audioPid: null,
        source: num('sourceIndex') === 7 ? 'uydu' : num('sourceIndex') === 2 ? 'kablo' : 'anten',
        scrambled: num('isScrambled') === 1,
        skipped: num('isSkipped') === 1,
        locked: num('isBlocked') === 1,
        invisible: num('isInvisable') === 1,
        deleted: num('isDeleted') === 1 || ((num('mapType') ?? 0) & 0x02) !== 0,
        serviceType: num('serviceType'),
      });
    }

    return {
      format: FORMAT.GC_XML,
      raw: text,
      model: model ? model[1] : null,
      cloneVersion: 100,
      channels,
      satellites: [],
      canDelete: false,
      capabilities: { rename: true, renumber: true, skip: true, lock: true, hide: true, favorites: true },
    };
  }

  function serializeGcXml(parsed, edits) {
    if (!edits || !edits.length) return parsed.raw;

    const byIdx = new Map();
    for (const e of edits) {
      assertWritable(e.field, WRITABLE_XML, null);
      if (!byIdx.has(e.idx)) byIdx.set(e.idx, []);
      byIdx.get(e.idx).push(e);
    }

    const patches = [];
    for (const [i, list] of byIdx) {
      const ch = parsed.channels[i];
      if (!ch) throw new Error(`Kanal bulunamadı: idx=${i}`);
      const itemText = parsed.raw.slice(ch.span.start, ch.span.end);
      let newItem = itemText;
      for (const e of list) {
        const re = new RegExp('(<' + e.field + '(?:\\s[^>]*)?>)([\\s\\S]*?)(</' + e.field + '>)');
        if (!re.test(newItem)) {
          throw new Error(`Bu kayıtta <${e.field}> etiketi yok — var olmayan etiket EKLENMEZ.`);
        }
        // Boş kanal adı <vchName></vchName> olamaz: TV tek boşluk bekliyor.
        let val = escapeXml(String(e.value));
        if (e.field === 'vchName' && val === '') val = ' ';
        newItem = newItem.replace(re, (_, o, __, c) => o + val + c);
      }
      if (newItem !== itemText) {
        patches.push({ start: ch.span.start, end: ch.span.end, text: newItem });
      }
    }

    patches.sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const p of patches) {
      out += parsed.raw.slice(cursor, p.start) + p.text;
      cursor = p.end;
    }
    out += parsed.raw.slice(cursor);
    return out;
  }

  // ══════════════════════════════════════════════════════════ genel arayüz

  function parse(text) {
    const fmt = detect(text);
    if (fmt === FORMAT.GC_JSON) return parseGcJson(text);
    if (fmt === FORMAT.GC_XML) return parseGcXml(text);
    if (fmt === FORMAT.NETCAST) {
      const err = new Error(
        'Bu bir NetCast (2009-2014) binary .TLL dosyası. Bu sürüm henüz bu formatı ' +
          'düzenleyemiyor — CRC32, tahsis haritası ve bağlı liste tutarlılığı gerektiriyor.'
      );
      err.format = FORMAT.NETCAST;
      throw err;
    }
    throw new Error('Dosya biçimi tanınamadı. LG GlobalClone .TLL dosyası bekleniyordu.');
  }

  function serialize(parsed, edits) {
    if (parsed.format === FORMAT.GC_JSON) return serializeGcJson(parsed, edits);
    if (parsed.format === FORMAT.GC_XML) return serializeGcXml(parsed, edits);
    throw new Error('Bu format yazılamıyor: ' + parsed.format);
  }

  /**
   * Numara değiştirme, radyo bitini KORUR. `majorNumber`'ın 0x4000 biti kanalın
   * radyo olduğunu söyler; sadece alt 14 bit numaradır. Biti düşürmek TV'de
   * radyoyu TV kanalı gibi gösterir.
   */
  function setNumberEdit(ch, newNumber) {
    const major = (newNumber & ~RADIO_BIT) | (ch.isRadio ? RADIO_BIT : 0);
    return { idx: ch.idx, field: 'majorNumber', value: major };
  }

  /** İsim değiştirme — bağlı TÜM alanlar tek işlemde. */
  function setNameEdits(parsed, ch, newName) {
    if (parsed.format === FORMAT.GC_JSON) {
      const out = [{ idx: ch.idx, field: 'channelName', value: newName }];
      if (ch.members && ch.members.chNameBase64) {
        out.push({ idx: ch.idx, field: 'chNameBase64', value: nameToBase64(newName) });
      }
      return out;
    }
    const utf8 = new TextEncoder().encode(newName);
    const needsMarker = utf8.some((b) => b > 0x7f);
    const bytes = needsMarker ? [0x15, ...utf8] : [...utf8];
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    return [
      { idx: ch.idx, field: 'vchName', value: newName },
      { idx: ch.idx, field: 'hexVchName', value: hex },
      { idx: ch.idx, field: 'lengthOfVchName', value: newName.length },
      { idx: ch.idx, field: 'notConvertedLengthOfVchName', value: newName.length },
    ];
  }

  return {
    FORMAT,
    detect,
    parse,
    serialize,
    setNumberEdit,
    setNameEdits,
    nameToBase64,
    WRITABLE_JSON,
    FORBIDDEN_JSON,
    WRITABLE_XML,
    ProtectedFieldError,
    RADIO_BIT,
    _internal: { unescapeWithMap, escapeXml, arrayElementSpans, objectMembers, skipValue },
  };
});
