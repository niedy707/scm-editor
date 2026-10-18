/**
 * TV kilidi testleri — sahte saat ve sahte TV ile; gerçek TV'ye dokunmaz.
 *   node --test tools/kilit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TvKilidi, KilitBekcisi, KILIT_MESAJI } from './net/kilit.mjs';
import { Tv } from './tv-ajan.mjs';

function kur() {
  const dizin = mkdtempSync(join(tmpdir(), 'kilit-'));
  const saat = { t: 1e12 };
  const k = new TvKilidi({ dizin, simdi: () => saat.t });
  return { k, saat, dizin, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}

test('kilit: süreli kilit süresi dolunca kalkar; süresiz kalır; diske yazılır; geçersiz süre reddedilir', async () => {
  const { k, saat, dizin, temizle } = kur();
  await k.kilitle('tv1', 30);
  await k.kilitle('tv2');
  assert.ok(k.bilgi('tv1'));
  assert.equal(k.bilgi('tv2').bitis, null);
  const ikinci = new TvKilidi({ dizin, simdi: () => saat.t });
  await ikinci.yukle();
  assert.deepEqual(Object.keys(ikinci.durum().kilitler).sort(), ['tv1', 'tv2']);
  saat.t += 31 * 60000;
  assert.equal(k.bilgi('tv1'), null);
  assert.ok(k.bilgi('tv2'));
  await k.ac('tv2');
  assert.equal(k.bilgi('tv2'), null);
  await assert.rejects(k.kilitle('tv1', 0), /süre/);
  await assert.rejects(k.kilitle('tv1', 1.5), /süre/);
  temizle();
});

function sahteTv(acik) {
  const olan = [];
  return { id: 'tv1', olan, acikMi: async () => acik.shift() ?? false, toast: async (m) => olan.push(['toast', m]), kapat: async () => olan.push(['kapat']) };
}

test('bekçi: kilitli TV açılınca uyarı + kapat + olay; kapalıysa ya da kilitli değilse dokunmaz', async () => {
  const { k, temizle } = kur();
  const tv = sahteTv([true, false]);
  const b = new KilitBekcisi({ tvler: [tv], kilit: k, bekle: async () => {} });
  assert.equal(await b.denetle(tv), null, 'kilitli değil');
  assert.deepEqual(tv.olan, []);
  await k.kilitle('tv1');
  assert.equal(await b.denetle(tv), 'kapatildi');
  assert.deepEqual(tv.olan, [['toast', KILIT_MESAJI], ['kapat']]);
  assert.equal(k.durum().olaylar[0].tv, 'tv1');
  assert.equal(await b.denetle(tv), 'kapali');
  assert.equal(tv.olan.length, 2);
  temizle();
});

test('kilitli TV: açma (uyan), Apple TV tuşu ve metni 423 ile reddedilir — TV\'ye hiçbir şey gitmez', async () => {
  let wol = 0;
  const tv = new Tv({ id: 'salon', ad: 'Salon', ip: '192.0.2.11', mac: 'aa:bb:cc:dd:ee:01', appletv: { ip: '192.0.2.12', id: 'ABCDEF123456' } }, 'anahtar', {
    wol: async () => { wol++; }, atv: { hazirMi: () => true, iste: async () => { throw new Error('Apple TV\'ye gitmemeli'); } },
  });
  tv.kilit = { bilgi: () => ({ bitis: null }) };
  await assert.rejects(tv.uyan(), (e) => e.kod === 423 && /Salon kilitli/.test(e.message));
  await assert.rejects(tv.appleTus('ENTER'), (e) => e.kod === 423);
  await assert.rejects(tv.appleMetin('a'), (e) => e.kod === 423);
  assert.equal(wol, 0);
});
