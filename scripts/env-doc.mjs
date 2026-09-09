#!/usr/bin/env node
/**
 * scripts/env-doc.mjs — 코드가 실제로 읽는 환경변수를 훑어 `docs/ENV.md` 를 만든다(v2.447, 감사 I1).
 *
 * 왜 자동 생성인가: portal.env.example 에는 79개만 적혀 있는데 코드는 282개를 읽는다(78% 미문서).
 * 운영자가 조정할 수 있는 값(수집 동시성·타임아웃·보존기간·상한)을 알 수 없어 기본값으로만 쓰거나
 * 소스를 뒤져야 했다. 손으로 관리하면 다음 기능 추가 때 다시 어긋나므로 **코드가 진실의 원천**이다.
 *
 * 수집 방법: `process.env.KEY` 참조를 전부 찾아 모듈 경로로 분류하고, 같은 줄에서 기본값
 * (`|| 8`, `?? 'x'`, `=== 'true'`)을 추출한다. 값 자체는 읽지 않는다(비밀 노출 없음).
 *
 * 사용: node scripts/env-doc.mjs        (docs/ENV.md 갱신)
 *       node scripts/env-doc.mjs --check (갱신이 필요하면 1 로 종료 — CI 에서 씀)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'server', 'src');
const OUT = path.join(ROOT, 'docs', 'ENV.md');
const EXAMPLE = path.join(ROOT, 'packaging', 'offline', 'portal.env.example');

/**
 * 스캐너가 못 잡는 키를 손으로 보완한다 — `process.env.X` 가 아니라 함수 인자로 env 를 받는 모듈
 * (예: `diskTrendPolicyFromEnv(env = process.env)` 안의 `env.KEY`)은 정규식에 걸리지 않는다.
 * 그런 모듈을 새로 만들면 여기에 추가할 것.
 */
const EXTRA = {
  DISKTREND_WARN_PCT: { area: '분석 도구', file: 'tools/diskTrend.js', def: '75' },
  DISKTREND_CRIT_PCT: { area: '분석 도구', file: 'tools/diskTrend.js', def: '85' },
  DISKTREND_SNAPSHOT_MAX_HOURS: { area: '분석 도구', file: 'tools/diskTrend.js', def: '72' },
};

/** 런타임이 주는 값 — 포탈 설정이 아니므로 문서에서 제외. */
const SKIP = new Set(['NODE_ENV', 'PATH', 'HOME', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'npm_package_version', 'PWD', 'USER']);

/** 모듈 경로 → 사람이 읽는 분류. 첫 세그먼트 기준(없으면 '공통'). */
const AREA = {
  agent: '엣지 에이전트', auth: '인증·권한', backup: '백업', bmstor: '베어메탈 스토리지',
  capacity: '리소스 적정성', central: '중앙(위임 수집)', collector: '수집 서버', datacenter: '법인/DC',
  gpu: 'GPU', guest: '게스트 작업', health: '헬스체크', horizon: 'Horizon', idrac: 'iDRAC/전력',
  insights: '인사이트', intro: '소개/지원', inventory: '인벤토리', ipam: 'IP 관리', llm: 'LLM',
  logs: '로그', metrics: '메트릭 수집', net: '네트워크 점검', nsx: 'NSX', pdu: 'PDU', ping: 'Ping 모니터',
  provision: 'VM 프로비저닝', proxy: '원격 접속(프록시)', relaycheck: '중계 경로 점검',
  relaytopo: '중계 토폴로지', reports: '리포트', rma: '원격 명령(RMA)', routes: 'API 라우트',
  sanswitch: 'SAN 스위치', search: '검색', security: '보안', storage: '스토리지 수집',
  svcmon: '서비스 모니터', system: '시스템', tools: '분석 도구', upgrade: '업그레이드',
  util: '공용 유틸', vcenter: 'vCenter 수집', vmclone: 'VM 복제', vmtrack: '추이 트래킹',
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 같은 줄에서 기본값 추출 — `|| 8` · `?? 'x'` · `=== 'true'` · `!== 'false'`. */
function defaultOf(line, key) {
  const after = line.slice(line.indexOf(`process.env.${key}`) + `process.env.${key}`.length);
  // `Number(process.env.X) || 300` · `Math.max(1, Number(process.env.X) || 8)` 처럼 괄호로 감싼
  // 형태가 흔하므로 닫는 괄호를 건너뛰고 기본값을 찾는다.
  let m = after.match(/^[\s)]*(?:\|\||\?\?)\s*(-?\d+(?:_\d+)*|'[^']{0,40}'|"[^"]{0,40}"|true|false)/);
  if (m) return m[1].replace(/_/g, '');
  m = after.match(/^\s*(===|!==)\s*('[^']*'|"[^"]*")/);
  if (m) return m[1] === '===' ? `기본 아님(${m[2]} 일 때만 적용)` : `기본 적용(${m[2]} 로 끄기)`;
  return '';
}

const rows = new Map();  // KEY -> { area, files:Set, def }
for (const file of walk(SRC)) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const area = AREA[rel.split('/')[0]] || '공통';
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/process\.env\.([A-Z][A-Z_0-9]*)/g)) {
      const key = m[1];
      if (SKIP.has(key)) continue;
      const cur = rows.get(key) || { area, files: new Set(), def: '' };
      cur.files.add(rel);
      if (!cur.def) cur.def = defaultOf(line, key);
      // 여러 모듈에서 쓰면 첫 분류를 유지하되 '공통' 보다 구체적인 쪽을 선호
      if (cur.area === '공통' && area !== '공통') cur.area = area;
      rows.set(key, cur);
    }
  }
}

for (const [key, v] of Object.entries(EXTRA)) {
  if (rows.has(key)) continue;
  rows.set(key, { area: v.area, files: new Set([v.file]), def: v.def });
}

let documented = new Set();
try {
  const ex = fs.readFileSync(EXAMPLE, 'utf8');
  documented = new Set([...ex.matchAll(/^#?\s*([A-Z][A-Z_0-9]{2,})=/gm)].map((m) => m[1]));
} catch { /* 예시 파일이 없으면 전부 미문서로 표기 */ }

const byArea = new Map();
for (const [key, v] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (!byArea.has(v.area)) byArea.set(v.area, []);
  byArea.get(v.area).push([key, v]);
}

const now = new Date().toISOString().slice(0, 10);
let md = `# 환경변수 레퍼런스 (자동 생성)

\`server/src\` 가 실제로 읽는 환경변수 **${rows.size}개**를 코드에서 추출한 목록이다.
설치본에서는 \`/etc/vmware-portal/portal.env\` 에 \`KEY=값\` 으로 넣고 서비스를 재시작한다.

- 생성: \`node scripts/env-doc.mjs\` (마지막 갱신 ${now})
- **이 파일을 직접 고치지 말 것** — 코드가 진실의 원천이며 다음 실행에서 덮어써진다.
- \`portal.env.example\` 에 예시가 있는 키는 ✅, 없는 키는 빈칸으로 표시한다.
- 기본값 칸이 비어 있으면 코드에서 한 줄로 추출하지 못한 것이다(해당 파일을 참조).

> ⚠️ 스토리지·SAN 수집 주기 등 **중앙에서 배포하는 값**은 portal.env 로 잡아도 중앙 설정이 우선한다
> (루트 CLAUDE.md '스토리지 폴러 주기는 중앙 배포값' 참조).

`;
for (const [area, list] of [...byArea].sort((a, b) => a[0].localeCompare(b[0], 'ko'))) {
  md += `\n## ${area} (${list.length})\n\n| 키 | 기본값 | 예시 | 정의 위치 |\n|---|---|---|---|\n`;
  for (const [key, v] of list) {
    const files = [...v.files].slice(0, 2).join(', ') + (v.files.size > 2 ? ` 외 ${v.files.size - 2}` : '');
    md += `| \`${key}\` | ${v.def ? `\`${v.def}\`` : ''} | ${documented.has(key) ? '✅' : ''} | ${files} |\n`;
  }
}
md += `\n---\n\n예시 파일(\`packaging/offline/portal.env.example\`)에 있는 키: ${[...documented].filter((k) => rows.has(k)).length} / ${rows.size}\n`;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const norm = (t) => t.replace(/마지막 갱신 \d{4}-\d{2}-\d{2}/, '');
  if (norm(cur) !== norm(md)) {
    console.error('docs/ENV.md 가 코드와 다릅니다 — `node scripts/env-doc.mjs` 로 갱신하세요.');
    process.exit(1);
  }
  console.log(`docs/ENV.md 최신 (${rows.size}개 키)`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
console.log(`docs/ENV.md 생성 — 키 ${rows.size}개 / 분류 ${byArea.size}개 / 예시 있음 ${[...documented].filter((k) => rows.has(k)).length}개`);
