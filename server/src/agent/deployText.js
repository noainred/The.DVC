/**
 * agent/deployText.js — Edge 노드 대량 배포용 **텍스트** 목록 파싱/생성(v2.432, 사용자 요구
 * '엣지노드 배포를 대용량으로 할 수 있게 import export text 방식과 입력 전에 배포하는 기능').
 *
 * 왜 CSV(v2.339) 와 따로 두는가:
 *  - CSV 가져오기는 **파일 업로드 + 헤더 필수 + 저장(등록) 전용** 이다. 현장에서 서버 목록은 보통
 *    엑셀/위키 표에서 **복사-붙여넣기** 로 오고, 헤더가 없으며, 그 자리에서 바로 설치하고 싶어 한다.
 *  - 여기서는 헤더가 없어도 위치(host / 이름 / 계정 / 비밀번호)로 읽고, `#` 주석·빈 줄을 건너뛰며,
 *    **공통 기본값**(계정·키·중앙 URL·토큰 등 폼에 한 번 입력)을 행마다 병합한다. 행 값이 우선.
 *
 * 정직한 한계:
 *  - **개인키는 행별로 넣을 수 없다**(여러 줄이라 한 줄 표에 담기지 않는다). 공통 기본값의 privateKey 를
 *    쓰거나(같은 키로 전 노드 접속 — 실제 운용 형태), 예외 노드는 CSV/개별 대상으로 등록할 것.
 *  - 공백 구분 형식에서는 **비밀번호에 공백을 쓸 수 없다**(구분자와 구별 불가). 탭/쉼표 구분이나
 *    공통 비밀번호를 쓸 것. 탭·쉼표가 하나라도 있으면 그 구분자로만 나눈다.
 *  - `host:port` 축약은 IPv4/호스트명만(IPv6 은 콜론이 주소의 일부라 구분 불가 — port 열을 쓸 것).
 */
import { parseCsvRows, csvLine, unguardCell, CSV_BOM } from '../util/csv.js';
import { targetRowIssue } from './deployCsv.js';

/** 텍스트 내보내기 열(탭 구분). CSV 열과 같되 advertiseUrl(v2.429 중계 엣지 경유 광고 URL)을 더한다. */
export const TEXT_COLUMNS = ['host', 'port', 'username', 'agentName', 'collectorDatacenter', 'centralUrl',
  'advertiseUrl', 'portalPort', 'installerPath', 'autoUpgrade', 'pushInventory', 'enabled',
  'password', 'centralToken', 'collectorToken'];

const SECRET_COLS = ['password', 'centralToken', 'collectorToken'];
/** 헤더 인식용 별칭 — 소문자·비영숫자 제거 후 비교. */
const ALIASES = {
  host: ['host', 'ip', 'ipaddress', 'address', '호스트', '주소'],
  port: ['port', 'sshport', '포트', 'ssh포트'],
  username: ['username', 'user', 'id', 'account', '계정', '아이디'],
  password: ['password', 'pw', 'pass', '비밀번호', '패스워드'],
  passphrase: ['passphrase', '패스프레이즈'],
  agentName: ['agentname', 'agent', 'name', '에이전트', '이름'],
  collectorDatacenter: ['collectordatacenter', 'datacenter', 'dc', '법인', '데이터센터'],
  centralUrl: ['centralurl', 'central', '중앙', '중앙url'],
  advertiseUrl: ['advertiseurl', 'advertise', '광고url'],
  portalPort: ['portalport', '포탈포트'],
  installerPath: ['installerpath', 'installer', '설치경로'],
  autoUpgrade: ['autoupgrade', '자동업그레이드'],
  pushInventory: ['pushinventory', '인벤토리push', '인벤토리'],
  enabled: ['enabled', 'active', '활성', '사용'],
  centralToken: ['centraltoken', '중앙토큰'],
  collectorToken: ['collectortoken', '수집토큰'],
};
/**
 * 헤더 없는 표의 **열 순서 프리셋**(v2.432.1, 사용자 요구 '서버별로 ip/pwd 넣는 기능 · 1줄에 ip/id/pw 넣는 기능').
 * 3열짜리 표는 `host 이름 계정` 과 `host 계정 비밀번호` 를 자동으로 구분할 수 없다(둘 다 흔한 형식이고
 * 값만 보고 맞히면 **비밀번호가 계정 자리로 들어가는** 사고가 난다). 그래서 추측하지 않고 화면에서 고르게 한다.
 * 헤더 행이 있으면 프리셋보다 헤더가 우선한다.
 */
export const COLUMN_PRESETS = {
  'host-name-user-pass': { label: 'host · 이름/법인 · 계정 · 비밀번호', columns: ['host', 'agentName', 'username', 'password'] },
  'host-user-pass': { label: 'host · 계정 · 비밀번호   (ip id pw)', columns: ['host', 'username', 'password'] },
  'host-pass': { label: 'host · 비밀번호   (ip pw)', columns: ['host', 'password'] },
  'host-name-pass': { label: 'host · 이름/법인 · 비밀번호', columns: ['host', 'agentName', 'password'] },
  'host-user-pass-name': { label: 'host · 계정 · 비밀번호 · 이름/법인', columns: ['host', 'username', 'password', 'agentName'] },
  'host-only': { label: 'host 만 (나머지는 공통값)', columns: ['host'] },
};
export const DEFAULT_PRESET = 'host-name-user-pass';
/** 기본 위치 열(하위 호환) — COLUMN_PRESETS[DEFAULT_PRESET].columns 와 같다. */
export const POSITIONAL = COLUMN_PRESETS[DEFAULT_PRESET].columns;
/** 프리셋 키 또는 열 배열 → 열 배열(순수). 알 수 없으면 기본 프리셋. */
export function resolveColumns(spec) {
  if (Array.isArray(spec) && spec.length) return spec.filter((k) => ALIASES[k] !== undefined || k === 'host');
  return COLUMN_PRESETS[spec]?.columns || POSITIONAL;
}
const BOOL_KEYS = ['autoUpgrade', 'pushInventory', 'enabled'];

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const bool = (v, dflt) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오', '미사용'].includes(s);
};

/**
 * 텍스트 → [{line, cells}] (원본 줄 번호 보존). 주석·빈 줄은 **먼저** 걷어낸 뒤 구분자를 정한다 —
 * 첫 줄이 주석이면 CSV 스니퍼가 탭을 못 보고 쉼표로 오판해 전 행이 한 셀이 되기 때문(실제 회귀).
 * 탭이 하나라도 있으면 탭 우선(엑셀 복붙), 없고 쉼표가 있으면 CSV 규칙(따옴표 지원), 둘 다 없으면 공백 구간.
 */
function splitRows(text) {
  const keep = String(text ?? '').split(/\r?\n/)
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => t.trim() && !t.trim().startsWith('#') && !t.trim().startsWith('//'));
  if (!keep.length) return [];
  const body = keep.map((k) => k.text).join('\n');
  if (body.includes('\t')) return keep.map((k) => ({ line: k.line, cells: k.text.split('\t').map((c) => c.trim()) }));
  if (body.includes(',')) {
    let rows = [];
    try { rows = parseCsvRows(body, { maxRows: 5000, maxCell: 8192 }); } catch { rows = []; }
    return rows.map((cells, i) => ({ line: keep[i]?.line ?? i + 1, cells: cells.map((c) => unguardCell(c).trim()) }));
  }
  return keep.map((k) => ({ line: k.line, cells: k.text.trim().split(/\s+/) }));
}

/** 헤더 행인가 — 알려진 열 이름이 2개 이상이면 헤더로 본다(host 하나만 있는 데이터 행 오인 방지). */
function headerMap(cells) {
  const map = {}; let hits = 0;
  cells.forEach((c, i) => {
    const n = norm(c);
    for (const [key, names] of Object.entries(ALIASES)) {
      if (names.includes(n) && map[key] === undefined) { map[key] = i; hits++; return; }
    }
  });
  return hits >= 2 && map.host !== undefined ? map : null;
}

/**
 * `root@10.0.0.1:2222` → { user:'root', host:'10.0.0.1', port:'2222' }(순수).
 * `user@` 접두와 `:port` 접미는 둘 다 선택. 콜론이 2개 이상이면(IPv6) 포트로 나누지 않는다.
 */
export function splitHostPort(v) {
  let s = String(v ?? '').trim();
  let user = '';
  const at = s.lastIndexOf('@');
  if (at > 0) { user = s.slice(0, at).trim(); s = s.slice(at + 1).trim(); }
  const m = /^([A-Za-z0-9.\-_]+):(\d{1,5})$/.exec(s);
  return m ? { user, host: m[1], port: m[2] } : { user, host: s, port: '' };
}

/**
 * 붙여넣은 텍스트 → 배포 대상 행 목록(순수). defaults 는 공통 기본값(행 값이 우선).
 * @returns {{ rows: Array, skipped: Array<{line:number,text:string,reason:string}>, header: object|null, count:number }}
 */
export function parseTargetsText(text, defaults = {}, { columns } = {}) {
  const lines = splitRows(text);
  const d = defaults || {};
  const pos = resolveColumns(columns ?? d.columns);
  const rows = []; const skipped = [];
  let map = null; let sawHeader = false;
  for (const { line, cells } of lines) {
    const joined = cells.join(' ').trim();
    if (!joined) continue;
    if (!sawHeader) {
      const h = headerMap(cells);
      if (h) { map = h; sawHeader = true; continue; }
      sawHeader = true;                                  // 첫 데이터 행 이후로는 헤더를 찾지 않는다
    }
    const get = (key) => {
      if (map) { const i = map[key]; return i === undefined ? '' : (cells[i] ?? '').trim(); }
      const p = pos.indexOf(key);
      return p >= 0 ? (cells[p] ?? '').trim() : '';
    };
    const hp = splitHostPort(get('host'));
    if (!hp.host) { skipped.push({ line, text: joined.slice(0, 200), reason: 'host 열이 비어 있습니다.' }); continue; }
    if (/\s/.test(hp.host)) { skipped.push({ line, text: joined.slice(0, 200), reason: `host 에 공백이 있습니다: ${hp.host}` }); continue; }
    const pick = (key, dflt = '') => get(key) || String(d[key] ?? '') || dflt;
    const row = {
      _line: line,
      host: hp.host,
      port: get('port') || hp.port || String(d.port || '') || '22',
      username: hp.user || pick('username', 'root'),   // `root@10.1.1.1` 형식이면 그 계정이 우선
      agentName: pick('agentName'),
      collectorDatacenter: pick('collectorDatacenter'),
      centralUrl: pick('centralUrl'),
      advertiseUrl: pick('advertiseUrl'),
      portalPort: pick('portalPort'),
      installerPath: pick('installerPath'),
      password: get('password') || String(d.password ?? ''),
      privateKey: String(d.privateKey ?? ''),        // 행별 개인키는 미지원(여러 줄) — 공통값만
      passphrase: get('passphrase') || String(d.passphrase ?? ''),
      centralToken: get('centralToken') || String(d.centralToken ?? ''),
      collectorToken: get('collectorToken') || String(d.collectorToken ?? ''),
    };
    // 이름/법인은 서로 비면 채워 준다(둘 중 하나만 적는 실사용 형태).
    if (!row.agentName && row.collectorDatacenter) row.agentName = row.collectorDatacenter;
    if (!row.collectorDatacenter && row.agentName) row.collectorDatacenter = row.agentName;
    for (const k of BOOL_KEYS) row[k] = bool(get(k), d[k] !== false);
    row._hasSecret = SECRET_COLS.some((k) => !!row[k]) || !!row.privateKey;
    rows.push(row);
  }
  return { rows, skipped, header: map, columns: pos, count: rows.length };
}

/**
 * 대량 배포 전 검증(순수 — 저장·접속 없음). CSV 가져오기의 analyzeTargetsImport 와 달리
 * '저장 여부'가 아니라 **배포 가능 여부**를 판정한다: 문법 · 목록 내 중복 · 자격증명 유무 ·
 * 기존 저장 대상과의 관계(신규/기존).
 * @param {{existingId?:(host,port,user)=>string|undefined, blockReason?:(host)=>string|null}} deps
 */
export function analyzeBulkDeploy(rows, { existingId = () => undefined, blockReason = () => null } = {}) {
  const seen = new Map();
  const report = []; const summary = { ready: 0, error: 0, known: 0, new: 0, withSecret: 0 };
  for (const row of rows) {
    const k = `${row.host}|${row.port}|${row.username}`.toLowerCase();
    const dup = seen.get(k);
    let reason = null;
    if (dup) reason = `목록 내 중복 — ${dup}행과 같은 host+port+계정`;
    else {
      reason = targetRowIssue(row)
        || blockReason(row.host)
        || (!row.password && !row.privateKey ? 'SSH 비밀번호/개인키가 없습니다(공통 자격증명을 입력하거나 열을 추가하세요).' : null)
        || (!row.username ? 'SSH 계정이 없습니다.' : null);
    }
    if (!dup) seen.set(k, row._line);
    const id = reason ? undefined : existingId(row.host, row.port, row.username);
    const action = reason ? 'error' : 'deploy';
    if (action === 'error') summary.error++;
    else {
      summary.ready++;
      if (id) summary.known++; else summary.new++;
      if (row._hasSecret) summary.withSecret++;
    }
    report.push({
      line: row._line, host: row.host, port: row.port, username: row.username,
      agentName: row.agentName, collectorDatacenter: row.collectorDatacenter,
      portalPort: row.portalPort || '', centralUrl: row.centralUrl || '',
      auth: row.privateKey ? 'key' : row.password ? 'password' : '', // 값이 아니라 '방식'만
      centralToken: row.centralToken ? (row._autoCentralToken ? 'auto' : 'set') : '',   // 유무·출처만(값 아님)
      collectorToken: row.collectorToken ? (row._autoCollectorToken ? 'auto' : 'set') : '',
      existing: !!id, action, reason,
    });
  }
  return { report, summary };
}

/**
 * 토큰 자동 채움(v2.432.1, 사용자 요구 '토큰 자동으로 넣는 기능'). 순수 — 난수 생성기는 주입받는다.
 *  - centralToken: 이 중앙 포탈의 토큰을 비어 있는 행에 채운다(전 노드 공통 — 중앙이 하나이므로).
 *  - collectorToken: **노드마다 다른 값**을 새로 만든다(중앙이 각 엣지를 당겨갈 때 쓰는 비밀 —
 *    한 값을 전 노드가 공유하면 한 대만 털려도 전 사이트 수집 데이터가 열린다).
 * 이미 값이 있는 행(표에 열로 적었거나 공통 기본값)은 건드리지 않는다.
 */
export function fillAutoTokens(rows, { centralToken = '', autoCollectorToken = false, gen } = {}) {
  for (const r of rows || []) {
    if (centralToken && !r.centralToken) { r.centralToken = centralToken; r._autoCentralToken = true; }
    if (autoCollectorToken && !r.collectorToken && typeof gen === 'function') { r.collectorToken = gen(); r._autoCollectorToken = true; }
    if (r.collectorToken) r._hasSecret = true;
  }
  return rows;
}

/** 저장된 대상 → 탭 구분 텍스트(내보내기). 비밀은 includeSecrets 일 때만(호출부가 소유자 게이트 책임). */
export function targetsToText(targets, { includeSecrets = false } = {}) {
  const head = `# Edge 노드 배포 대상 — 탭 구분. 이 텍스트를 그대로 '대량 배포' 입력칸에 붙여넣을 수 있습니다.\n`
    + `# 비밀 값${includeSecrets ? '을 포함합니다 — 취급 주의.' : '은 제외됩니다(공통 자격증명을 화면에서 입력하세요).'}\n`;
  const lines = [TEXT_COLUMNS.join('\t')];
  for (const t of targets || []) {
    lines.push(TEXT_COLUMNS.map((k) => {
      if (SECRET_COLS.includes(k)) return includeSecrets ? String(t[k] || '') : '';
      if (k === 'port') return String(t.port || 22);
      if (k === 'autoUpgrade' || k === 'pushInventory') return t[k] ? 'true' : 'false';
      if (k === 'enabled') return t.enabled === false ? 'false' : 'true';
      return String(t[k] ?? '');
    }).map((v) => v.replace(/[\t\r\n]+/g, ' ')).join('\t'));
  }
  return head + lines.join('\n') + '\n';
}

/** 붙여넣기용 샘플 — 화면의 '열 순서'와 헤더 형식을 모두 안내한다. */
export function sampleText() {
  return [
    '# ── 형식 A) 열 순서를 화면에서 고르고 값만 붙여넣기 ──────────────────────────',
    '# 열 순서 "host · 이름/법인 · 계정 · 비밀번호" 일 때',
    '10.112.158.221\tAZ\troot\tPassw0rd!',
    '10.113.158.221\tGM1\troot\tPassw0rd!',
    '',
    '# 열 순서 "host · 계정 · 비밀번호" (ip id pw) 일 때',
    '# 10.114.158.221\troot\tPassw0rd!',
    '',
    '# 열 순서 "host · 비밀번호" (ip pw) 일 때 — 계정은 공통값(root)을 씁니다',
    '# 10.115.158.221\tPassw0rd!',
    '',
    '# ── 형식 B) 계정을 host 에 붙여쓰기 (열 순서와 무관) ─────────────────────────',
    '# root@10.116.158.221\tPassw0rd!',
    '# ops@10.117.158.221:2222\tPassw0rd!',
    '',
    '# ── 형식 C) 헤더를 적으면 열 순서가 자유롭습니다(헤더가 화면 선택보다 우선) ──',
    '# 별칭: ip·호스트 / 계정·id / 비밀번호·pw / 법인·dc / 포탈포트 / 중앙url / 수집토큰 …',
    'host\tusername\tpassword\tagentName\tportalPort',
    '10.118.158.221\troot\tPassw0rd!\tHD\t4000',
  ].join('\n') + '\n';
}

/** CSV 로 내려받기(엑셀 호환) — 텍스트와 같은 열. csvLine 이 수식 인젝션(=,+,-,@)을 가드한다. */
export function targetsToTextCsv(targets, opts) {
  const lines = targetsToText(targets, opts).split('\n').filter((l) => l && !l.startsWith('#'));
  return CSV_BOM + lines.map((l) => csvLine(l.split('\t'))).join('\r\n') + '\r\n';
}

/** CSV 샘플(헤더 + 예시 2행) — 엑셀에서 열어 채운 뒤 그대로 올리면 된다. */
export function sampleTextCsv() {
  return CSV_BOM + [
    csvLine(TEXT_COLUMNS),
    csvLine(['10.112.158.221', '22', 'root', 'AZ', 'AZ', 'http://192.168.20.143:4000', '', '4000', '', 'true', 'false', 'true', 'Passw0rd!', '', '']),
    csvLine(['10.113.158.221', '22', 'root', 'GM1', 'GM1', 'http://192.168.20.143:4000', '', '4000', '', 'true', 'false', 'true', '', '', '']),
  ].join('\r\n') + '\r\n';
}
