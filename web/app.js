/* eslint-env browser */
/* global GlobalClone, OrderEngine, I18N */
/**
 * Arayüz katmanı.
 *
 * Tasarım kararı: dosya asla baştan üretilmez. Kullanıcı düzenlemeleri bir
 * "çalışma durumu" üzerinde tutulur; kaydederken bu durum orijinalle
 * karşılaştırılıp yalnız GERÇEKTEN değişen alanlar için yama üretilir.
 * Böylece hiçbir şey değiştirilmediğinde çıktı girdiyle birebir aynı olur.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = (k, ...a) => I18N.t(k, ...a);

  const TURKSAT_URL_HINT = 'data/turksat-42e-*.json';

  const S = {
    parsed: null,
    fileName: 'GlobalClone00001.TLL',
    rawText: '',
    work: [],       // düzenlenebilir durum
    base: [],       // dosyadan okunan ilk hâl (karşılaştırma tabanı)
    undo: [],
    redo: [],
    turksat: null,  // {satirlar:[...]} — varsa frekans karşılaştırması
    pendingMatch: null,
  };

  // ───────────────────────────────────────────────────────────── yardımcılar

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function download(text, name, mime) {
    const blob = new Blob([text], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function snapshot() {
    return S.work.map((w) => ({ ...w }));
  }
  function pushUndo() {
    S.undo.push(snapshot());
    if (S.undo.length > 200) S.undo.shift();
    S.redo.length = 0;
    refreshUndoButtons();
  }
  function refreshUndoButtons() {
    $('btnUndo').disabled = !S.undo.length;
    $('btnRedo').disabled = !S.redo.length;
  }

  // ───────────────────────────────────────────────────────── dosya yükleme

  function loadText(text, name) {
    let parsed;
    try {
      parsed = GlobalClone.parse(text);
    } catch (e) {
      showFatal(e);
      return;
    }
    S.parsed = parsed;
    S.rawText = text;
    S.fileName = name || 'GlobalClone00001.TLL';
    S.base = parsed.channels.map((c) => ({
      number: c.number, isRadio: c.isRadio, name: c.name,
      skipped: !!c.skipped, locked: !!c.locked, invisible: !!c.invisible,
    }));
    S.work = S.base.map((b) => ({ ...b }));
    S.undo = []; S.redo = [];

    $('welcome').hidden = true;
    $('editor').hidden = false;

    const fmtLabel = parsed.format === GlobalClone.FORMAT.GC_JSON ? 'webOS 5-7 · JSON' : 'webOS 2-4 · XML';
    $('fmtBadge').textContent = fmtLabel;
    $('modelName').textContent = parsed.model || '—';
    $('fileMeta').textContent =
      ` · ${parsed.channels.length} kanal · CloneVersion ${parsed.cloneVersion} · ${S.fileName}`;

    const warns = [];
    if (!parsed.canDelete) {
      warns.push(
        'Bu formatta kanal <b>gerçekten silinemez</b>. Silinen kanallar TV tarafından ' +
          'rastgele yerlere geri konuyor. Bunun yerine kanalı listenin sonuna at veya ' +
          '"atla" işaretle — bu araç bilerek silme sunmuyor.'
      );
    }
    if (!parsed.capabilities.favorites) {
      warns.push('webOS 5+ dosyalarında <b>favori listeleri export edilmiyor</b>, bu yüzden burada düzenlenemez.');
    }
    const box = $('warnBox');
    box.hidden = !warns.length;
    box.innerHTML = warns.map((w) => '<p>' + w + '</p>').join('');

    render();
    refreshUndoButtons();
  }

  function showFatal(e) {
    const isNetcast = e && e.format === GlobalClone.FORMAT.NETCAST;
    toast((isNetcast ? '' : t('errRead') + ': ') + (e.message || e), 'err');
  }

  function readFile(file) {
    const rd = new FileReader();
    rd.onload = () => loadText(String(rd.result), file.name);
    rd.onerror = () => toast(t('errRead'), 'err');
    rd.readAsText(file, 'utf-8');
  }

  // ─────────────────────────────────────────────────── Türksat karşılaştırma

  function turksatFor(ch) {
    if (!S.turksat || !ch.name) return null;
    const norm = OrderEngine.normName;
    const key = norm(ch.name);
    const hit = S.turksat.satirlar.find((r) => norm(r.kanal) === key);
    if (!hit) return null;
    const same = ch.frequency != null && Math.abs(hit.frekans - ch.frequency) <= OrderEngine.FREQ_TOLERANCE;
    return { row: hit, same, suspect: (S.turksat.supheliUydular || []).includes(hit.uydu) };
  }

  // ───────────────────────────────────────────────────────────── tablo

  function visibleRows() {
    const q = OrderEngine.normName($('search').value);
    const f = $('filter').value;
    const out = [];
    S.parsed.channels.forEach((c, i) => {
      const w = S.work[i];
      if (q && !OrderEngine.normName(w.name).includes(q) && String(w.number) !== $('search').value.trim()) return;
      if (f === 'tv' && w.isRadio) return;
      if (f === 'radio' && !w.isRadio) return;
      if (f === 'fta' && c.scrambled) return;
      if (f === 'scrambled' && !c.scrambled) return;
      if (f === 'changed' && !isChanged(i)) return;
      out.push(i);
    });
    return out;
  }

  function isChanged(i) {
    const a = S.base[i], b = S.work[i];
    return a.number !== b.number || a.name !== b.name || a.skipped !== b.skipped ||
      a.locked !== b.locked || a.invisible !== b.invisible;
  }

  function render() {
    const rows = visibleRows();
    rows.sort((x, y) => S.work[x].number - S.work[y].number || x - y);

    const html = rows.map((i) => {
      const c = S.parsed.channels[i];
      const w = S.work[i];
      const ts = turksatFor(c);
      const changed = isChanged(i);

      let tsCell = '<span class="muted">—</span>';
      if (ts) {
        const cls = ts.same ? 'ok' : 'diff';
        tsCell =
          `<span class="tsc ${cls}">${ts.row.frekans} ${ts.row.pol || ''} · ${esc(ts.row.uydu || '')}` +
          (ts.suspect ? ' <span class="suspect" title="Türksat 3A emekli — bu kayıt bayat olabilir">⚠</span>' : '') +
          '</span>';
      }

      const flags = [
        c.scrambled ? '<span class="chip">🔒</span>' : '',
        w.skipped ? '<span class="chip">atla</span>' : '',
        w.locked ? '<span class="chip">kilit</span>' : '',
        w.invisible ? '<span class="chip">gizli</span>' : '',
        c.deleted ? '<span class="chip warnchip">silinmiş</span>' : '',
      ].join('');

      const minor = c.minorNumber != null && c.minorNumber !== w.number
        ? `<span class="minor-diff" title="TV menüsünde bu numara görünüyor olabilir">${c.minorNumber}</span>`
        : `<span class="muted">${c.minorNumber ?? '—'}</span>`;

      return (
        `<tr data-i="${i}" class="${changed ? 'changed' : ''}">` +
        `<td class="num"><input class="numin" type="number" min="1" max="16383" value="${w.number}" data-i="${i}"></td>` +
        `<td class="num">${minor}</td>` +
        `<td><input class="namein" type="text" value="${esc(w.name)}" maxlength="40" data-i="${i}"></td>` +
        `<td>${w.isRadio ? t('radio') : t('tv')}</td>` +
        `<td class="num">${c.frequency ?? '—'}</td>` +
        `<td>${esc(c.satelliteId ?? '—')}</td>` +
        `<td>${tsCell}</td>` +
        `<td class="flags">${flags}</td>` +
        '</tr>'
      );
    }).join('');

    $('tbody').innerHTML = html;
    $('empty').hidden = rows.length > 0;
    updateSaveStat();
  }

  function updateSaveStat() {
    const n = S.parsed ? S.parsed.channels.filter((_, i) => isChanged(i)).length : 0;
    $('saveStat').textContent = n ? t('changeCount', n) : t('noChange');
    $('saveStat').className = n ? 'stat-changed' : 'muted';
  }

  // ───────────────────────────────────────────────────────── düzenlemeler

  function setNumber(i, v) {
    const n = Math.max(1, Math.min(16383, Number(v) || 1));
    if (S.work[i].number === n) return;
    pushUndo();
    S.work[i].number = n;
    render();
  }
  function setName(i, v) {
    if (S.work[i].name === v) return;
    pushUndo();
    S.work[i].name = v;
    updateSaveStat();
    const tr = document.querySelector(`tr[data-i="${i}"]`);
    if (tr) tr.classList.toggle('changed', isChanged(i));
  }

  function computeEdits() {
    const p = S.parsed;
    const isJson = p.format === GlobalClone.FORMAT.GC_JSON;
    const edits = [];
    for (let i = 0; i < p.channels.length; i++) {
      const a = S.base[i], b = S.work[i], ch = p.channels[i];
      if (b.number !== a.number) {
        edits.push(
          isJson
            ? GlobalClone.setNumberEdit(ch, b.number)
            : { idx: i, field: 'prNum', value: (b.number & ~GlobalClone.RADIO_BIT) | (ch.isRadio ? GlobalClone.RADIO_BIT : 0) }
        );
      }
      if (b.name !== a.name) edits.push(...GlobalClone.setNameEdits(p, ch, b.name));
      if (b.skipped !== a.skipped) {
        edits.push(isJson ? { idx: i, field: 'skipped', value: b.skipped } : { idx: i, field: 'isSkipped', value: b.skipped ? 1 : 0 });
      }
      if (b.locked !== a.locked) {
        edits.push(isJson ? { idx: i, field: 'locked', value: b.locked } : { idx: i, field: 'isBlocked', value: b.locked ? 1 : 0 });
      }
      if (b.invisible !== a.invisible) {
        edits.push(isJson ? { idx: i, field: 'Invisible', value: b.invisible } : { idx: i, field: 'isInvisable', value: b.invisible ? 1 : 0 });
      }
    }
    return edits;
  }

  // ───────────────────────────────────────────────────────────── ön-uçuş

  function preflight(edits) {
    const out = [];
    const p = S.parsed;

    if (!edits.length) {
      out.push({ level: 'info', msg: t('noChange') });
    }

    if (S.fileName !== 'GlobalClone00001.TLL') {
      out.push({
        level: 'warn',
        msg:
          `Dosya adı <code>${esc(S.fileName)}</code>. TV yalnız <code>GlobalClone00001.TLL</code> adını ` +
          'kabul ediyor — indirilen dosya bu adla kaydedilecek.',
      });
    }

    const seen = new Map();
    const dupes = [];
    S.work.forEach((w, i) => {
      const key = w.number;
      if (seen.has(key)) dupes.push([seen.get(key), i, key]);
      else seen.set(key, i);
    });
    if (dupes.length) {
      out.push({
        level: 'error',
        msg: `${dupes.length} numara çakışması var (ör. ${dupes[0][2]}). Aynı numarada iki kanal olamaz.`,
      });
    }

    const longNames = S.work.filter((w) => w.name.length > 40).length;
    if (longNames) out.push({ level: 'error', msg: `${longNames} kanal adı 40 karakteri aşıyor.` });

    const emptyNames = S.work.filter((w, i) => !w.name.trim() && S.base[i].name.trim()).length;
    if (emptyNames) out.push({ level: 'warn', msg: `${emptyNames} kanalın adı boşaltıldı.` });

    out.push({
      level: 'info',
      msg:
        'USB bellek <b>FAT32</b> olmalı (tercihen ≤16 GB). Dosyayı TV\'ye ' +
        '<b>Kanal Kopyalama → USB\'den TV\'ye</b> ile yükle. Orijinali sakla — bir sorun olursa geri dönebilirsin.',
    });
    if (!p.canDelete) {
      out.push({ level: 'info', msg: 'Bu araç kanal SİLMİYOR; yalnız numara/ad/işaret değiştiriyor.' });
    }
    return out;
  }

  function showPreflight(edits, onOk) {
    const items = preflight(edits);
    const blocking = items.some((i) => i.level === 'error');
    $('preflightList').innerHTML = items
      .map((i) => `<div class="pf ${i.level}"><span class="pf-ic"></span><div>${i.msg}</div></div>`)
      .join('');
    $('btnPreOk').disabled = blocking;
    $('preflightModal').hidden = false;
    $('btnPreOk').onclick = () => { $('preflightModal').hidden = true; onOk(); };
  }

  // ───────────────────────────────────────────────────────────── kaydetme

  function save() {
    let edits;
    try {
      edits = computeEdits();
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    showPreflight(edits, () => {
      let out;
      try {
        out = GlobalClone.serialize(S.parsed, edits);
      } catch (e) {
        if (e instanceof GlobalClone.ProtectedFieldError) toast(t('protectedField') + ': ' + e.message, 'err');
        else toast(e.message, 'err');
        return;
      }
      download(out, 'GlobalClone00001.TLL', 'application/octet-stream');
      toast(t('savedAs', 'GlobalClone00001.TLL'), 'ok');
    });
  }

  // ──────────────────────────────────────────────── sıra geri yükleme akışı

  function parseRecipeFile(text, name) {
    if (/\.csv$/i.test(name)) {
      const rows = text.split(/\r?\n/).filter(Boolean);
      const out = [];
      for (const line of rows) {
        const parts = line.split(/[;,\t]/);
        const num = Number(String(parts[0]).replace(/[^\d]/g, ''));
        const nm = (parts[1] || '').trim();
        if (!nm || !Number.isFinite(num) || !num) continue;
        out.push({ name: nm, number: num, SVCID: null, TSID: null, ONID: null, frequency: null, videoPid: null, audioPid: null });
      }
      return out;
    }
    const j = JSON.parse(text);
    if (j && j.tip === 'scm-editor-sira-tarifi') return j.kanallar;
    if (j && (j.kanallar || j.channelList)) return OrderEngine.fromTvDump(j);
    if (Array.isArray(j)) return j;
    throw new Error('Tanınmayan dosya. TV dökümü, sıra tarifi veya CSV bekleniyordu.');
  }

  function showMatchReport(res) {
    const rep = $('matchReport');
    const byMethod = {};
    for (const m of res.matched) byMethod[m.method] = (byMethod[m.method] || 0) + 1;
    const label = { id: 'kimlik (SVCID/TSID/ONID)', name: 'kanal adı', pid: 'PID + frekans', freq: 'frekans (son çare)' };

    let html = `<p class="summary">${t('matchSummary', res.matched.length, res.onlyNew.length, res.onlyOld.length)}</p>`;
    html += '<ul class="methods">';
    for (const k of ['id', 'name', 'pid', 'freq']) {
      if (byMethod[k]) html += `<li><b>${byMethod[k]}</b> — ${label[k]}</li>`;
    }
    html += '</ul>';

    if (res.suggestions.length) {
      html +=
        '<p class="sugg-title">SD→HD olabilecek eşleşmeler (otomatik uygulanmaz, işaretle):</p><div class="sugglist">' +
        res.suggestions
          .map(
            (s, i) =>
              `<label><input type="checkbox" class="sugg" data-i="${i}"> ` +
              `<b>${esc(s.oldName)}</b> (#${s.oldNumber}) → <b>${esc(s.newName)}</b></label>`
          )
          .join('') +
        '</div>';
    }
    if (res.onlyOld.length) {
      html +=
        `<details><summary>${res.onlyOld.length} kanal yeni listede bulunamadı</summary><div class="misslist">` +
        res.onlyOld.slice(0, 200).map((o) => `<span>${esc(o.name)}</span>`).join('') +
        '</div></details>';
    }
    rep.innerHTML = html;
    rep.hidden = false;
    $('btnRestoreApply').disabled = res.matched.length === 0 && res.suggestions.length === 0;
  }

  function applyOrder() {
    const res = S.pendingMatch;
    if (!res) return;
    const accepted = [...document.querySelectorAll('.sugg:checked')].map((el) => res.suggestions[Number(el.dataset.i)]);
    let plan;
    try {
      plan = OrderEngine.buildPlan(res, S.parsed.channels, { acceptedSuggestions: accepted });
    } catch (e) {
      toast(e.message, 'err');
      return;
    }
    pushUndo();
    for (const p of plan) S.work[p.idx].number = p.newNumber;
    $('restoreModal').hidden = true;
    render();
    toast(t('applied', plan.length), 'ok');
  }

  // ─────────────────────────────────────────────── Türksat verisini yükleme

  async function tryLoadTurksat() {
    // file:// üzerinden fetch engellidir; bu yüzden sessizce geçilir.
    if (location.protocol === 'file:') return;
    try {
      const r = await fetch('../data/turksat-42e-latest.json');
      if (!r.ok) return;
      S.turksat = await r.json();
      if (S.parsed) render();
    } catch { /* veri yoksa sütun boş kalır, akış bozulmaz */ }
  }

  // ──────────────────────────────────────────────────────────── olaylar

  function wire() {
    const drop = $('drop');
    drop.addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', (e) => e.target.files[0] && readFile(e.target.files[0]));
    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); })
    );
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (f) readFile(f);
    });

    $('search').addEventListener('input', render);
    $('filter').addEventListener('change', render);

    $('tbody').addEventListener('change', (e) => {
      const i = Number(e.target.dataset.i);
      if (e.target.classList.contains('numin')) setNumber(i, e.target.value);
      else if (e.target.classList.contains('namein')) setName(i, e.target.value);
    });

    $('btnUndo').addEventListener('click', () => {
      if (!S.undo.length) return;
      S.redo.push(snapshot());
      S.work = S.undo.pop();
      refreshUndoButtons();
      render();
    });
    $('btnRedo').addEventListener('click', () => {
      if (!S.redo.length) return;
      S.undo.push(snapshot());
      S.work = S.redo.pop();
      refreshUndoButtons();
      render();
    });
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        (e.shiftKey ? $('btnRedo') : $('btnUndo')).click();
      }
    });

    $('btnOriginal').addEventListener('click', () => {
      download(S.rawText, 'GlobalClone00001.orijinal.TLL');
      toast(t('savedAs', 'GlobalClone00001.orijinal.TLL'), 'ok');
    });
    $('btnClose').addEventListener('click', () => {
      S.parsed = null;
      $('editor').hidden = true;
      $('welcome').hidden = false;
      $('file').value = '';
    });

    $('btnSave').addEventListener('click', save);
    $('btnPreCancel').addEventListener('click', () => ($('preflightModal').hidden = true));

    $('btnRestore').addEventListener('click', () => {
      $('matchReport').hidden = true;
      $('recipeName').textContent = '';
      $('btnRestoreApply').disabled = true;
      S.pendingMatch = null;
      $('restoreModal').hidden = false;
    });
    $('btnRestoreCancel').addEventListener('click', () => ($('restoreModal').hidden = true));
    $('btnRestoreApply').addEventListener('click', applyOrder);

    $('recipeFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const old = parseRecipeFile(String(rd.result), f.name);
          S.pendingMatch = OrderEngine.match(old, S.parsed.channels);
          $('recipeName').textContent = `${f.name} · ${old.length} kanal`;
          showMatchReport(S.pendingMatch);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
      rd.readAsText(f, 'utf-8');
    });

    $('btnRecipeExport').addEventListener('click', () => {
      const chans = S.parsed.channels.map((c, i) => ({ ...c, number: S.work[i].number, name: S.work[i].name }));
      download(JSON.stringify(OrderEngine.toRecipe(chans), null, 1), 'sira-tarifi.json', 'application/json');
    });

    $('btnLang').addEventListener('click', () => {
      const next = I18N.getLang() === 'tr' ? 'en' : 'tr';
      I18N.setLang(next);
      $('btnLang').textContent = next === 'tr' ? 'EN' : 'TR';
      if (S.parsed) render();
    });
  }

  I18N.setLang('tr');
  wire();
  tryLoadTurksat();
  window.__SCM = S; // hata ayıklama için
})();
