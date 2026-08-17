#!/usr/bin/env node
/**
 * Yerel statik sunucu — yalnız geliştirme/kullanım kolaylığı için.
 *
 * `web/editor.html` dosyasını çift tıklayarak da açabilirsin; tek fark, file://
 * üzerinden `data/turksat-42e-latest.json` okunamadığı için "Türksat'a göre"
 * sütununun boş kalmasıdır. Sunucu yalnız 127.0.0.1'e bağlanır, dışarı açılmaz.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.tll': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = decodeURIComponent(url.pathname);
    // Kökten /web/ altına YÖNLENDİR (içerik sunma). Aksi hâlde sayfanın
    // göreli yolları /style.css gibi çözülür ve 404 olur.
    if (p === '/' || p === '/web') {
      res.writeHead(302, { Location: '/web/' }).end();
      return;
    }
    if (p === '/web/') p = '/web/home.html';

    // Dizin dışına çıkışı engelle
    const full = normalize(resolve(ROOT, '.' + p));
    if (!full.startsWith(ROOT + sep)) {
      res.writeHead(403).end('403');
      return;
    }
    const st = await stat(full);
    if (st.isDirectory()) { res.writeHead(403).end('403'); return; }

    const buf = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Editör hazır:  http://127.0.0.1:${PORT}/\n`);
});
