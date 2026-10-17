/**
 * LG webOS — uzaktan kumanda giriş kanalı.
 *
 * SSAP'ta kanal listesini yazan bir uç YOK (14 setter adayı gerçek cihazda
 * 404 döndü). Ama `getPointerInputSocket` VAR: TV, tuş basımlarını kabul eden
 * ayrı bir WebSocket adresi veriyor. Yazma yolumuz bu — TV'nin KENDİ Kanal
 * Yöneticisini ağdan sürüyoruz.
 *
 * Körlemesine menü sürmek kırılgandır; bu yüzden her adımdan sonra SSAP'tan
 * `getChannelList` okunup değişikliğin gerçekten olduğu DOĞRULANIR (bkz.
 * closed-loop akışı, tools/net/lg-editor.mjs). Doğrulanamayan adımda durulur.
 */

import { connectUrl } from '../ws-client.mjs';

/** TV'nin kabul ettiği tuş adları (kumanda karşılıkları). */
export const KEYS = {
  UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT',
  ENTER: 'ENTER', BACK: 'BACK', EXIT: 'EXIT', HOME: 'HOME', MENU: 'MENU',
  CHANNELUP: 'CHANNELUP', CHANNELDOWN: 'CHANNELDOWN',
  RED: 'RED', GREEN: 'GREEN', YELLOW: 'YELLOW', BLUE: 'BLUE',
  INFO: 'INFO', LIST: 'LIST', GUIDE: 'GUIDE', DASH: 'DASH',
  VOLUMEUP: 'VOLUMEUP', VOLUMEDOWN: 'VOLUMEDOWN', MUTE: 'MUTE',
  0: '0', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LgInput {
  constructor(conn) {
    this.conn = conn;
    this.sentCount = 0;
  }

  /**
   * @param {LgSsap} ssap  eşleşmiş SSAP oturumu
   */
  static async open(ssap, opts = {}) {
    const res = await ssap.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    const path = res?.socketPath;
    if (!path) throw new Error('TV kumanda soketi adresi vermedi (socketPath boş).');
    const { conn } = await connectUrl(path, opts);
    return new LgInput(conn);
  }

  /** Kumanda protokolü: `type:...\n` satırları, boş satırla biten blok. */
  _raw(lines) {
    this.conn.send(lines.join('\n') + '\n\n');
    this.sentCount++;
  }

  /** Tek tuş gönderir. */
  async button(name, { settleMs = 350 } = {}) {
    const key = KEYS[name] || String(name).toUpperCase();
    this._raw(['type:button', `name:${key}`]);
    if (settleMs) await sleep(settleMs);
    return key;
  }

  /**
   * Magic Remote imleci: göreli hareket (piksel). İlk hareket imleci ekranda gösterir.
   * Protokol: `type:move`, `dx`, `dy`, `down:0` (basılı değil).
   */
  move(dx, dy) {
    this._raw(['type:move', `dx:${Math.round(dx)}`, `dy:${Math.round(dy)}`, 'down:0']);
  }

  /** İmlecin bulunduğu yere tıklar (Magic Remote'un tekerine basmak). */
  click() {
    this._raw(['type:click']);
  }

  /** Sırayla birden çok tuş. */
  async sequence(names, { settleMs = 350, onStep = () => {} } = {}) {
    const out = [];
    for (const n of names) {
      const k = await this.button(n, { settleMs });
      out.push(k);
      onStep(k);
    }
    return out;
  }

  /** Sayıyı rakam tuşlarıyla girer (kanal numarası yazmak için). */
  async digits(n, opts = {}) {
    return this.sequence(String(n).split(''), opts);
  }

  close() { try { this.conn.close(); } catch { /* yok say */ } }
}

/**
 * Zararsız bağlantı testi: kumanda soketine bağlanır ve HİÇBİR tuş göndermez.
 * Kanalın gerçekten açık olduğunu, TV'de hiçbir şey değiştirmeden kanıtlar.
 */
export async function testInputChannel(ssap, opts = {}) {
  const res = await ssap.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
  if (!res?.socketPath) return { ok: false, sebep: 'socketPath alınamadı' };
  const { conn } = await connectUrl(res.socketPath, opts);
  const ok = !conn.closed;
  conn.close();
  return { ok, socketPath: res.socketPath.replace(/\/[0-9a-f]{8,}\//i, '/<gizli>/') };
}
