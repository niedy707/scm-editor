/* eslint-env browser */
/* global Verify, OrderEngine */
/**
 * TV Frekans Doğrulama ekranı.
 *
 * `tools/lgtv-read.mjs` ile TV'den WiFi üzerinden okunan listeyi, Türksat'ın
 * resmî tablosuyla çapraz karşılaştırır. Hiçbir şey yazmaz — salt rapor.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const S = { dump: null, table: null, rapor: null };

  const ROZET = {
    [Verify.DURUM.GUNCEL]: ['ok', 'güncel'],
    [Verify.DURUM.ESKI_FREKANS]: ['warn', 'eski frekans'],
    [Verify.DURUM.TP_TANINDI]: ['muted', 'transponder tanındı'],
    [Verify.DURUM.TABLODA_YOK]: ['muted', 'tabloda yok'],
    [Verify.DURUM.SUPHELI_UYDU]: ['err', 'şüpheli uydu'],
  };

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function download(text, name, mime) {
    const b = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const u = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }

  async function loadTable() {
    try {
      const r = await fetch('../data/turksat-42e-latest.json');
      if (r.ok) S.table = await r.json();
    } catch { /* veri yoksa aşağıda uyarılır */ }
  }

  function run(dump) {
    S.dump = dump;
    const kanallar = dump.kanallar || [];
    if (!S.table) {
      toast('Türksat tablosu bulunamadı. Önce: node tools/fetch-turksat.mjs', 'err');
      return;
    }
    S.rapor = Verify.run(kanallar, S.table);

    $('load').hidden = true;
    $('report').hidden = false;

    const model = dump.model || dump.systemInfo?.modelName || '—';
    $('badge').textContent = (dump.marka || 'lg').toUpperCase();
    $('model').textContent = model;
    $('meta').textContent =
      ` · ${kanallar.length} kanal · okunma ${String(dump.okunmaZamani || '').slice(0, 16).replace('T', ' ')}` +
      ` · Türksat verisi ${S.table.cekilmeTarihi}`;

    const t = S.rapor.ozet.tavsiye;
    $('advice').innerHTML = `<p><b>${t.seviye === 'error' ? '⚠️' : t.seviye === 'warn' ? '⚠️' : '✓'}</b> ${t.metin}</p>`;
    $('advice').style.borderLeftColor =
      t.seviye === 'error' ? 'var(--err)' : t.seviye === 'warn' ? 'var(--warn)' : 'var(--ok)';

    const s = S.rapor.ozet.say;
    const kart = (n, etiket, cls) =>
      `<div class="card ${cls || ''}"><div class="card-n">${n}</div><div class="card-l">${etiket}</div></div>`;
    $('cards').innerHTML =
      kart(s[Verify.DURUM.GUNCEL], 'güncel', 'ok') +
      kart(s[Verify.DURUM.ESKI_FREKANS], 'eski frekans', 'warn') +
      kart(s[Verify.DURUM.TP_TANINDI], 'transponder tanındı', '') +
      kart(s[Verify.DURUM.TABLODA_YOK], 'tabloda yok', '') +
      kart(s[Verify.DURUM.SUPHELI_UYDU], 'şüpheli uydu', 'err') +
      kart(S.rapor.eksik.length, 'taramada yok', '') +
      kart(S.rapor.ozet.transponder.tvToplam, 'transponder', '');

    renderTps();
    renderMissing();
    render();
  }

  function render() {
    const q = OrderEngine.normName($('search').value);
    const f = $('filter').value;
    const rows = S.rapor.satirlar.filter((r) => {
      if (f !== 'all' && r.durum !== f) return false;
      if (q && !OrderEngine.normName(r.name).includes(q)) return false;
      return true;
    });
    rows.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

    $('count').textContent = `${rows.length} / ${S.rapor.satirlar.length} kanal`;
    $('tbody').innerHTML = rows
      .map((r) => {
        const [cls, etiket] = ROZET[r.durum] || ['muted', r.durum];
        const resmi = r.resmi
          ? `${r.resmi.frekans} ${r.resmi.pol || ''}`
          : '<span class="muted">—</span>';
        const fark = r.durum === Verify.DURUM.ESKI_FREKANS;
        return (
          `<tr><td class="num">${r.number ?? '—'}</td>` +
          `<td>${esc(r.name)}${r.isRadio ? ' <span class="chip">radyo</span>' : ''}</td>` +
          `<td class="num ${fark ? 'tsc diff' : ''}">${r.frequency ?? '—'}</td>` +
          `<td class="num">${resmi}</td>` +
          `<td>${esc(r.resmi?.uydu ?? '—')}</td>` +
          `<td><span class="stat ${cls}">${etiket}</span></td></tr>`
        );
      })
      .join('');
  }

  function renderTps() {
    const tp = S.rapor.ozet.transponder;
    let h = `<p class="muted">TV'de ${tp.tvToplam} transponder, resmî tabloda ${tp.resmiToplam}.</p>`;
    if (tp.yalnizTv.length) {
      h += `<p><b>Yalnız TV'de olan (${tp.yalnizTv.length})</b> — resmî tabloda karşılığı yok, kapanmış olabilir:</p><div class="misslist">` +
        tp.yalnizTv.map((t) => `<span>${t.frekans} <small>(${t.kanallar.length} kanal)</small></span>`).join('') + '</div>';
    }
    if (tp.yalnizResmi.length) {
      h += `<p><b>Yalnız resmî tabloda olan (${tp.yalnizResmi.length})</b> — TV bunları hiç bulmamış:</p><div class="misslist">` +
        tp.yalnizResmi.map((t) => `<span>${t.frekans} ${t.pol || ''} <small>${t.uydu || ''}</small></span>`).join('') + '</div>';
    }
    $('tps').innerHTML = h;
  }

  function renderMissing() {
    const m = S.rapor.eksik;
    $('missSum').textContent = `Türksat'ta olup TV'de bulunmayan kanallar (${m.length})`;
    $('missing').innerHTML = m
      .slice(0, 400)
      .map((r) => `<span>${esc(r.kanal)} <small>${r.frekans} ${r.pol || ''}</small></span>`)
      .join('');
  }

  function readFile(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        run(JSON.parse(String(rd.result)));
      } catch (e) {
        toast('Dosya okunamadı: ' + e.message, 'err');
      }
    };
    rd.readAsText(file, 'utf-8');
  }

  /** Ana sayfadan `tv.html#ip=...` ile gelindiyse dökümü köprüden çeker. */
  async function loadFromBridge(ip) {
    const bases = [location.origin, 'http://127.0.0.1:8173'];
    for (const b of bases) {
      try {
        const r = await fetch(`${b}/api/dump`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip }),
        });
        if (!r.ok) continue;
        run(await r.json());
        return true;
      } catch { /* sonraki adayı dene */ }
    }
    toast(`Köprüden ${ip} dökümü alınamadı. Ana sayfadan "Kanal listesini oku" ile yeniden dene.`, 'err');
    return false;
  }

  async function loadLocal() {
    for (const p of ['../data/tv-salon-2.json', '../data/tv-salon.json']) {
      try {
        const r = await fetch(p);
        if (!r.ok) continue;
        run(await r.json());
        return;
      } catch { /* sonrakini dene */ }
    }
    toast('Bu bilgisayarda kayıtlı TV okuması bulunamadı.', 'err');
  }

  $('btnPick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => e.target.files[0] && readFile(e.target.files[0]));
  $('btnLocal').addEventListener('click', loadLocal);
  $('search').addEventListener('input', render);
  $('filter').addEventListener('change', render);

  $('btnRecipe').addEventListener('click', () => {
    const r = OrderEngine.toRecipe(S.dump.kanallar);
    download(JSON.stringify(r, null, 1), 'sira-tarifi.json', 'application/json');
  });

  $('btnCsv').addEventListener('click', () => {
    const head = 'no;ad;tv_frekans;turksat_frekans;pol;uydu;durum';
    const lines = S.rapor.satirlar.map((r) =>
      [r.number ?? '', r.name, r.frequency ?? '', r.resmi?.frekans ?? '', r.resmi?.pol ?? '', r.resmi?.uydu ?? '',
        (Verify.ETIKET[r.durum] || r.durum)].join(';')
    );
    download('﻿' + [head, ...lines].join('\r\n'), 'frekans-raporu.csv', 'text/csv;charset=utf-8');
  });

  loadTable().then(() => {
    const ip = new URLSearchParams(location.hash.slice(1)).get('ip');
    if (ip) loadFromBridge(ip);
  });
})();
