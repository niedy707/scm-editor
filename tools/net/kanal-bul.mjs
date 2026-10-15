/**
 * Kanalı insanın yazdığı adla bulmak: "Kanal D", "Habertürk TV", "CNN Türk TV".
 *
 * TV'deki adlar başka: "KANAL D HD", "HABERTURK HD", "CNN TÜRK HD". Ortak kök,
 * sondaki "HD / TV / SD…" kelimeleri atılıp Türkçe harfler sadeleştirilince çıkar.
 * Ekler KELİME olarak atılır, normalleştirmeden ÖNCE: normalleştirme boşlukları
 * sildiği için sonradan "TV8"in "TV"si ile "Star TV"nin "TV"si ayırt edilemez.
 *
 * Aynı kanal listede birden çok frekansta olabiliyor ("TRT1 HD" gerçek listede 4 kez).
 * Kullanıcının kastettiği, numarası en küçük olandır — listede ilk gördüğü.
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { normName } = createRequire(import.meta.url)(resolve(ROOT, 'web/lib/order.js'));

const EKLER = new Set(['HD', 'TV', 'SD', 'FHD', 'UHD', '4K']);

/** "Habertürk TV" → "HABERTURK", "KANAL D HD" → "KANALD", "TV8" → "TV8". */
export function anaAd(ad) {
  const kelimeler = String(ad || '').trim().split(/\s+/).filter(Boolean);
  while (kelimeler.length > 1 && EKLER.has(normName(kelimeler[kelimeler.length - 1]))) kelimeler.pop();
  return normName(kelimeler.join(' '));
}

/**
 * @param {Array<{no:number, ad:string}>} kanallar TV kanalları (radyo hariç)
 * @returns {object|null} adı tutan en küçük numaralı kanal
 */
export function kanalBul(kanallar, ad) {
  const hedef = anaAd(ad);
  if (!hedef) return null;
  let en = null;
  for (const k of kanallar) {
    if (anaAd(k.ad) !== hedef) continue;
    if (!en || k.no < en.no) en = k;
  }
  return en;
}
