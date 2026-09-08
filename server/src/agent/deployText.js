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
/** 헤더 없는 표의 위치 열 — 실사용 빈도 순(호스트 → 법인/이름 → 계정 → 비밀번호). */
export const POSITIONAL = ['host', 'agentName', 'username', 'password'];
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

/** `10.0.0.1:2222` → { host, port }. 콜론이 2개 이상이면(IPv6) 나누지 않는다. */
export function splitHostPort(v) {
  const s = String(v ?? '').trim();
  const m = /^([A-Za-z0-9.\-_]+):(\d{1,5})$/.exec(s);
  return m ? { host: m[1], port: m[2] } : { host: s, port: '' };
}

/**
 * 붙여넣은 텍스트 → 배포 대상 행 목록(순수). defaults 는 공통 기본값(행 값이 우선).
 * @returns {{ rows: Array, skipped: Array<{line:number,text:string,reason:string}>, header: object|null, count:number }}
 */
export function parseTargetsText(text, defaults = {}) {
  const lines = splitRows(text);
  const d = defaults || {};
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
      const p = POSITIONAL.indexOf(key);
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
      username: pick('username', 'root'),
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
  return { rows, skipped, header: map, count: rows.length };
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
      existing: !!id, action, reason,
    });
  }
  return { report, summary };
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

/** 붙여넣기용 샘플(헤더 없는 위치 형식 + 헤더 형식 둘 다 안내). */
export function sampleText() {
  return [
    '# 형식 1 — 헤더 없이 위치로: host[:SSH포트]  이름/법인  계정  비밀번호',
    '#   계정·비밀번호·중앙 URL 등은 아래 "공통 자격증명/기본값"에 한 번만 넣으면 생략할 수 있습니다.',
    '10.112.158.221\tAZ\troot',
    '10.113.158.221\tGM1\troot',
    '10.114.158.221:2222\tGM2\troot',
    '',
    '# 형식 2 — 헤더를 적으면 열 순서가 자유롭습니다(별칭 지원: ip/계정/법인/포트 …)',
    'host\tagentName\tcollectorDatacenter\tportalPort\tautoUpgrade',
    '10.115.158.221\tHD\tHD\t4000\ttrue',
  ].join('\n') + '\n';
}

/** CSV 로 내려받고 싶을 때(엑셀 호환) — 텍스트와 같은 열. */
export function targetsToTextCsv(targets, opts) {
  const lines = targetsToText(targets, opts).split('\n').filter((l) => l && !l.startsWith('#'));
  return CSV_BOM + lines.map((l) => csvLine(l.split('\t'))).join('\r\n') + '\r\n';
}
