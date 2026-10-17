/**
 * TV ajanı testleri — TV'ye, ağa ve digiturk'e BAĞLANMADAN (sahte fetch, sahte TV, sahte saat).
 *
 *   node --test tools/tv-ajan.test.mjs
 *
 * Gerçek cihaz davranışı (Wake-on-LAN'ın TV'yi gerçekten açması, tvplus'ın evden çalışması)
 * burada sınanamaz; o doğrulama evde yapılır (TODO.md).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digiturkAyristir, tvplusAyristir, simdiSonraki, trGunu, Rehber } from './net/rehber.mjs';
import { sihirliPaket, yayinAdresi } from './net/wol.mjs';
import { uyandir, Tv, sunucuKur } from './tv-ajan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORNEK = readFileSync(join(ROOT, 'fixtures/rehber/digiturk-ornek.html'), 'utf8');
const TR = 3 * 3600 * 1000;
/** İstanbul saatiyle an. */
const tr = (y, m, d, s, dk = 0) => Date.UTC(y, m - 1, d, s, dk) - TR;
const GUN = trGunu(tr(2026, 10, 16, 12));

// ───────────────────────────────────────────── rehber: ayrıştırma

test('trGunu: UTC gece yarısından önce de İstanbul günü doğru', () => {
  assert.equal(trGunu(Date.UTC(2026, 9, 15, 22, 30)).anahtar, '2026-10-16');   // TR 01:30
  assert.equal(trGunu(Date.UTC(2026, 9, 15, 20, 59)).anahtar, '2026-10-15');   // TR 23:59
});

test('digiturkAyristir: kanallar, varlık çözümü, süre, programsız kanal atlanır', () => {
  const m = digiturkAyristir(ORNEK, GUN);
  assert.deepEqual([...m.keys()].sort(), ['CNNTURK', 'KANALD']);
  const d = m.get('KANALD');
  assert.equal(d.ad, 'KANAL D');
  assert.equal(d.programlar[0].ad, 'Sabah Kuşağı');
  assert.equal(d.programlar[1].ad, 'Akşam Dizisi & Final');
  assert.equal(d.programlar[0].bas, tr(2026, 10, 16, 6));
  assert.equal(d.programlar[0].bit, tr(2026, 10, 16, 8));
  assert.equal(m.get('CNNTURK').programlar[1].ad, "Tartışma 'Masa'");
});

test('digiturkAyristir: gece yarısını geçen program ertesi güne yazılır', () => {
  const p = digiturkAyristir(ORNEK, GUN).get('KANALD').programlar;
  assert.equal(p[2].bas, tr(2026, 10, 16, 23, 30));
  assert.equal(p[2].bit, tr(2026, 10, 17, 0, 30));
  assert.equal(p[3].ad, 'Tekrar Bölüm');
  assert.equal(p[3].bas, tr(2026, 10, 17, 0, 30));
});

test('simdiSonraki: süren program + sonraki, saatler İstanbul saati', () => {
  const p = digiturkAyristir(ORNEK, GUN).get('KANALD').programlar;
  const r = simdiSonraki(p, tr(2026, 10, 16, 21, 15));
  assert.equal(r.simdi.ad, 'Akşam Dizisi & Final');
  assert.equal(r.simdi.bas, '20:00');
  assert.equal(r.simdi.bit, '23:30');
  assert.equal(r.sonraki.ad, 'Gece Filmi');
  // Boşlukta (08:00-20:00 arası yayın yok): şu an yok, sonraki var.
  const b = simdiSonraki(p, tr(2026, 10, 16, 12));
  assert.equal(b.simdi, null);
  assert.equal(b.sonraki.ad, 'Akşam Dizisi & Final');
});

test('tvplusAyristir: saat dilimi, geçersiz kayıt atlanır, sıralı', () => {
  const r = tvplusAyristir({ playbilllist: [
    { name: 'İkinci', starttime: '2026-10-16 21:00:00 UTC+03:00', endtime: '2026-10-16 22:00:00 UTC+03:00' },
    { name: 'Birinci &amp; Ön', starttime: '2026-10-16 20:00:00 UTC+03:00', endtime: '2026-10-16 21:00:00 UTC+03:00' },
    { name: 'Bozuk', starttime: 'dün', endtime: '2026-10-16 22:00:00 UTC+03:00' },
    { name: '', starttime: '2026-10-16 20:00:00 UTC+03:00', endtime: '2026-10-16 21:00:00 UTC+03:00' },
  ] });
  assert.deepEqual(r.map((p) => p.ad), ['Birinci & Ön', 'İkinci']);
  assert.equal(r[0].bas, tr(2026, 10, 16, 20));
  assert.deepEqual(tvplusAyristir(null), []);
});

// ───────────────────────────────────────────── rehber: önbellek ve kaynak sırası

/** Gerçek işaretlemeyle n kanallı sayfa (sözleşme: < 10 kanal hata). */
function sayfa(n, ekle = '') {
  const kanal = (ad, prog) => `<div class="swiper-slide channelContent">
    <input type="hidden" id="channelID" name="channelID" value="${ad}" />
    <div class="tvGuideResult-box-wholeDates channelDetail">
      <span class="tvGuideResult-box-wholeDates-time-hour">20:00</span>
      <span class="tvGuideResult-box-wholeDates-time-totalMinute">- 120dk</span>
      <span class="tvGuideResult-box-wholeDates-title" title="${prog}">${prog}</span>
    </div></div>`;
  return Array.from({ length: n }, (_, i) => kanal(`DOLGU ${i}`, `Program ${i}`)).join('') + ekle;
}

function sahteFetch(govde, { durum = 200 } = {}) {
  const f = async (url) => {
    f.cagrilar.push(String(url));
    if (govde instanceof Error) throw govde;
    return { ok: durum === 200, status: durum, text: async () => govde };
  };
  f.cagrilar = [];
  return f;
}

test('Rehber: bellek → disk önbelleği; yeniden başlatmada ağa çıkmaz', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'rehber-'));
  try {
    const an = tr(2026, 10, 16, 21);
    const f = sahteFetch(sayfa(12, ORNEK));
    const r = new Rehber({ dizin, fetchFn: f, simdi: () => an });
    const k = await r.kanal('Kanal D');
    assert.equal(k.simdi.ad, 'Akşam Dizisi & Final');
    assert.equal(k.kaynak, 'digiturk');
    await r.kanal('CNN Türk TV');
    assert.equal(f.cagrilar.length, 1, 'aynı gün ikinci kez çekilmez');
    assert.match(f.cagrilar[0], /Day=10%2F16%2F2026\+00%3A00%3A00/);

    const f2 = sahteFetch(new Error('ağ yok'));
    const r2 = new Rehber({ dizin, fetchFn: f2, simdi: () => an + 3600e3 });
    assert.equal((await r2.kanal('KANAL D HD')).simdi.ad, 'Akşam Dizisi & Final');
    assert.equal(f2.cagrilar.length, 0, 'diskteki taze kayıt yeter');
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('Rehber: dün yalnız önbellekten okunur (digiturk geçmiş günü boş verir)', async () => {
  const f = sahteFetch(sayfa(12, ORNEK));
  const r = new Rehber({ fetchFn: f, simdi: () => tr(2026, 10, 17, 0, 15) });
  await r.kanal('Kanal D');
  // 00:15'te Kanal D'de digiturk'e göre yayın yok → tvplus yedeği de denenir; digiturk'e tek istek.
  const dt = f.cagrilar.filter((u) => u.includes('digiturk'));
  assert.equal(dt.length, 1);
  assert.match(dt[0], /Day=10%2F17%2F2026/, 'yalnız bugün istenir');
});

test('Rehber: gece yarısından sonra dünün süren programı bulunur', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'rehber-'));
  try {
    // Dün (16.10) çekilip diske yazılmış; bugün (17.10) sayfasında Kanal D yok.
    await new Rehber({ dizin, fetchFn: sahteFetch(sayfa(12, ORNEK)), simdi: () => tr(2026, 10, 16, 21) }).kanal('Kanal D');
    const r = new Rehber({ dizin, fetchFn: sahteFetch(sayfa(12)), simdi: () => tr(2026, 10, 17, 0, 10) });
    const k = await r.kanal('Kanal D');
    assert.equal(k.simdi.ad, 'Gece Filmi');
    assert.equal(k.sonraki.ad, 'Tekrar Bölüm');
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('Rehber: biçim değişmişse (< 10 kanal) sessizce boş dönmez, hata 15 dk tekrarlanmaz', async () => {
  let an = tr(2026, 10, 16, 21);
  const f = sahteFetch(ORNEK);   // yalnız 2 kanal
  const r = new Rehber({ fetchFn: f, simdi: () => an });
  await assert.rejects(r.gun(trGunu(an)), /yalnız 2 kanal/);
  await assert.rejects(r.gun(trGunu(an)), /yalnız 2 kanal/);
  assert.equal(f.cagrilar.length, 1, 'olumsuz önbellek');
  an += 16 * 60 * 1000;
  await assert.rejects(r.gun(trGunu(an)));
  assert.equal(f.cagrilar.length, 2, '15 dk sonra yeniden dener');
});

test('Rehber: ağ hatasında bayat veri kullanılır', async () => {
  let an = tr(2026, 10, 16, 8, 30);
  let govde = sayfa(12, ORNEK);
  let istek = 0;
  const fetchFn = async () => {
    istek++;
    if (govde instanceof Error) throw govde;
    return { ok: true, status: 200, text: async () => govde };
  };
  const r = new Rehber({ fetchFn, simdi: () => an });
  await r.kanal('Kanal D');
  govde = new Error('ağ yok');
  an += 7 * 3600e3;   // 15:30 — tazelik (6 sa) geçti, aynı gün
  const once = istek;
  const k = await r.kanal('Kanal D');
  assert.ok(istek > once, 'yeniden çekmeyi denedi');
  assert.equal(k.simdi, null);
  assert.equal(k.sonraki.ad, 'Akşam Dizisi & Final');
});

test('Rehber: digiturk\'te programı olmayan kanal için tvplus yedeği', async () => {
  const fetchFn = async (url, ops = {}) => {
    if (String(url).includes('digiturk')) return { ok: true, status: 200, text: async () => sayfa(12) };
    if (String(url).endsWith('/Authenticate')) return { ok: true, status: 200, headers: { getSetCookie: () => ['JSESSIONID=abc; Path=/'] }, json: async () => ({}) };
    assert.equal(ops.headers.Cookie, 'JSESSIONID=abc');
    assert.equal(JSON.parse(ops.body).channelid, '87');
    return { ok: true, status: 200, json: async () => ({ playbilllist: [
      { name: 'Gece Bülteni', starttime: '2026-10-16 20:00:00 UTC+03:00', endtime: '2026-10-16 22:00:00 UTC+03:00' },
    ] }) };
  };
  const r = new Rehber({ fetchFn, simdi: () => tr(2026, 10, 16, 21) });
  const k = await r.kanal('Habertürk TV');
  assert.equal(k.simdi.ad, 'Gece Bülteni');
  assert.equal(k.kaynak, 'tvplus');
});

test('Rehber: tvplus ulaşılamıyorsa 15 dk yeniden denenmez', async () => {
  let an = tr(2026, 10, 16, 21);
  let tvplus = 0;
  const fetchFn = async (url) => {
    if (String(url).includes('digiturk')) return { ok: true, status: 200, text: async () => sayfa(12) };
    tvplus++;
    throw new Error('bağlantı kurulamadı');
  };
  const r = new Rehber({ fetchFn, simdi: () => an });
  assert.equal(await r.kanal('Habertürk TV'), null);
  await r.kanal('Kanal D');
  assert.equal(tvplus, 1);
  an += 16 * 60 * 1000;
  await r.kanal('Habertürk TV');
  assert.equal(tvplus, 2);
});

// ───────────────────────────────────────────── Wake-on-LAN

test('sihirliPaket: 6×FF + 16×MAC, ayraç biçimi fark etmez', () => {
  const p = sihirliPaket('02:1A:2B:3C:4D:5E');
  assert.equal(p.length, 102);
  assert.ok(p.subarray(0, 6).every((b) => b === 0xff));
  for (let i = 0; i < 16; i++) assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString('hex'), '021a2b3c4d5e');
  assert.deepEqual(sihirliPaket('02-1a-2b-3c-4d-5e'), p);
  assert.throws(() => sihirliPaket('02:1a:2b'), /geçersiz MAC/);
});

test('yayinAdresi: TV\'nin alt ağındaki arayüzden; bulunamazsa /24', () => {
  const ara = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.0.9', netmask: '255.255.255.255' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.8.5', netmask: '255.255.252.0' }],
  };
  assert.equal(yayinAdresi('192.168.9.40', ara), '192.168.11.255');
  assert.equal(yayinAdresi('172.16.5.9', ara), '172.16.5.255');
  assert.equal(yayinAdresi('172.16.5.9', null), '172.16.5.255');
});

// ───────────────────────────────────────────── uyandırma döngüsü

function sahteSaat() {
  let t = 0;
  return { simdi: () => t, bekle: async (ms) => { t += ms; } };
}

test('uyandir: hazırsa paket göndermez', async () => {
  let wol = 0;
  const r = await uyandir({ hazirMi: async () => true, wol: async () => { wol++; }, ...sahteSaat() });
  assert.deepEqual(r, { uyandirildi: false, wolSayisi: 0 });
  assert.equal(wol, 0);
});

test('uyandir: paket gönderir, 5 sn\'de bir yineler, hazır olunca döner', async () => {
  const s = sahteSaat();
  let wol = 0;
  const r = await uyandir({ hazirMi: async () => s.simdi() >= 12000, wol: async () => { wol++; }, ...s });
  assert.equal(r.uyandirildi, true);
  assert.equal(wol, 2);            // 0. ve 6. sn (5 sn geçtikten sonraki ilk yoklamada); 12. sn'de hazır
  assert.equal(r.wolSayisi, 2);
});

test('uyandir: açılmazsa zaman aşımı, paket sayısıyla', async () => {
  const r = await uyandir({ hazirMi: async () => false, wol: async () => {}, sureMs: 20000, ...sahteSaat() });
  assert.equal(r.zamanAsimi, true);
  assert.ok(r.wolSayisi >= 3);
});

// ───────────────────────────────────────────── Tv: "her türlü o kanalı aç"

/**
 * SSAP'a hiç dokunmayan Tv: bağlantı/istek/kanal listesi sahte, ekrandaki kanal durumlu.
 * `geriAl`: uyanmadan sonraki ilk N kanal komutunu TV "kabul edip" uygulamaz (16.10.2026'da
 * görülen: açılışını bitirirken son kanala döndü). `hepGeriAl`: hiç uygulamaz.
 */
function sahteTv({ acik = false, acilirMi = true, mac = 'aa:bb:cc:dd:ee:ff', liste, geriAl = 0, hepGeriAl = false, onPlan = 'com.webos.app.livetv', teshisDizini = null, girisler = [{ id: 'HDMI_2', label: 'Apple OTT', appId: 'com.webos.app.hdmi2' }] } = {}) {
  const s = sahteSaat();
  const olaylar = [];
  const kanallar = liste || [
    { no: 3, ad: 'KANAL D HD', channelId: 'k3' },
    { no: 12, ad: 'CNN TÜRK HD', channelId: 'c12' },
  ];
  const durum = { kanal: { channelNumber: '7', channelName: 'TRT 1 HD', channelId: 't7' }, onPlan };
  const tv = new Tv({ id: 'oda', ad: 'Oda', ip: '192.0.2.10', mac }, 'anahtar', {
    wol: async (m, ip) => { olaylar.push(`wol ${m} ${ip}`); if (acilirMi) acik = true; },
    uyanma: { simdi: s.simdi, bekle: s.bekle },
    teshisDizini,
  });
  tv.hazirMi = async () => acik;
  tv.kanallar = async () => kanallar;
  tv.ekran = async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  tv.iste = async (uri, payload) => {
    if (uri === 'ssap://tv/getCurrentChannel') return durum.kanal;
    if (uri.endsWith('/getForegroundAppInfo')) return { appId: durum.onPlan };
    if (uri === 'ssap://tv/getExternalInputList') return { devices: girisler };
    if (uri.endsWith('/listLaunchPoints')) return { launchPoints: [] };
    if (uri === 'ssap://system.launcher/launch') durum.onPlan = payload.id;
    olaylar.push(`${uri} ${JSON.stringify(payload)}`);
    if (uri === 'ssap://tv/openChannel' && !hepGeriAl && !(geriAl-- > 0)) {
      const k = kanallar.find((x) => x.channelId === payload.channelId);
      durum.kanal = { channelNumber: String(k.no), channelName: k.ad, channelId: k.channelId };
      durum.onPlan = 'com.webos.app.livetv';
    }
    return {};
  };
  return { tv, olaylar, durum };
}

const kanalKomutlari = (olaylar) => olaylar.filter((o) => o.startsWith('ssap://tv/openChannel'));

test('kanalAc: TV açıksa uyandırmadan doğrudan kanalı açar', async () => {
  const { tv, olaylar } = sahteTv({ acik: true });
  const k = await tv.kanalAc({ ad: 'Kanal D' });
  assert.deepEqual(k, { no: 3, ad: 'KANAL D HD', acildi: false });
  assert.deepEqual(olaylar, ['ssap://tv/openChannel {"channelId":"k3"}']);
});

test('kanalAc: TV kapalıysa önce açar, sonra kanalı açar', async () => {
  const { tv, olaylar } = sahteTv({ acik: false });
  const k = await tv.kanalAc({ ad: 'CNN Türk TV' });
  assert.equal(k.acildi, true);
  assert.equal(k.yineleme, 0);
  assert.equal(k.no, 12);
  assert.equal(olaylar[0], 'wol aa:bb:cc:dd:ee:ff 192.0.2.10');
  assert.equal(olaylar.at(-1), 'ssap://tv/openChannel {"channelId":"c12"}');
});

test('kanalAc: yeni açılan TV ilk istekleri reddederse yeniden dener', async () => {
  const { tv, olaylar } = sahteTv({ acik: false });
  let red = 2;
  const iste = tv.iste;
  tv.iste = async (uri, p) => { if (red-- > 0) throw new Error('canlı yayın hazır değil'); return iste(uri, p); };
  const k = await tv.kanalAc({ no: 3 });
  assert.equal(k.no, 3);
  assert.equal(olaylar.filter((o) => o.startsWith('ssap://tv/openChannel')).length, 1);
});

test('kanalAc: uyanan TV son kanala dönerse fark edilir ve komut yinelenir', async () => {
  const { tv, olaylar, durum } = sahteTv({ acik: false, geriAl: 1 });
  const k = await tv.kanalAc({ ad: 'Kanal D' });
  assert.deepEqual(k, { no: 3, ad: 'KANAL D HD', acildi: true, yineleme: 1 });
  assert.equal(kanalKomutlari(olaylar).length, 2);
  assert.equal(durum.kanal.channelId, 'k3');
});

test('kanalAc: TV son HDMI girişinde açılırsa canlı yayına geçirilir', async () => {
  const { tv, durum } = sahteTv({ acik: false, onPlan: 'com.webos.app.hdmi1', geriAl: 1 });
  const k = await tv.kanalAc({ ad: 'Kanal D' });
  assert.equal(k.yineleme, 1);
  assert.equal(durum.onPlan, 'com.webos.app.livetv');
});

test('kanalAc: kanal hiç tutmazsa "açıldı" denmez — 502 ve teşhis görüntüsü', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'teshis-'));
  try {
    const { tv, olaylar } = sahteTv({ acik: false, hepGeriAl: true, teshisDizini: dizin });
    await assert.rejects(tv.kanalAc({ ad: 'Kanal D' }), (e) => e.kod === 502 && /ekrana gelmedi/.test(e.message) && /7 TRT 1 HD/.test(e.message));
    assert.equal(kanalKomutlari(olaylar).length, 4, 'ilk komut + en çok 3 yineleme');
    const dosyalar = readdirSync(dizin);
    assert.equal(dosyalar.length, 1);
    assert.match(dosyalar[0], /^uyanma-oda-.*\.jpg$/);
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('kanalAc: TV zaten açıksa doğrulama beklenmez (hızlı yol)', async () => {
  const { tv, olaylar } = sahteTv({ acik: true, hepGeriAl: true });
  assert.deepEqual(await tv.kanalAc({ ad: 'Kanal D' }), { no: 3, ad: 'KANAL D HD', acildi: false });
  assert.equal(kanalKomutlari(olaylar).length, 1);
});

test('kanalAc: MAC yoksa 409, açılmazsa 504 ve ayar ipucu', async () => {
  const yok = sahteTv({ mac: null }).tv;
  await assert.rejects(yok.kanalAc({ ad: 'Kanal D' }), (e) => e.kod === 409 && /MAC/.test(e.message));
  const acilmaz = sahteTv({ acilirMi: false }).tv;
  await assert.rejects(acilmaz.kanalAc({ ad: 'Kanal D' }), (e) => e.kod === 504 && /Wi-Fi ile aç/.test(e.message));
});

test('kanalAc: bilinmeyen kanal 404', async () => {
  const { tv } = sahteTv({ acik: true });
  await assert.rejects(tv.kanalAc({ ad: 'Yok TV' }), (e) => e.kod === 404);
});

test('giriş: Apple TV, TV\'nin giriş adından bulunur; canlı yayına dönülür; durum kaynağı söyler', async () => {
  const { tv, olaylar, durum } = sahteTv({ acik: true });
  assert.deepEqual(await tv.girisDegistir('apple'), { kaynak: 'apple', uygulama: 'com.webos.app.hdmi2' });
  assert.equal(durum.onPlan, 'com.webos.app.hdmi2');
  assert.equal((await tv.durum()).kaynak, 'apple');
  assert.deepEqual(await tv.girisDegistir('canli'), { kaynak: 'canli', uygulama: 'com.webos.app.livetv' });
  assert.equal((await tv.durum()).kaynak, 'canli');
  assert.equal(olaylar.filter((o) => o.startsWith('ssap://system.launcher/launch')).length, 2);
});

test('giriş: keyfi hedef 400, Apple TV girişi yoksa 404, kapalı TV önce açılır', async () => {
  const { tv } = sahteTv({ acik: true });
  await assert.rejects(tv.girisDegistir('com.netflix'), (e) => e.kod === 400);
  const yok = sahteTv({ acik: true, girisler: [{ id: 'HDMI_1', label: 'HDMI 1', appId: 'com.webos.app.hdmi1' }] }).tv;
  await assert.rejects(yok.girisDegistir('apple'), (e) => e.kod === 404 && /Apple TV girişi bulunamadı/.test(e.message));
  const kapali = sahteTv({ acik: false });
  await kapali.tv.girisDegistir('apple');
  assert.equal(kapali.olaylar[0], 'wol aa:bb:cc:dd:ee:ff 192.0.2.10');
});

// ───────────────────────────────────────────── HTTP uçları

const TOKEN = 'x'.repeat(40);

async function sunucuyla(tvler, ops, fn) {
  const s = sunucuKur(tvler, { token: TOKEN, log: () => {}, ...ops });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const taban = `http://127.0.0.1:${s.address().port}`;
  const iste = (yol, govde, { token = TOKEN } = {}) => fetch(taban + yol, {
    method: govde ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: govde ? JSON.stringify(govde) : undefined,
  });
  try { await fn(iste); } finally { await new Promise((r) => s.close(r)); }
}

test('HTTP: belirteçsiz 401, bilinmeyen TV 404, geçersiz kanal 400', async () => {
  const { tv } = sahteTv({ acik: true });
  await sunucuyla([tv], {}, async (iste) => {
    assert.equal((await iste('/tvler', null, { token: 'y'.repeat(40) })).status, 401);
    assert.equal((await iste('/kanal', { tv: 'yok', ad: 'Kanal D' })).status, 404);
    assert.equal((await iste('/kanal', { tv: 'oda' })).status, 400);
    assert.equal((await iste('/kanal', { tv: 'oda', no: '3; rm' })).status, 400);
  });
});

test('HTTP: /kanal kapalı TV\'yi açıp kanalı açar, /ac yalnız açar', async () => {
  const { tv, olaylar } = sahteTv({ acik: false });
  await sunucuyla([tv], {}, async (iste) => {
    const r = await iste('/kanal', { tv: 'oda', ad: 'Kanal D' });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).kanal, { no: 3, ad: 'KANAL D HD', acildi: true, yineleme: 0 });
    const a = await iste('/ac', { tv: 'oda' });
    assert.deepEqual(await a.json(), { ok: true, uyandirildi: false });
    assert.equal(olaylar.filter((o) => o.startsWith('wol')).length, 1);
  });
});

test('HTTP: /giris yalnız iki hedef kabul eder', async () => {
  const { tv } = sahteTv({ acik: true });
  await sunucuyla([tv], {}, async (iste) => {
    assert.equal((await iste('/giris', { tv: 'oda', hedef: 'youtube' })).status, 400);
    const r = await iste('/giris', { tv: 'oda', hedef: 'apple' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, kaynak: 'apple', uygulama: 'com.webos.app.hdmi2' });
  });
});

test('HTTP: /ac açılmayan TV için 504 ve okunur hata', async () => {
  const { tv } = sahteTv({ acilirMi: false });
  await sunucuyla([tv], {}, async (iste) => {
    const r = await iste('/ac', { tv: 'oda' });
    assert.equal(r.status, 504);
    assert.match((await r.json()).hata, /Wi-Fi ile aç/);
  });
});

test('HTTP: /epg rehberden gelir, TV kapalıyken de çalışır, numara önbellekten', async () => {
  const { tv } = sahteTv({ acik: false });
  tv.liste = [{ no: 3, ad: 'KANAL D HD', channelId: 'k3' }];
  const rehber = { kanal: async (ad) => (ad === 'Kanal D' ? { simdi: { ad: 'Dizi', bas: '20:00', bit: '22:00' }, sonraki: null, kaynak: 'digiturk' } : null) };
  await sunucuyla([tv], { rehber }, async (iste) => {
    const j = await (await iste('/epg', { tv: 'oda', adlar: ['Kanal D', 'Star TV'] })).json();
    assert.deepEqual(j.kanallar[0], { ad: 'Kanal D', no: 3, simdi: { ad: 'Dizi', bas: '20:00', bit: '22:00' }, sonraki: null, kaynak: 'digiturk' });
    assert.deepEqual(j.kanallar[1], { ad: 'Star TV', no: null, simdi: null, sonraki: null, kaynak: null });
  });
});

test('HTTP: /tvler bir TV uyandırılırken sırada beklemez', async () => {
  const { tv } = sahteTv({ acik: true });
  tv.durum = async () => ({ id: 'oda', acik: true });
  let birak;
  tv.sirayla(() => new Promise((r) => { birak = r; }));   // uzun süren iş (uyandırma gibi)
  await sunucuyla([tv], {}, async (iste) => {
    const r = await Promise.race([
      iste('/tvler').then((x) => x.json()),
      new Promise((_, red) => setTimeout(() => red(new Error('/tvler sırada bekledi')), 1000)),
    ]);
    assert.deepEqual(r, { tvler: [{ id: 'oda', acik: true }] });
  });
  birak();
});
