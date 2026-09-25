/**
 * v2.613 아키텍처 점검 — 그룹 A(특수 기능 카탈로그·도구 셸·집행 매핑) 웹 회귀.
 *   CATALOG2613-01 카탈로그 플래그 ↔ docs/API.md 게이트 열 · CATALOG2613-02 소유 화면 밖 `/tools/*` 호출의 가드 ·
 *   CATALOG2613-05(+WEB2613-13) 렌더 분기 == 카탈로그 · CATALOG2613-06(+WEB2613-04) 도구 루트 서브탭은 useHashTab ·
 *   CATALOG2613-07 잠금 판정 단일 소스 · CATALOG2613-08 인라인 관리자 가드 0 · CATALOG2613-11 주석의 도구 수 삭제.
 * 웹 테스트는 node 환경(DOM 없음)이라 소스를 문자열로 읽어 대조한다(카탈로그는 실제 import).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './specialToolsList.js';
import { lockReasonOf } from './toolVisibility.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readWeb = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

/** 소스 파일 목록(테스트 제외). */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx?|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

// ── CATALOG2613-01 ───────────────────────────────────────────────────────────
/**
 * docs/API.md(생성물)의 게이트 열을 읽는다 → { '/api/admin/os-scan': '역할 `admin`', … } + 그룹별 설명.
 * ⚠ 문서는 `scripts/api-doc.mjs` 가 소스에서 만든다 — 손으로 쓴 목록이 아니라 라우터 선언의 투영이다.
 */
function apiDocGates() {
  const md = read('docs/API.md');
  const gates = new Map(); const groupDesc = new Map();
  let group = '';
  for (const line of md.split('\n')) {
    const h = line.match(/^## `(\/[^`]+)`/);
    if (h) { group = h[1]; continue; }
    const g = line.match(/^\| \[`(\/[^`]+)`\]\([^)]*\) \| \d+ \| (.+) \|$/);
    if (g) { groupDesc.set(g[1], g[2]); continue; }
    const r = line.match(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \| (.+?) \| \[/);
    if (r && group) gates.set(`${r[1]} ${group}${r[2] === '/' ? '' : r[2]}`, r[3]);
  }
  return { gates, groupDesc };
}

describe('CATALOG2613-01: 카탈로그 플래그는 주 API 게이트(docs/API.md)와 같은 방향이다', () => {
  const { gates, groupDesc } = apiDocGates();
  const byKey = new Map(TOOLS.map((t) => [t.k, t]));
  it('API.md 를 읽었다(생성물 형식이 바뀌면 이 테스트가 먼저 안다)', () => {
    expect(gates.size).toBeGreaterThan(500);
    expect(groupDesc.get('/api/insights')).toMatch(/requirePerm\('insights'\)/);
  });
  // 주 API 가 역할 admin 인 도구 → adminOnly:true (verify: 5개. shutdown 은 v2.590 W2 가 화면을 확정해 제외).
  const ADMIN_MAIN_API = {
    'real-os': 'GET /api/admin/os-scan',
    portaldb: 'GET /api/admin/portal-db',
    serveranalysis: 'GET /api/admin/idrac',
    'nic-speed': 'GET /api/admin/idrac/nic-speed',
    'nic-models': 'GET /api/admin/idrac/nic-models',
  };
  for (const [k, ep] of Object.entries(ADMIN_MAIN_API)) {
    it(`${k}: 주 API ${ep} 가 역할 admin 이면 카탈로그도 adminOnly`, () => {
      const gate = gates.get(ep);
      expect(gate, `${ep} 가 API.md 에 없다`).toBeTruthy();
      expect(gate).toMatch(/역할 `admin`/);
      expect(byKey.get(k)?.adminOnly, `${k} 에 adminOnly:true 가 없다 — viewer 에게 '열 수 있는 카드' 로 보인다(열면 403)`).toBe(true);
    });
  }
  // 주 API 가 /api/insights/* (마운트 requirePerm('insights')) 인 도구 → perm:'insights'.
  const INSIGHTS_MAIN_API = { fleet: 'GET /api/insights/fleet', powermap: 'GET /api/insights/power-breakdown', topo3d: 'GET /api/insights/graph' };
  for (const [k, ep] of Object.entries(INSIGHTS_MAIN_API)) {
    it(`${k}: 주 API ${ep} 는 insights 권한 마운트 아래 — 카탈로그 perm:'insights'`, () => {
      expect(gates.has(ep), `${ep} 가 API.md 에 없다`).toBe(true);
      expect(byKey.get(k)?.perm).toBe('insights');
    });
  }
  it('shutdown 은 의도적으로 adminOnly 를 붙이지 않는다(v2.590 W2 — operator 문구를 화면이 확정했다)', () => {
    expect(byKey.get('shutdown')?.adminOnly).toBeFalsy();
    expect(gates.get('GET /api/admin/emergency-stop')).toMatch(/역할 `admin`/);
  });
  it('perm 값은 전부 기존 권한 키 형식이고 insights-hub 와 같은 키를 쓴다', () => {
    const perms = new Set(TOOLS.filter((t) => t.perm).map((t) => t.perm));
    expect([...perms].sort()).toEqual(['dashboard', 'insights', 'inv.nsx', 'svcmon']);
  });
});

// ── CATALOG2613-02 ───────────────────────────────────────────────────────────
/** 서버 집행 매핑(`/tools/<seg>` → 도구 키)을 소스에서 읽는다(서버 모듈은 permissions/config 를 끌고 와 import 하지 않는다). */
function serverToolPathKeys() {
  const src = read('server/src/auth/toolAccess.js');
  const one = src.match(/export const TOOL_PATH_KEYS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  const two = src.match(/export const TOOL_PATH2_KEYS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  expect(one && two).toBeTruthy();
  const parse = (body) => [...body.matchAll(/^\s*'?([a-z0-9/-]+)'?:\s*'([a-z0-9-]+)'/gm)].map((m) => [m[1], m[2]]);
  return { one: new Map(parse(one[1])), two: new Map(parse(two[1])) };
}
const keyForToolsPath = (maps, p) => {
  const segs = p.replace(/^\/+/, '').split('/');
  if (segs.length >= 2 && maps.two.has(`${segs[0]}/${segs[1]}`)) return maps.two.get(`${segs[0]}/${segs[1]}`);
  return maps.one.get(segs[0].replace(/\.(csv|json|xlsx)$/, '')) || null;
};

describe('CATALOG2613-02: 도구 키에 묶인 /tools 엔드포인트를 소유 화면 밖에서 부르면 접근 가드가 있다', () => {
  it('IpmsMatches — ipam 접근이 없으면 조회하지 않고 그 사실을 말하며, 조회 실패는 삼키지 않는다(ErrorBox → 403 은 AccessDenied)', () => {
    const src = readWeb('components/IpmsMatches.jsx');
    expect(src).toMatch(/toolAllowed\('ipam'\)/);
    expect(src).toMatch(/IPMS_DENIED_TEXT/);
    expect(src).toMatch(/<ErrorBox message=\{err\}/);
    expect(src).not.toMatch(/\.catch\(\(\) => \{ if \(on\) setRows\(\[\]\); \}\)/); // 예전: 403 → '자료가 없습니다'
    expect(src.match(/IPMS_DENIED_TEXT = '([^']*)'/)?.[1]).not.toContain('`'); // 문구에 백틱 금지(BoldText 규약)
  });
  it('Nsx SegmentVms — ipam 접근이 없으면 조회하지 않고 그 사실을 말하며, 조회 실패는 삼키지 않는다', () => {
    const src = readWeb('views/Nsx.jsx');
    expect(src).toMatch(/toolAllowed\('ipam'\)/);
    expect(src).toMatch(/IPAM_DENIED_TEXT/);
    expect(src).toMatch(/if \(err\) return <div[^>]*><ErrorBox message=\{err\} \/><\/div>;/);
    expect(src).not.toMatch(/\.catch\(\(\) => \{ if \(!dead\) setRows\(\[\]\); \}\)/);
  });
  it('스윕 — 소유 화면 밖에서 매핑된 /tools/<seg> 를 부르는 파일은 toolAllowed( 를 가지거나 허용 목록(사유)에 있다', () => {
    const maps = serverToolPathKeys();
    const st = readWeb('views/SpecialTools.jsx');
    // 소유 화면 = SpecialTools 가 lazy 로 여는 파일 전부(views/*.jsx · views/tools/**).
    const owners = new Set([...st.matchAll(/import\('\.\/([^']+)'\)/g)].map((m) => path.join(WEB, 'views', m[1])));
    // 정당한 예외 — 사유는 실제 코드를 열어 확인한 것(verify-catalog CATALOG2613-02).
    const ALLOW = {
      'views/VCenterDetail.jsx': 'vm-clone 배지는 그 도구의 데이터 — 실패 시 숨김이 주석에 명시된 설계(usePolling 은 403 이면 폴링을 끊는다)',
      'views/VCenters.jsx': 'vm-track TrendKpi — 실패(403)면 카드를 숨기는 의도된 강등(주석 명시)',
      'components/taskLabel.js': '요청 라벨 표 — 호출이 아니라 문자열 키',
      'views/fleetPartialText.js': '문구 모듈 — 경로를 문장에 적을 뿐 호출하지 않는다',
      'views/trendMeta.js': '문구 모듈 — 경로를 문장에 적을 뿐 호출하지 않는다',
      'views/collectors/EmptyInvModal.jsx': '수집 서버 진단(admin 설정 화면) — 엣지 로그 pull 은 서버가 adminOnly',
      'views/MetricsSettings.jsx': '설정 화면(admin) — 도구 거부 목록의 대상이 아니다',
      'views/PowerOffCheckSettings.jsx': '설정 화면(admin)',
      'views/StorageIntervals.jsx': '설정 화면(admin)',
      'views/VmSeriesSettings.jsx': '설정 화면(admin)',
      'views/SanSwitchPerf.jsx': '설정 화면(admin) — SAN 포트 사용량 수집 설정',
    };
    const offenders = [];
    for (const f of walk(path.join(WEB))) {
      if (owners.has(f) || f.startsWith(path.join(WEB, 'views', 'tools') + path.sep)) continue;
      const rel = path.relative(WEB, f);
      if (rel === 'views/SpecialTools.jsx' || rel === 'api.js') continue;
      const src = fs.readFileSync(f, 'utf8');
      const calls = [...src.matchAll(/['`]\/tools\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)/g)].map((m) => m[1]);
      const keys = new Set(calls.map((p) => keyForToolsPath(maps, p)).filter(Boolean));
      if (!keys.size) continue;
      if (ALLOW[rel]) continue;
      if (/toolAllowed\(/.test(src)) continue;
      offenders.push(`${rel} → ${[...keys].join(',')}`);
    }
    expect(offenders).toEqual([]);
    // 허용 목록의 항목은 실재해야 한다(사유가 낡은 채 남지 않게).
    for (const rel of Object.keys(ALLOW)) expect(fs.existsSync(path.join(WEB, rel)), `${rel} 가 없다 — 허용 목록에서 빼라`).toBe(true);
  });
});

// ── CATALOG2613-05 / WEB2613-13 ──────────────────────────────────────────────
describe('CATALOG2613-05/WEB2613-13: ToolPanel 렌더 분기 집합 == 카탈로그 키(external·topTab·comingSoon 제외)', () => {
  it('분기가 없는 키는 빈 패널이 되고, 키가 없는 분기는 죽은 코드다 — 둘 다 0', () => {
    const st = readWeb('views/SpecialTools.jsx');
    const panel = st.slice(st.indexOf('function ToolPanel('));
    const branches = [...panel.matchAll(/\{tool === '([a-z0-9-]+)' && </g)].map((m) => m[1]);
    const want = TOOLS.filter((t) => !t.external && !t.topTab && !t.comingSoon).map((t) => t.k);
    expect(new Set(branches).size).toBe(branches.length); // 같은 키에 분기 두 개면 두 번 그려진다
    expect(branches.slice().sort()).toEqual(want.slice().sort());
  });
});

// ── CATALOG2613-06 / WEB2613-04 ──────────────────────────────────────────────
describe('CATALOG2613-06/WEB2613-04: 도구 루트의 서브탭은 useHashTab 으로 URL 에 싣는다', () => {
  const CASES = {
    'views/tools/PortalCheck.jsx': ['portal-check', 'tokens'],
    'views/tools/LinkCheck.jsx': ['link-check', 'settings'],
    'views/tools/PartFaults.jsx': ['part-faults', 'open'],
  };
  for (const [rel, [k, fb]] of Object.entries(CASES)) {
    it(`${rel}: base ['tools','${k}'] · fallback '${fb}'`, () => {
      const src = readWeb(rel);
      expect(src).toMatch(/import \{ useHashTab \} from '\.\.\/\.\.\/hooks\/useHashTab\.js'/);
      const re = new RegExp(`useHashTab\\(\\{ base: \\['tools', '${k}'\\], valid: (?:\\[[^\\]]*\\]|[^,]+), fallback: '${fb}' \\}\\)`);
      expect(src).toMatch(re);
      expect(src).not.toMatch(new RegExp(`useState\\('${fb}'\\)`)); // 로컬 상태로 되돌아가면 새로고침에 첫 탭으로
    });
  }
  it('스윕 — views/tools 에서 최상위 VIEWS 상수를 가진 도구 파일은 useHashTab 을 쓴다', () => {
    const dir = path.join(WEB, 'views', 'tools');
    const bad = [];
    for (const f of walk(dir)) {
      const src = fs.readFileSync(f, 'utf8');
      if (!/^const VIEWS = \[/m.test(src)) continue;
      if (!/useHashTab\(\{ base: \['tools', '/.test(src)) bad.push(path.relative(WEB, f));
    }
    expect(bad).toEqual([]);
  });
});

// ── CATALOG2613-07 ───────────────────────────────────────────────────────────
describe('CATALOG2613-07: 잠금 사유 판정은 toolVisibility.lockReasonOf 하나 — perm 축 포함', () => {
  const can = (p) => p !== 'insights';           // insights 권한을 회수한 계정
  const toolAllowed = (k) => k !== 'ipam';       // ipam 은 거부 목록
  it('adminOnly → perm → 도구별 접근 순서로 판정하고, 문구가 셋 다 다르다', () => {
    const r1 = lockReasonOf({ k: 'storage-mon', adminOnly: true }, { isAdmin: false, can, toolAllowed });
    const r2 = lockReasonOf({ k: 'fleet', perm: 'insights' }, { isAdmin: false, can, toolAllowed });
    const r3 = lockReasonOf({ k: 'ipam' }, { isAdmin: false, can, toolAllowed });
    expect(r1).toMatch(/관리자\(admin\) 전용/);
    expect(r2).toMatch(/권한\)\.$/);
    expect(r3).toMatch(/도구별 접근\)\.$/);
    expect(new Set([r1, r2, r3]).size).toBe(3);
    expect(lockReasonOf({ k: 'gpu' }, { isAdmin: false, can, toolAllowed })).toBeNull();
    expect(lockReasonOf(null, {})).toMatch(/알 수 없는/);
  });
  it('admin 은 잠기지 않고, 허용 목록에 명시된 도구는 adminOnly 표시 관례를 넘긴다(v2.555)', () => {
    expect(lockReasonOf({ k: 'storage-mon', adminOnly: true }, { isAdmin: true, can: () => false, toolAllowed: () => true })).toBeNull();
    expect(lockReasonOf({ k: 'storage-mon', adminOnly: true }, { isAdmin: false, toolsAllowed: ['storage-mon'], can, toolAllowed: () => true })).toBeNull();
    expect(lockReasonOf({ k: 'storage-mon', adminOnly: true }, { isAdmin: false, toolsAllowed: ['gpu'], can, toolAllowed: () => true })).toMatch(/관리자/);
  });
  it('문구에 백틱이 없다', () => {
    for (const t of [{ k: 'a', adminOnly: true }, { k: 'b', perm: 'x' }, { k: 'c' }, null]) {
      expect(lockReasonOf(t, { can: () => false, toolAllowed: () => false }) || '').not.toContain('`');
    }
  });
  it('네 화면(카드 그리드·V4 내비·V4 기능 찾기·⌘K 팔레트)이 같은 함수를 쓰고 자기 판정을 두지 않는다', () => {
    const FILES = ['views/SpecialTools.jsx', 'version_4/V4App.jsx', 'version_4/pages/Tools.jsx', 'version_4/Palette.jsx'];
    for (const rel of FILES) {
      const src = readWeb(rel);
      expect(src, rel).toMatch(/import \{[^}]*\blockReasonOf\b[^}]*\} from '[./]+\/(?:views\/)?toolVisibility\.js'/);
      expect(src, rel).not.toMatch(/const lockReasonOf = \(t\) => \{/);        // 예전 로컬 구현
      expect(src, rel).not.toMatch(/!\(canTools && toolAllowed\(it\.k\)\)/); // 예전 Tools.jsx 판정(perm 축 없음)
      expect(src, rel).not.toMatch(/관리자\(admin\) 전용 기능입니다/);          // 문구는 한 모듈에만
    }
  });
});

// ── CATALOG2613-08 ───────────────────────────────────────────────────────────
describe('CATALOG2613-08: ToolPanel 에 인라인 관리자 가드(isAdmin ? … : 관리자 전용)가 없다', () => {
  it('렌더 분기의 `(isAdmin ? <` 0 · 인라인 문구 0 — 관리자 판정은 서버 403 + AccessDenied 하나', () => {
    const st = readWeb('views/SpecialTools.jsx');
    expect((st.match(/&& \(isAdmin \? </g) || []).length).toBe(0);
    expect(st).not.toContain('<span className="muted">관리자 전용 기능입니다.</span>');
    // 예전 7개 분기가 이제 다른 21개와 같은 모양이다.
    for (const k of ['capacity-advisor', 'dir-usage', 'mail-diag', 'vmprovision', 'agent-scans', 'login-fails', 'net-issues']) {
      expect(st).toMatch(new RegExp(`\\{tool === '${k}' && <[A-Za-z]+ \\/>\\}`));
    }
  });
});

// ── CATALOG2613-11 ───────────────────────────────────────────────────────────
describe('CATALOG2613-11: 주석에 도구 수를 적지 않는다(매 릴리스 낡는다 — TOOLS.length 가 사실)', () => {
  const FILES = ['version_4/tree.js', 'views/toolSections.js', 'views/SpecialTools.jsx', 'version_4/pages/Tools.jsx', 'version_4/V4App.jsx', '../../server/src/toolcats/catalog.js'];
  for (const rel of FILES) {
    it(rel, () => {
      const src = readWeb(rel);
      expect(src.match(/(?:도구|기능|카드)\s*\(?\s*\d{2,}\s*(?:개|장)/g) || []).toEqual([]);
    });
  }
});
