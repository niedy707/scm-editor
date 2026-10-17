/**
 * Apple TV köprüsü — ajandan Apple TV yardımcısına (tools/atv-yardimci.py, pyatv) satır başına JSON.
 *
 * Yardımcı ilk istekte başlatılır ve açık kalır (bağlantıyı o tutar; her komutta yeniden kurmak Pi 3'te
 * ~3,5 sn). Süreç düşerse bekleyen istekler hata alır, sonraki istek yeniden başlatır.
 * Kimlik dosyası yoksa (Apple TV hiç eşleştirilmemiş) `hazirMi()` false — ajan TV'nin kendi uygulamasına döner.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

export class AtvHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

export class AppleTvKopru {
  /**
   * @param {object} o
   * @param {string} o.python  pyatv kurulu Python (örn. /opt/pyatv/bin/python3)
   * @param {string} o.betik   tools/atv-yardimci.py
   * @param {string} o.depo    pyatv kimlik dosyası (eşleştirme bunu yazar)
   */
  constructor({ python, betik, depo, spawnFn = spawn, varMi = existsSync, log = () => {} }) {
    Object.assign(this, { python, betik, depo, spawnFn, varMi, log });
    this.no = 0;
    this.bekleyen = new Map();
    this.surec = null;
  }

  hazirMi() {
    return this.varMi(this.python) && this.varMi(this.betik) && this.varMi(this.depo);
  }

  _baslat() {
    const p = this.spawnFn(this.python, [this.betik, this.depo], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.surec = p;
    createInterface({ input: p.stdout }).on('line', (satir) => {
      let j;
      try { j = JSON.parse(satir); } catch { return; }
      const b = j.no != null && this.bekleyen.get(j.no);
      if (!b) return;
      this.bekleyen.delete(j.no);
      if (j.ok) b.coz(j); else b.red(new AtvHata(502, `Apple TV: ${j.hata || 'bilinmeyen hata'}`));
    });
    createInterface({ input: p.stderr }).on('line', (satir) => {
      if (satir.trim()) this.log(`[apple-tv] ${satir.slice(0, 300)}`);
    });
    const bitti = (neden) => {
      if (this.surec !== p) return;
      this.surec = null;
      for (const [no, b] of this.bekleyen) { this.bekleyen.delete(no); b.red(new AtvHata(502, `Apple TV yardımcısı kapandı (${neden})`)); }
    };
    p.on('exit', (kod) => bitti(`çıkış ${kod}`));
    p.on('error', (e) => bitti(e.message));
  }

  /** Bir iş gönderir: "uygulama" {uygulama}, "tus" {tus}, "metin" {metin}, "uygulamalar". */
  iste(cihaz, is, ek = {}, ms = 25000) {
    if (!this.hazirMi()) return Promise.reject(new AtvHata(409, 'Apple TV eşleştirilmemiş'));
    if (!this.surec) this._baslat();
    const no = ++this.no;
    return new Promise((coz, red) => {
      const z = setTimeout(() => { this.bekleyen.delete(no); red(new AtvHata(504, 'Apple TV yanıt vermedi')); }, ms);
      this.bekleyen.set(no, {
        coz: (j) => { clearTimeout(z); coz(j); },
        red: (e) => { clearTimeout(z); red(e); },
      });
      this.surec.stdin.write(JSON.stringify({ no, cihaz, is, ...ek }) + '\n');
    });
  }

  kapat() {
    if (this.surec) { try { this.surec.stdin.end(); } catch { /* yok say */ } }
  }
}
