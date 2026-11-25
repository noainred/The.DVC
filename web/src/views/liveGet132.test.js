/**
 * 전체 점검 132회차(129회차 추정 E2) — GET 인데 서버가 **실제 장비 · 네트워크에 접속하는** 호출이 기본 20초 시한 · 재시도 2회를 탔다.
 *
 * 고치기 전: fetchJson 은 시한 초과를 일시 오류로 보고 다시 보낸다. 서버는 끊긴 요청의 처리를 멈추지 않으므로, 처리가 20초를 넘으면
 *   같은 점검(iDRAC Redfish 순차 요청 수십 개 · 전 vCenter TCP 프로브 · 중계 경로 3단계)이 **세 번 겹쳐 시작**되고 화면은 60초 뒤 '시간 초과' 만 보였다.
 * 고친 뒤: 그 호출은 { timeoutMs(넉넉히), retries: 0 } — 길게 한 번만 기다린다. api.js 의 재시도 규약은 그대로다.
 *
 * '실접속 GET' 의 목록은 서버가 갖고 있다(server/src/auth/demoGuest.js LIVE_GET_DENY — 서버 테스트 audit2719b 가 라우터 스택과 대조).
 * 이 파일은 그 목록의 경로를 부르는 웹 호출이 전부 retries: 0 인지 본다(새 실접속 GET 을 기본 옵션으로 부르면 여기서 걸린다).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from '../api.js';
import { _resetPerfClient } from '../perfClient.js';
import { stripComments } from '../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..');
const read = (rel) => stripComments(fs.readFileSync(path.join(WEB, rel), 'utf8'));

const origFetch = globalThis.fetch;
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
beforeEach(() => { _resetPerfClient(); globalThis.localStorage = memStore(); globalThis.sessionStorage = memStore(); });
afterEach(() => { globalThis.fetch = origFetch; });

/** 응답하지 않는 서버 — 요청이 시한으로 끊길 때까지 매달린다. 시작된 요청 수를 센다(서버는 끊긴 요청의 처리를 계속한다). */
function hangingFetch() {
  const st = { started: 0 };
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    st.started += 1;
    const sig = init.signal;
    const fail = () => reject(sig.reason || new DOMException('signal timed out', 'TimeoutError'));
    if (sig.aborted) fail(); else sig.addEventListener('abort', fail, { once: true });
  });
  return st;
}

describe('재현 — 시한을 넘긴 GET 은 기본 옵션이면 세 번 시작된다', () => {
  it('기본(재시도 2회): 같은 요청이 3번 나간다 · retries: 0 이면 1번', async () => {
    const a = hangingFetch();
    await expect(fetchJson('/admin/idrac/srv-1/gpu-probe', {}, undefined, { timeoutMs: 40 })).rejects.toThrow();
    expect(a.started).toBe(3); // 고치기 전 호출부는 이 길을 탔다(시한만 20초였다)
    const b = hangingFetch();
    await expect(fetchJson('/admin/idrac/srv-1/gpu-probe', {}, undefined, { timeoutMs: 40, retries: 0 })).rejects.toThrow();
    expect(b.started).toBe(1);
  });
});

/** 소스에서 fetchJson( … ) 호출 식 전체를 뽑는다(괄호 짝 · 문자열 · 템플릿을 건너뛴다). */
function fetchJsonCalls(src) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf('fetchJson(', from);
    if (i < 0) break;
    let depth = 0; let j = i + 'fetchJson'.length; let q = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === '\\') j += 1; else if (c === q) q = null; continue; }
      if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push(src.slice(i, j + 1));
    from = j + 1;
  }
  return out;
}

/** 호출의 첫 인자가 글자(문자열 · 템플릿)면 그 경로 — 템플릿의 ${식} 은 ':x' 한 세그먼트로 바꾼다(식 안의 따옴표 · 중괄호를 건너뛴다). 아니면 ''. */
function firstArgText(call) {
  const m = call.match(/^fetchJson\(\s*([`'"])/);
  if (!m) return '';
  const q = m[1];
  let out = '';
  for (let i = m[0].length; i < call.length; i++) {
    const c = call[i];
    if (c === '\\') { i += 1; continue; }
    if (c === q) return out;
    if (q === '`' && c === '$' && call[i + 1] === '{') {
      let depth = 0; let j = i + 1;
      for (; j < call.length; j++) { if (call[j] === '{') depth += 1; else if (call[j] === '}') { depth -= 1; if (depth === 0) break; } }
      const expr = call.slice(i + 2, j);
      out += /\?/.test(expr) && /['"]\?/.test(expr) ? `?${expr}` : ':x';   // 질의를 붙이는 식(refresh ? '?refresh=1' : '')은 질의로 남긴다
      i = j;
      continue;
    }
    out += c;
  }
  return '';
}

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.(js|jsx)$/.test(e.name)) out.push(f);
  }
  return out;
};

describe('실접속 GET 을 부르는 웹 호출은 전부 길게 한 번만 기다린다', () => {
  // 서버의 실접속 GET 목록(경로 + 질의 조건)
  const demo = fs.readFileSync(path.resolve(WEB, '../../server/src/auth/demoGuest.js'), 'utf8');
  const block = demo.slice(demo.indexOf('export const LIVE_GET_DENY = ['), demo.indexOf('];', demo.indexOf('export const LIVE_GET_DENY = [')));
  const live = [...block.matchAll(/\{ path: '\/api([^']+)'(?:, query: \['(\w+)', '(\w+)'\])? \}/g)].map((m) => ({ path: m[1], query: m[2] ? [m[2], m[3]] : null }));

  it('서버 목록을 읽었다(다섯 곳 이상)', () => {
    expect(live.length).toBeGreaterThanOrEqual(5);
    expect(live.map((l) => l.path)).toEqual(expect.arrayContaining(['/admin/vcenter/relay-test', '/admin/idrac/:id/gpu-probe', '/admin/idrac/:id/inventory', '/tools/network-check']));
  });

  it('그 경로를 부르는 fetchJson 호출은 retries: 0 과 20초보다 긴 시한을 준다', () => {
    const hits = [];
    const bad = [];
    for (const f of walk(WEB)) {
      const rel = path.relative(WEB, f).split(path.sep).join('/');
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      // 파일 안의 옵션 상수(const X = { … retries: 0 … })
      const consts = new Map([...src.matchAll(/const (\w+) = (\{[^{}\n]*\});/g)].map((m) => [m[1], m[2]]));
      for (const call of fetchJsonCalls(src)) {
        // 경로 글자: `…${expr}…` 의 식을 한 세그먼트로 본다
        const lit = firstArgText(call);
        if (!lit) continue;
        const [p, qs = ''] = lit.split('?');
        const l = live.find((x) => new RegExp(`^${x.path.replace(/:id/g, '[^/]+')}$`).test(p));
        if (!l) continue;
        // 질의 조건이 있는 경로는 그 질의를 실을 수 있는 호출만 본다(캐시 조회는 기본 옵션 그대로)
        if (l.query && !new RegExp(`\\b${l.query[0]}\\b`).test(`${qs} ${call}`)) continue;
        hits.push(`${rel}: ${lit}`);
        const expanded = call.replace(/\b(\w+)\b/g, (w) => (consts.has(w) ? consts.get(w) : w));
        const t = (expanded.match(/timeoutMs:\s*([\d_]+)/) || [])[1];
        if (!/retries:\s*0\b/.test(expanded)) bad.push(`${rel}: ${lit} — retries: 0 이 없다`);
        else if (!t || Number(t.replace(/_/g, '')) <= 20_000) bad.push(`${rel}: ${lit} — 시한이 기본(20초)보다 길지 않다`);
      }
    }
    expect(bad).toEqual([]);
    // 지금 화면이 부르는 다섯 호출이 전부 잡혔다(스윕이 무력해지지 않게)
    expect(hits.length).toBeGreaterThanOrEqual(5);
    for (const want of ['views/Diagnostics.jsx', 'views/VCenterConnTest.jsx', 'views/idrac/IdracDetailModal.jsx', 'views/DavinciChecks.jsx']) {
      expect(hits.some((h) => h.startsWith(want)), want).toBe(true);
    }
  });

  it('인벤토리의 캐시 조회(새로 수집 아님)는 기본 옵션 그대로다 — 마운트 조회까지 재시도를 끄지 않는다', () => {
    const m = read('views/idrac/IdracDetailModal.jsx');
    expect(m).toMatch(/inventory\$\{refresh \? '\?refresh=1' : ''\}`, \{\}, undefined, refresh \? LIVE_IDRAC_GET : \{\}\)/);
    expect(m).toMatch(/const LIVE_IDRAC_GET = \{ timeoutMs: 120_000, retries: 0 \};/);
  });
});
