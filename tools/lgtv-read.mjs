#!/usr/bin/env node
/**
 * Adım 1 — Ağdan oku (temassız), komut satırı arayüzü.
 *
 * Tüm ağ ve ayrıştırma mantığı `tools/net/lg-ssap.mjs` içindedir; bu dosya
 * yalnız ince bir kabuktur. (Daha önce bu dosyanın kendi normalleştirici
 * kopyası vardı; modül çıkarıldıktan sonra ikisi birbirinden ayrı düştü ve
 * `isRadio` alanı yalnız birinde üretildiği için radyo kanalları sessizce
 * "radyo değil" göründü. Tekrarı kaldırmak bu sınıf hatayı bitirir.)
 *
 * Kullanım:
 *   node tools/lgtv-read.mjs 192.168.1.42
 *   node tools/lgtv-read.mjs 192.168.1.42 --out data/salon.json
 *   node tools/lgtv-read.mjs 192.168.1.42 --probe      # belgelenmemiş uçları YOKLA (salt okunur)
 *   node tools/lgtv-read.mjs --discover                # ağdaki TV'leri ara
 *   node tools/lgtv-read.mjs 192.168.1.42 --insecure   # LG olmayan sertifikayı da kabul et
 *
 * İlk bağlantıda TV ekranında eşleştirme onayı çıkar; kumandayla kabul et.
 * Alınan anahtar `.lgtv-clients.json` dosyasına yazılır, TV bir daha sormaz.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTv } from './net/lg-ssap.mjs';
import { scanNetwork } from './net/discover.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEYSTORE = resolve(ROOT, '.lgtv-clients.json');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const host = args.find((a, i) => !a.startsWith('-') && /^[\d.]+$/.test(a) && args[i - 1] !== '--out');

const log = (...a) => console.log(...a);

function loadKeys() {
  if (!existsSync(KEYSTORE)) return {};
  try { return JSON.parse(readFileSync(KEYSTORE, 'utf8')); } catch { return {}; }
}
function saveKey(ip, key) {
  const all = loadKeys();
  all[ip] = key;
  writeFileSync(KEYSTORE, JSON.stringify(all, null, 2) + '\n');
}

async function main() {
  if (flag('--discover') || !host) {
    if (!host) log('IP verilmedi — ağ taranıyor…\n');
    const cihazlar = await scanNetwork();
    if (!cihazlar.length) {
      console.error('Ağda televizyon bulunamadı.');
      console.error('TV açık ve aynı ağda olmalı; uyku modunda ağ servisleri kapalıdır.');
      process.exit(1);
    }
    log('Bulunan cihazlar:');
    for (const d of cihazlar) {
      log(`  ${d.ip.padEnd(15)} ${String(d.marka).padEnd(9)} ${d.okunabilir ? 'okunabilir' : 'ağdan okunamıyor'}${d.not ? ' · ' + d.not : ''}`);
    }
    if (!host) {
      const ilk = cihazlar.find((d) => d.okunabilir);
      if (ilk) log(`\nÇalıştır: node tools/lgtv-read.mjs ${ilk.ip}`);
      return;
    }
  }

  const keys = loadKeys();
  const vardi = !!keys[host];
  if (!vardi) {
    log('\n  ⚠️  TV EKRANINDA EŞLEŞTİRME ONAYI ÇIKACAK — kumandayla "Kabul Et" de.');
    log('     (bu bir kereliktir)\n');
  }

  const { sonuc, clientKey } = await readTv(host, {
    clientKey: keys[host] || null,
    probe: flag('--probe'),
    allowAnyCertificate: flag('--insecure'),
    onStatus: (s) => {
      if (s.asama === 'baglaniyor') log(`→ ${s.ip} bağlanılıyor…`);
      if (s.asama === 'baglandi') { log(`  bağlandı: ${s.url}`); if (s.sertifika) log(`  sertifika: ${s.sertifika}`); }
      if (s.asama === 'eslesti') log('  eşleşti.');
      if (s.asama === 'uc-ok') log(`  ✓ ${s.uri}`);
      if (s.asama === 'uc-hata') console.warn(`  ✗ ${s.uri} → ${s.hata}`);
    },
  });
  if (clientKey && clientKey !== keys[host]) { saveKey(host, clientKey); log('  anahtar kaydedildi.'); }

  if (sonuc.kesif) {
    log('\n  Belgelenmemiş uçlar (hepsi salt okunur):');
    for (const [uri, r] of Object.entries(sonuc.kesif)) log(`    ${r.var ? '✓ VAR  ' : '·  yok '} ${uri}`);
  }

  const outPath = resolve(ROOT, opt('--out', `data/tv-${host.replace(/\./g, '_')}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(sonuc, null, 2) + '\n');

  const n = sonuc.kanallar.length;
  log('\n──────────────────────────────────────────');
  log(`  Kanal sayısı : ${n}  (${sonuc.kanallar.filter((c) => c.isRadio).length} radyo)`);
  log(`  Model        : ${sonuc.model || '?'}`);
  log(`  Firmware     : ${sonuc.firmware || '?'}`);
  log('  Alan kapsamı :');
  for (const [k, v] of Object.entries(sonuc.alanKapsami)) {
    log(`      ${k.padEnd(15)} ${String(v).padStart(5)} / ${n}  (%${n ? Math.round((v / n) * 100) : 0})`);
  }
  log(`\n  Kaydedildi   : ${outPath}`);
  log('──────────────────────────────────────────');
}

main().catch((e) => {
  console.error('\nHATA: ' + (e.message || e));
  console.error('\nİpuçları:');
  console.error('  • TV açık ve bilgisayarla aynı ağda olmalı (uyku modunda SSAP kapalıdır).');
  console.error('  • Ayarlar → Bağlantı → "Mobil TV Açık" / "LG Connect Apps" açık olmalı.');
  console.error('  • Eşleştirme onayı TV ekranında çıkar; kabul edilmezse zaman aşımına düşer.');
  console.error('  • IP bulmak için: node tools/lgtv-read.mjs --discover');
  process.exit(1);
});
