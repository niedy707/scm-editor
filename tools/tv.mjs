#!/usr/bin/env node
/**
 * TV'yi komut satırından sür — tuş gönder, ekranı gör, uygulama aç.
 *
 * Kullanım:
 *   node tools/tv.mjs <ip> ekran [cikti.jpg]          ekran görüntüsü al
 *   node tools/tv.mjs <ip> tus UP DOWN ENTER …        kumanda tuşları gönder
 *   node tools/tv.mjs <ip> ac <uygulamaKimligi>       uygulama aç (örn. com.webos.app.channeledit)
 *   node tools/tv.mjs <ip> on                         ön plandaki uygulama
 *   node tools/tv.mjs <ip> kanal                      o an açık kanal
 *   node tools/tv.mjs <ip> liste [--ilk 15]           TV'deki sıranın başı (--radyo 1: radyolar)
 *   node tools/tv.mjs <ip> git <numara>               o numaradaki kanala geç
 *   node tools/tv.mjs <ip> sirala --adlar "A|B|C"     bu kanalları bu sırayla başa al (plan gösterir)
 *   node tools/tv.mjs <ip> sirala --tarif sira.json   kayıtlı sıra tarifini uygula (--ilk N: ilk N kanal)
 *                                  … --uygula 1       planı TV'de gerçekten uygula
 *
 * Seçenekler:
 *   --bekle <ms>     tuşlar arası bekleme (varsayılan 450)
 *   --ekran <dosya>  işlemden sonra ekran görüntüsünü kaydet
 *   --son <ms>       ekran görüntüsünden önceki bekleme (varsayılan 900)
 *
 * Tuş adında `x3` gibi tekrar yazılabilir: `DOWNx5`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { LgSsap, normalizeChannel } from './net/lg-ssap.mjs';
import { LgInput } from './net/lg-input.mjs';
import { captureScreen } from './net/lg-screen.mjs';
import { readTvList, applyHead } from './net/lg-editor.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OrderEngine = createRequire(import.meta.url)(resolve(ROOT, 'web/lib/order.js'));
const KEYSTORE = resolve(ROOT, '.lgtv-clients.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const opts = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
  else rest.push(argv[i]);
}
const [ip, komut, ...args] = rest;

if (!ip || !komut) {
  console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
  process.exit(1);
}

const keys = existsSync(KEYSTORE) ? JSON.parse(readFileSync(KEYSTORE, 'utf8')) : {};
if (!keys[ip]) {
  console.error(`${ip} için eşleştirme anahtarı yok — önce: node tools/lgtv-read.mjs ${ip}`);
  process.exit(1);
}

const tv = new LgSsap(ip);
try {
  await tv.connect();
  await tv.register(keys[ip]);

  if (komut === 'ekran') {
    opts.ekran = args[0] || opts.ekran || 'ekran.jpg';
    opts.son = opts.son ?? 0;
  } else if (komut === 'tus') {
    const input = await LgInput.open(tv);
    const bekle = Number(opts.bekle ?? 450);
    for (const a of args) {
      const m = /^(.+?)x(\d+)$/i.exec(a);
      const [ad, kac] = m ? [m[1], Number(m[2])] : [a, 1];
      for (let i = 0; i < kac; i++) await input.button(ad, { settleMs: bekle });
    }
    input.close();
    console.log(`${input.sentCount} tuş gönderildi`);
  } else if (komut === 'ac') {
    const r = await tv.request('ssap://system.launcher/launch', { id: args[0] });
    console.log('açıldı:', JSON.stringify(r));
  } else if (komut === 'on') {
    console.log((await tv.request('ssap://com.webos.applicationManager/getForegroundAppInfo')).appId);
  } else if (komut === 'kanal') {
    const c = await tv.request('ssap://tv/getCurrentChannel');
    console.log(`${c.channelNumber} ${c.channelName}`);
  } else if (komut === 'liste') {
    // İlk N kanal, TV'deki numara sırasıyla. `--radyo 1` radyo listesini verir.
    const r = await tv.request('ssap://tv/getChannelList');
    const hepsi = (r.channelList || []).map((c, i) => normalizeChannel(c, i));
    const secili = hepsi
      .filter((c) => c.isRadio === (opts.radyo === '1'))
      .sort((a, b) => OrderEngine.displayNumber(a.number) - OrderEngine.displayNumber(b.number));
    for (const c of secili.slice(0, Number(opts.ilk ?? 15))) {
      console.log(String(OrderEngine.displayNumber(c.number)).padStart(4), c.name);
    }
    console.log(`(${secili.length} kanal)`);
  } else if (komut === 'git') {
    // Numaraya göre kanala geç: `git 73`
    const r = await tv.request('ssap://tv/getChannelList');
    const hedef = (r.channelList || []).find((c) => String(c.channelNumber) === String(args[0]) && !c.Radio);
    if (!hedef) throw new Error(`${args[0]} numaralı kanal yok`);
    await tv.request('ssap://tv/openChannel', { channelId: hedef.channelId });
    console.log(`geçildi: ${hedef.channelNumber} ${hedef.channelName}`);
  } else if (komut === 'sirala') {
    const list = await readTvList(tv);
    const satir = (c) => ({
      name: c.name, number: c.number, isRadio: false,
      SVCID: c.raw.SVCID ?? null, TSID: c.raw.TSID ?? null, ONID: c.raw.ONID ?? null,
      frequency: c.raw.Frequency ?? null, serviceType: c.raw.serviceType ?? null,
    });
    let head;
    if (opts.adlar) {
      // Öğe ya kanal numarasıdır ("73") ya da addır. Aynı kanal birden çok frekansta
      // olabildiği için (gerçek listede "TRT1 HD" 4 kez var) ad eşleşmesinde en küçük
      // numaralı olan — kullanıcının listede ilk gördüğü — alınır.
      head = opts.adlar.split('|').map((ad) => {
        const n = OrderEngine.normName(ad);
        const bulunan = /^\d+$/.test(ad.trim())
          ? list.filter((c) => c.number === Number(ad))
          : list.filter((c) => OrderEngine.normName(c.name) === n);
        if (!bulunan.length) throw new Error(`"${ad}" TV listesinde yok`);
        if (bulunan.length > 1) console.log(`not: "${ad}" ${bulunan.length} kanalla eşleşiyor; ${bulunan[0].number} numaralı alındı`);
        return bulunan[0].key;
      });
    } else if (opts.tarif) {
      const tarif = JSON.parse(readFileSync(resolve(opts.tarif), 'utf8'));
      const eski = (tarif.kanallar || []).filter((c) => !c.isRadio && c.serviceType !== 2);
      const es = OrderEngine.match(eski, list.map(satir));
      const sirali = es.matched.slice().sort((a, b) => a.oldNumber - b.oldNumber);
      head = sirali.slice(0, Number(opts.ilk ?? sirali.length)).map((m) => list[m.idx].key);
      const yontem = {};
      for (const m of es.matched) yontem[m.method] = (yontem[m.method] || 0) + 1;
      console.log(`tarif: ${eski.length} kanal · eşleşen ${es.matched.length} (${Object.entries(yontem).map(([k, v]) => `${k}: ${v}`).join(', ')}) · TV'de bulunmayan ${es.onlyOld.length}`);
      for (const o of es.onlyOld) console.log(`  bulunamadı: ${o.number} ${o.name}`);
    } else {
      throw new Error('--adlar "A|B|C" ya da --tarif dosya.json gerekli');
    }
    const uygula = opts.uygula === '1';
    if (uygula) {
      // Geri dönüş güvencesi: uygulamadan önce bugünkü sıra kaydedilir.
      const dir = resolve(ROOT, 'data/yerel');
      mkdirSync(dir, { recursive: true });
      const ad = `sira-${ip.replace(/\./g, '_')}-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.json`;
      writeFileSync(resolve(dir, ad), JSON.stringify(OrderEngine.toRecipe(list.map(satir)), null, 1) + '\n');
      console.log(`yedek: data/yerel/${ad}`);
    }
    const r = await applyHead(tv, head, {
      dryRun: !uygula,
      log: (m) => console.log(m),
      onShot: (buf, ad) => { const d = resolve(ROOT, 'data/yerel'); mkdirSync(d, { recursive: true }); writeFileSync(resolve(d, ad), buf); console.log(`  ekran görüntüsü: data/yerel/${ad}`); },
    });
    if (!r.plan.length) console.log('TV zaten istenen sırada — taşıma gerekmiyor.');
    else if (!uygula) {
      console.log(`plan: ${r.plan.length} taşıma (≈${Math.round(r.plan.length * 11 / 6) / 10} dk)`);
      for (const p of r.plan) console.log(`  ${String(p.numara).padStart(4)} ${p.kanal}  →  ${p.hedef}`);
      console.log('uygulamak için: --uygula 1');
    } else {
      console.log(`bitti: ${r.yapilan} taşıma, ${r.hatali} yinelenen adım, ${r.sure} sn`);
    }
  } else {
    throw new Error('bilinmeyen komut: ' + komut);
  }

  if (opts.ekran) {
    await sleep(Number(opts.son ?? 900));
    const buf = await captureScreen(tv);
    writeFileSync(resolve(opts.ekran), buf);
    const on = await tv.request('ssap://com.webos.applicationManager/getForegroundAppInfo');
    console.log(`ekran: ${opts.ekran} (${buf.length} bayt) · ön plan: ${on.appId}`);
  }
} catch (e) {
  console.error('HATA: ' + (e.message || e));
  process.exitCode = 1;
} finally {
  tv.close();
}
