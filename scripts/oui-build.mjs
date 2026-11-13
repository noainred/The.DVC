#!/usr/bin/env node
/**
 * oui-build.mjs — MAC 앞자리 → 제조사 이름 표(`server/src/ipam/vendor/oui.tsv.gz`)를 만든다(v2.999 — 설계 docs/design/ipam-alerts-mac-dns ②).
 *
 * 원천: npm `oui-data`(BSD-2-Clause — IEEE 공개 등록부 MA-L · MA-M · MA-S 를 JSON 으로 담은 것). 포탈은 실행 중 내려받지 않는다
 *   (오프라인 설치 — 표는 릴리스에 실린다). 첫 줄(조직 이름)만 쓰고 주소 줄은 버린다. 이 스크립트는 개발 때만 돈다.
 *
 * 사용:
 *   npm pack oui-data@<버전> && tar xzf oui-data-<버전>.tgz
 *   node scripts/oui-build.mjs package/index.json <버전>
 * 산출: server/src/ipam/vendor/oui.tsv.gz(첫 줄 `# oui-data@<버전> · <건수>` · 이후 `PREFIX\t이름` — 접두 오름차순)와 같은 폴더의 LICENSE 사본.
 *   같은 입력이면 같은 바이트다(gzip 헤더 시각 0 · 정렬).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'server/src/ipam/vendor');
const [src, ver] = process.argv.slice(2);
if (!src || !ver) { console.error('사용: node scripts/oui-build.mjs <oui-data/index.json> <버전>'); process.exit(2); }
const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const rows = [];
let skipped = 0;
for (const [k, v] of Object.entries(data)) {
  const name = String(v || '').split('\n')[0].replace(/[\u0000-\u001f\u007f\t]/g, '').trim().slice(0, 80);
  if (!/^(?:[0-9A-F]{6}|[0-9A-F]{7}|[0-9A-F]{9})$/.test(k) || !name) { skipped += 1; continue; }
  rows.push([k, name]);
}
rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const text = `# oui-data@${ver} · ${rows.length}\n${rows.map(([k, n]) => `${k}\t${n}`).join('\n')}\n`;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'oui.tsv.gz'), zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9 }));
const lic = path.join(path.dirname(src), 'LICENSE');
if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(OUT_DIR, 'oui-data-LICENSE.txt'));
console.log(`oui.tsv.gz: ${rows.length}건(버린 것 ${skipped}) · 원문 ${text.length}자`);
