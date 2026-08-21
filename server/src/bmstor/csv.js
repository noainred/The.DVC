/**
 * bmstor/csv.js — 베어메탈 스토리지 서버 CSV 내보내기/가져오기/샘플(v2.341, 사용자 요구 —
 * 다수 서버 일괄 등록). 수집 서버 CSV(v2.338)와 같은 골격: 드라이런(문법 검증) → 덮어쓰기
 * 명시 확인 → 커밋.
 *
 * 식별 키: (host, SSH포트, 계정) — 배포 대상 CSV(v2.339)와 동일 규칙.
 * 검증: 저장과 같은 규칙(registry.bmServerInputIssue 주입 — host/포트/계정/마운트 문법) +
 *   **agent 는 등록된 수집 서버(원격) 이름만 허용**(사용자 요구 — 텍스트 오타로 유령 엣지에
 *   위임되는 것 방지. 화면 select 와 같은 목록으로 검사). dispatch 는 poll|push.
 * 보안: password 는 기본 내보내지 않음(빈 컬럼 — 가져오기에서 비우면 기존 유지).
 *   `?secrets=1` 은 requireSettingsOwner + 감사로그(호출부 책임). 대역과 달리 mounts 는
 *   비밀이 아니므로 한 셀에 세미콜론(;) 구분으로 그대로 나간다.
 */

import { parseCsvRows, csvLine, unguardCell, CSV_BOM } from '../util/csv.js';

// v2.344: group(단일) → groups(세미콜론/쉼표 구분, 서버당 최대 3개 — 멀티 그룹). 가져오기는
// 구형 'group' 헤더도 별칭으로 수용한다(왕복 호환).
export const CSV_COLUMNS = ['name', 'host', 'port', 'username', 'groups', 'agent', 'dispatch', 'mounts', 'enabled', 'password'];

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오'].includes(s);
};

/** 서버 목록 → CSV. includeSecrets 를 쓰려면 호출부가 소유자 게이트 + 감사로그를 책임진다. */
export function bmServersToCsv(servers, { includeSecrets = false } = {}) {
  const lines = [csvLine(CSV_COLUMNS)];
  for (const s of servers || []) {
    lines.push(csvLine([
      s.name || '', s.host || '', s.port || 22, s.username || 'root',
      (Array.isArray(s.groups) && s.groups.length ? s.groups : (s.group ? [s.group] : [])).join('; '),
      s.agent || '',
      s.agent ? (s.dispatch === 'push' ? 'push' : 'poll') : '',
      (s.mounts || []).join('; '),
      s.enabled === false ? 'false' : 'true',
      includeSecrets ? (s.password || '') : '',
    ]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 샘플 CSV — 헤더 + 설명 주석 행 + 예시 2행(주석 행은 가져오기에서 자동 스킵). */
export function sampleCsv() {
  const lines = [
    csvLine(CSV_COLUMNS),
    csvLine(['# name: 표시 이름(비우면 host)', '# host: SSH IP/FQDN(필수)', '# port: SSH 포트(기본 22)',
      '# username: 계정(기본 root)', '# groups: 합산 그룹 — 세미콜론(;) 구분 최대 3개(선택)', '# agent: 위임 엣지 이름(비우면 중앙 직접 — 등록된 수집 서버만 허용)',
      '# dispatch: poll(에이전트 폴링, 기본)|push(중앙→엣지 직접)', '# mounts: 세미콜론(;) 구분 절대경로(필수)',
      '# enabled: true|false', '# password: 비우면 기존 유지(신규는 없음)']),
    csvLine(['백업서버-01', '10.20.0.31', '22', 'root', 'WA-백업; 전사-아카이브', 'WA-Edge', 'poll', '/; /data', 'true', 'ChangeMe!1']),
    csvLine(['미디어서버-01', '10.10.0.44', '22', 'root', '', '', '', '/srv/media', 'true', '']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** CSV 텍스트 → 서버 입력 배열(순수). mounts 는 ;/줄바꿈 분리 문자열 배열. */
export function parseBmServersCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const col = {
    name: idx('name', '표시명', '이름'), host: idx('host', 'ip', '호스트'), port: idx('port', '포트'),
    username: idx('username', 'user', '계정'), groups: idx('groups', 'group', '그룹'),
    agent: idx('agent', '엣지', '수집주체'), dispatch: idx('dispatch', '방식'),
    mounts: idx('mounts', '마운트'), enabled: idx('enabled', '활성'),
    password: idx('password', '비밀번호', 'pw'),
  };
  if (col.host < 0 || col.mounts < 0) return { rows: [], error: "필수 헤더 'host' 와 'mounts' 가 없습니다." };

  const cell = (cells, i, { trim = true } = {}) => {
    if (i < 0) return '';
    const raw = unguardCell(cells[i] ?? '');
    return trim ? raw.trim() : raw;
  };
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const host = cell(cells, col.host);
    if (!host) return;                      // 완전 빈 행 스킵
    const name = cell(cells, col.name);
    if (name.startsWith('#')) return;       // 샘플 주석 행 스킵
    out.push({
      _line: n + 2,
      name: name || host,
      host,
      port: cell(cells, col.port) || '22',
      username: cell(cells, col.username) || 'root',
      groups: cell(cells, col.groups), // 세미콜론/쉼표 구분 문자열 — 정규화·상한(3개)은 저장 검증(bmServerInputIssue) 단일 소스
      agent: cell(cells, col.agent),
      dispatch: cell(cells, col.dispatch).toLowerCase() === 'push' ? 'push' : 'poll',
      mounts: cell(cells, col.mounts).split(/[;\n]/).map((s) => s.trim()).filter(Boolean),
      enabled: bool(cell(cells, col.enabled)),
      password: cell(cells, col.password, { trim: false }),
      _hasPassword: col.password >= 0 && cell(cells, col.password, { trim: false }) !== '',
    });
  });
  return { rows: out };
}

/**
 * 가져오기 무결성 검사(순수). 판정: add / overwrite((host,port,계정) 일치) / error(저장 규칙
 * 위반·미등록 엣지·파일 내 중복). validAgent 는 등록된 수집 서버(원격) 이름 검사 함수.
 */
export function analyzeBmServersImport(rows, { existingId, validate, validAgent }) {
  const seen = new Map();
  const report = [];
  const summary = { add: 0, overwrite: 0, error: 0, withPassword: 0 };
  for (const row of rows) {
    const base = { line: row._line, name: row.name, host: row.host, port: row.port, username: row.username, agent: row.agent, mountCount: row.mounts.length, hasPassword: !!row._hasPassword };
    const k = `${row.host}|${row.port}|${row.username}`.toLowerCase();
    const dupLine = seen.get(k);
    let action = 'error'; let reason = null;
    if (dupLine) reason = `파일 내 중복 — ${dupLine}행과 같은 host+port+계정(어느 행이 저장될지 모호)`;
    else {
      reason = validate({ host: row.host, port: row.port, username: row.username, mounts: row.mounts, groups: row.groups });
      if (!reason && row.agent && !validAgent(row.agent)) reason = `미등록 엣지: '${row.agent}' — 설정 › 수집 서버(원격)에 등록된 이름만 사용할 수 있습니다.`;
      if (!reason) action = existingId(row.host, row.port, row.username) ? 'overwrite' : 'add';
    }
    if (!dupLine) seen.set(k, row._line);
    if (row._hasPassword && action !== 'error') summary.withPassword++;
    summary[action === 'error' ? 'error' : action]++;
    report.push({ ...base, action, reason });
  }
  return { report, summary };
}
