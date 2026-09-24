import { describe, it, expect } from 'vitest';
import { downloadFailText } from './downloadFailText.js';
import { HttpError } from '../api.js';

describe('downloadFailText (v2.602 WEB2602-01)', () => {
  it('409 export_busy 는 서버 사유를 그대로 말하고 파일을 저장하지 않았다고 적는다', () => {
    const e = new HttpError('다른 내보내기가 진행 중입니다(본인 · 3초 경과). 끝난 뒤 다시 시도하세요.', { status: 409, body: { error: 'export_busy', reason: '다른 내보내기가 진행 중입니다(본인 · 3초 경과). 끝난 뒤 다시 시도하세요.' } });
    const t = downloadFailText(e);
    expect(t).toContain('다른 내보내기가 진행 중');
    expect(t).toContain('파일은 저장하지 않았습니다');
  });
  it('403 은 권한 안내 + 필요 역할', () => {
    const e = new HttpError('forbidden', { status: 403, body: { error: 'forbidden', requiredRole: ['admin'] } });
    expect(downloadFailText(e)).toMatch(/권한이 없습니다 \(필요 역할: admin\)/);
  });
  it('그 밖의 상태는 코드와 사유를 함께', () => {
    expect(downloadFailText(new HttpError('boom', { status: 500 }))).toContain('(HTTP 500) — boom');
    expect(downloadFailText(new Error('network'))).toContain('— network');
    expect(downloadFailText(null)).toContain('알 수 없는 오류');
  });
  it('백틱을 쓰지 않는다(BoldText 규약)', () => {
    expect(downloadFailText(new HttpError('x', { status: 409 }))).not.toMatch(/`/);
  });
});

// ── 실패 응답을 파일로 저장하지 않는다(실제 헬퍼 호출) ──────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { downloadFile } from '../api.js';
import { saveResponseAsFile } from './tools/shared.jsx';

const failRes = (status, body) => {
  let blobCalls = 0;
  return {
    ok: false, status, headers: { get: () => '' },
    json: async () => body, blob: async () => { blobCalls++; return new Blob([JSON.stringify(body)]); },
    get blobCalls() { return blobCalls; },
  };
};

describe('다운로드 헬퍼는 실패 응답을 저장하지 않는다 (WEB2602-01)', () => {
  it('api.js downloadFile — 409 export_busy 면 HttpError(409, 서버 사유)로 던지고 blob 을 읽지 않는다', async () => {
    const res = failRes(409, { ok: false, error: 'export_busy', reason: '다른 내보내기가 진행 중입니다(본인 · 2초 경과). 끝난 뒤 다시 시도하세요.' });
    const orig = globalThis.fetch;
    const origLs = globalThis.localStorage; const origSs = globalThis.sessionStorage;
    const store = () => { const mem = new Map(); return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }; };
    globalThis.localStorage = store(); globalThis.sessionStorage = store();
    globalThis.fetch = async () => res;
    try {
      await expect(downloadFile('/tools/ipam.xlsx', 'x.xlsx')).rejects.toMatchObject({ status: 409 });
      expect(res.blobCalls).toBe(0);
    } finally { globalThis.fetch = orig; globalThis.localStorage = origLs; globalThis.sessionStorage = origSs; }
  });
  it('shared.jsx saveResponseAsFile — 403 이면 던지고 blob 을 읽지 않는다', async () => {
    const res = failRes(403, { error: 'forbidden', requiredRole: ['admin'] });
    await expect(saveResponseAsFile(res, 'gpu.csv')).rejects.toMatchObject({ status: 403 });
    expect(res.blobCalls).toBe(0);
  });
  it('소스 스윕 — res.blob() 를 직접 부르는 화면 파일은 res.ok 를 확인한다(api.js 제외)', () => {
    const root = path.resolve(__dirname, '..');
    const bad = [];
    const walk = (d) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) { if (n !== 'vendor') walk(p); continue; }
        if (!/\.(jsx?|tsx?)$/.test(n) || /\.test\./.test(n) || p.endsWith(`${path.sep}api.js`)) continue;
        const s = fs.readFileSync(p, 'utf8');
        if (/\.blob\(\)/.test(s) && !/\bres\.ok\b/.test(s)) bad.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(bad).toEqual([]);
  });
});
