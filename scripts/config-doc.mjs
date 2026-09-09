#!/usr/bin/env node
/**
 * scripts/config-doc.mjs — CONFIG_DIR 에 만들어지는 설정·데이터 파일 목록을 코드에서 추출해
 * `docs/CONFIG-FILES.md` 를 만든다(v2.448).
 *
 * 왜: 운영자가 백업·이관·장애 대응을 하려면 "어떤 파일이 무엇을 담고, 지우면 무슨 일이 나는지"를
 * 알아야 하는데 그 목록이 어디에도 없었다. 파일은 코드가 만들므로 코드가 진실의 원천이다.
 *
 * 추출 항목: 파일명 · 정의 모듈 · 용도(모듈 상단 주석 첫 줄) · 비밀 포함 여부(0600/secret 힌트) ·
 * 원자적 쓰기 여부(atomicWriteFileSync) · 손상 보존(preserveCorrupt).
 * 파일 내용은 읽지 않는다(비밀 노출 없음).
 *
 * 사용: node scripts/config-doc.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'server', 'src');
const OUT = path.join(ROOT, 'docs', 'CONFIG-FILES.md');

/** 파일별 사람이 쓴 설명·주의사항. 코드에서 뽑을 수 없는 '지우면 어떻게 되는가'를 담는다. */
const NOTES = {
  'portal.env': ['환경변수(설치본이 읽는 유일한 설정 파일)', '⚠ 지우면 인증 비밀·중앙 토큰이 사라져 로그인·수집이 전부 끊긴다. 백업 필수. 자세한 키는 docs/ENV.md'],
  'auth-secret': ['세션 토큰 서명 키(자동 생성)', '⚠ 바뀌면 전 사용자 세션 무효(재로그인). 유출 시 임의 계정 토큰 위조 가능 — 0600 유지'],
  'users.json': ['포탈 계정(역할·비밀번호 해시·TOTP 시크릿)', '⚠ 지우면 관리자 계정이 사라진다. 기동 시 초기 관리자만 재생성'],
  'secrets-key': ['자격증명 봉인 키(암호화 모드)', '⚠ 지우면 저장된 모든 비밀번호를 복호할 수 없다(재입력 필요)'],
  'credentials.json': ['통합 계정(장비 SSH/API 자격증명)', '봉인 저장. API 응답에 값이 실리지 않는다'],
  'settings-owners.txt': ['설정 소유자 목록(백업·비밀 CSV 등 최상위 권한)', 'username 기준. 표시이름 승계 불가'],
  'vcenters.json': ['vCenter 등록(주소·계정·수집 옵션)', '⚠ 지우면 수집 대상이 사라진다. v2.444 부터 예제 폴백 없음'],
  'collectors.json': ['원격 수집 서버(엣지) 목록과 토큰', '중앙이 이 목록을 pull 한다'],
  'agent-deploy-targets.json': ['Edge 노드 설치 대상(SSH 접속 정보)', '비밀 4종(centralToken·collectorToken 등) 포함 — 소유자만 CSV 내보내기'],
  'central-inventory.json': ['위임 사이트가 push 한 인벤토리 캐시', '재시작 시 콜드스타트용. 지워도 다음 push 로 복구'],
  'central-agent-tokens.json': ['엣지 에이전트별 개별 토큰', '⚠ 지우면 엣지 push 가 전부 401'],
  'audit.ndjson': ['감사 로그(상태 변경 기록)', '보안 자산 — 보존 정책에 따라 관리. AUDIT_MAX 로 상한'],
  'alarm-mutes.json': ['알람 음소거 규칙', 'v2.448 부터 원자적 쓰기 + 손상 보존'],
  'permissions.json': ['역할별 권한 매트릭스 + 도구별 접근 거부', 'v2.448 부터 서버가 도구 거부를 집행'],
  'relay-topology.json': ['중계(HAProxy) 토폴로지 정의', '노드 SSH 자격증명 포함 — host 변경 시 비밀 미이월'],
  'db-location.json': ['시계열 DB 저장 경로(dbDir)', '이 값이 가리키는 곳에 *.db 가 만들어진다'],
  'vmperf': ['디렉터리 — vCenter별 VM 성능 DB(+ _index.json 역산 매핑)', 'v2.448 부터 파일명에 해시 접미사(id 충돌 방지)'],
  'initial-admin-password.txt': ['최초 기동 시 생성된 관리자 임시 비밀번호', '⚠ 로그인 후 즉시 변경하고 이 파일을 삭제할 것'],
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 모듈 상단 블록 주석의 첫 문장(용도). */
function moduleSummary(text) {
  const m = /^\/\*\*\s*\n\s*\*\s*([^\n]+)/.exec(text);
  if (!m) return '';
  return m[1].replace(/^[\w./-]+\.js\s*[—-]\s*/, '').trim().slice(0, 110);
}

const files = new Map(); // fileName -> { modules:Set, atomic:bool, preserve:bool, mode600:bool, summary }
for (const f of walk(SRC)) {
  const text = fs.readFileSync(f, 'utf8');
  const rel = path.relative(SRC, f).replace(/\\/g, '/');
  const summary = moduleSummary(text);
  for (const m of text.matchAll(/path\.join\([^)]*?(?:configDir|dbDir|DIR|ROOT)[^)]*?,\s*'([^']+)'\s*\)/g)) {
    const name = m[1];
    if (!name || name.includes('/') || name.startsWith('.')) continue;
    const cur = files.get(name) || { modules: new Set(), atomic: false, preserve: false, mode600: false, summary: '' };
    cur.modules.add(rel);
    if (/atomicWriteFileSync/.test(text)) cur.atomic = true;
    if (/preserveCorrupt/.test(text)) cur.preserve = true;
    if (/0o600/.test(text)) cur.mode600 = true;
    if (!cur.summary && summary) cur.summary = summary;
    files.set(name, cur);
  }
}
for (const name of Object.keys(NOTES)) if (!files.has(name)) files.set(name, { modules: new Set(['(외부/설치 스크립트)']), atomic: false, preserve: false, mode600: false, summary: '' });

const kind = (n) => (n.endsWith('.db') ? 'DB' : n.endsWith('.ndjson') ? '로그(NDJSON)' : n.endsWith('.json') ? '설정' : n.endsWith('.txt') ? '텍스트' : n.includes('.') ? '기타' : '디렉터리');
const rows = [...files].sort((a, b) => a[0].localeCompare(b[0]));
const now = new Date().toISOString().slice(0, 10);

let md = `# 설정·데이터 파일 레퍼런스 (자동 생성)

포탈이 \`CONFIG_DIR\`(설치본 기본 \`/etc/vmware-portal\`) 아래에 만드는 파일 **${rows.length}개**의 목록이다.
시계열 DB 는 \`db-location.json\` 이 가리키는 \`dbDir\` 로 옮길 수 있다.

- 생성: \`node scripts/config-doc.mjs\` (마지막 갱신 ${now})
- **이 파일을 직접 고치지 말 것** — 코드가 진실의 원천이다. 설명 보완은 \`scripts/config-doc.mjs\` 의 \`NOTES\` 에 추가한다.
- 열 의미: **원자적** = 쓰기 도중 크래시에도 파일이 깨지지 않음(\`atomicWriteFileSync\`) · **손상보존** = 읽기 실패 시 원본을 \`.corrupt.<ts>\` 로 보존 · **0600** = 소유자만 읽기

> ⚠️ **백업**: 설정 › 포탈 백업이 이 디렉터리를 통째로 담는다. 수동 백업 시에도 \`portal.env\`·\`auth-secret\`·\`secrets-key\`·\`users.json\` 은 반드시 포함할 것 — 이 넷이 없으면 복원해도 로그인·복호가 안 된다.

| 파일 | 종류 | 용도 | 원자적 | 손상보존 | 0600 | 정의 모듈 |
|---|---|---|:--:|:--:|:--:|---|
`;
for (const [name, v] of rows) {
  const note = NOTES[name];
  const desc = note ? note[0] : (v.summary || '');
  const mods = [...v.modules].slice(0, 2).join(', ') + (v.modules.size > 2 ? ` 외 ${v.modules.size - 2}` : '');
  md += `| \`${name}\` | ${kind(name)} | ${desc} | ${v.atomic ? '✅' : ''} | ${v.preserve ? '✅' : ''} | ${v.mode600 ? '✅' : ''} | ${mods} |\n`;
}
md += `\n## 주의가 필요한 파일\n\n`;
for (const [name, note] of Object.entries(NOTES)) {
  if (note[1]) md += `- **\`${name}\`** — ${note[1]}\n`;
}
md += `\n---\n\n관련 문서: [환경변수 레퍼런스](ENV.md) · [설정 화면 안내](SETTINGS.md) · [설치](INSTALL.md)\n`;

if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const norm = (t) => t.replace(/마지막 갱신 \d{4}-\d{2}-\d{2}/, '');
  if (norm(cur) !== norm(md)) { console.error('docs/CONFIG-FILES.md 가 코드와 다릅니다 — `node scripts/config-doc.mjs` 로 갱신하세요.'); process.exit(1); }
  console.log(`docs/CONFIG-FILES.md 최신 (${rows.length}개 파일)`); process.exit(0);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
console.log(`docs/CONFIG-FILES.md 생성 — 파일 ${rows.length}개`);
