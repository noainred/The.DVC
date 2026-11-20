// 전체 점검 156회차 5축(웹 화면 전체) — 회귀.
//  A1 스냅샷 보류 저장 · A2 집중 모니터링 알림 규칙 고치기 · A3 잠깐 보기 연장 · A4 Bareos 번들 지우기:
//     api.js 의 putJson · delJson(sendJson)은 400 · 409 를, postJson 은 409 를 던지지 않고 본문을 돌려준다 — 거절 본문을 성공으로 읽거나 조용히 삼키던 4곳.
//     기존 스윕(views/audit2727e.test.js)은 `await <fn>(` 꼴만 본다(그 파일 주석의 '한계') — 여기서 약속 연쇄 꼴(`<fn>(…).then(() =>`)을 전수로 센다.
//  A5 서버 명령 실행 — 늦게 온 지난 실행의 출력을 새 실행의 표 아래에 붙이지 않는다.
//  A6 서비스 워커(public/sw.js) — 캐시를 지우는 곳이 없어 옛 판의 화면 조각이 끝없이 쌓였다(129 · 132 · 133회차가 남긴 것).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { requireChanged } from '../changeResult.js';
import { okOrThrow } from './bareosInstallText.js';
import { outputStale, OUTPUT_STALE_TEXT } from './serverCmdText.js';
import { saveHold } from './snapshots/SnapshotTool.jsx';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.join(here, '..', '..');
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('A1 스냅샷 보류 — 서버가 거절한 저장(400 본문)을 ‘보류했습니다’ 로 읽지 않는다', () => {
  const form = { key: 'va\nvm-1', vcenterId: 'va', vmId: 'vm-1', days: '30', reason: '이관 중' };
  it('거절 본문({ ok:false, reason })이면 그 사유로 던진다 — 성공 안내 글을 만들지 않는다', async () => {
    // 서버 vmhygiene/holds.js setHold: 보류 상한 · 사유 없음 · 일수 밖 → routes/api/vcTools.js 가 400 + { ok:false, reason }
    await expect(saveHold(form, async () => ({ ok: false, reason: '보류는 2000건까지입니다.' }))).rejects.toThrow('보류는 2000건까지입니다.');
    await expect(saveHold({ ...form, days: 0 }, async () => ({ ok: false, reason: '보류 일수는 0(풀기) ~ 90일 정수입니다.' }))).rejects.toThrow(/보류 일수/);
  });
  it('성공이면 안내 글 — 일수는 수로 보낸다(0 = 풀기)', async () => {
    const sent = [];
    const put = async (p, b) => { sent.push([p, b]); return { ok: true, hold: null }; };
    expect(await saveHold(form, put)).toMatch(/^30일 보류했습니다/);
    expect(await saveHold({ ...form, days: '0' }, put)).toBe('보류를 풀었습니다.');
    expect(sent[0]).toEqual(['/tools/snapshots/holds', { vcenterId: 'va', vmId: 'vm-1', days: 30, reason: '이관 중' }]);
    expect(sent[1][1].days).toBe(0);
  });
  it('요청이 던진 오류(403 · 404 · 503)는 그대로 지나간다', async () => {
    await expect(saveHold(form, async () => { throw new Error('이 vCenter 는 쓰기 범위 밖입니다.'); })).rejects.toThrow('쓰기 범위 밖');
  });
  it('보류 창은 saveHold 를 지나 저장한다(창 안에서 putJson 을 직접 부르지 않는다)', () => {
    const s = src('./snapshots/SnapshotTool.jsx');
    const at = s.indexOf('function HoldForm(');
    expect(at).toBeGreaterThan(0);
    const body = s.slice(at);
    expect(body).toMatch(/saveHold\(form\)\.then\(onDone\)\.catch\(/);
    expect(body).not.toMatch(/putJson\(/);
  });
  it('좁은 화면 — 보류 창(저장 실패 사유 포함)이 표의 가로 스크롤 밖으로 밀리지 않게 폭을 화면에 맞추고 왼쪽에 붙인다', () => {
    // Chromium 400px 판독: 표 상자(최소 폭 1180px) 안이라 ‘보류’ 를 누르면 사유 줄이 스크롤 왼쪽 화면 밖에 놓였다(창 폭 1128px)
    const css = stripComments(fs.readFileSync(path.join(here, './snapshots/snapshots.css'), 'utf8'));
    const m = /@media \(max-width: 720px\) \{ \.snp-hold \{([^}]*)\} \}/.exec(css);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/position: sticky; left: 0;/);
    expect(m[1]).toMatch(/max-width: calc\(100vw - \d+px\);/);
    expect(m[1]).toMatch(/white-space: normal;/);
  });
});

describe('A2 집중 모니터링 알림 규칙 — 고치기(PUT)의 400 본문을 ‘고쳤습니다’ 로 읽지 않는다', () => {
  it('서버가 실제로 400 으로 거절하는 고치기 입력(서비스 이름 꼴이 아닌 필수 앱 · 그룹 없음)을 requireChanged 가 사유로 던진다', async () => {
    const { normalizeRule } = await import('../../../../server/src/focusmon/alerts.js');
    const ok = { name: 'DB 앱', metric: 'cpu', threshold: 90, durMin: 5, severity: 'warn', scope: { kind: 'record' } };
    expect(normalizeRule(ok).ok).toBe(true);
    // 화면은 필수 앱 칸이 비었는지만 본다 — 'oracle-db'(…service 가 아님)는 저장 단추가 열리고 서버가 거절한다
    const badApp = normalizeRule({ ...ok, metric: 'app', threshold: 1, app: 'oracle-db' });
    // 그룹이 하나도 없을 때 ‘그룹’ 을 고르면 화면이 group: '' 을 보낸다
    const badGroup = normalizeRule({ ...ok, scope: { kind: 'group', group: '' } });
    for (const r of [badApp, badGroup]) {
      expect(r.ok).toBe(false);
      expect(typeof r.reason).toBe('string');
      expect(() => requireChanged(r)).toThrow(r.reason);
    }
    expect(requireChanged({ ok: true, rule: {} })).toEqual({ ok: true, rule: {} });
  });
  it('규칙 저장 · 켜기/끄기 · 지우기 모두 응답을 requireChanged 로 판정한 뒤에 성공을 말한다', () => {
    const s = src('./FocusMonAlerts.jsx');
    expect(s).toMatch(/import \{ requireChanged \} from '\.\.\/changeResult\.js'/);
    expect(s).toMatch(/p\.then\(requireChanged\)\.then\(\(\) => \{ setMsg\?\.\(\{ tone: 'ok', text: `규칙/);
    expect(s).toMatch(/const act = \(p, ok\) => \{ setBusy\(true\); p\.then\(requireChanged\)\.then\(/);
    expect(s).not.toMatch(/\bp\.then\(\s*\(\s*\)\s*=>/);   // 응답을 받지 않고 성공 처리하던 꼴
  });
});

describe('A3 잠깐 보기 연장 — 409(최대 시간 · 계속 수집) 본문을 조용히 삼키지 않는다', () => {
  it('연장 두 곳 모두 응답을 requireChanged 로 판정한다(거절이면 catch 가 사유를 보인다)', () => {
    const s = src('./FocusMonTool.jsx');
    const hits = s.match(/\/extend`, \{\}\)\.then\(\(r\) => \{ requireChanged\(r\); mainQ\.reload\(\); \}\)\s*\.catch\(\(e\) => setMsg\(\{ tone: 'bad', text: e\?\.body\?\.reason \|\| e\?\.message \}\)\)/g) || [];
    expect(hits.length).toBe(2);
    expect(s).not.toMatch(/\/extend`, \{\}\)\.then\(\(\) =>/);
  });
  it('서버 거절 본문은 사유를 메시지 · body.reason 으로 실어 던져진다', () => {
    const body = { ok: false, code: 'max', reason: '잠깐 보기는 시작부터 최대 4시간입니다 — 계속 보려면 계속 수집으로 시작하세요.' };
    let err = null;
    try { requireChanged(body); } catch (e) { err = e; }
    expect(err?.message).toBe(body.reason);
    expect(err?.body?.reason).toBe(body.reason);
  });
});

describe('A4 Bareos 번들 지우기 — 지운 파일이 없다는 응답({ ok:false })을 ‘지웠습니다’ 로 읽지 않는다', () => {
  it('서버 deleteBundle 은 지운 파일이 없으면 false — 라우트가 200 { ok:false } 로 답한다', async () => {
    const { deleteBundle } = await import('../../../../server/src/bareos/install/bundle.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full156-'));
    try { expect(deleteBundle('2.0.0', dir)).toBe(false); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const route = stripComments(fs.readFileSync(path.join(here, '../../../../server/src/routes/api/bareosInstall.js'), 'utf8'));
    expect(route).toMatch(/const ok = deleteBundle\(v\);[\s\S]{0,200}res\.json\(\{ ok \}\);/);
  });
  it('화면은 그 응답을 okOrThrow 로 판정한다 — 사유 없는 ok:false 는 ‘지우지 못했습니다’', () => {
    const s = src('./BareosInstall.jsx');
    expect(s).toMatch(/act\(async \(\) => okOrThrow\(await delJson\(`\$\{P\}\/bundle\/\$\{encodeURIComponent\(x\.version\)\}`\), `번들 \$\{x\.version\} 을\(를\) 지우지 못했습니다/);
    expect(s).not.toMatch(/act\(\(\) => delJson\(/);
    expect(() => okOrThrow({ ok: false }, '번들 1.0 을(를) 지우지 못했습니다')).toThrow('지우지 못했습니다');
    expect(okOrThrow({ ok: true })).toEqual({ ok: true });
  });
});

describe('스윕 — 쓰기 요청 뒤 응답을 받지 않는 약속 연쇄(`<fn>(…).then(() =>`)', () => {
  // sendJson 계열(put · patch · del)은 400 · 409 를, postJson 은 409 를 본문으로 돌려준다 — `.then(() => …)` 은 그 본문을 버린다.
  // 아래 허용 목록은 서버 라우트를 따라가 '400 · 409 본문이 오지 않는다(404 · 403 · 503 은 던진다)' 를 확인한 것뿐이다(156회차):
  //   FocusMonAlerts — PUT /tools/focus-mon/settings(실패는 503) · FocusMonHistory — DELETE events/:id(404 · 503) ·
  //   FocusMonTool 2 — DELETE targets/:id(404 · 503) · DELETE sessions/:id(404).
  //   새로 걸리면 응답을 받아 requireChanged(또는 r.ok)로 판정하거나, 서버 라우트를 확인하고 여기에 사유와 함께 적는다.
  const ALLOW = { 'views/tools/FocusMonAlerts.jsx': 1, 'views/tools/FocusMonHistory.jsx': 1, 'views/tools/FocusMonTool.jsx': 2 };
  const closeOf = (s, open) => {
    let d = 0; let q = null;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '(') d++; else if (c === ')') { d--; if (d === 0) return i; }
    }
    return -1;
  };
  const count = (text) => {
    let n = 0; const re = /\b(delJson|putJson|patchJson|sendJson|postJson)\s*\(/g; let m;
    while ((m = re.exec(text))) {
      const close = closeOf(text, m.index + m[0].length - 1);
      if (close >= 0 && /^\s*\.then\(\s*(async\s*)?\(\s*\)\s*=>/.test(text.slice(close + 1, close + 60))) n += 1;
    }
    return n;
  };
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  it('검출 결과가 허용 목록과 글자 그대로 같다', () => {
    const found = {};
    for (const f of walk(WEB_SRC)) {
      const rel = path.relative(WEB_SRC, f).split(path.sep).join('/');
      if (/\.test\.(js|jsx)$/.test(rel) || rel === 'api.js' || rel.startsWith('test/')) continue;
      const n = count(stripComments(fs.readFileSync(f, 'utf8')));
      if (n) found[rel] = n;
    }
    expect(found).toEqual(ALLOW);
  });
  it('검출기 자체 검증 — 응답을 버리는 연쇄만 센다', () => {
    expect(count("putJson('/x', { a: 1 }).then(() => done())")).toBe(1);
    expect(count("delJson(`/x/${enc(id)}`)\n  .then(async () => { ok(); })")).toBe(1);
    expect(count("postJson(`/x/${id}/extend`, {}).then(() => reload())")).toBe(1);
    expect(count("putJson('/x', b).then((r) => { requireChanged(r); done(); })")).toBe(0);
    expect(count("putJson('/x', b).then(requireChanged).then(() => done())")).toBe(0);
    expect(count("const r = await putJson('/x', b);")).toBe(0);
  });
});

describe('A5 서버 명령 실행 — 늦게 온 지난 실행의 출력을 버린다', () => {
  it('보낼 때 · 응답 · 지금 화면의 실행 열쇠가 모두 같을 때만 쓴다', () => {
    expect(outputStale('run-a', { ok: true, runKey: 'run-a', rows: [] }, 'run-a')).toBe(false);
    // 응답을 기다리는 사이 화면이 새 실행(run-b)으로 바뀌었다 — 서버는 요청을 받은 때의 실행(run-a)으로 200 을 줬다
    expect(outputStale('run-a', { ok: true, runKey: 'run-a', rows: [{ id: 's1', out: '지난 출력' }] }, 'run-b')).toBe(true);
    expect(outputStale('run-a', { ok: true, runKey: 'run-b', rows: [] }, 'run-a')).toBe(true);
    expect(outputStale('run-a', { ok: true, rows: [] }, 'run-a')).toBe(false);   // 열쇠 없는 응답(옛 서버) — 보낸 열쇠로만 본다
    expect(outputStale('run-a', { ok: true, runKey: 'run-a' }, '')).toBe(true);   // 지난 출력이 지워진 화면
    expect(OUTPUT_STALE_TEXT).not.toContain('`');
  });
  it('fetchOut 은 받은 출력을 넣기 전에 대조한다(화면의 실행 열쇠는 렌더마다 ref 에)', () => {
    const s = src('./ServerCmdTool.jsx');
    expect(s).toMatch(/lastKeyRef\.current = lastKey;/);
    const at = s.indexOf('const fetchOut = async');
    const body = s.slice(at, s.indexOf('const toggleOpen', at));
    expect(body).toMatch(/const sent = v\.last\?\.runKey \|\| '';/);
    expect(body).toMatch(/run: sent \}/);
    const chk = body.indexOf('if (outputStale(sent, r, lastKeyRef.current)) throw new Error(OUTPUT_STALE_TEXT);');
    expect(chk).toBeGreaterThan(0);
    expect(chk).toBeLessThan(body.indexOf('setOuts('));
  });
});

describe('A6 서비스 워커 — 오래 다시 받지 않은 캐시(옛 판의 화면 조각)를 지운다', () => {
  const SW = fs.readFileSync(path.join(WEB_SRC, '..', 'public', 'sw.js'), 'utf8');
  const DAY = 86_400_000;
  /** 서비스 워커를 가짜 환경에서 돌린다 — 캐시(Map) · fetch · 사건 등록. */
  function boot({ online = true } = {}) {
    const store = new Map();   // url → 응답(가짜)
    const res = (date) => ({ ok: true, type: 'basic', headers: new Headers(date == null ? {} : { date: new Date(date).toUTCString() }), clone() { return this; } });
    const keyOf = (r) => (typeof r === 'string' ? new URL(r, 'https://portal.test').href : r.url);
    const cache = {
      keys: async () => [...store.keys()].map((url) => ({ url })),
      match: async (r) => store.get(keyOf(r)),
      delete: async (r) => store.delete(keyOf(r)),
      put: async (r, v) => { store.set(keyOf(r), v); },
    };
    const caches = { open: async () => cache, keys: async () => ['vmportal-shell-v1'], delete: async () => true, match: async (r) => store.get(keyOf(r)) };
    const handlers = {};
    const self = { addEventListener: (n, fn) => { handlers[n] = fn; }, skipWaiting() {}, location: { origin: 'https://portal.test' }, clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} } };
    const fetched = [];
    const fetch = async (req) => { fetched.push(req.url); if (!online) throw new TypeError('Failed to fetch'); return res(Date.now()); };
    new Function('self', 'caches', 'fetch', SW)(self, caches, fetch);
    /** fetch 사건 하나 — 응답과 수명 연장 약속이 모두 끝날 때까지 기다린다. */
    const hit = async (pathname, mode = 'no-cors') => {
      const waits = []; let responded = null;
      handlers.fetch({ request: { method: 'GET', url: `https://portal.test${pathname}`, mode }, respondWith: (p) => { responded = p; }, waitUntil: (p) => { waits.push(p); } });
      const out = responded ? await responded : undefined;
      await Promise.all(waits);
      return { intercepted: !!responded, out };
    };
    const seed = (pathname, date) => store.set(`https://portal.test${pathname}`, res(date));
    return { store, hit, seed, fetched, has: (pathname) => store.has(`https://portal.test${pathname}`) };
  }

  it('화면을 여는 요청이 성공하면, 기한(14일)을 넘겨 다시 받지 않은 것만 지운다 — Date 없는 응답은 그대로', async () => {
    const sw = boot();
    sw.seed('/assets/Old-aaaa1111.js', Date.now() - 20 * DAY);
    sw.seed('/assets/Cur-bbbb2222.js', Date.now() - 1 * DAY);
    sw.seed('/assets/NoDate-cccc3333.js', null);
    const r = await sw.hit('/', 'navigate');
    expect(r.intercepted).toBe(true);
    expect(r.out?.ok).toBe(true);
    expect(sw.has('/assets/Old-aaaa1111.js')).toBe(false);
    expect(sw.has('/assets/Cur-bbbb2222.js')).toBe(true);
    expect(sw.has('/assets/NoDate-cccc3333.js')).toBe(true);
    expect(sw.has('/')).toBe(true);   // 이번 응답은 담긴 뒤에 정리한다(방금 담은 것을 지우지 않는다)
  });
  it('자산 요청만으로는 정리하지 않는다 · 정리는 시간당 한 번', async () => {
    const sw = boot();
    sw.seed('/assets/Old-aaaa1111.js', Date.now() - 20 * DAY);
    await sw.hit('/assets/Cur-bbbb2222.js');
    expect(sw.has('/assets/Old-aaaa1111.js')).toBe(true);
    await sw.hit('/', 'navigate');
    expect(sw.has('/assets/Old-aaaa1111.js')).toBe(false);
    sw.seed('/assets/Old2-dddd4444.js', Date.now() - 30 * DAY);
    await sw.hit('/', 'navigate');   // 방금 정리했다 — 한 시간 안에는 다시 훑지 않는다
    expect(sw.has('/assets/Old2-dddd4444.js')).toBe(true);
  });
  it('오래 다시 받지 않은 화면(/)도 이번에 받은 응답으로 바뀐 뒤라 남는다', async () => {
    const sw = boot();
    sw.seed('/', Date.now() - 40 * DAY);
    await sw.hit('/', 'navigate');
    expect(sw.has('/')).toBe(true);
  });
  it('네트워크가 끊기면 예전처럼 캐시로 답하고 아무것도 지우지 않는다', async () => {
    const sw = boot({ online: false });
    sw.seed('/', Date.now() - 40 * DAY);
    sw.seed('/assets/Old-aaaa1111.js', Date.now() - 40 * DAY);
    const r = await sw.hit('/', 'navigate');
    expect(r.out?.ok).toBe(true);
    expect(sw.has('/assets/Old-aaaa1111.js')).toBe(true);
    const a = await sw.hit('/assets/Old-aaaa1111.js');
    expect(a.out?.ok).toBe(true);
  });
  it('API · 다른 출처 · GET 이 아닌 요청에는 끼어들지 않는다(그대로)', async () => {
    const sw = boot();
    expect((await sw.hit('/api/tools/server-cmd')).intercepted).toBe(false);
    expect((await sw.hit('/metrics')).intercepted).toBe(false);
    expect(sw.fetched).toEqual([]);
  });
});
