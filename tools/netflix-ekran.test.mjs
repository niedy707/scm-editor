/**
 * Netflix ekran okuyucu testleri — gerçek OCR çıktıları (oturma odası, 18.10.2026) ve sahte ekran/saatle.
 *   node --test tools/netflix-ekran.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { netflixAyikla, NetflixOkuyucu } from './net/netflix-ekran.mjs';

// Tesseract'ın gerçek okumaları: "S" → "$", "B" → "8", "1. Bölüm" → "1, Bolum"; köşe bildirimi başlığı örtmüş.
const DURAKLATILMIS = { sag_ust: ['Organize İşler', '$1: B1 “1, Bolum”'], sol_ust: ['—- b) bi', 'SEÇENEKLER'], alt: ['“Yarın saat Üçte de randevunuz var" diye', '06:23 EÇ 31:20', 'Türkçe (Orijinal) y Türkçe (Orijinal + Alt Yazı Diğer...'] };
const BILDIRIMLI = { sag_ust: ['© Deneme 1. satır Deneme 2. satır x', '$1: 81 “1. Bölüm"'], sol_ust: ['— 8) bi', 'SEÇENEKLER'], alt: ['06:23 — — © | ~ 31:20'] };

test('ayıklama: dizi adı, sezon/bölüm (OCR hatalarına toleranslı), bölüm adı, geçen/kalan süre', () => {
  assert.deepEqual(netflixAyikla(DURAKLATILMIS), { baslik: 'Organize İşler', sezon: 1, bolum: 1, bolumAdi: '1. Bolum', gecenSn: 383, kalanSn: 1880 });
  assert.equal(netflixAyikla(BILDIRIMLI).bolum, 1, '"81" → B1');
  assert.equal(netflixAyikla({ sag_ust: ['Bir Film'], sol_ust: ['SEÇENEKLER'], alt: [] }).baslik, 'Bir Film', 'film: bölüm satırı yok, oynatıcı işareti var');
  assert.equal(netflixAyikla({ sag_ust: ['rastgele yazı'], sol_ust: ['başka'], alt: [] }), null, 'oynatıcı ekranda değil');
});

test('okuyucu: başlık ancak iki okuma tutarsa kabul edilir; oynayana dizi/bölüm/süre işlenir; Netflix\'ten çıkınca düşer', async () => {
  const saat = { t: 1e12 };
  const okumalar = [BILDIRIMLI, DURAKLATILMIS, DURAKLATILMIS];
  const n = new NetflixOkuyucu({ ekranAl: async () => Buffer.from('jpeg'), oku: async () => okumalar.shift(), simdi: () => saat.t });
  const nf = (durum) => ({ uygulama: 'Netflix', baslik: null, durum, hash: 'h1' });
  const bekle = () => new Promise((r) => setImmediate(r));
  assert.equal(n.tazele(nf('paused')).baslik, null);    // 1. okuma (bildirim örtmüş) — aday
  await bekle();
  saat.t += 3000;
  n.tazele(nf('paused'));                                // 2. okuma farklı → yeni aday
  await bekle();
  assert.equal(n.bilinen, null);
  saat.t += 3000;
  n.tazele(nf('paused'));                                // 3. okuma 2.'yle aynı → kabul
  await bekle();
  const o = n.tazele(nf('paused'));
  assert.deepEqual([o.dizi, o.sezon, o.bolum, o.baslik, o.konum, o.sure, o.ekrandan], ['Organize İşler', 1, 1, '1. Bolum', 383, 2263, true]);
  saat.t += 60000;
  assert.equal(n.tazele(nf('playing')).konum, 443, 'oynarken konum ilerler');
  assert.equal(n.tazele({ uygulama: 'YouTube', baslik: 'X', durum: 'playing' }).baslik, 'X');
  assert.equal(n.bilinen, null, 'Netflix\'ten çıkınca düşer');
});

test('okuyucu: Netflix duraklatınca "idle" bildirir — o da okunur; oynatıcı bulunamadıkça aralık uzar (en çok 60 sn)', async () => {
  const saat = { t: 1e12 };
  let okuma = 0;
  const n = new NetflixOkuyucu({ ekranAl: async () => Buffer.from('j'), oku: async () => { okuma++; return { sag_ust: [], sol_ust: [], alt: [] }; }, simdi: () => saat.t });
  const bekle = () => new Promise((r) => setImmediate(r));
  const idle = { uygulama: 'Netflix', durum: 'idle' };
  n.tazele(idle); await bekle();
  assert.equal(okuma, 1);
  saat.t += 9000; n.tazele(idle); await bekle();
  assert.equal(okuma, 1, '1 boş okumadan sonra 16 sn beklenir');
  saat.t += 8000; n.tazele(idle); await bekle();
  assert.equal(okuma, 2);
  for (let i = 0; i < 10; i++) { saat.t += 61000; n.tazele(idle); await bekle(); }
  assert.equal(okuma, 12, 'en çok 60 sn aralık');
});

test('okuyucu: oynarken başlık biliniyorsa ekran okunmaz; içerik (hash) değişince başlık düşer', async () => {
  const saat = { t: 1e12 };
  let okuma = 0;
  const n = new NetflixOkuyucu({ ekranAl: async () => Buffer.from('j'), oku: async () => { okuma++; return DURAKLATILMIS; }, simdi: () => saat.t });
  n.bilinen = { baslik: 'Organize İşler', sezon: 1, bolum: 1, bolumAdi: '1. Bolum', zaman: saat.t };
  n.hash = 'h1';
  saat.t += 10 * 60000;
  n.tazele({ uygulama: 'Netflix', durum: 'playing', hash: 'h1' });
  assert.equal(okuma, 0);
  assert.equal(n.tazele({ uygulama: 'Netflix', durum: 'playing', hash: 'h2' }).dizi, undefined, 'yeni içerik: eski başlık gösterilmez');
});
