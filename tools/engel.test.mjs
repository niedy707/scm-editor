/**
 * YouTube engelleri testleri — sahte YouTube yanıtları ve sahte TV ile; ağa ve TV'ye dokunmaz.
 *   node --test tools/engel.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngelListesi, EngelBekcisi, linkCoz, katla, kanalAdiAyikla, MESAJ, UYARI } from './net/engel.mjs';

test('link çözme: video ve kanal biçimleri; düz metin link sayılmaz', () => {
  assert.deepEqual(linkCoz('https://www.youtube.com/watch?v=abcdefghijk&t=30s'), { tur: 'video', id: 'abcdefghijk' });
  assert.deepEqual(linkCoz('youtu.be/abcdefghijk?si=x'), { tur: 'video', id: 'abcdefghijk' });
  assert.deepEqual(linkCoz('https://m.youtube.com/shorts/abcdefghijk'), { tur: 'video', id: 'abcdefghijk' });
  assert.deepEqual(linkCoz('https://www.youtube.com/@OrnekKanal/videos'), { tur: 'kanal', yol: '@OrnekKanal' });
  assert.deepEqual(linkCoz('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'), { tur: 'kanal', yol: 'channel/UCabcdefghijklmnopqrstuv' });
  assert.equal(linkCoz('minecraft'), null);
  assert.equal(linkCoz('https://example.com/watch?v=abcdefghijk'), null);
});

test('katlama: Türkçe büyük/küçük harf ve aksan farkı gözetilmez', () => {
  assert.equal(katla('MİNECRAFT'), katla('minecraft'));
  assert.equal(katla('MINECRAFT'), katla('minecraft'));
  assert.equal(katla('ÇOCUK Şarkıları'), 'cocuk sarkilari');
});

function liste(getir = async () => { throw new Error('ağa çıkmamalı'); }) {
  const dizin = mkdtempSync(join(tmpdir(), 'engel-'));
  const l = new EngelListesi({ dizin, getir });
  return { l, dizin, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}
const yanit = (govde, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => govde, text: async () => govde });

test('ekleme: video linki başlık+kanalı oEmbed\'den, kanal linki adı kanal sayfasından alır; aynısı iki kez eklenmez', async () => {
  const { l, dizin, temizle } = liste(async (url) => {
    if (url.includes('/oembed')) return yanit({ title: 'Örnek Video Başlığı', author_name: 'Örnek Kanal' });
    if (url.includes('/@OrnekKanal')) return yanit('<html><script>var x = {"channelMetadataRenderer":{"title":"Örnek \\"Kanal\\" TV","description":""}}</script></html>');
    throw new Error(`beklenmeyen ${url}`);
  });
  const v = await l.ekle({ metin: 'https://youtu.be/abcdefghijk' });
  assert.equal(v.kural.tur, 'video');
  assert.equal(v.kural.baslik, 'Örnek Video Başlığı');
  assert.equal(v.kural.kanal, 'Örnek Kanal');
  const k = await l.ekle({ metin: 'https://www.youtube.com/@OrnekKanal' });
  assert.deepEqual([k.kural.tur, k.kural.deger], ['kanal', 'Örnek "Kanal" TV']);
  const w = await l.ekle({ metin: 'korku' });
  assert.equal(w.kural.tur, 'kelime');
  const vk = await l.ekle({ metin: 'https://youtu.be/bbbbbbbbbbb', tur: 'kanal' });
  assert.deepEqual([vk.kural.tur, vk.kural.deger, vk.kural.ornek], ['kanal', 'Örnek Kanal', 'Örnek Video Başlığı'], 'video linkinden kanalı');
  await l.sil(vk.kural.id);
  const ad = await l.ekle({ metin: 'Bir Kanal', tur: 'kanal' });
  assert.equal(ad.kural.tur, 'kanal');
  assert.equal((await l.ekle({ metin: 'KORKU' })).varmis, true);
  assert.equal(l.durum().kurallar.length, 4);
  const ikinci = new EngelListesi({ dizin });
  await ikinci.yukle();
  assert.equal(ikinci.durum().kurallar.length, 4);
  await l.sil(w.kural.id);
  assert.equal(l.durum().kurallar.length, 3);
  await assert.rejects(l.sil('yok'), /kural yok/);
  temizle();
});

test('eşleşme: video (başlık+kanal ya da kimlik), kanal adı, kelime sözcük başında', async () => {
  const { l, temizle } = liste(async () => yanit({ title: 'Örnek Video Başlığı', author_name: 'Örnek Kanal' }));
  await l.ekle({ metin: 'https://youtu.be/abcdefghijk' });
  await l.ekle({ metin: 'Bir Kanal', tur: 'kanal' });
  await l.ekle({ metin: 'oyun' });
  assert.equal(l.eslesen({ baslik: 'ÖRNEK VİDEO BAŞLIĞI', kanal: 'örnek kanal' })?.tur, 'video');
  assert.equal(l.eslesen({ baslik: 'Örnek Video Başlığı', kanal: 'Başka Kanal' }), null);
  assert.equal(l.eslesen({ baslik: 'Başka', kanal: 'Başka', videoId: 'abcdefghijk' })?.tur, 'video');
  assert.equal(l.eslesen({ baslik: 'Herhangi', kanal: 'BİR KANAL' })?.tur, 'kanal');
  assert.equal(l.eslesen({ baslik: 'En iyi OYUNLARI oynuyoruz', kanal: 'X' })?.tur, 'kelime');
  assert.equal(l.eslesen({ baslik: 'Koyun sürüsü', kanal: 'X' }), null, 'sözcük ortasında geçmesi tutmaz');
  temizle();
});

function sahteTv(oynayanlar) {
  const komutlar = [];
  const bildirimler = [];
  return {
    id: 'tv1', appletv: { ip: '1.2.3.4', id: 'x' }, komutlar, bildirimler,
    appledaOynayan: async () => (oynayanlar.length > 1 ? oynayanlar.shift() : oynayanlar[0]),
    appleKomut: async (tus) => { komutlar.push(tus); },
    bildirimGoster: async (m, sn) => { bildirimler.push([m, sn]); },
  };
}

test('bekçi: kademeli — 1. duraklat + geri ×2, yine oynatılırsa 2. YouTube kapat', async () => {
  const { l, temizle } = liste();
  await l.ekle({ metin: 'oyun' });
  const yt = (durum) => ({ uygulama: 'YouTube', baslik: 'Oyun videosu', sanatci: 'Bir Kanal', durum });
  const tv = sahteTv([yt('playing'), yt('paused')]);
  let kapatma = 0;
  tv.appleUygulamaKapat = async () => { kapatma++; };
  const uyarilar = [];
  tv.uyariGoster = async (satirlar, ms) => { uyarilar.push([satirlar, ms]); };
  const saat = { t: 1e12 };
  const b = new EngelBekcisi({ tvler: [tv], liste: l, bekle: async () => {}, simdi: () => saat.t });
  const oynat = async () => { tv.sira = [yt('playing'), yt('paused')]; return b.denetle(tv); };
  tv.appledaOynayan = async () => (tv.sira.length > 1 ? tv.sira.shift() : tv.sira[0]);
  const kural = await oynat();
  assert.equal(kural.tur, 'kelime');
  assert.deepEqual(tv.komutlar, ['pause', 'menu', 'menu'], '1. kademe: duraklat + oynatıcıdan çık');
  assert.deepEqual(tv.bildirimler, [[MESAJ, 8]]);
  assert.equal(l.durum().olaylar[0].baslik, 'Oyun videosu');
  // duraklatılmış haliyle tekrar sorulunca bir şey yapılmaz
  assert.equal(await b.denetle(tv), null);
  saat.t += 60000;
  await oynat();
  assert.equal(kapatma, 1, '2. kademe: YouTube kapatılır');
  assert.deepEqual(uyarilar, [[UYARI, 10000]], '… ardından ortada uyarı');
  assert.match(UYARI.join(' '), /ülkenizde engellenmiştir/);
  assert.equal(UYARI.length, 4);
  assert.match(UYARI[0], /^ {25}⚠️/, 'ilk satırın girintisi korunur');
  saat.t += 60000;
  await oynat();
  assert.equal(kapatma, 2, 'yine açılırsa yine kapatılır');
  assert.deepEqual(l.durum().olaylar.map((o) => o.seviye), [2, 2, 1]);
  // 10 dk sessizlikten sonra yeniden 1. kademe
  saat.t += 11 * 60000;
  tv.komutlar.length = 0;
  await oynat();
  assert.deepEqual(tv.komutlar, ['pause', 'menu', 'menu']);
  temizle();
});

test('bekçi: tuş kaçtıysa (hâlâ oynuyor) bir kez daha; YouTube dışı ve kuralsız içeriğe dokunmaz', async () => {
  const { l, temizle } = liste();
  await l.ekle({ metin: 'oyun' });
  const yt = { uygulama: 'YouTube', baslik: 'Oyun videosu', sanatci: 'K', durum: 'playing' };
  const tv = sahteTv([yt, yt]);
  await new EngelBekcisi({ tvler: [tv], liste: l, bekle: async () => {} }).denetle(tv);
  assert.deepEqual(tv.komutlar, ['pause', 'menu', 'menu', 'pause'], 'tuş kaçtıysa yeniden duraklatılır');
  const nf = sahteTv([{ uygulama: 'Netflix', baslik: 'Oyun', durum: 'playing' }]);
  assert.equal(await new EngelBekcisi({ tvler: [nf], liste: l, bekle: async () => {} }).denetle(nf), null);
  const temiz = sahteTv([{ uygulama: 'YouTube', baslik: 'Belgesel', sanatci: 'K', durum: 'playing' }]);
  assert.equal(await new EngelBekcisi({ tvler: [temiz], liste: l, bekle: async () => {} }).denetle(temiz), null);
  assert.deepEqual([nf.komutlar, temiz.komutlar], [[], []]);
  temizle();
});

test('kanal adı ayıklama: og:title yedeği', () => {
  assert.equal(kanalAdiAyikla('<meta property="og:title" content="A &amp; B">'), 'A & B');
  assert.equal(kanalAdiAyikla('<html></html>'), null);
});

test('işlem kaydı: kural eklendi / silindi, engelleme açıldı / kapatıldı — kaynakla', async () => {
  const { l, temizle } = liste();
  const { kural } = await l.ekle({ metin: 'oyun' }, 'panel');
  await l.ayarla({ acik: false }, 'panel');
  await l.ayarla({ acik: true }, 'dogrudan');
  await l.sil(kural.id, 'panel');
  assert.deepEqual(l.durum().islemler.map((i) => [i.ne, i.deger ?? null, i.kaynak]), [
    ['silindi', 'oyun', 'panel'], ['acildi', null, 'dogrudan'], ['kapatildi', null, 'panel'], ['eklendi', 'oyun', 'panel'],
  ]);
  temizle();
});
