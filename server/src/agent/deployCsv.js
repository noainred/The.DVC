/**
 * agent/deployCsv.js — Edge 노드 설치(에이전트 배포) 대상 CSV 내보내기/가져오기/샘플(v2.339).
 *
 * 수집 서버 CSV(v2.338, collector/csv.js)와 같은 골격 — 공용 파서(util/csv.js) 재사용,
 * 드라이런(문법 검증) 후 커밋, 기존 항목과 겹치면 overwrite 명시 확인.
 *
 * 식별 키: **(host, port, username)** — deployRegistry.findTargetByHost 와 동일 규칙
 * (같은 호스트라도 SSH 포트/계정이 다르면 별개 대상 — 스크린샷의 :22/:4067 사례).
 *
 * 보안: 비밀값(password·centralToken·collectorToken)은 기본 내보내지 않는다(빈 컬럼).
 * `?secrets=1` 은 requireSettingsOwner 게이트 + 감사로그(호출부 책임). 가져오기에서 비우면
 * 기존 값 유지(saveTarget 규칙). privateKey(멀티라인)·gpuGuest(중첩)는 CSV 미지원 — 가져오기가
 * 건드리지 않으므로 기존 저장값이 그대로 유지된다.
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';

export const CSV_COLUMNS = ['host', 'port', 'username', 'agentName', 'centralUrl', 'collectorDatacenter',
  'portalPort', 'installerPath', 'autoUpgrade', 'pushInventory', 'enabled', 'password', 'centralToken', 'collectorToken'];

const SECRET_COLS = ['password', 'centralToken', 'collectorToken'];

const bool = (v, dflt) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오'].includes(s);
};

/** 대상 목록 → CSV. includeSecrets 가 아니면 비밀 3컬럼은 빈 값(왕복 편집 시 기존 유지). */
export function targetsToCsv(targets, { includeSecrets = false } = {}) {
  const lines = [csvLine(CSV_COLUMNS)];
  for (const t of targets || []) {
    lines.push(csvLine(CSV_COLUMNS.map((k) => {
      if (SECRET_COLS.includes(k)) return includeSecrets ? (t[k] || '') : '';
      if (k === 'port') return t.port || 22;
      if (k === 'autoUpgrade' || k === 'pushInventory') return t[k] ? 'true' : 'false';
      if (k === 'enabled') return t.enabled === false ? 'false' : 'true';
      return t[k] ?? '';
    })));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 샘플 CSV — 헤더 + 설명 주석 행 + 예시 2행(주석 행은 가져오기에서 자동 스킵). */
export function sampleCsv() {
  const lines = [
    csvLine(CSV_COLUMNS),
    csvLine(['# host: SSH 접속 IP/FQDN(필수)', '# port: SSH 포트(기본 22)', '# username: SSH 계정(기본 root)',
      '# agentName: 에이전트 이름', '# centralUrl: 중앙 포탈 URL', '# collectorDatacenter: 법인 라벨',
      '# portalPort: 엣지 포탈 포트(기본 4000)', '# installerPath: 비우면 중앙 기본 패키지',
      '# autoUpgrade: true|false', '# pushInventory: true|false', '# enabled: true|false',
      '# password: SSH 비번 — 비우면 기존 유지', '# centralToken: 비우면 기존 유지', '# collectorToken: 비우면 기존 유지']),
    csvLine(['192.168.88.221', '22', 'root', 'AZ', 'http://192.168.20.143:4000', 'AZ', '4000', '', 'true', 'true', 'true', 'ChangeMe!1', '', '']),
    csvLine(['192.168.60.221', '22', 'root', 'GM1', 'http://192.168.20.143:4000', 'GM1', '4000', '', 'true', 'true', 'true', '', '', '']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/**
 * CSV 텍스트 → 대상 입력 배열(순수 — 저장은 라우트에서 saveTarget 으로). 헤더 별칭 허용.
 * 비밀값은 공백이 유의미할 수 있어 trim 하지 않는다.
 */
export function parseTargetsCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const col = {
    host: idx('host', 'ip', '호스트'), port: idx('port', '포트'), username: idx('username', 'user', '계정'),
    agentName: idx('agentname', 'agent', '에이전트'), centralUrl: idx('centralurl', '중앙', 'central'),
    collectorDatacenter: idx('collectordatacenter', 'datacenter', '법인', 'dc'),
    portalPort: idx('portalport', '포탈포트'), installerPath: idx('installerpath', '설치경로'),
    autoUpgrade: idx('autoupgrade', '자동업그레이드'), pushInventory: idx('pushinventory', '인벤토리push'),
    enabled: idx('enabled', '활성'),
    password: idx('password', '비밀번호', 'pw'), centralToken: idx('centraltoken'), collectorToken: idx('collectortoken'),
  };
  if (col.host < 0) return { rows: [], error: "필수 헤더 'host' 가 없습니다." + delimiterHint(rows[0]) };

  const cell = (cells, i, { trim = true } = {}) => {
    if (i < 0) return '';
    const raw = unguardCell(cells[i] ?? '');
    return trim ? raw.trim() : raw;
  };
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const host = cell(cells, col.host);
    if (!host) return;                              // 완전 빈 행 스킵
    if (host.startsWith('#')) return;               // 샘플 주석 행 스킵
    const secret = (i) => cell(cells, i, { trim: false });
    out.push({
      _line: n + 2,
      host,
      port: cell(cells, col.port) || '22',
      username: cell(cells, col.username) || 'root',
      agentName: cell(cells, col.agentName),
      centralUrl: cell(cells, col.centralUrl),
      collectorDatacenter: cell(cells, col.collectorDatacenter),
      portalPort: cell(cells, col.portalPort),
      installerPath: cell(cells, col.installerPath),
      autoUpgrade: bool(cell(cells, col.autoUpgrade), true),
      pushInventory: bool(cell(cells, col.pushInventory), true),
      enabled: bool(cell(cells, col.enabled), true),
      password: secret(col.password),
      centralToken: secret(col.centralToken),
      collectorToken: secret(col.collectorToken),
      _hasSecret: SECRET_COLS.some((k, j) => {
        const i = [col.password, col.centralToken, col.collectorToken][j];
        return i >= 0 && secret(i) !== '';
      }),
    });
  });
  return { rows: out };
}

/** 한 행의 문법 검증(드라이런·커밋 공용) — null=통과. 저장(saveTarget)은 host 만 보므로 여기서 보강. */
export function targetRowIssue(row) {
  if (!row.host) return 'host 누락';
  const port = Number(row.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return `SSH 포트가 올바르지 않음: ${row.port}`;
  if (row.portalPort !== '') {
    const pp = Number(row.portalPort);
    if (!Number.isInteger(pp) || pp < 1 || pp > 65535) return `포탈 포트가 올바르지 않음: ${row.portalPort}`;
  }
  if (row.centralUrl && !/^https?:\/\/\S+$/.test(row.centralUrl)) return `centralUrl 은 http(s):// 형식이어야 함: ${row.centralUrl}`;
  return null;
}

/**
 * 가져오기 무결성 검사(순수 — 저장 없음). 판정: add / overwrite((host,port,username) 일치) /
 * error(문법·파일 내 중복). 커밋은 overwrite=true 명시 시에만 기존 항목을 갱신한다.
 * @param {{existingId:(host,port,user)=>string|undefined}} deps
 */
export function analyzeTargetsImport(rows, { existingId }) {
  const seen = new Map(); // host|port|user → 첫 행
  const report = [];
  const summary = { add: 0, overwrite: 0, error: 0, withSecret: 0 };
  for (const row of rows) {
    const base = { line: row._line, host: row.host, port: row.port, username: row.username, agentName: row.agentName, hasSecret: !!row._hasSecret };
    const k = `${row.host}|${row.port}|${row.username}`.toLowerCase();
    const dupLine = seen.get(k);
    let action = 'error'; let reason = null;
    if (dupLine) reason = `파일 내 중복 — ${dupLine}행과 같은 host+port+계정(어느 행이 저장될지 모호)`;
    else {
      reason = targetRowIssue(row);
      if (!reason) action = existingId(row.host, row.port, row.username) ? 'overwrite' : 'add';
    }
    if (!dupLine) seen.set(k, row._line);
    if (row._hasSecret && action !== 'error') summary.withSecret++;
    summary[action === 'error' ? 'error' : action]++;
    report.push({ ...base, action, reason });
  }
  return { report, summary };
}
