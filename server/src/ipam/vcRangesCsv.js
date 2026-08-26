/**
 * ipam/vcRangesCsv.js — vCenter별 IP 스캔 대역 CSV 내보내기/가져오기/샘플.
 *
 * iDRAC 스캔 대역 CSV(idrac/scanRangesCsv.js, v2.339)와 같은 골격 — 드라이런(문법 검증) 후
 * 커밋, 기존 vCenter 와 겹치면 overwrite 명시 확인. 대역(ranges)은 CSV 한 셀에
 * **세미콜론(;)** 으로 직렬화한다(쉼표는 셀 구분과 겹침). 가져오기는 ; 와 줄바꿈 둘 다 허용.
 *
 * 식별 키: **vcenter(이름 또는 ID)** — 저장 모델(rangeStore)이 vCenter 단위 1엔트리라
 * CSV 도 vCenter 당 1행이고, 가져오기 커밋은 그 vCenter 의 대역 전체를 CSV 값으로 교체한다
 * (saveVcRanges 의 기존 계약과 동일).
 *
 * 대역 문법은 실제 스캐너와 같은 파서(scan.js rangeSize — CIDR/범위/단일 IP)를 검증기로
 * 재사용해, 드라이런 통과 = 주기 스캔이 실제로 해석 가능함을 보장한다.
 */

import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { rangeSize } from './scan.js';

export const CSV_COLUMNS = ['vcenter', 'ranges', 'enabled'];

const bool = (v, dflt = true) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return !['false', '0', 'no', 'n', 'off', '비활성', 'disabled', '아니오', '제외'].includes(s);
};

/**
 * 대역 목록 → CSV. entries 는 listVcRanges() 결과.
 * @param {(id:string)=>string} vcName vcenterId → 표시명(가져오기는 이름/ID 둘 다 허용)
 */
export function vcRangesToCsv(entries, vcName = (x) => x) {
  const lines = [csvLine(CSV_COLUMNS)];
  for (const e of entries || []) {
    lines.push(csvLine([
      vcName(e.vcenterId) || e.vcenterId || '',
      (e.ranges || []).join('; '),
      e.enabled === false ? 'false' : 'true',
    ]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 샘플 CSV — 헤더 + 설명 주석 행 + 예시 2행(주석 행은 가져오기에서 자동 스킵). */
export function sampleCsv() {
  const lines = [
    csvLine(CSV_COLUMNS),
    csvLine(['# vcenter: 등록된 vCenter 이름 또는 ID(필수)',
      '# ranges: 세미콜론(;) 구분 — CIDR(10.0.0.0/24)·범위(10.0.0.1-50)·단일 IP',
      '# enabled: true|false(주기 스캔 포함 여부, 비우면 true)']),
    csvLine(['서울-vc01', '10.10.0.0/24; 10.10.1.1-50', 'true']),
    csvLine(['pl-warsaw-vc', '172.16.5.0/26', 'false']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** CSV 텍스트 → 대역 입력 배열(순수). ranges 는 ;/줄바꿈 분리 배열로 변환. */
export function parseVcRangesCsv(text) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: 2000, maxCell: 8192 }); }
  catch (e) { return { rows: [], error: e.message }; }
  if (rows.length < 2) return { rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const idx = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const col = {
    vcenter: idx('vcenter', 'vcenterid', 'vcenter_id', 'vc'),
    ranges: idx('ranges', '대역', 'ips'),
    enabled: idx('enabled', '활성', '주기'),
  };
  if (col.vcenter < 0 || col.ranges < 0) return { rows: [], error: "필수 헤더 'vcenter' 와 'ranges' 가 없습니다." + delimiterHint(rows[0]) };

  const cell = (cells, i) => (i < 0 ? '' : unguardCell(cells[i] ?? '').trim());
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const vcenter = cell(cells, col.vcenter);
    const rangesRaw = cell(cells, col.ranges);
    if (!vcenter && !rangesRaw) return;        // 완전 빈 행 스킵
    if (vcenter.startsWith('#')) return;       // 샘플 주석 행 스킵
    out.push({
      _line: n + 2,
      vcenter,
      ranges: rangesRaw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean),
      enabled: bool(cell(cells, col.enabled)),
    });
  });
  return { rows: out };
}

/**
 * 가져오기 무결성 검사(순수 — 저장 없음). 판정: add / overwrite(기존 vCenter 엔트리 있음) /
 * error(vCenter 미해석·대역 문법 오류·파일 내 중복 vCenter).
 * @param {{resolveVc:(v:string)=>string|null, hasExisting:(vcId:string)=>boolean}} deps
 *   resolveVc: 이름/ID → vcenterId(못 찾으면 null → 오류 — 오타로 유령 vCenter 생성 방지)
 */
export function analyzeVcRangesImport(rows, { resolveVc, hasExisting }) {
  const seen = new Map(); // vcId → 첫 행
  const report = [];
  const summary = { add: 0, overwrite: 0, error: 0 };
  for (const row of rows) {
    const base = { line: row._line, vcenter: row.vcenter, rangeCount: row.ranges.length, enabled: row.enabled };
    let action = 'error'; let reason = null; let vcId = null;
    if (!row.ranges.length) reason = '대역(ranges)이 비어 있음';
    else {
      vcId = resolveVc(row.vcenter);
      if (!vcId) reason = `알 수 없는 vCenter: '${row.vcenter}' (등록된 vCenter 이름 또는 ID 여야 함)`;
      else {
        const bad = row.ranges.find((s) => rangeSize(s) <= 0); // 스캐너와 같은 파서로 문법 검증
        if (bad !== undefined) reason = `대역 문법 오류: '${bad}' (CIDR/범위/단일 IP 형식이 아님)`;
      }
    }
    if (!reason) {
      const dupLine = seen.get(vcId);
      if (dupLine) reason = `파일 내 중복 — ${dupLine}행과 같은 vCenter(어느 행이 저장될지 모호)`;
      else { seen.set(vcId, row._line); action = hasExisting(vcId) ? 'overwrite' : 'add'; }
    }
    summary[action === 'error' ? 'error' : action]++;
    report.push({ ...base, vcId, action, reason });
  }
  return { report, summary };
}
