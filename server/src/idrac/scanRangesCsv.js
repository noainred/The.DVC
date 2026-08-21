/**
 * idrac/scanRangesCsv.js — 법인별 iDRAC 장비 스캔 대역 CSV 내보내기/가져오기/샘플(v2.339).
 *
 * 수집 서버 CSV(v2.338)와 같은 골격 — 드라이런(문법 검증) 후 커밋, 기존 항목과 겹치면
 * overwrite 명시 확인. 대역(ranges) 배열은 CSV 한 셀에 **세미콜론(;)** 으로 직렬화한다
 * (쉼표는 셀 구분과 겹침). 가져오기는 ; 와 줄바꿈 둘 다 허용.
 *
 * 식별 키: **(datacenter, service)** — 화면 목록의 정렬/표시 단위와 동일. 같은 키의 기존
 * 엔트리가 2개 이상이면(수동 중복 등록) 어느 것을 덮어쓸지 모호하므로 그 행은 오류로 판정.
 *
 * 보안: password 는 기본 내보내지 않는다(빈 컬럼 — 가져오기에서 비우면 기존 유지,
 * saveScanRanges 규칙). `?secrets=1` 은 requireSettingsOwner + 감사로그(호출부 책임).
 * 대역 문법은 기존 파서(iprange.expandIpList — CIDR/범위/단일 IP)를 검증기로 재사용해
 * 드라이런 통과 = 스캐너가 실제로 해석 가능함을 보장한다.
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { expandIpList } from './iprange.js';

export const CSV_COLUMNS = ['datacenter', 'service', 'ranges', 'username', 'agent', 'dispatch', 'enabled', 'mode', 'password'];

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오'].includes(s);
};

/**
 * 스캔 대역 목록 → CSV. entries 는 listScanRanges() 결과(비번 미포함) 또는 원본(포함) —
 * includeSecrets 를 쓰려면 호출부가 소유자 게이트 + 감사로그를 책임진다.
 * @param {(id:string)=>string} dcName datacenterId → 표시명(가져오기는 이름/ID 둘 다 허용)
 */
export function scanRangesToCsv(entries, dcName = (x) => x, { includeSecrets = false } = {}) {
  const lines = [csvLine(CSV_COLUMNS)];
  for (const e of entries || []) {
    lines.push(csvLine([
      dcName(e.datacenterId) || e.datacenterId || '',
      e.service || '',
      (e.ranges || []).join('; '),
      e.username || '',
      e.agent || '',
      e.dispatch === 'push' ? 'push' : 'poll',
      e.enabled === false ? 'false' : 'true',
      e.mode || 'merge',
      includeSecrets ? (e.password || '') : '',
    ]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 샘플 CSV — 헤더 + 설명 주석 행 + 예시 2행(주석 행은 가져오기에서 자동 스킵). */
export function sampleCsv() {
  const lines = [
    csvLine(CSV_COLUMNS),
    csvLine(['# datacenter: 법인 이름 또는 ID(필수)', '# service: 서비스 라벨(선택 — 법인 내 복수 대역 구분)',
      '# ranges: 세미콜론(;) 구분 — CIDR(10.0.0.0/24)·범위(10.0.0.1-50)·단일 IP', '# username: iDRAC 계정',
      '# agent: 위임 엣지 이름(비우면 중앙 직접)', '# dispatch: poll|push', '# enabled: true|false',
      '# mode: merge|replace-datacenter', '# password: 비우면 기존 유지(신규는 없음)']),
    csvLine(['AZ', '', '192.168.88.0/26; 192.168.88.100-110', 'root', 'AZ', 'poll', 'true', 'merge', 'ChangeMe!1']),
    csvLine(['AZ', 'AZ IRS MGMT', '192.168.89.10', 'root', 'AZ-IRS', 'push', 'true', 'merge', '']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** CSV 텍스트 → 스캔 대역 입력 배열(순수). ranges 는 ;/줄바꿈 분리 배열로 변환. */
export function parseScanRangesCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const col = {
    datacenter: idx('datacenter', 'datacenterid', '법인', 'dc'), service: idx('service', '서비스'),
    ranges: idx('ranges', '대역', 'ips'), username: idx('username', 'user', '계정'),
    agent: idx('agent', '엣지', '스캔주체'), dispatch: idx('dispatch', '방식'),
    enabled: idx('enabled', '활성', '주기'), mode: idx('mode', '등록모드'),
    password: idx('password', '비밀번호', 'pw'),
  };
  if (col.datacenter < 0 || col.ranges < 0) return { rows: [], error: "필수 헤더 'datacenter' 와 'ranges' 가 없습니다." + delimiterHint(rows[0]) };

  const cell = (cells, i, { trim = true } = {}) => {
    if (i < 0) return '';
    const raw = unguardCell(cells[i] ?? '');
    return trim ? raw.trim() : raw;
  };
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const datacenter = cell(cells, col.datacenter);
    const rangesRaw = cell(cells, col.ranges);
    if (!datacenter && !rangesRaw) return;          // 완전 빈 행 스킵
    if (datacenter.startsWith('#')) return;         // 샘플 주석 행 스킵
    out.push({
      _line: n + 2,
      datacenter,
      service: cell(cells, col.service),
      ranges: rangesRaw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean),
      username: cell(cells, col.username),
      agent: cell(cells, col.agent),
      dispatch: cell(cells, col.dispatch).toLowerCase() === 'push' ? 'push' : 'poll',
      enabled: bool(cell(cells, col.enabled)),
      mode: cell(cells, col.mode).toLowerCase() === 'replace-datacenter' ? 'replace-datacenter' : 'merge',
      password: cell(cells, col.password, { trim: false }),
      _hasPassword: col.password >= 0 && cell(cells, col.password, { trim: false }) !== '',
    });
  });
  return { rows: out };
}

/**
 * 가져오기 무결성 검사(순수 — 저장 없음). 판정: add / overwrite((법인,서비스) 일치 1건) /
 * error(법인 미해석·대역 문법 오류·기존 중복 2건 이상·파일 내 중복).
 * @param {{resolveDc:(v:string)=>string|null, existingIds:(dcId:string, service:string)=>string[]}} deps
 *   resolveDc: 이름/ID → datacenterId(못 찾으면 null → 오류 — 오타로 유령 법인 생성 방지)
 */
export function analyzeScanRangesImport(rows, { resolveDc, existingIds }) {
  const seen = new Map(); // dcId|service → 첫 행
  const report = [];
  const summary = { add: 0, overwrite: 0, error: 0, withPassword: 0 };
  for (const row of rows) {
    const base = { line: row._line, datacenter: row.datacenter, service: row.service, rangeCount: row.ranges.length, hasPassword: !!row._hasPassword };
    let action = 'error'; let reason = null; let dcId = null;
    if (!row.ranges.length) reason = '대역(ranges)이 비어 있음';
    else {
      dcId = resolveDc(row.datacenter);
      if (!dcId) reason = `알 수 없는 법인: '${row.datacenter}' (등록된 법인 이름 또는 ID 여야 함)`;
      else {
        const { errors } = expandIpList(row.ranges.join('\n')); // 실제 스캐너와 같은 파서로 문법 검증
        if (errors?.length) reason = `대역 문법 오류: ${errors[0]}${errors.length > 1 ? ` 외 ${errors.length - 1}건` : ''}`;
      }
    }
    if (!reason) {
      const k = `${dcId}|${row.service}`.toLowerCase();
      const dupLine = seen.get(k);
      if (dupLine) reason = `파일 내 중복 — ${dupLine}행과 같은 법인+서비스(어느 행이 저장될지 모호)`;
      else {
        seen.set(k, row._line);
        const ids = existingIds(dcId, row.service);
        if (ids.length > 1) reason = `기존에 같은 법인+서비스 엔트리가 ${ids.length}개 — 어느 것을 덮어쓸지 모호(화면에서 정리 후 재시도)`;
        else action = ids.length === 1 ? 'overwrite' : 'add';
      }
    }
    if (row._hasPassword && action !== 'error') summary.withPassword++;
    summary[action === 'error' ? 'error' : action]++;
    report.push({ ...base, dcId, action, reason });
  }
  return { report, summary };
}
