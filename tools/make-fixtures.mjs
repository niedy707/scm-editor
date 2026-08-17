#!/usr/bin/env node
/**
 * Sentetik test dosyaları üretir.
 *
 * DİKKAT — dürüstlük notu: bunlar GERÇEK TV çıktısı değildir. Belgelenmiş şemaya
 * göre elle kurulmuş dosyalardır ve ayrıştırıcı/yamalayıcı mantığını doğrulamak
 * içindir. Bir modelin gerçekten desteklendiğini ancak O MODELDEN alınmış gerçek
 * bir dosya kanıtlar. Kendi TV'lerinden aldığın dosyaları `fixtures/local/`
 * altına koy (git'e girmez).
 *
 * Frekanslar Türksat'ın resmî tablosundan (data/turksat-42e-*.json) alınır, yani
 * geçiş sonrası gerçek değerlerdir.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'fixtures/synthetic');

function loadTurksat() {
  const dir = resolve(ROOT, 'data');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.startsWith('turksat-42e-')).sort(); } catch {}
  if (!files.length) return null;
  return JSON.parse(readFileSync(resolve(dir, files[files.length - 1]), 'utf8'));
}

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const b64 = (name) => {
  const utf8 = Buffer.from(name, 'utf8');
  const bytes = utf8.some((b) => b > 0x7f) ? Buffer.concat([Buffer.from([0x15]), utf8]) : utf8;
  return bytes.toString('base64');
};

const RADIO_BIT = 0x4000;

function pickChannels(ts, n) {
  if (!ts) return null;
  const rows = ts.satirlar.filter((r) => r.uydu !== 'T3A' && r.frekans && r.vpid);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.kanal)) continue;
    seen.add(r.kanal);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

// ─────────────────────────────────────────────── webOS 5/6/7 (CloneVersion 200)

function makeV200(rows) {
  const satIds = { T4A: '0420', T5B: '0421', T6A: '0422' };
  const tpKey = (r) => `${r.uydu}|${r.frekans}|${r.pol}`;
  const tpMap = new Map();
  for (const r of rows) if (!tpMap.has(tpKey(r))) tpMap.set(tpKey(r), r);

  const channelList = rows.map((r, i) => {
    const isRadio = /RADYO|FM|RADIO/i.test(r.kanal);
    const num = i + 1;
    const satId = satIds[r.uydu] || '0420';
    return {
      majorNumber: (num & ~RADIO_BIT) | (isRadio ? RADIO_BIT : 0),
      minorNumber: num,
      channelName: r.kanal,
      chNameBase64: b64(r.kanal),
      sourceIndex: 'SATELLITE DIGITAL',
      SVCID: 1000 + i,
      programNum: 1000 + i,
      TSID: 2000 + (i % 40),
      ONID: 42,
      frequency: r.frekans,
      satelliteId: satId,
      tpId: satId + String(r.frekans * 10).padStart(6, '0').slice(-6),
      videoPid: r.vpid ?? 0,
      audioPid: r.apid ?? 0,
      pcrPid: r.vpid ?? 0,
      serviceType: isRadio ? 2 : 25,
      scrambled: /BEIN|SPOR/i.test(r.kanal),
      skipped: false,
      locked: false,
      Invisible: false,
      deleted: false,
      disabled: false,
      disableUpdate: false,   // korumalı — araç buna ASLA yazmaz
      factoryDefault: false,  // korumalı
      userEditChNumber: false,// korumalı
      userSelCHNo: false,     // korumalı
      mapType: 'CUSTOMIZED',
      nitVersion: 11,
      hdStatus: 4,
      videoStreamType: 36,
      dvbss2: 0,
      bandwidth: 'BW_8M',
    };
  });

  const bySat = {};
  for (const [, r] of tpMap) {
    const id = satIds[r.uydu] || '0420';
    (bySat[id] = bySat[id] || []).push({
      networkId: 42,
      frequency: r.frekans,
      homeTp: false,
      channelIdx: 0,
      polarization: r.pol === 'H' ? 'Horizontal' : 'Vertical',
      TSID: 2000 + (r.frekans % 40),
      factoryDefault: true,
      ONID: 42,
      nitVersion: 18,
      dvbsS2: 0,
      symbolRate: r.sr ?? 27500,
      satelliteId: id,
      codeRate: 1,
    });
  }
  const satelliteList = Object.entries(bySat).map(([id, tps]) => ({
    tpListLoad: true,
    satLocation: '42.0E',
    factoryDefault: true,
    deleteFlag: false,
    TransponderList: tps,
    satelliteId: id,
    angleToGo: '42.0E',
    satelliteName: 'TURKSAT 42.0E (' + id + ')',
  }));

  const doc = {
    modelInfo: { modelName: 'OLED55C1-SENTETIK' },
    tkgsConfigObj: { tkgsEnable: true, operator: 'Turksat TKGS' },
    positionConfigObj: {},
    bouquetList: [],
    settingIdList: [],
    channelList,
    satelliteList,
    lcnStoreObj: {},
    operatorConfigObj: {},
    motorPositionObj: {},
    homeTpList: [],
  };

  const inner = escapeXml(JSON.stringify(doc));
  return (
    '<?xml version="1.0"?>\r\n' +
    '<TLLDATA>\r\n' +
    '\t<ModelInfo>\r\n' +
    '\t\t<ModelName type="0">OLED55C1-SENTETIK</ModelName>\r\n' +
    '\t\t<CloneVersion type="1">\r\n' +
    '\t\t\t<MajorVersion type="0">200</MajorVersion>\r\n' +
    '\t\t\t<MinorVersion type="0">000</MinorVersion>\r\n' +
    '\t\t\t<SatelliteDBVersion type="0">500</SatelliteDBVersion>\r\n' +
    '\t\t</CloneVersion>\r\n' +
    '\t\t<DTVInfo type="0">DTV_DVB</DTVInfo>\r\n' +
    '\t\t<BroadcastCountrySetting type="0">TUR</BroadcastCountrySetting>\r\n' +
    '\t\t<country type="0">EU</country>\r\n' +
    '\t</ModelInfo>\r\n' +
    '\t<CHANNEL>\r\n' +
    '\t\t<legacybroadcast>' + inner + '</legacybroadcast>\r\n' +
    '\t</CHANNEL>\r\n' +
    '</TLLDATA>\r\n'
  );
}

// ───────────────────────────────────────────────── webOS 2-4 (CloneVersion 100)

function makeV100(rows) {
  const items = rows
    .map((r, i) => {
      const isRadio = /RADYO|FM|RADIO/i.test(r.kanal);
      const num = i + 1;
      const major = (num & ~RADIO_BIT) | (isRadio ? RADIO_BIT : 0);
      const utf8 = Buffer.from(r.kanal, 'utf8');
      const bytes = utf8.some((b) => b > 0x7f) ? Buffer.concat([Buffer.from([0x15]), utf8]) : utf8;
      return [
        '<ITEM>',
        `<prNum>${major}</prNum>`,
        '<minorNum>0</minorNum>',
        '<original_network_id>42</original_network_id>',
        `<transport_id>${2000 + (i % 40)}</transport_id>`,
        '<network_id>42</network_id>',
        `<service_id>${1000 + i}</service_id>`,
        `<physicalNum>${num}</physicalNum>`,
        '<sourceIndex>7</sourceIndex>',
        `<serviceType>${isRadio ? 2 : 25}</serviceType>`,
        `<frequency>${r.frekans}</frequency>`,
        '<nitVersion>10</nitVersion>',
        '<mapType>1</mapType>',
        '<mapAttr>0</mapAttr>',
        `<programNo>${1000 + i}</programNo>`,
        '<favoriteIdxA>250</favoriteIdxA>',
        '<isInvisable>0</isInvisable>',
        '<isBlocked>0</isBlocked>',
        '<isSkipped>0</isSkipped>',
        '<isNumUnSel>0</isNumUnSel>',
        '<isDeleted>0</isDeleted>',
        '<chNameByte>0</chNameByte>',
        '<isDisabled>0</isDisabled>',
        `<isScrambled>${/BEIN|SPOR/i.test(r.kanal) ? 1 : 0}</isScrambled>`,
        `<hexVchName>${bytes.toString('hex')}</hexVchName>`,
        `<notConvertedLengthOfVchName>${r.kanal.length}</notConvertedLengthOfVchName>`,
        `<vchName>${escapeXml(r.kanal)}</vchName>`,
        `<lengthOfVchName>${r.kanal.length}</lengthOfVchName>`,
        '<usSatelliteHandle>1</usSatelliteHandle>',
        '<isUserSelCHNo>0</isUserSelCHNo>',
        '<videoStreamType>27</videoStreamType>',
        '</ITEM>',
      ].join('');
    })
    .join('\r\n');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\r\n\r\n' +
    '<TLLDATA>\r\n' +
    '<ModelInfo>\r\n' +
    '<ModelName type="0">50UK6470-SENTETIK</ModelName>\r\n' +
    '<CloneVersion type="1">\r\n' +
    '<MajorVersion>100</MajorVersion>\r\n' +
    '<MinorVersion>000</MinorVersion>\r\n' +
    '<SatelliteDBVersion>400</SatelliteDBVersion>\r\n' +
    '</CloneVersion>\r\n' +
    '<DTVInfo type="0">DTV_DVB</DTVInfo>\r\n' +
    '<BroadcastCountrySetting type="0">TUR</BroadcastCountrySetting>\r\n' +
    '<country type="0">EU</country>\r\n' +
    '</ModelInfo>\r\n' +
    '<CHANNEL>\r\n' +
    '<ATV>\r\n</ATV>\r\n' +
    '<DTV>\r\n' + items + '\r\n</DTV>\r\n' +
    '</CHANNEL>\r\n' +
    '</TLLDATA>\r\n'
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const ts = loadTurksat();
if (!ts) {
  console.error('data/turksat-42e-*.json bulunamadı. Önce: node tools/fetch-turksat.mjs');
  process.exit(1);
}

let rows = pickChannels(ts, 60);
// Kaçış ve Türkçe karakter yollarının test edilebilmesi için özel adlar ekle
rows = rows.concat([
  { kanal: 'beIN H&E', frekans: 12072, pol: 'V', sr: 27500, vpid: 4942, apid: 5042, uydu: 'T4A' },
  { kanal: 'ÇAĞRI TV İĞNE ÖŞÜ', frekans: 11794, pol: 'V', sr: 30000, vpid: 1699, apid: 1799, uydu: 'T4A' },
  { kanal: 'TRT FM RADYO', frekans: 11957, pol: 'V', sr: 27500, vpid: 1590, apid: 1690, uydu: 'T4A' },
]);

mkdirSync(OUT, { recursive: true });
const v200 = makeV200(rows);
const v100 = makeV100(rows);
writeFileSync(resolve(OUT, 'GlobalClone00001.v200.TLL'), v200, 'utf8');
writeFileSync(resolve(OUT, 'GlobalClone00001.v100.TLL'), v100, 'utf8');
writeFileSync(
  resolve(OUT, 'netcast-sample.TLL'),
  Buffer.from([0x5a, 0x5a, 0x5a, 0x5a, 0x2c, 0x8c, 0x00, 0x00, 0x8a, 0x00, 0x00, 0x00])
);

console.log('Sentetik dosyalar üretildi:');
console.log(`  ${rows.length} kanal · frekans kaynağı: ${ts.cekilmeTarihi} Türksat tablosu`);
console.log(`  fixtures/synthetic/GlobalClone00001.v200.TLL  (${v200.length} bayt)`);
console.log(`  fixtures/synthetic/GlobalClone00001.v100.TLL  (${v100.length} bayt)`);
console.log('  fixtures/synthetic/netcast-sample.TLL         (binary tanıma testi)');
