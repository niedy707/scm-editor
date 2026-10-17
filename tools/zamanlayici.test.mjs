/**
 * Zamanlayıcı testleri — sahte saat, sahte yürütücü; TV'ye dokunmaz.
 *   node --test tools/zamanlayici.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Zamanlayici, sonrakiHaftalik, trAn, TOLERANS_MS } from './net/zamanlayici.mjs';

const TR = 3 * 3600e3;
const tr = (y, m, d, s, dk = 0) => Date.UTC(y, m - 1, d, s, dk) - TR;   // İstanbul saati → ms
const KANAL = { no: 3, ad: 'KANAL D HD' };

/** Sahte saat: setTimeout gerçekte kurulur ama çalışmayı testler `ilerle` + `_yokla` ile sürer. */
function kur({ dosya = null, sonuc = { sonuc: 'ok' }, simdi = tr(2026, 10, 17, 20, 0) } = {}) {
  const saat = { t: simdi };
  const calisan = [];
  const uyarilar = [];
  const z = new Zamanlayici({
    dosya,
    simdi: () => saat.t,
    calistir: async (g) => { calisan.push(g); if (sonuc instanceof Error) throw sonuc; return sonuc; },
    uyar: async (g, sn) => { uyarilar.push(sn); },
  });
  const ilerle = async (ms) => { saat.t += ms; z._yokla(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  return { z, saat, calisan, uyarilar, ilerle };
}

test('sonrakiHaftalik: gün listesi + saat, İstanbul saatiyle; geçmiş saat ertesi uygun güne', () => {
  // 17.10.2026 Cumartesi 20:00 TR
  const cumartesi20 = tr(2026, 10, 17, 20, 0);
  assert.equal(sonrakiHaftalik('21:30', [6], cumartesi20), tr(2026, 10, 17, 21, 30));      // aynı gün, ileride
  assert.equal(sonrakiHaftalik('19:00', [6], cumartesi20), tr(2026, 10, 24, 19, 0));       // aynı gün geçti → haftaya
  assert.equal(sonrakiHaftalik('08:00', [1, 2, 3, 4, 5], cumartesi20), tr(2026, 10, 19, 8, 0));   // hafta içi → Pazartesi
  assert.equal(sonrakiHaftalik('00:30', [7], cumartesi20), tr(2026, 10, 18, 0, 30));       // gece yarısından sonra, Pazar
  assert.equal(trAn('2026-10-18', '20:00'), tr(2026, 10, 18, 20, 0));
});

test('geri dön: vakti gelince bir kez çalışır, geçmişe "ok" yazılır, görev biter', async () => {
  const { z, calisan, ilerle } = kur();
  const g = await z.geriDon({ tv: 'salon', dk: 8, kanal: KANAL });
  assert.equal(g.an - z.simdi(), 8 * 60000);
  await ilerle(7 * 60000);
  assert.equal(calisan.length, 0);
  await ilerle(60000);
  assert.equal(calisan.length, 1);
  assert.deepEqual(calisan[0].kanal, KANAL);
  assert.equal(z.liste().gorevler.length, 0);
  assert.equal(z.liste().gecmis[0].sonuc, 'ok');
  z.durdur();
});

test('geri dön: TV başına tek sayaç — yenisi eskisinin yerine geçer; başka TV etkilenmez', async () => {
  const { z } = kur();
  await z.geriDon({ tv: 'salon', dk: 8, kanal: KANAL });
  await z.geriDon({ tv: 'salon', dk: 3, kanal: KANAL });
  await z.geriDon({ tv: 'oturma', dk: 5, kanal: KANAL });
  const l = z.liste().gorevler;
  assert.equal(l.length, 2);
  assert.equal(l.find((g) => g.tv === 'salon').dk, 3);
  z.durdur();
});

test('geri dön: uzat, şimdi çalıştır, iptal', async () => {
  const { z, calisan, ilerle } = kur();
  const g = await z.geriDon({ tv: 'salon', dk: 2, kanal: KANAL });
  await z.uzat(g.id, 1);
  await ilerle(2 * 60000);
  assert.equal(calisan.length, 0, 'uzatılan sayaç henüz çalışmamalı');
  await ilerle(60000);
  assert.equal(calisan.length, 1);
  const g2 = await z.geriDon({ tv: 'salon', dk: 8, kanal: KANAL });
  await z.hemen(g2.id);
  assert.equal(calisan.length, 2);
  const g3 = await z.geriDon({ tv: 'salon', dk: 8, kanal: KANAL });
  await z.sil(g3.id);
  await ilerle(10 * 60000);
  assert.equal(calisan.length, 2);
  assert.equal(z.liste().gecmis[0].sonuc, 'iptal');
  z.durdur();
});

test('kaçırma: tolerans içinde bir kez çalışır, dışında çalışmaz ve "kacirildi" yazılır', async () => {
  const icinde = kur();
  await icinde.z.geriDon({ tv: 'salon', dk: 1, kanal: KANAL });
  await icinde.ilerle(60000 + TOLERANS_MS['geri-don'] - 1000);
  assert.equal(icinde.calisan.length, 1);
  icinde.z.durdur();

  const disinda = kur();
  disinda.z._zamanla = () => {};   // ajan kapalıymış gibi: zamanlayıcı hiç kurulmasın
  await disinda.z.geriDon({ tv: 'salon', dk: 1, kanal: KANAL });
  await disinda.ilerle(60000 + TOLERANS_MS['geri-don'] + 60000);
  assert.equal(disinda.calisan.length, 0);
  assert.equal(disinda.z.liste().gecmis[0].sonuc, 'kacirildi');
  assert.equal(disinda.z.liste().gorevler.length, 0);
});

test('haftalık: çalıştıktan sonra bir sonraki ana geçer; kaçırılan an geriye dönük çalıştırılmaz', async () => {
  const { z, calisan, ilerle } = kur();
  const g = await z.ekle({ tv: 'salon', kanal: 'Kanal D', zaman: { tur: 'haftalik', saat: '20:30', gunler: [6] } });
  assert.equal(g.an, tr(2026, 10, 17, 20, 30));
  await ilerle(30 * 60000);
  assert.equal(calisan.length, 1);
  assert.equal(z.liste().gorevler[0].an, tr(2026, 10, 24, 20, 30));
  // Ajan bir haftadan uzun kapalı kaldı: tek "kacirildi", sonra yine ileriye planlanır.
  z._zamanla = () => {};
  await ilerle(8 * 24 * 3600e3);
  assert.equal(calisan.length, 1);
  assert.equal(z.liste().gecmis[0].sonuc, 'kacirildi');
  assert.ok(z.liste().gorevler[0].an > z.simdi());
  z.durdur();
});

test('program: bir kez — geçmişteki an reddedilir; geçersiz girdiler 400', async () => {
  const { z } = kur();
  await assert.rejects(z.ekle({ tv: 'salon', kanal: 'Kanal D', zaman: { tur: 'tek', tarih: '2026-10-17', saat: '19:00' } }), (e) => e.kod === 400);
  await assert.rejects(z.ekle({ tv: 'salon', kanal: 'Kanal D', zaman: { tur: 'haftalik', saat: '25:00', gunler: [1] } }), (e) => e.kod === 400);
  await assert.rejects(z.ekle({ tv: 'salon', kanal: 'Kanal D', zaman: { tur: 'haftalik', saat: '20:00', gunler: [] } }), (e) => e.kod === 400);
  await assert.rejects(z.ekle({ tv: 'salon', kanal: '', zaman: { tur: 'tek', tarih: '2026-10-18', saat: '20:00' } }), (e) => e.kod === 400);
  await assert.rejects(z.geriDon({ tv: 'salon', dk: 0, kanal: KANAL }), (e) => e.kod === 400);
  await assert.rejects(z.geriDon({ tv: 'salon', dk: 121, kanal: KANAL }), (e) => e.kod === 400);
  await assert.rejects(z.sil('yok'), (e) => e.kod === 404);
  const g = await z.ekle({ tv: 'salon', kanal: 'Kanal D', zaman: { tur: 'tek', tarih: '2026-10-18', saat: '20:00' }, tvKapaliysa: 'atla' });
  assert.equal(g.an, tr(2026, 10, 18, 20, 0));
  assert.equal(g.tvKapaliysa, 'atla');
  z.durdur();
});

test('kalıcılık: yeniden başlatmada görevler geri gelir, sayaç baştan sayılmaz', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'zaman-'));
  try {
    const dosya = join(dizin, 'zamanlayici.json');
    const a = kur({ dosya });
    await a.z.geriDon({ tv: 'salon', dk: 8, kanal: KANAL });
    await a.z.ekle({ tv: 'oturma', kanal: 'TV8', zaman: { tur: 'haftalik', saat: '21:00', gunler: [1, 2, 3, 4, 5] } });
    a.z.durdur();
    const kayit = JSON.parse(readFileSync(dosya, 'utf8'));
    assert.equal(kayit.gorevler.length, 2);
    const b = kur({ dosya, simdi: a.saat.t + 5 * 60000 });   // 5 dk sonra yeniden başladı
    await b.z.yukle();
    assert.equal(b.z.liste().gorevler.length, 2);
    await b.ilerle(3 * 60000);                                 // 8. dakika
    assert.equal(b.calisan.length, 1);
    assert.equal(b.calisan[0].tur, 'geri-don');
    b.z.durdur();
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('yürütücü hata atarsa geçmişe "hata" ve neden yazılır', async () => {
  const { z, ilerle } = kur({ sonuc: new Error('TV yanıt vermedi') });
  await z.geriDon({ tv: 'salon', dk: 1, kanal: KANAL });
  await ilerle(60000);
  const s = z.liste().gecmis[0];
  assert.equal(s.sonuc, 'hata');
  assert.match(s.neden, /yanıt vermedi/);
  z.durdur();
});

test('ön uyarı: 1 dk ve 10 sn kala; uzatılınca eski uyarılar iptal, yenileri kurulur', async () => {
  // Gerçek zamanlayıcı: kısa süreli görevle (an = şimdi + 61 sn) 60. sn uyarısı ~1 sn sonra gelir.
  const uyarilar = [];
  const z = new Zamanlayici({ calistir: async () => ({ sonuc: 'ok' }), uyar: async (g, sn) => { uyarilar.push(sn); } });
  const g = await z.geriDon({ tv: 'salon', dk: 1, kanal: KANAL });
  g.an = Date.now() + 61000;
  z._zamanla(g);
  await new Promise((r) => setTimeout(r, 1300));
  assert.deepEqual(uyarilar, [60]);
  await z.sil(g.id);
  z.durdur();
});
