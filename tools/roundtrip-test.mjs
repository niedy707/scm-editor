#!/usr/bin/env node
/**
 * Regresyon testleri.
 *
 * En önemlisi ilk test: DEĞİŞİKLİK YOKSA ÇIKTI GİRDİYLE BİREBİR AYNI OLMALI.
 * "Dosyayı hiç değiştirmedim ama TV'ye geri koyunca liste bozuldu" şikayet
 * sınıfının tek yapısal savunması budur.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GC = require(resolve(ROOT, 'web/lib/globalclone.js'));
const Order = require(resolve(ROOT, 'web/lib/order.js'));

let pass = 0, fail = 0;
const results = [];

function t(name, fn) {
  try {
    fn();
    pass++; results.push(['✓', name, '']);
  } catch (e) {
    fail++; results.push(['✗', name, e.message]);
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'eşit değil'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'doğru değil'); }
function throws(fn, re, msg) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error((msg || 'hata bekleniyordu') + ' ama hata atılmadı');
  if (re && !re.test(threw.message)) throw new Error(`hata mesajı beklenene uymuyor: ${threw.message}`);
}

const FIX = resolve(ROOT, 'fixtures/synthetic');
if (!existsSync(join(FIX, 'GlobalClone00001.v200.TLL'))) {
  console.error('Sentetik dosyalar yok. Önce: node tools/make-fixtures.mjs');
  process.exit(1);
}
const v200 = readFileSync(join(FIX, 'GlobalClone00001.v200.TLL'), 'utf8');
const v100 = readFileSync(join(FIX, 'GlobalClone00001.v100.TLL'), 'utf8');
const netcast = readFileSync(join(FIX, 'netcast-sample.TLL'), 'latin1');

// ══════════════════════════════════════════════════════════ format tespiti

t('format tespiti: webOS 5+ → gc-json', () => eq(GC.detect(v200), GC.FORMAT.GC_JSON));
t('format tespiti: webOS 2-4 → gc-xml', () => eq(GC.detect(v100), GC.FORMAT.GC_XML));
t('format tespiti: NetCast binary → netcast', () => eq(GC.detect(netcast), GC.FORMAT.NETCAST));
t('NetCast açılırsa açıklayıcı hata verir', () =>
  throws(() => GC.parse(netcast), /NetCast/, 'NetCast reddi'));

// ═══════════════════════════════════════════════════════ BYTE-SADIKLIK (v200)

t('v200: değişiklik yok → çıktı BİREBİR aynı', () => {
  const p = GC.parse(v200);
  eq(GC.serialize(p, []), v200, 'byte-sadıklık bozuldu');
});

t('v200: boş düzenleme dizisi de birebir aynı', () => {
  const p = GC.parse(v200);
  eq(GC.serialize(p, undefined), v200);
});

t('v200: tek numara değişikliği yalnız o baytları değiştirir', () => {
  const p = GC.parse(v200);
  const out = GC.serialize(p, [GC.setNumberEdit(p.channels[5], 77)]);
  ok(out !== v200, 'hiç değişmemiş');
  // Fark uzunluğu makul olmalı (tek sayı alanı)
  eq(Math.abs(out.length - v200.length) <= 4, true, 'fark çok büyük');
  const p2 = GC.parse(out);
  eq(p2.channels[5].number, 77);
  for (let i = 0; i < p.channels.length; i++) {
    if (i === 5) continue;
    eq(p2.channels[i].majorNumber, p.channels[i].majorNumber, `kanal ${i} numarası bozuldu`);
    eq(p2.channels[i].name, p.channels[i].name, `kanal ${i} adı bozuldu`);
  }
});

t('v200: radyo biti korunur', () => {
  const p = GC.parse(v200);
  const radio = p.channels.find((c) => c.isRadio);
  ok(radio, 'sentetik dosyada radyo kanalı yok');
  const out = GC.serialize(p, [GC.setNumberEdit(radio, 12)]);
  const r2 = GC.parse(out).channels[radio.idx];
  eq(r2.number, 12, 'numara');
  eq(r2.isRadio, true, 'radyo biti düştü');
  eq(r2.majorNumber, 12 | GC.RADIO_BIT, 'majorNumber');
});

t('v200: isim değişikliği channelName VE chNameBase64 alanlarını birlikte yazar', () => {
  const p = GC.parse(v200);
  const ch = p.channels[3];
  const out = GC.serialize(p, GC.setNameEdits(p, ch, 'YENİ KANAL ÇĞİÖŞÜ'));
  const c2 = GC.parse(out).channels[3];
  eq(c2.name, 'YENİ KANAL ÇĞİÖŞÜ', 'düz ad');
  eq(c2.nameB64, GC.nameToBase64('YENİ KANAL ÇĞİÖŞÜ'), 'base64 ad');
  const bytes = Buffer.from(c2.nameB64, 'base64');
  eq(bytes[0], 0x15, 'UTF-8 gösterge baytı (0x15) eksik');
  eq(bytes.slice(1).toString('utf8'), 'YENİ KANAL ÇĞİÖŞÜ', 'UTF-8 gövde');
});

t('v200: ASCII isimde 0x15 ön eki EKLENMEZ', () => {
  const bytes = Buffer.from(GC.nameToBase64('TRT 1 HD'), 'base64');
  eq(bytes[0] === 0x15, false, 'gereksiz gösterge baytı eklendi');
  eq(bytes.toString('utf8'), 'TRT 1 HD');
});

t('v200: XML kaçışlı isim (&) bozulmadan okunur ve komşusu korunur', () => {
  const p = GC.parse(v200);
  const amp = p.channels.find((c) => c.name.includes('&'));
  ok(amp, 'sentetik dosyada & içeren kanal yok');
  eq(amp.name, 'beIN H&E');
  const out = GC.serialize(p, [GC.setNumberEdit(p.channels[0], 900)]);
  eq(GC.parse(out).channels[amp.idx].name, 'beIN H&E', '& içeren ad bozuldu');
  ok(out.includes('beIN H&amp;E'), 'ham dosyada kaçış korunmadı');
});

t('v200: & içeren isim yazıldığında yeniden kaçışlanır', () => {
  const p = GC.parse(v200);
  const out = GC.serialize(p, GC.setNameEdits(p, p.channels[2], 'A & B <C>'));
  ok(out.includes('A &amp; B &lt;C&gt;'), 'yazılan ad XML-kaçışlanmadı');
  eq(GC.parse(out).channels[2].name, 'A & B <C>');
});

// ══════════════════════════════════════════════════ KORUMALI ALAN POLİTİKASI

for (const f of ['disableUpdate', 'factoryDefault', 'deleted', 'userEditChNumber', 'userSelCHNo']) {
  t(`korumalı alan reddedilir: ${f}`, () => {
    const p = GC.parse(v200);
    throws(
      () => GC.serialize(p, [{ idx: 0, field: f, value: true }]),
      /korumalı|ASLA/,
      `${f} yazımı`
    );
  });
}

t('bilinmeyen alan reddedilir', () => {
  const p = GC.parse(v200);
  throws(() => GC.serialize(p, [{ idx: 0, field: 'uyduAyari', value: 1 }]), /yazılabilir/);
});

t('dosyada olmayan alan EKLENMEZ', () => {
  const p = GC.parse(v200);
  delete p.channels[0].members.minorNumber;
  throws(() => GC.serialize(p, [{ idx: 0, field: 'minorNumber', value: 5 }]), /alanı yok/);
});

// ═══════════════════════════════════════════════════════ BYTE-SADIKLIK (v100)

t('v100: değişiklik yok → çıktı BİREBİR aynı', () => {
  const p = GC.parse(v100);
  eq(GC.serialize(p, []), v100);
});

t('v100: numara değişince radyo biti korunur', () => {
  const p = GC.parse(v100);
  const radio = p.channels.find((c) => c.isRadio);
  ok(radio, 'radyo kanalı yok');
  const out = GC.serialize(p, [{ idx: radio.idx, field: 'prNum', value: 33 | GC.RADIO_BIT }]);
  const r2 = GC.parse(out).channels[radio.idx];
  eq(r2.number, 33);
  eq(r2.isRadio, true);
});

t('v100: isim yazımı vchName + hexVchName + uzunlukları birlikte günceller', () => {
  const p = GC.parse(v100);
  const out = GC.serialize(p, GC.setNameEdits(p, p.channels[4], 'ÖZEL KANAL'));
  const c2 = GC.parse(out).channels[4];
  eq(c2.name, 'ÖZEL KANAL');
  const hexBytes = Buffer.from(c2.nameHex, 'hex');
  eq(hexBytes[0], 0x15, 'hex alanında UTF-8 göstergesi yok');
  eq(hexBytes.slice(1).toString('utf8'), 'ÖZEL KANAL', 'hex gövde');
});

t('v100: boş ad <vchName></vchName> değil tek boşluk olur', () => {
  const p = GC.parse(v100);
  const out = GC.serialize(p, [{ idx: 1, field: 'vchName', value: '' }]);
  ok(out.includes('<vchName> </vchName>'), 'boş ad tek boşluğa çevrilmedi');
  ok(!out.includes('<vchName></vchName>'), 'boş etiket kaldı');
});

t('v100: satır sonları CRLF olarak korunur', () => {
  const p = GC.parse(v100);
  const out = GC.serialize(p, [{ idx: 0, field: 'prNum', value: 5 }]);
  eq((out.match(/\r\n/g) || []).length, (v100.match(/\r\n/g) || []).length, 'CRLF sayısı değişti');
  ok(!/[^\r]\n/.test(out), 'yalnız LF satır sonu oluştu');
});

// ═══════════════════════════════════════════════════════════ SIRA MOTORU

t('sıra motoru: SVCID+TSID+ONID ile birebir eşleşir', () => {
  const p = GC.parse(v200);
  const eski = p.channels.map((c) => ({
    name: c.name, number: c.number, SVCID: c.SVCID, TSID: c.TSID, ONID: c.ONID,
    frequency: c.frequency, videoPid: c.videoPid, audioPid: c.audioPid,
  }));
  const res = Order.match(eski, p.channels);
  eq(res.matched.length, eski.length, 'hepsi eşleşmeliydi');
  ok(res.matched.every((m) => m.method === 'id'), 'kimlik yöntemiyle eşleşmedi');
  eq(res.onlyNew.length, 0);
  eq(res.onlyOld.length, 0);
});

t('sıra motoru: kimlikler değişse bile isimle eşleşir', () => {
  const p = GC.parse(v200);
  const eski = p.channels.map((c) => ({
    name: c.name, number: 900 + c.idx, SVCID: null, TSID: null, ONID: null,
    frequency: null, videoPid: null, audioPid: null,
  }));
  const res = Order.match(eski, p.channels);
  eq(res.matched.length, eski.length);
  ok(res.matched.every((m) => m.method === 'name'), 'isimle eşleşmedi');
});

t('sıra motoru: frekans ±2 MHz toleransla eşleşir (12380 vs 12379)', () => {
  const yeni = [{ idx: 0, name: 'X', SVCID: null, TSID: null, ONID: null, frequency: 12379, videoPid: 111, audioPid: 222 }];
  const eski = [{ name: 'FARKLI AD', number: 3, SVCID: null, TSID: null, ONID: null, frequency: 12380, videoPid: 111, audioPid: 222 }];
  const res = Order.match(eski, yeni);
  eq(res.matched.length, 1, 'PID/frekans eşleşmesi olmadı');
});

t('sıra motoru: 5 MHz sapma eşleşmez (yanlış eşleşme üretmez)', () => {
  const yeni = [{ idx: 0, name: 'X', SVCID: null, TSID: null, ONID: null, frequency: 12385, videoPid: null, audioPid: null }];
  const eski = [{ name: 'Y', number: 3, SVCID: null, TSID: null, ONID: null, frequency: 12380, videoPid: null, audioPid: null }];
  eq(Order.match(eski, yeni).matched.length, 0);
});

t('sıra motoru: SD→HD adayı önerilir ama otomatik eşleştirilmez', () => {
  const yeni = [{ idx: 0, name: 'KANAL D HD', SVCID: 1, TSID: 1, ONID: 1, frequency: 12245, videoPid: 101, audioPid: 201 }];
  const eski = [{ name: 'KANAL D', number: 4, SVCID: 9, TSID: 9, ONID: 9, frequency: 11012, videoPid: 5, audioPid: 6 }];
  const res = Order.match(eski, yeni);
  eq(res.matched.length, 0, 'otomatik eşleşmemeliydi');
  eq(res.suggestions.length, 1, 'SD→HD önerisi üretilmedi');
  eq(res.suggestions[0].reason, 'sd-hd');
});

t('sıra motoru: numara çakışması olmadan plan üretir', () => {
  const p = GC.parse(v200);
  const eski = p.channels.map((c, i) => ({
    name: c.name, number: (i % 7) + 1, // kasten çakışmalı
    SVCID: c.SVCID, TSID: c.TSID, ONID: c.ONID,
    frequency: c.frequency, videoPid: c.videoPid, audioPid: c.audioPid,
  }));
  const plan = Order.buildPlan(Order.match(eski, p.channels), p.channels);
  const nums = plan.map((x) => x.newNumber);
  eq(new Set(nums).size, nums.length, 'çakışan numara üretildi');
  ok(nums.every((n) => n >= 1 && n < GC.RADIO_BIT), 'numara aralık dışı');
});

t('sıra motoru planı byte-sadık uygulanır ve geri okunur', () => {
  const p = GC.parse(v200);
  const eski = p.channels.map((c) => ({
    name: c.name, number: p.channels.length - c.idx, // ters sıra
    SVCID: c.SVCID, TSID: c.TSID, ONID: c.ONID,
    frequency: c.frequency, videoPid: c.videoPid, audioPid: c.audioPid,
  }));
  const plan = Order.buildPlan(Order.match(eski, p.channels), p.channels);
  const edits = plan.map((x) => GC.setNumberEdit(p.channels[x.idx], x.newNumber));
  const out = GC.serialize(p, edits);
  const p2 = GC.parse(out);
  for (const x of plan) eq(p2.channels[x.idx].number, x.newNumber, `kanal ${x.idx}`);
  eq(p2.channels.length, p.channels.length, 'kanal sayısı değişti');
});

// ═══════════════════════════════════════════════════════════════════ rapor

const w = Math.max(...results.map((r) => r[1].length));
for (const [mark, name, msg] of results) {
  console.log(`  ${mark} ${name.padEnd(w)}${msg ? '   → ' + msg : ''}`);
}
console.log(`\n  ${pass} geçti, ${fail} kaldı\n`);
process.exit(fail ? 1 : 0);
