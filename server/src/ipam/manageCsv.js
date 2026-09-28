/**
 * ipam/manageCsv.js — IP **관리상태 + 메모·태그** CSV 내보내기·가져오기 판정(순수, v2.636).
 *
 * 사용자 요청(2026-09-28): IP관리 서브메뉴의 '대용량 CSV import/export' 페이지. 선택 "IP 관리상태 + 스캔 대역".
 * 관리상태(override: 상태·디바이스·담당자·라벨·호스트명·귀속 vCenter·예약 만료·비고)와 메모·태그(annotation)는 IP 단위
 * 입력이라 화면에서 한 건씩 고치면 양이 많다 — 내보내서 고친 뒤 다시 가져온다(v2.513 대량 등록과 같은 '검증 → 적용' 2단계).
 *
 * ── 규칙(정직성) ─────────────────────────────────────────────────────────────
 *  · **헤더에 있는 열만** 바꾼다. 열이 없으면 그 필드는 건드리지 않는다(메모만 고친 파일이 상태를 지우지 않게).
 *  · 열이 있고 칸이 **비어 있으면 그 값을 지운다** — 내보낸 파일의 빈 칸은 '값 없음' 이라 왕복이 같아야 한다.
 *  · 값을 **조용히 고치지 않는다** — 모르는 상태·디바이스 종류, 날짜 형식 오류, 길이 초과는 그 행을 오류로 보고한다.
 *    (저장 함수 `overrides.clean` 은 모르는 상태를 빈 값으로 바꿔 **조용히 지운다** — 가져오기가 그 경로를 타면 오타 하나가
 *    기존 상태를 지운다. 그래서 여기서 먼저 막는다.)
 *  · 파일에 **없는 IP 는 건드리지 않는다**(행을 지웠다고 관리상태가 삭제되지 않는다 — 삭제는 칸을 비워서 명시한다).
 *  · 범위(scope) 판정은 호출부가 넘긴 `verdict(ip, claimedVcenterId)` 하나로 한다 — 단건 저장·일괄 적용과 **같은 함수**다
 *    (routes/api/ipamExport.js ipOverrideWriteVerdict — v2.630 AUTHZ2630-01).
 *  · 수식 가드(`guardCell`)를 내보내기에, 역가드(`unguardCell`)를 가져오기에 **쌍으로** 쓴다.
 */
import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { canonIp } from '../util/ipv4.js';

/** 열 이름(내보내기 순서) — 필드 키와 한글 별칭. */
export const MANAGE_COLUMNS = Object.freeze([
  { key: 'ip', aliases: ['ip', 'ip주소', 'ipaddress', 'address'] },
  { key: 'status', aliases: ['status', '상태', '관리상태'] },
  { key: 'deviceType', aliases: ['devicetype', 'device', '디바이스', '디바이스종류'] },
  { key: 'owner', aliases: ['owner', '담당자'] },
  { key: 'label', aliases: ['label', '라벨', '용도'] },
  { key: 'hostname', aliases: ['hostname', 'host', '호스트명'] },
  { key: 'vcenter', aliases: ['vcenter', 'vcenterid', 'vc', '귀속vcenter', '센터'] },
  { key: 'reservedUntil', aliases: ['reserveduntil', 'reserved', '예약만료', '예약만료일'] },
  { key: 'note', aliases: ['note', '비고'] },
  { key: 'memo', aliases: ['memo', '메모'] },
  { key: 'tags', aliases: ['tags', '태그'] },
]);
/** override 로 가는 열 → override 필드 이름. */
const OVERRIDE_FIELD = Object.freeze({ status: 'status', deviceType: 'deviceType', owner: 'owner', label: 'label', hostname: 'hostnameOverride', vcenter: 'claimedVcenterId', reservedUntil: 'reservedUntil', note: 'note' });
/** 길이 상한 — overrides.clean·annotations 의 절단 값과 같다(여기서는 자르지 않고 오류로 보고한다). */
export const MANAGE_LIMITS = Object.freeze({ owner: 200, label: 200, hostname: 253, vcenter: 120, note: 1000, memo: 2000, tagCount: 20, tagLen: 100 });
/** 파일 한 번에 받는 행 상한(청크가 아니라 요청 하나 기준). 화면은 이보다 작게 나눠 보낸다. */
export const MANAGE_CHUNK_MAX = 2500;

const norm = (h) => unguardCell(h).trim().toLowerCase().replace(/[\s_\-()]/g, '');

/** 내보내기 한 줄에 쓸 태그 문자열 — 세미콜론 구분(쉼표는 CSV 구분자와 헷갈린다). */
const tagsText = (tags) => (Array.isArray(tags) ? tags.join('; ') : '');
const splitTags = (s) => String(s || '').split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * 관리상태·메모 → CSV. entries: [{ ip, override|null, annotation|null }] (호출부가 범위로 거른 것).
 * @param {(id:string)=>string} vcName  vCenter id → 표시 이름(가져오기는 이름·id 둘 다 받는다)
 * @param {(iso:string)=>string} dayOf  예약 만료 ISO → 'YYYY-MM-DD'(overrides.reservedUntilDay — 저장값은 다음 날 0시다)
 */
export function manageToCsv(entries, { vcName = (x) => x, dayOf = (x) => String(x || '').slice(0, 10) } = {}) {
  const lines = [csvLine(MANAGE_COLUMNS.map((c) => c.key))];
  for (const e of entries || []) {
    const o = e.override || {}; const a = e.annotation || {};
    lines.push(csvLine([
      e.ip, o.status || '', o.deviceType || '', o.owner || '', o.label || '', o.hostnameOverride || '',
      o.claimedVcenterId ? (vcName(o.claimedVcenterId) || o.claimedVcenterId) : '',
      o.reservedUntil ? dayOf(o.reservedUntil) : '', o.note || '', a.memo || '', tagsText(a.tags),
    ]));
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** 샘플 — 헤더 + 주석 행(가져오기에서 건너뜀) + 예시. */
export function manageSampleCsv(statuses = [], deviceTypes = []) {
  const lines = [
    csvLine(MANAGE_COLUMNS.map((c) => c.key)),
    csvLine([`# ip 필수 · status: ${statuses.join('|')} · deviceType: ${deviceTypes.join('|')}`, '# 칸을 비우면 그 값을 지웁니다 · 열을 빼면 그 필드는 그대로 둡니다', '', '', '', '', '# vcenter: 이름 또는 ID', '# reservedUntil: YYYY-MM-DD(그날까지 예약)', '', '', '# tags: 세미콜론(;) 구분']),
    csvLine(['10.10.0.25', 'reserved', 'server', '홍길동', 'DB 이관 예정', '', '', '2026-12-31', '', '이관 전 예약', 'db; 이관']),
    csvLine(['10.10.0.26', 'active', 'switch', '네트워크팀', '코어 스위치', 'core-sw01', '', '', '', '', 'network']),
  ];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/**
 * CSV 텍스트 → { columns, rows:[{_line, ip, <열 키>: 원문}], error }. lineOffset 은 청크로 나눠 보낼 때 원래 파일의 행 번호를
 * 맞추기 위한 값이다(청크의 헤더 다음 첫 행이 파일의 몇 번째 데이터 행인지 — 0 이면 첫 청크).
 */
export function parseManageCsv(text, { lineOffset = 0, maxRows = MANAGE_CHUNK_MAX } = {}) {
  let rows;
  try { rows = parseCsvRows(text, { maxRows: maxRows + 1, maxCell: 4096 }); }
  catch (e) { return { columns: [], rows: [], error: e.message }; }
  if (rows.length < 2) return { columns: [], rows: [], error: '헤더 + 최소 1개 데이터 행이 필요합니다.' };
  const header = rows[0].map(norm);
  const idx = {};
  for (const c of MANAGE_COLUMNS) { const i = header.findIndex((h) => c.aliases.includes(h)); if (i >= 0) idx[c.key] = i; }
  if (idx.ip == null) return { columns: [], rows: [], error: "필수 헤더 'ip' 가 없습니다." + delimiterHint(rows[0]) };
  const columns = MANAGE_COLUMNS.map((c) => c.key).filter((k) => idx[k] != null);
  if (columns.length < 2) return { columns, rows: [], error: "바꿀 열이 없습니다 — 'ip' 외에 status·owner·memo 같은 열이 하나 이상 있어야 합니다." };
  const off = Math.max(0, Math.floor(Number(lineOffset) || 0));
  const out = [];
  rows.slice(1).forEach((cells, n) => {
    const ipRaw = unguardCell(cells[idx.ip] ?? '').trim();
    if (ipRaw.startsWith('#')) return;                       // 샘플 주석 행
    const row = { _line: off + n + 2, ip: ipRaw };
    for (const k of columns) if (k !== 'ip') row[k] = unguardCell(cells[idx[k]] ?? '').trim();
    if (!ipRaw && columns.every((k) => k === 'ip' || !row[k])) return; // 완전 빈 행
    out.push(row);
  });
  return { columns, rows: out, error: null };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** 두 값이 '같은 값' 인가(빈 값·null·undefined 는 같은 '없음'). */
const same = (a, b) => String(a ?? '') === String(b ?? '');

/**
 * 가져오기 판정(순수 — 저장 없음).
 * @param {object[]} rows      parseManageCsv 결과
 * @param {string[]} columns   헤더에 있는 열 키
 * @param {object} ctx
 *   getOverride(ip)·getAnnotation(ip) — 현재 값 / resolveVc(nameOrId)→id|null / verdict(ip, claimedId)→null|{reason}
 *   statuses·deviceTypes — 허용 값 / dayOf(iso)→'YYYY-MM-DD'
 * @returns {{ report:object[], summary:{create,update,same,clear,error}, plans:object[] }}
 *   plans: 적용할 행만 — { line, ip, override: partial|null, annotation: {memo,tags}|null }
 */
export function analyzeManageImport(rows, columns, ctx) {
  const has = (k) => columns.includes(k);
  const statuses = ctx.statuses || []; const deviceTypes = ctx.deviceTypes || [];
  const dayOf = ctx.dayOf || ((x) => String(x || '').slice(0, 10));
  const seen = new Map();
  const report = []; const plans = [];
  const summary = { create: 0, update: 0, same: 0, clear: 0, error: 0 };
  for (const r of rows) {
    const out = { line: r._line, ip: r.ip, action: 'error', reason: null, changes: [] };
    const push = () => { summary[out.action] += 1; report.push(out); };
    const ip = canonIp(r.ip);
    if (!ip) { out.reason = r.ip ? `IP 형식이 아닙니다: '${String(r.ip).slice(0, 40)}'` : 'IP 칸이 비어 있습니다.'; push(); continue; }
    out.ip = ip;
    if (seen.has(ip)) { out.reason = `파일 안에서 같은 IP 가 두 번 나옵니다(${seen.get(ip)}행) — 어느 행을 쓸지 모호해 이 행은 적용하지 않습니다.`; push(); continue; }
    seen.set(ip, r._line);
    const errs = [];
    const cur = ctx.getOverride(ip) || {};
    const curA = ctx.getAnnotation(ip) || {};
    const patch = {};
    if (has('status')) {
      const v = String(r.status || '').toLowerCase();
      if (v && !statuses.includes(v)) errs.push(`상태 '${r.status}' 는 쓸 수 없습니다(허용: ${statuses.join(', ')})`); else patch.status = v;
    }
    if (has('deviceType')) {
      const v = String(r.deviceType || '').toLowerCase();
      if (v && !deviceTypes.includes(v)) errs.push(`디바이스 종류 '${r.deviceType}' 는 쓸 수 없습니다(허용: ${deviceTypes.join(', ')})`); else patch.deviceType = v;
    }
    for (const k of ['owner', 'label', 'hostname', 'note']) {
      if (!has(k)) continue;
      const v = r[k] || '';
      if (v.length > MANAGE_LIMITS[k]) errs.push(`${k} 가 ${MANAGE_LIMITS[k]}자를 넘습니다(${v.length}자)`); else patch[OVERRIDE_FIELD[k]] = v;
    }
    if (has('vcenter')) {
      const v = r.vcenter || '';
      if (!v) patch.claimedVcenterId = '';
      else { const id = ctx.resolveVc(v); if (!id) errs.push(`알 수 없는 vCenter: '${v.slice(0, 60)}'(등록된 이름 또는 ID)`); else patch.claimedVcenterId = id; }
    }
    if (has('reservedUntil')) {
      const v = r.reservedUntil || '';
      if (v && !validDate(v)) errs.push(`예약 만료일 '${v}' 는 YYYY-MM-DD 형식이 아닙니다`); else patch.reservedUntil = v;
    }
    let ann = null;
    if (has('memo') || has('tags')) {
      const memo = has('memo') ? (r.memo || '') : (curA.memo || '');
      const tags = has('tags') ? splitTags(r.tags) : (Array.isArray(curA.tags) ? curA.tags : []);
      if (memo.length > MANAGE_LIMITS.memo) errs.push(`메모가 ${MANAGE_LIMITS.memo}자를 넘습니다(${memo.length}자)`);
      if (tags.length > MANAGE_LIMITS.tagCount) errs.push(`태그가 ${MANAGE_LIMITS.tagCount}개를 넘습니다(${tags.length}개)`);
      if (tags.some((t) => t.length > MANAGE_LIMITS.tagLen)) errs.push(`태그 하나가 ${MANAGE_LIMITS.tagLen}자를 넘습니다`);
      ann = { memo, tags };
    }
    if (errs.length) { out.reason = errs.join(' · '); push(); continue; }
    // 범위 판정 — 새 귀속(있으면)과 기존 귀속을 함께 본다(호출부 verdict 가 ipOverrideWriteVerdict 와 같은 규칙).
    const v = ctx.verdict(ip, patch.claimedVcenterId || '');
    if (v) { out.reason = v.reason || '범위 밖이거나 수정 권한이 없는 IP 입니다.'; push(); continue; }
    // 바뀌는 필드 계산
    for (const [k, val] of Object.entries(patch)) {
      const before = k === 'reservedUntil' ? (cur.reservedUntil ? dayOf(cur.reservedUntil) : '') : cur[k];
      if (!same(before, val)) out.changes.push(k);
    }
    if (ann) {
      if (!same(curA.memo || '', ann.memo)) out.changes.push('memo');
      if (!same((curA.tags || []).join(';'), ann.tags.join(';'))) out.changes.push('tags');
    }
    const hadAny = Object.keys(cur).some((k) => !['updatedAt', 'updatedBy'].includes(k) && cur[k]) || !!(curA.memo || (curA.tags || []).length);
    const willAny = (() => {
      const next = { ...cur, ...patch };
      const ov = ['status', 'owner', 'label', 'deviceType', 'hostnameOverride', 'note', 'reservedUntil', 'claimedVcenterId'].some((k) => next[k]);
      const an = ann ? !!(ann.memo || ann.tags.length) : !!(curA.memo || (curA.tags || []).length);
      return ov || an;
    })();
    if (!out.changes.length) out.action = 'same';
    else if (!hadAny) out.action = 'create';
    else if (!willAny) out.action = 'clear';
    else out.action = 'update';
    push();
    if (out.action !== 'same') {
      const ovChanged = out.changes.some((k) => k !== 'memo' && k !== 'tags');
      plans.push({ line: out.line, ip, override: ovChanged ? patch : null, annotation: out.changes.some((k) => k === 'memo' || k === 'tags') ? ann : null });
    }
  }
  return { report, summary, plans };
}
