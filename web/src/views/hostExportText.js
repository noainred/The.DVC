/**
 * views/hostExportText.js — vCenter 화면 '호스트 · 클러스터 엑셀' 창 도우미(순수, v2.802 — vitest 가 고정).
 *
 * 사용자 요청(2026-10-27): "호스트 및 클러스터 정보로 VM 처럼 멋지게 · 호스트 1개에 엑셀 sheet 1개 · 최대한 자세하고 많은 정보".
 * 시안 https://claude.ai/artifact/HKxFuVeie66ddR2i8VxmFX 승인. 클러스터 목록·출처 상태·묶음 권한은 서버(GET /tools/host-export/status)가 준다 —
 * 여기는 묶음 글자 · 타일 · 시트 수 · 요청 본문만. 묶음 키는 서버 vcenter/hostExport.js HOST_EXPORT_PARTS 와 같다(테스트 대조).
 */
import { agoText } from './tools/vmExportText.js';

export const RESERVED_SHEETS = 4;   // 요약 · 클러스터 · 호스트 목록 · 읽는 법(서버 hostExportXlsx.HOST_XLSX_SHEETS)

/** 묶음 — [키, 이름, 출처 설명, 필요한 권한('hygiene'|'hw'|''), 기본값]. 'base' 는 늘 들어간다(서버 본문에는 싣지 않는다). */
export const PARTS = Object.freeze([
  ['base', '기본 · CPU · 메모리 · 클러스터', '인벤토리 · 클러스터 구성 — 늘 넣습니다', '', true],
  ['sec', '구성 · 보안 점검(SSH · NTP · 잠금 모드 · 인증서 …)', '호스트 구성 캐시 — ESXi 호스트 구성 점검과 같은 판정', 'hygiene', true],
  ['net', '네트워크(물리 NIC · 가상 스위치 · 포트그룹 · VLAN)', 'NIC 인벤토리 + 구성 캐시(스위치 · 포트그룹은 구성 점검 권한이 있을 때)', '', true],
  ['st', '스토리지(HBA · 멀티패스 · 데이터스토어)', 'HBA 인벤토리 + 구성 캐시 · 데이터스토어는 이 호스트 VM 기준', '', true],
  ['hw', '하드웨어 상태(iDRAC 부품 · 펌웨어)', 'iDRAC 에 등록된 서버만(서비스 태그로 맞춤) · 관리자 판본', 'hw', true],
  ['boot', '최근 재부팅(계획 · 예기치 않음 · 원인 미상)', '부팅 시각 + vCenter 이벤트', 'hygiene', true],
  ['vm', '이 호스트의 VM 목록', '인벤토리 — 전원 · vCPU · 메모리 · 사용률 · 데이터스토어 · 폴더', '', true],
  ['vmVeeam', 'VM 목록에 Veeam 마지막 백업 · 최근 1일 백업 여부', 'Veeam 연동 — 고르면 내려받을 때 대조(조금 느려집니다)', '', false],
]);
const NEED_TEXT = Object.freeze({ hygiene: '‘ESXi 호스트 구성 점검’ 권한이 없어 넣을 수 없습니다', hw: '관리자 판본에만 넣습니다' });

/** 처음 상태 — 권한 없는 묶음은 끈다. */
export function initialState(status) {
  const acc = status?.access || {};
  const parts = {};
  for (const [k, , , need, on] of PARTS) parts[k] = on && (!need || acc[need] === true);
  return { mode: 'all', picked: {}, parts };
}

/** 창에 그릴 묶음 줄 — 고정(base) · 권한 없음(잠김 + 사유) · Veeam 은 VM 목록이 있어야. */
export function partRows(status, st) {
  const acc = status?.access || {};
  const days = status?.bootDays;
  return PARTS.map(([k, label, src, need]) => {
    const denied = !!need && acc[need] !== true;
    const needsVm = k === 'vmVeeam' && !st.parts.vm;
    return {
      key: k, label, fixed: k === 'base', denied, disabled: k === 'base' || denied || needsVm,
      on: k === 'base' ? true : !denied && !needsVm && !!st.parts[k],
      src: denied ? NEED_TEXT[need] : needsVm ? '‘이 호스트의 VM 목록’ 을 고르면 넣을 수 있습니다' : k === 'boot' && Number.isFinite(days) ? `${src} · 최근 ${days}일` : src,
    };
  });
}

/** 고른 호스트 수 — 전체면 그 vCenter 호스트 수, 클러스터 고르기면 고른 클러스터 합. */
export function pickedHosts(status, st) {
  if (!status) return 0;
  if (st.mode !== 'pick') return status.hosts || 0;
  return (status.clusters || []).filter((c) => st.picked[c.key]).reduce((s, c) => s + (c.hosts || 0), 0);
}

/** 아래 줄 — '시트 N장' · 넘치면 사유. */
export function sheetLine(status, st) {
  const n = pickedHosts(status, st);
  const max = status?.max;
  if (st.mode === 'pick' && n === 0) return { text: '클러스터를 하나 이상 고르세요', ok: false, n };
  if (!n) return { text: '내보낼 호스트가 없습니다', ok: false, n };
  if (Number.isFinite(max) && n > max) return { text: `호스트 ${n.toLocaleString()}대 — 한 파일 최대 ${max}대라 클러스터를 골라 나눠 내려받으세요`, ok: false, n };
  return { text: `시트 ${(n + RESERVED_SHEETS).toLocaleString()}장`, ok: true, n };
}

/** 요청 본문(POST /tools/host-export.xlsx). */
export function exportBody(status, st) {
  const parts = partRows(status, st).filter((r) => !r.fixed && r.on).map((r) => r.key);
  const body = { parts };
  if (st.mode === 'pick') body.clusters = (status?.clusters || []).filter((c) => st.picked[c.key]).map((c) => c.key);
  return body;
}

/**
 * 출처 타일 4장 — 모르는 수는 '—'(0 이 아니다). 권한이 없어 서버가 주지 않은 출처는 그 사유.
 * @returns {Array<{key, label, value, sub, tone:'ok'|'info'|'warn'|'none'}>}
 */
export function sourceTiles(status, now = Date.now()) {
  const s = status?.sources || {};
  const out = [];
  const inv = s.inventory;
  out.push({ key: 'inv', label: '인벤토리', value: inv ? `호스트 ${Number(inv.hosts || 0).toLocaleString()}대` : '—', sub: inv?.at ? `마지막 ${agoText(inv.at, now)}` : '', tone: inv ? 'ok' : 'none' });
  if (s.hcfg) {
    const left = Math.max(0, (s.hcfg.total || 0) - (s.hcfg.read || 0));
    out.push({ key: 'hcfg', label: '호스트 구성 캐시', value: `${s.hcfg.read} / ${s.hcfg.total}`, sub: left ? `아직 못 읽은 호스트 ${left}대` : '모두 읽음', tone: left ? 'warn' : 'info' });
  } else out.push({ key: 'hcfg', label: '호스트 구성 캐시', value: '—', sub: '구성 점검 권한 없음', tone: 'none' });
  if (s.clusterCfg) {
    const left = Math.max(0, (s.clusterCfg.total || 0) - (s.clusterCfg.read || 0));
    out.push({ key: 'ccfg', label: '클러스터 구성', value: `${s.clusterCfg.read} / ${s.clusterCfg.total}`, sub: left ? `아직 못 읽은 클러스터 ${left}개` : s.clusterCfg.at ? `마지막 ${agoText(s.clusterCfg.at, now)}` : '', tone: left ? 'warn' : 'info' });
  } else out.push({ key: 'ccfg', label: '클러스터 구성', value: '—', sub: '클러스터 점검 권한 없음', tone: 'none' });
  if (s.idrac && !s.idrac.error) {
    const none = Math.max(0, (s.idrac.total || 0) - (s.idrac.registered || 0));
    const wait = Math.max(0, (s.idrac.registered || 0) - (s.idrac.matched || 0));
    out.push({ key: 'idrac', label: 'iDRAC', value: `${s.idrac.matched} / ${s.idrac.total}`, sub: [none && `등록 안 된 서버 ${none}대`, wait && `인벤토리 대기 ${wait}대`].filter(Boolean).join(' · ') || '모두 맞춤', tone: none || wait ? 'warn' : 'info' });
  } else out.push({ key: 'idrac', label: 'iDRAC', value: '—', sub: s.idrac?.error ? '등록부를 읽지 못함' : '관리자 판본에만', tone: 'none' });
  return out;
}
