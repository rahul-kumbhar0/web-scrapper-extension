// Tiny fixture server: static files + a fake Shopify products.json and BASE-substituted sitemaps.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.xml': 'application/xml', '.json': 'application/json', '.txt': 'text/plain', '.gz': 'application/gzip', '.jpg': 'image/jpeg' };
// 1x1 JPEG so <img> loads succeed
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

export async function startServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const base = `http://${req.headers.host}`;
    if (u.pathname === '/products.json') {
      const page = Number(u.searchParams.get('page') || 1);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(page === 1 ? fs.readFileSync(path.join(FIXTURES, 'products-page1.json')) : '{"products":[]}');
    }
    if (u.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(JPG); }
    const file = path.join(FIXTURES, path.normalize(decodeURIComponent(u.pathname)));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    let body = fs.readFileSync(file);
    if (/\.(xml|txt)$/.test(file)) body = body.toString().replaceAll('BASE', base).replace('Sitemap: /', `Sitemap: ${base}/`);
    if (file.endsWith('.gz')) {
      const zlib = await import('node:zlib');
      body = zlib.gzipSync(zlib.gunzipSync(body).toString().replaceAll('BASE', base));
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
