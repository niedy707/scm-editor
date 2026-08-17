/* eslint-env browser */
/**
 * Ana sayfa — evdeki televizyonları bulur ve okur.
 *
 * Tüm ağ işleri köprü üzerinden yapılır (tools/bridge.mjs); tarayıcı TV'ye
 * doğrudan bağlanamaz çünkü TV'nin sertifikası WebSocket için kabul edilmiyor.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Köprü LAN modundaysa erişim anahtarı adres çubuğunda #k=... ile gelir.
  const TOKEN = new URLSearchParams(location.hash.slice(1)).get('k');

  /**
   * Köprü adayları. Sayfa köprünün kendi adresinden açıldıysa aynı köken
   * kullanılır (her tarayıcıda çalışır). Yayınlanmış HTTPS sürümünden açıldıysa
   * yerel köprü denenir — bunu yalnız Chrome/Edge'in yerel ağ istisnası
   * kabul eder; Safari ve Firefox HTTPS sayfadan http adresine isteği karışık
   * içerik sayıp engeller. O durumda sayfa "köprü yok" der ve kurulumu anlatır.
   */
  const ADAYLAR = [location.origin, 'http://127.0.0.1:8173'];
  let BASE = location.origin;

  const S = { cihazlar: [], saglik: null };

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  async function api(ad, body) {
    const r = await fetch(`${BASE}/api/${ad}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Bridge-Token': TOKEN } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.hata || `HTTP ${r.status}`);
    return j;
  }

  async function checkBridge() {
    for (const aday of ADAYLAR) {
      BASE = aday;
      try {
        S.saglik = await api('health');
        $('bridgeState').textContent =
          'köprü bağlı' + (S.saglik.lan ? ' · ev ağına açık' : '') +
          (aday === location.origin ? '' : ' · yerel');
        $('bridgeState').className = 'stat ok';
        $('btnScan').disabled = false;
        return true;
      } catch { /* sonraki adayı dene */ }
    }
    $('bridgeState').textContent = 'köprü yok';
    $('bridgeState').className = 'stat err';
    $('btnScan').disabled = true;
    const note = $('scanNote');
    note.hidden = false;
    note.innerHTML =
      '<p>Televizyon taraması için bilgisayarında <b>köprünün</b> çalışıyor olması gerekiyor. ' +
      'Aşağıdaki komutu çalıştır, sonra bu sayfayı yenile — ya da doğrudan ' +
      '<code>http://127.0.0.1:8173/web/</code> adresini aç (her tarayıcıda çalışan yol budur).</p>';
    return false;
  }

  function markaEtiket(d) {
    if (d.marka === 'lg') return ['ok', 'LG'];
    if (d.marka === 'lg?') return ['warn', 'LG?'];
    if (d.marka === 'samsung') return ['warn', 'Samsung'];
    return ['muted', d.marka || '?'];
  }

  function render() {
    if (!S.cihazlar.length) {
      $('devices').innerHTML =
        '<p class="muted">Henüz cihaz bulunmadı. Televizyonların <b>açık</b> ve aynı WiFi ağında olduğundan emin ol.</p>';
      return;
    }
    $('devices').innerHTML = S.cihazlar
      .map((d, i) => {
        const [cls, etiket] = markaEtiket(d);
        const baslik = d.model || d.sertifika?.cn || d.ip;
        const alt = [
          d.ip,
          (d.portlar || []).length ? 'port ' + d.portlar.join(', ') : null,
          d.eslesmis ? 'eşleşmiş' : null,
        ].filter(Boolean).join(' · ');
        return (
          `<div class="devcard">` +
          `<div class="devhead"><span class="stat ${cls}">${etiket}</span><b>${esc(baslik)}</b></div>` +
          `<div class="muted small">${esc(alt)}</div>` +
          (d.sertifika ? `<div class="muted small">sertifika: ${esc(d.sertifika.cn || '')} · ${esc(d.sertifika.org || '')}</div>` : '') +
          (d.not ? `<div class="devnote">${esc(d.not)}</div>` : '') +
          `<div class="devactions">` +
          (d.okunabilir
            ? `<button class="primary" data-read="${i}" type="button">Kanal listesini oku</button>`
            : `<button disabled type="button">Ağdan okunamıyor</button>`) +
          `</div><div class="devlog" id="log${i}"></div></div>`
        );
      })
      .join('');
  }

  async function scan() {
    $('btnScan').disabled = true;
    $('btnScan').textContent = 'taranıyor…';
    $('scanMeta').textContent = ' · ağ taranıyor, ~10 saniye';
    try {
      const r = await api('scan', {});
      S.cihazlar = r.cihazlar || [];
      $('scanMeta').textContent = ` · ${S.cihazlar.length} cihaz bulundu`;
      const note = $('scanNote');
      if (!S.cihazlar.length) {
        note.hidden = false;
        note.innerHTML =
          '<p>Hiç televizyon bulunamadı. Kontrol et: TV <b>açık mı</b> (uyku modunda ağ servisleri kapalıdır), ' +
          'bilgisayarla <b>aynı WiFi ağında mı</b>, ve LG için <b>Ayarlar → Bağlantı → Mobil TV Açık</b> etkin mi.</p>';
      } else {
        note.hidden = true;
      }
      render();
    } catch (e) {
      toast('Tarama başarısız: ' + e.message, 'err');
    } finally {
      $('btnScan').disabled = false;
      $('btnScan').textContent = 'Ağı tara';
    }
  }

  async function read(i) {
    const d = S.cihazlar[i];
    const log = $('log' + i);
    const yaz = (t, cls) => { log.innerHTML += `<div class="${cls || ''}">${esc(t)}</div>`; };
    log.innerHTML = '';
    if (!d.eslesmis) {
      yaz('TV ekranında eşleştirme onayı çıkacak — kumandayla "Kabul Et" de.', 'hi');
    }
    yaz('bağlanılıyor…');
    try {
      const r = await api('read', { ip: d.ip });
      const s = r.ozet;
      yaz(`bağlandı: ${s.baglanti?.url || ''}`);
      if (s.baglanti?.sertifika) yaz(s.baglanti.sertifika);
      yaz(`${s.model || '?'} · firmware ${s.firmware || '?'} · ${s.kanalSayisi} kanal`, 'ok');

      if (!s.eksikAlanlar.length) {
        yaz('tüm kimlik alanları eksiksiz geldi — eşleştirme kusursuz olacak', 'ok');
      } else {
        // Hangi alanın eksik olduğu, eşleştirmenin ne kadar güvenilir olacağını belirler.
        yaz('eksik gelen alanlar: ' + s.eksikAlanlar.map((e) => `${e.alan} (${e.gelen}/${e.toplam})`).join(', '), 'hi');
        const kritik = s.eksikAlanlar.filter((e) => ['SVCID', 'TSID', 'ONID'].includes(e.alan));
        yaz(
          kritik.length
            ? 'kimlik alanları eksik: eşleştirme kanal adına ve frekansa düşecek'
            : 'kimlik alanları tam: eşleştirme yine de güvenilir',
          kritik.length ? 'hi' : 'ok'
        );
      }
      log.innerHTML += `<div><a class="linkbtn" href="tv.html#ip=${encodeURIComponent(d.ip)}">Frekans doğrulama raporunu aç →</a></div>`;
      d.eslesmis = true;
    } catch (e) {
      yaz('hata: ' + e.message, 'err');
    }
  }

  $('btnScan').addEventListener('click', scan);
  $('devices').addEventListener('click', (e) => {
    const b = e.target.closest('[data-read]');
    if (b) read(Number(b.dataset.read));
  });

  checkBridge().then((ok) => { if (ok) scan(); });
})();
