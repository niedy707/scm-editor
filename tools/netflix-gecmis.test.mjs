/**
 * Netflix izleme geçmişi doldurucu testleri — sahte Netflix yanıtları ve sahte izleme kaydıyla; ağa çıkmaz.
 *   node --test tools/netflix-gecmis.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ogeyiCoz, eslestir, NetflixGecmisi, NetflixDoldurucu } from './net/netflix-gecmis.mjs';
import { IzlemeKaydi } from './net/izleme.mjs';

const TR = 3 * 3600e3;
const tr = (s, dk = 0) => Date.UTC(2026, 9, 18, s, dk) - TR;
const dizi = (dk, bolum, sezon = '1. Sezon') => ({ date: tr(13, dk), seriesTitle: 'Bir Dizi', episodeTitle: bolum, seasonDescriptor: sezon, title: bolum, movieID: 1 });

test('kayıt çözme ve eşleştirme: kesitin süresine düşen bölüm(ler), film; dışarıdakiler alınmaz', () => {
  assert.deepEqual(ogeyiCoz(dizi(28, '1. Bölüm')), { zaman: tr(13, 28), dizi: 'Bir Dizi', sezon: 1, bolumAdi: '1. Bölüm', baslik: null });
  assert.equal(ogeyiCoz({ date: 1, title: 'Bir Film' }).baslik, 'Bir Film');
  const gecmis = [dizi(28, '1. Bölüm'), dizi(55, '2. Bölüm'), { date: tr(9, 0), title: 'Sabah Filmi' }].map(ogeyiCoz);
  assert.equal(eslestir({ bas: tr(13, 10), bit: tr(13, 30) }, gecmis), 'Bir Dizi S1 — 1. Bölüm');
  assert.equal(eslestir({ bas: tr(13, 10), bit: tr(13, 56) }, gecmis), 'Bir Dizi S1 — 1. Bölüm · 2. Bölüm');
  assert.equal(eslestir({ bas: tr(8, 50), bit: tr(9, 5) }, gecmis), 'Sabah Filmi');
  assert.equal(eslestir({ bas: tr(11, 0), bit: tr(12, 0) }, gecmis), null);
});

function sahteNetflix({ guid = 'G1', ogeler = [] } = {}) {
  const istekler = [];
  const getir = async (url, opt = {}) => {
    istekler.push({ url, cerez: opt.headers?.Cookie });
    if (url.includes('/settings/viewed')) {
      return { status: guid ? 200 : 302, ok: !!guid, text: async () => (guid ? `<script>x={"userInfo":{"data":{"name":"Profil","userGuid":"${guid}"}}}</script>` : '') };
    }
    return { status: 200, ok: true, json: async () => ({ jsonGraph: { aui: { viewingActivity: { value: { viewedItems: ogeler } } } } }) };
  };
  return { getir, istekler };
}

function kur() {
  const dizin = mkdtempSync(join(tmpdir(), 'nfg-'));
  writeFileSync(join(dizin, 'netflix.cerez'), 'NETFLIX_ID=a\nSECURE_NETFLIX_ID=b\n');
  return { dizin, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}

test('geçmiş okuma: çerezle oturum → etkin profilin kayıtları, en yeniden eskiye; çerez geçersizse null ve yeniden denenmez', async () => {
  const k = kur();
  const n = sahteNetflix({ ogeler: [dizi(28, '1. Bölüm'), dizi(55, '2. Bölüm')] });
  const g = new NetflixGecmisi({ cerezDosyasi: join(k.dizin, 'netflix.cerez'), getir: n.getir });
  const liste = await g.oku();
  assert.deepEqual(liste.map((x) => x.bolumAdi), ['2. Bölüm', '1. Bölüm']);
  assert.equal(n.istekler[0].cerez, 'NetflixId=a; SecureNetflixId=b');
  const gecersiz = sahteNetflix({ guid: null });
  const g2 = new NetflixGecmisi({ cerezDosyasi: join(k.dizin, 'netflix.cerez'), getir: gecersiz.getir });
  assert.equal(await g2.oku(), null);
  assert.equal(await g2.oku(), null);
  assert.equal(gecersiz.istekler.length, 1, 'geçersiz çerezle ikinci kez gidilmez');
  assert.equal(await new NetflixGecmisi({ cerezDosyasi: join(k.dizin, 'yok'), getir: gecersiz.getir }).oku(), null);
  k.temizle();
});

test('doldurucu: başlığı eksik Netflix kesiti yoksa Netflix\'e hiç gidilmez; varsa eşleşen başlık kayda işlenir', async () => {
  const k = kur();
  const saat = { t: tr(14, 0) };
  const iz = new IzlemeKaydi({ dizin: join(k.dizin, 'izleme'), tvler: [], simdi: () => saat.t });
  await iz.yukle();
  const n = sahteNetflix({ ogeler: [dizi(28, '1. Bölüm')] });
  const d = new NetflixDoldurucu({ izleme: iz, gecmis: new NetflixGecmisi({ cerezDosyasi: join(k.dizin, 'netflix.cerez'), getir: n.getir }), simdi: () => saat.t });
  assert.equal(await d.tur(), null);
  assert.equal(n.istekler.length, 0, 'eksik yok → sorgu yok');
  await iz._yaz('oturma', { bas: tr(13, 10), kaynak: 'apple', uygulama: 'Netflix', program: null }, tr(13, 30));
  await iz._yaz('oturma', { bas: tr(12, 0), kaynak: 'apple', uygulama: 'YouTube', program: null }, tr(12, 20));
  assert.equal(await d.tur(), 1);
  const ks = await iz.kesitler({ bas: tr(0), bit: tr(23, 59) });
  const nf = ks.find((x) => x.uygulama === 'Netflix');
  assert.deepEqual([nf.program, nf.ek], ['Bir Dizi S1 — 1. Bölüm', 'netflix-gecmis']);
  assert.equal(ks.find((x) => x.uygulama === 'YouTube').program, null, 'Netflix dışı kesite dokunulmaz');
  const once = n.istekler.length;
  assert.equal(await d.tur(), null, 'artık eksik yok');
  assert.equal(n.istekler.length, once);
  // ek dosyası kalıcı
  const iz2 = new IzlemeKaydi({ dizin: join(k.dizin, 'izleme'), tvler: [], simdi: () => saat.t });
  await iz2.yukle();
  assert.equal((await iz2.kesitler({ bas: tr(0), bit: tr(23, 59) })).find((x) => x.uygulama === 'Netflix').program, 'Bir Dizi S1 — 1. Bölüm');
  k.temizle();
});

test('doldurucu takvimi: izlenen başlıksız Netflix varsa hemen; veri yoksa 15 → 30 → 60 dk; pasif/kısa kesit tetiklemez', async () => {
  const k = kur();
  const saat = { t: tr(14, 0) };
  const iz = new IzlemeKaydi({ dizin: join(k.dizin, 'izleme'), tvler: [], simdi: () => saat.t });
  await iz.yukle();
  const n = sahteNetflix({ ogeler: [] });
  const sorgular = () => n.istekler.filter((x) => x.url.includes('/settings/viewed')).length;
  const d = new NetflixDoldurucu({ izleme: iz, gecmis: new NetflixGecmisi({ cerezDosyasi: join(k.dizin, 'netflix.cerez'), getir: n.getir }), simdi: () => saat.t });
  await iz._yaz('oturma', { bas: tr(13, 50), kaynak: 'apple', uygulama: 'Netflix', program: null, pasif: 'bekleme' }, tr(13, 58));
  await iz._yaz('oturma', { bas: tr(13, 58), kaynak: 'apple', uygulama: 'Netflix', program: null }, tr(13, 59));
  assert.equal(await d.tur(), null, 'yalnız pasif ve 2 dk\'dan kısa: sorgu yok');
  assert.equal(sorgular(), 0);
  await iz._yaz('oturma', { bas: tr(13, 59), kaynak: 'apple', uygulama: 'Netflix', program: null }, tr(14, 0));
  await iz._yaz('oturma', { bas: tr(14, 0), kaynak: 'apple', uygulama: 'Netflix', program: null }, tr(14, 5));
  saat.t = tr(14, 5);
  assert.equal(await d.tur(), 0, 'izlenen başlıksız → hemen sorgu');
  const dene = async (dk) => { saat.t = tr(14, 5) + dk * 60000; await d.tur(); return sorgular(); };
  assert.equal(await dene(14), 1, '15 dk dolmadan yok');
  assert.equal(await dene(15), 2, '15 dk sonra');
  assert.equal(await dene(44), 2);
  assert.equal(await dene(45), 3, 'sonra 30 dk');
  assert.equal(await dene(104), 3);
  assert.equal(await dene(105), 4, 'sonra 60 dk');
  assert.equal(await dene(165), 5, 'yine 60 dk');
  k.temizle();
});
