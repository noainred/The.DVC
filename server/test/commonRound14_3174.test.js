/**
 * v3.17.5 — 2차 공통 기능 점검 4회차: 내려받기(Blob 저장)는 공용 `web/src/util/saveBlob.js` 하나 · 파일 이름 판정은 `api.js dispositionName` 하나.
 *
 * 고정하는 것:
 *  ① 웹 소스(테스트 제외)에 '누르자마자 revokeObjectURL' 이 되살아나지 않는다 — setTimeout 안이 아닌 revoke 는 공용 헬퍼와
 *     첨부 미리보기의 언마운트 정리(AttachBox)만 허용. 예전엔 13곳이 click 직후 지웠다.
 *  ② Content-Disposition 을 손으로 파싱하지 않는다 — `filename` 정규식은 api.js dispositionName 하나(예전 postDownload · saveResponseAsFile 이
 *     첫 filename= 을 집어 filename* 의 한글 이름을 버렸고, decodeURIComponent 가 URIError 로 저장을 깼다).
 *  ③ 공용 헬퍼를 실제로 호출해 본다(DOM 대역) — 문서에 붙여 누르고 떼며, 주소는 바로 지우지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(e.name) && !/\.test\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(WEB, p).split(path.sep).join('/');

test('① click 직후 revokeObjectURL 이 없다(setTimeout 밖 revoke 는 공용 헬퍼 · 첨부 미리보기 정리만)', () => {
  const ALLOW = new Set(['util/saveBlob.js', 'views/attach/AttachBox.jsx']);
  const hits = [];
  for (const f of walk(WEB)) {
    if (ALLOW.has(rel(f))) continue;
    stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
      if (/URL\.revokeObjectURL\(/.test(line) && !/setTimeout\(/.test(line)) hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], `공용 util/saveBlob.js 를 쓸 것:\n${hits.join('\n')}`);
});

test('①-2 URL.createObjectURL 은 공용 헬퍼 안에만(첨부 미리보기 제외) — 손으로 쓴 내려받기가 되살아나지 않는다', () => {
  const ALLOW = new Set(['util/saveBlob.js', 'views/attach/AttachBox.jsx']);
  const hits = [];
  for (const f of walk(WEB)) {
    if (ALLOW.has(rel(f))) continue;
    if (/URL\.createObjectURL\(/.test(stripComments(fs.readFileSync(f, 'utf8')))) hits.push(rel(f));
  }
  assert.deepEqual(hits, [], `공용 util/saveBlob.js 를 쓸 것:\n${hits.join('\n')}`);
});

test('② Content-Disposition 파일 이름 정규식은 api.js dispositionName 하나', () => {
  const hits = [];
  for (const f of walk(WEB)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const n = (src.match(/\/filename[^/\n]{0,40}\/i?\.exec\(/g) || []).length;
    if (n && !(rel(f) === 'api.js' && n === 2)) hits.push(`${rel(f)} × ${n}`);
  }
  assert.deepEqual(hits, []);
});

test('③ saveBlob — 문서에 붙여 누르고 떼며, 주소는 1초 뒤에 지운다', async () => {
  const log = [];
  const timers = [];
  const g = globalThis;
  const saved = { document: g.document, URL_c: URL.createObjectURL, URL_r: URL.revokeObjectURL, setTimeout: g.setTimeout };
  const a = { click: () => log.push('click'), remove: () => log.push('remove') };
  g.document = { createElement: () => a, body: { appendChild: () => log.push('append') } };
  URL.createObjectURL = () => 'blob:x';
  URL.revokeObjectURL = (u) => log.push(`revoke:${u}`);
  g.setTimeout = (fn, ms) => { timers.push(ms); fn(); return 0; };
  try {
    const { saveBlob } = await import(pathToFileURL(path.join(WEB, 'util/saveBlob.js')).href);
    saveBlob(new Blob(['a']), '보고서.csv');
    assert.deepEqual(log, ['append', 'click', 'remove', 'revoke:blob:x']);
    assert.equal(a.download, '보고서.csv');
    assert.equal(timers[0], 1000);
  } finally {
    g.document = saved.document; URL.createObjectURL = saved.URL_c; URL.revokeObjectURL = saved.URL_r; g.setTimeout = saved.setTimeout;
  }
});
