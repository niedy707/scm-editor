/**
 * Ayar bekçisi testleri — sahte TV ve sahte saatle; gerçek TV'ye ve Bark'a dokunmaz.
 *   node --test tools/ayar-bekcisi.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AyarBekcisi, ayarOku, farklar, barkGonderici } from './net/ayar-bekcisi.mjs';

/** Sahte TV: `durum` değiştirilerek TV'nin "yanıtları" değiştirilir; `null` alan → o uç hata verir. */
function sahteTv(durum) {
  const sorulan = [];
  return {
    id: 'salon', ad: 'Salon', durum, sorulan,
    async acikMi() { return this.durum.acik; },
    async iste(uri, payload) {
      sorulan.push(uri);
      const d = this.durum;
      if (uri === 'ssap://settings/getSystemSettings') {
        if (payload.category === '') {
          if (!d.eula) throw new Error('500 Application error');
          return { settings: { eulaStatus: d.eula } };
        }
        const v = d.ayar?.[payload.keys[0]];
        if (v == null) throw new Error('500 Application error');
        return { settings: { [payload.keys[0]]: v } };
      }
      if (uri === 'ssap://com.webos.applicationManager/listApps') {
        if (!d.uygulamalar) throw new Error('zaman aşımı');
        return { apps: d.uygulamalar.map(([id, title]) => ({ id, title })) };
      }
      if (uri === 'ssap://config/getConfigs') {
        if (!d.surum) throw new Error('401');
        return { configs: { 'tv.nyx.firmwareVersion': d.surum, 'tv.nyx.platformVersion': '11.2.0' } };
      }
      throw new Error('401 insufficient permissions');
    },
  };
}

const TEMEL = () => ({
  acik: true,
  ayar: { livePlus: 'off', homePromotion: 'off' },
  eula: { acrOnAllowed: false, voiceAllowed: true, generalTermsAllowed: true },
  uygulamalar: [['netflix', 'Netflix'], ['youtube.leanback.v4', 'YouTube']],
  surum: '43.21.77',
});

function kur(durum = TEMEL()) {
  const dizin = mkdtempSync(join(tmpdir(), 'ayar-'));
  const saat = { t: 1e12 };
  const giden = [];
  const tv = sahteTv(durum);
  const bekci = new AyarBekcisi({ tvler: [tv], dizin, simdi: () => saat.t, bildir: async (b, g) => { giden.push([b, g]); return true; } });
  return { bekci, tv, saat, giden, dizin, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}

test('ayar: ilk okuma yalnız "son bilinen" olur; değişmeyen okuma olay üretmez', async () => {
  const { bekci, giden, temizle } = kur();
  assert.equal(await bekci.denetle(bekci.tvler[0]), 'ilk');
  assert.equal(await bekci.denetle(bekci.tvler[0]), 'ayni');
  assert.equal(giden.length, 0);
  assert.equal(bekci.durum().olaylar.length, 0);
  assert.equal(bekci.durum().tvler.salon.surum, '43.21.77');
  temizle();
});

test('ayar: güncelleme ayarı geri açar + uygulama geri gelir → tek olay, tek Bark, kalıcı', async () => {
  const { bekci, tv, giden, dizin, saat, temizle } = kur();
  await bekci.denetle(tv);
  tv.durum.ayar.livePlus = 'on';
  tv.durum.eula.acrOnAllowed = true;
  tv.durum.uygulamalar.push(['com.lge.app.copilot', 'Copilot']);
  tv.durum.surum = '43.22.10';
  saat.t += 3600e3;
  assert.equal(await bekci.denetle(tv), 'degisti');
  assert.equal(giden.length, 1);
  const [baslik, govde] = giden[0];
  assert.match(baslik, /TV ayarı değişti/);
  assert.match(govde, /^Salon: /);
  assert.match(govde, /Live Plus: kapalı → açık/);
  assert.match(govde, /Görüntüleme bilgisi sözleşmesi: kapalı → açık/);
  assert.match(govde, /yeni uygulama: Copilot/);
  assert.match(govde, /yazılım 43\.21\.77 → 43\.22\.10/);
  const o = bekci.durum().olaylar[0];
  assert.equal(o.ne, 'degisti');
  assert.equal(o.bildirildi, true);
  // Yeni örnek diskten okur; aynı durum tekrar olay üretmez.
  await bekci.yaziliyor;
  const ikinci = new AyarBekcisi({ tvler: [tv], dizin, simdi: () => saat.t, bildir: async () => true });
  await ikinci.yukle();
  assert.equal(ikinci.durum().olaylar.length, 1);
  assert.equal(await ikinci.denetle(tv), 'ayni');
  temizle();
});

test('ayar: okunamayan değer (500 / geçici hata) sahte değişiklik üretmez, önceki değer korunur', async () => {
  const { bekci, tv, giden, temizle } = kur();
  tv.durum.ayar = { livePlus: 'off' };   // oturma odası: homePromotion genel uca kapalı
  await bekci.denetle(tv);
  tv.durum.uygulamalar = null;            // listApps zaman aşımı
  tv.durum.eula = null;
  assert.equal(await bekci.denetle(tv), 'ayni');
  assert.equal(giden.length, 0);
  assert.equal(bekci.durum().tvler.salon.uygulamaSayisi, 2);
  assert.equal(bekci.durum().tvler.salon.degerler['sozlesme.acrOnAllowed'], false);
  temizle();
});

test('ayar: kapalı TV\'ye hiçbir şey sorulmaz', async () => {
  const d = TEMEL();
  d.acik = false;
  const { bekci, tv, temizle } = kur(d);
  assert.equal(await bekci.denetle(tv), 'kapali');
  assert.equal(tv.sorulan.length, 0);
  temizle();
});

test('ayar: TV açık ama hiçbir şey okunamadı → olay + Bark, 24 saatte bir kez', async () => {
  const { bekci, tv, giden, saat, temizle } = kur({ acik: true });
  assert.equal(await bekci.denetle(tv), 'okunamadi');
  assert.equal(await bekci.denetle(tv), 'okunamadi');
  assert.equal(giden.length, 1);
  assert.match(giden[0][0], /okuyamadı/);
  saat.t += 25 * 3600e3;
  await bekci.denetle(tv);
  assert.equal(giden.length, 2);
  // Okuma düzelince ilk başarılı okuma "ilk" sayılır (karşılaştıracak değer yok).
  Object.assign(tv.durum, TEMEL());
  assert.equal(await bekci.denetle(tv), 'ilk');
  temizle();
});

test('ayar: webOS 4.5 — sürüm getCurrentSWInformation\'dan', async () => {
  const tv = sahteTv({});
  tv.iste = async (uri) => {
    if (uri === 'ssap://com.webos.service.update/getCurrentSWInformation') return { major_ver: '05', minor_ver: '40.97' };
    throw new Error('500');
  };
  const r = await ayarOku(tv);
  assert.equal(r.surum, '05.40.97');
  assert.equal(r.okunan, 1);
});

test('ayar: farklar — kaldırılan uygulama ve bilinmeyen sözleşme bayrağı', () => {
  const f = farklar(
    { degerler: { 'sozlesme.customAdAllowed': true }, uygulamalar: { a: 'A', b: 'B' }, surum: '1' },
    { degerler: { 'sozlesme.customAdAllowed': false }, uygulamalar: { a: 'A' }, surum: '1' },
  );
  assert.deepEqual(f, ['Sözleşme customAdAllowed: açık → kapalı', 'kaldırılan uygulama: B']);
});

test('ayar: Bark gönderici yalnız "code":200 yanıtını başarı sayar', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'bark-'));
  const betik = join(dizin, 'bark.sh');
  writeFileSync(betik, '#!/bin/sh\n[ -f "$BARK_ENV" ] || { echo "ayar yok" >&2; exit 1; }\ncat "$BARK_ENV"\n');
  chmodSync(betik, 0o755);
  const iyi = join(dizin, 'iyi.env');
  writeFileSync(iyi, '{"code":200,"message":"success"}');
  const kotu = join(dizin, 'kotu.env');
  writeFileSync(kotu, '{"code":400,"message":"failed"}');
  const kayit = [];
  assert.equal(await barkGonderici({ betik, ayar: iyi })('b', 'g'), true);
  assert.equal(await barkGonderici({ betik, ayar: kotu, log: (m) => kayit.push(m) })('b', 'g'), false);
  assert.equal(await barkGonderici({ betik, ayar: join(dizin, 'yok.env'), log: (m) => kayit.push(m) })('b', 'g'), false);
  assert.equal(kayit.length, 2);
  rmSync(dizin, { recursive: true, force: true });
});
