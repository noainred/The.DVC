/**
 * util/staticGzip.js — 빌드 자산(해시 이름·불변)의 gzip 전송(v2.596, 감사 PERFWEB-02 — 실측).
 *
 * 왜: compression 은 `res.json` 만 감싼다(util/compress.js). JS·CSS 청크는 express.static 이 **원본 그대로** 보내
 * 고RTT(800ms+) 법인이 첫 로드에 수 MB 를 받았다. 해시 자산은 내용이 바뀌지 않으므로 **파일마다 한 번만** 비동기로
 * 압축해 메모리에 두고 재사용한다(요청마다 동기 gzip 금지 — 이벤트 루프 규약). 진행 중인 압축은 공유한다.
 *
 * 안전: `/assets/<안전한 이름>` 만 다룬다(경로 탈출 불가 — 이름에 '/'·'..' 없음). 캐시 상한을 넘으면 압축하지 않고
 * 원본 경로(express.static)로 넘긴다. Accept-Encoding 에 gzip 이 없으면 손대지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8' };
const NAME_RE = /^[\w.-]+$/;
export const STATIC_GZIP_MAX_BYTES = 96 * 1024 * 1024;   // 압축본 합계 상한

export function createStaticGzip(distDir) {
  const assets = path.join(distDir, 'assets');
  const cache = new Map();        // name -> { mtimeMs, buf, size }
  const inflight = new Map();     // name -> Promise
  let total = 0;
  const build = async (name, file, st) => {
    const raw = await fs.promises.readFile(file);
    const buf = await gzip(raw, { level: 9 });
    const prev = cache.get(name);
    if (prev) total -= prev.buf.length;
    if (total + buf.length > STATIC_GZIP_MAX_BYTES) return null;
    cache.set(name, { mtimeMs: st.mtimeMs, buf, size: raw.length });
    total += buf.length;
    return cache.get(name);
  };
  return async function staticGzip(req, res, next) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const m = /^\/assets\/([^/]+)$/.exec(req.path);
      if (!m || !NAME_RE.test(m[1]) || m[1].includes('..')) return next();
      const ext = path.extname(m[1]).toLowerCase();
      if (!TYPES[ext]) return next();
      if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return next();
      const file = path.join(assets, m[1]);
      let st;
      try { st = await fs.promises.stat(file); } catch { return next(); }
      if (!st.isFile() || st.size < 1024) return next();   // 작은 파일은 이득이 없다
      let ent = cache.get(m[1]);
      if (!ent || ent.mtimeMs !== st.mtimeMs) {
        let p = inflight.get(m[1]);
        if (!p) { p = build(m[1], file, st).finally(() => inflight.delete(m[1])); inflight.set(m[1], p); }
        ent = await p;
        if (!ent) return next();
      }
      res.setHeader('Content-Type', TYPES[ext]);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(ent.buf.length));
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (req.method === 'HEAD') return res.end();
      return res.end(ent.buf);
    } catch { return next(); }
  };
}
