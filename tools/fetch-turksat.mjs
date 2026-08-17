#!/usr/bin/env node
/**
 * Adım 2 — Frekans veritabanını kur (temassız).
 *
 * Türksat'ın resmî frekans listesini (42°E) çeker ve tarih damgalı JSON olarak
 * kaydeder. Editör bunu "bu kanal şu an hangi frekansta?" sorusuna cevap vermek
 * ve eski listeyle yeni listeyi eşleştirmek için kullanır.
 *
 * Kullanım:
 *   node tools/fetch-turksat.mjs
 *   node tools/fetch-turksat.mjs --out data/turksat-42e.json
 *
 * Not: Resmî XLSX/PDF dışa aktarma uçları 2026-08-17 itibarıyla HTTP 500
 * döndürüyor, bu yüzden HTML tablosu ayrıştırılır. `items_per_page` parametresi
 * sunucu tarafından yok sayılıyor; sayfa başına 50 satır sabittir.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://www.turksat.com.tr/uydu/yayincilik-hizmetleri/turksat-frekans-listesi';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_PAGES = 40; // güvenlik freni; normalde 16 sayfada biter
const DELAY_MS = 200;

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', Uuml: 'Ü', ouml: 'ö', Ouml: 'Ö', ccedil: 'ç', Ccedil: 'Ç',
  scaron: 'š', euro: '€', hellip: '…', ndash: '–', mdash: '—',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n] !== undefined ? ENTITIES[n] : m));
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Sayfadaki ilk <table> gövdesinin satırlarını hücre dizisi olarak döndürür. */
function parseRows(html) {
  const table = /<table[\s\S]*?<\/table>/i.exec(html);
  if (!table) return [];
  const body = table[0];
  const rows = [];
  for (const tr of body.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Başlık satırından sütun adlarını tanır; site sütun sırasını değiştirirse bozulmasın diye. */
function headerMap(cells) {
  const idx = {};
  cells.forEach((c, i) => {
    // DİKKAT: Türkçe küçültme "PID" → "pıd" yapar (noktasız ı) ve regex'i kaçırır.
    // Başlık eşlemesi bu yüzden İngilizce küçültme + ı→i normalizasyonu kullanır.
    const k = c.toLowerCase().replace(/ı/g, 'i');
    if (/kanal/.test(k)) idx.kanal = i;
    else if (/frekans/.test(k)) idx.frekans = i;
    else if (/^pol/.test(k)) idx.pol = i;
    else if (/kapsama/.test(k)) idx.kapsama = i;
    else if (/^sr$|symbol/.test(k)) idx.sr = i;
    else if (/^fec$/.test(k)) idx.fec = i;
    else if (/v-?pid/.test(k)) idx.vpid = i;
    else if (/a-?pid/.test(k)) idx.apid = i;
    else if (/uydu/.test(k)) idx.uydu = i;
  });
  return idx;
}

/** Rakam içermeyen / eksik hücrede 0 değil null döner — "veri yok" ile "sıfır" karışmasın. */
const toNum = (v) => {
  if (v === undefined || v === null) return null;
  const digits = String(v).replace(/[^\d]/g, '');
  if (digits === '') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
};

/**
 * Site BIG-IP arkasında ve ilk istek zaman zaman düşüyor (özellikle bağlantı
 * bir süre boştaysa). Tek denemede pes etmek sayfayı sessizce eksik bırakır,
 * bu yüzden artan beklemeyle 3 kez denenir.
 */
async function fetchPage(page, tries = 3) {
  const url = `${BASE}?page=${page}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'tr,en;q=0.8' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(500 * (i + 1));
    }
  }
  throw new Error(`${lastErr?.message || lastErr} — ${url}`);
}

async function main() {
  const all = [];
  let cols = null;
  let pages = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    process.stdout.write(`\r  sayfa ${page} çekiliyor... (${all.length} satır)`);
    let html;
    try {
      html = await fetchPage(page);
    } catch (e) {
      console.error(`\n  sayfa ${page} alınamadı: ${e.message}`);
      break;
    }
    const rows = parseRows(html);
    if (!rows.length) break;

    let data = rows;
    if (/kanal/i.test(rows[0].join(' ')) && /frekans/i.test(rows[0].join(' '))) {
      cols = cols || headerMap(rows[0]);
      data = rows.slice(1);
    }
    if (!cols) { console.error('\n  Tablo başlığı tanınamadı — site yapısı değişmiş olabilir.'); break; }
    if (!data.length) break;

    const before = all.length;
    for (const r of data) {
      const kanal = r[cols.kanal] ?? '';
      if (!kanal) continue;
      all.push({
        kanal,
        frekans: toNum(r[cols.frekans]),
        pol: (r[cols.pol] || '').toUpperCase().startsWith('H') ? 'H' : (r[cols.pol] || '').toUpperCase().startsWith('V') ? 'V' : (r[cols.pol] || null),
        kapsama: r[cols.kapsama] || null,
        sr: toNum(r[cols.sr]),
        fec: r[cols.fec] || null,
        vpid: toNum(r[cols.vpid]),
        apid: toNum(r[cols.apid]),
        uydu: r[cols.uydu] || null,
      });
    }
    if (all.length === before) break; // yeni satır gelmiyorsa bitti
    pages = page + 1;
    await sleep(DELAY_MS);
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');

  if (!all.length) {
    console.error('Hiç satır alınamadı. Site erişilebilir mi kontrol et:');
    console.error('  ' + BASE);
    process.exit(1);
  }

  /**
   * Sayfalama sırasında aynı satırın iki kez gelmesi mümkün. Tekilleştirme
   * anahtarı TÜM alanları kapsar — çünkü aynı kanal farklı kapsama huzmesinde
   * (Batı/Doğu/TR) ayrı ayrı yayınlanabiliyor ve bunlar gerçek, ayrı satırlar.
   * Dar bir anahtar bunları sessizce yutar.
   */
  const seen = new Set();
  const rows = all.filter((r) => {
    const k = [r.kanal, r.frekans, r.pol, r.kapsama, r.sr, r.fec, r.vpid, r.apid, r.uydu].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const dropped = all.length - rows.length;

  const bySat = {};
  const tps = new Set();
  for (const r of rows) {
    bySat[r.uydu || '?'] = (bySat[r.uydu || '?'] || 0) + 1;
    if (r.frekans && r.pol) tps.add(`${r.frekans}${r.pol}@${r.uydu}`);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const out = {
    kaynak: BASE,
    cekilmeTarihi: stamp,
    konum: '42.0E',
    satirSayisi: rows.length,
    sayfaSayisi: pages,
    uyduDagilimi: bySat,
    transponderSayisi: tps.size,
    /**
     * Türksat 3A 16 Ağustos 2026'da emekliye ayrıldı ama resmî tabloda hâlâ
     * kayıtları duruyor. Bunların yayında olup olmadığı doğrulanamadı; editör
     * bu satırları "şüpheli" olarak işaretler.
     */
    supheliUydular: ['T3A'],
    satirlar: rows,
  };

  const outPath = resolve(ROOT, opt('--out', `data/turksat-42e-${stamp}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  const body = JSON.stringify(out, null, 1) + '\n';
  writeFileSync(outPath, body);
  // Web arayüzünün sabit bir adres üzerinden bulabilmesi için sürüm-bağımsız kopya.
  writeFileSync(resolve(ROOT, 'data/turksat-42e-latest.json'), body);

  console.log('──────────────────────────────────────────');
  console.log(`  Satır      : ${rows.length}  (${pages} sayfa, ham ${all.length}, birebir tekrar ${dropped})`);
  console.log(`  Transponder: ${tps.size}`);
  console.log('  Uydu dağılımı:');
  for (const [k, v] of Object.entries(bySat).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(k).padEnd(6)} ${String(v).padStart(5)}${out.supheliUydular.includes(k) ? '   ⚠️ şüpheli (T3A emekli)' : ''}`);
  }
  console.log(`\n  Kaydedildi : ${outPath}`);
  console.log('──────────────────────────────────────────');
}

main().catch((e) => { console.error('HATA: ' + (e.message || e)); process.exit(1); });
