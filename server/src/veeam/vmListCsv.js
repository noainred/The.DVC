/**
 * veeam/vmListCsv.js — vCenter › 'VM 및 폴더' 의 **VM 목록 CSV**(순수, v2.792).
 *
 * 사용자 요청(2026-10-26): "Vcenter 화면에서 vm 폴더에서 vm list export 할때 Veeam 백업여부, 백업여부 판단할 수 있는 snapshot 포함여부
 *   포함해서 csv export". 선택: 대상 = 화면 기준(‘Off VM 포함’·검색 결과 반영) · 표준 검증.
 *
 * 판정은 새로 만들지 않는다 — '백업 세부내용' 도구와 **같은 VM 단위 결과**(backupStatus.vmBackupView)를 쓰고, 한 칸 판단은
 * backupStatus.backupVerdict(= viewClass)다. 이 모듈은 열 이름과 칸 글자만 정한다.
 *  · 모르는 값은 '모름'(Veeam·이벤트 기준) 또는 빈칸 — 0·'없음' 으로 쓰지 않는다. Veeam 서버가 연결돼 있지 않으면 '연동 없음'.
 *  · 스냅샷은 세 가지를 나눠 싣는다: ① 지금 있는 Veeam 임시 스냅샷('VEEAM BACKUP TEMPORARY SNAPSHOT' — 하루 넘으면 '잔존')
 *    ② 최근 N일 Veeam 계정이 만든 스냅샷 이벤트(횟수·마지막) ③ VM 의 전체 스냅샷(수·크기·최근 생성·이름 — 사람이 만든 것 포함).
 *  · 시각은 포탈 시각(util/dayKey localStamp — 프로세스 TZ 가 아니다)이고 머리에 오프셋을 적는다.
 *  · 장비·폴더 이름은 util/csv.js 수식 가드를 거친다(csvLine).
 *  · v2.792(시안 승인 — https://claude.ai/artifact/MENTpVFxe9D4Y4XgAazpBg ③): 폴더는 '폴더 1~N단계' 열(가장 깊은 VM 에 맞춘 열 수) + '폴더 경로' 열.
 *    엑셀의 '데이터(행 단위)' 시트(vmListXlsx.js)도 이 열 정의를 그대로 쓴다 — CSV 와 엑셀 데이터 시트가 같은 열이다.
 */
import { csvLine, CSV_BOM } from '../util/csv.js';
import { localStamp, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { backupVerdict } from './backupStatus.js';

/** 한 번에 받는 VM id 상한 — /api 본문 1MB(index.js) 안에 든다(id 약 30바이트 × 2만). 웹 vcdVmList.js 가 같은 값(테스트 대조). */
export const VM_LIST_MAX_IDS = 20_000;

/**
 * 폴더 경로 → 단계 배열. 화면 트리(web VCenterDetail buildFolderTree)와 같은 규칙 — '/' 로 나누고 vSphere 의 숨은 'vm' 폴더·빈 조각은 뺀다.
 * 수집기는 데이터센터 바로 아래 VM 을 'vm' 으로 적는다(soapClient folderPath) → [] (최상위).
 */
export function folderParts(folder) {
  return String(folder || 'vm').split('/').filter((p) => p && p !== 'vm');
}
/** 폴더 단계 열 수 — 가장 깊은 VM 에 맞춘다(최소 1 · 수집기 경로 상한 32). */
export function folderLevels(rows) {
  let n = 1;
  for (const r of rows || []) n = Math.max(n, folderParts(r?.view?.folder).length);
  return Math.min(n, 32);
}

const POWER_TEXT = Object.freeze({ POWERED_ON: '켜짐', POWERED_OFF: '꺼짐', SUSPENDED: '일시 중지' });
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num1 = (v) => (fin(v) ? Math.round(v * 10) / 10 : '');

/** 머리의 시각 표기 — '(UTC+09:00)'. */
export function offsetLabel(offsetMin = DAY_OFFSET_MIN) {
  const m = Number(offsetMin) || 0;
  const sign = m < 0 ? '−' : '+';
  const a = Math.abs(m);
  return `(UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')})`;
}

/** Veeam 칸 — '백업 대상' · '백업 중' · '대기' · '없음' · '연동 없음' · '모름'. vmBackupView 의 v: undefined = 모름 · null = 없음. */
export function veeamStateText(v, linked) {
  if (v === undefined) return '모름';
  if (!v) return linked ? '없음' : '연동 없음';
  return v.state === 'run' ? '백업 중' : v.state === 'wait' ? '대기' : '백업 대상';
}

/**
 * 열 정의 — 화면·테스트가 같은 목록을 본다. get(row) 의 row = { vc, inv(인벤토리 VM), view(vmBackupView), linked, snapDays, offsetMin }.
 */
export function vmListColumns({ snapDays = 7, offsetMin = DAY_OFFSET_MIN, levels = 1 } = {}) {
  const tz = offsetLabel(offsetMin);
  const t = (ms) => (fin(ms) && ms > 0 ? localStamp(ms, offsetMin) : '');
  const lv = Math.max(1, Math.min(32, Number(levels) || 1));
  const level = Array.from({ length: lv }, (_, i) => ({ h: `폴더 ${i + 1}단계`, folderLevel: i + 1, get: (r) => folderParts(r.view.folder)[i] || '' }));
  return [
    { h: 'vCenter', get: (r) => r.vc },
    ...level,
    { h: '폴더 경로', get: (r) => folderParts(r.view.folder).join('/') },
    { h: 'VM', get: (r) => r.view.name },
    { h: '전원', get: (r) => POWER_TEXT[r.view.power] || r.view.power || '' },
    { h: '템플릿', get: (r) => (r.inv.template === true ? '예' : '') },
    { h: '클러스터', get: (r) => r.inv.cluster || '' },
    { h: '호스트', get: (r) => r.inv.host || '' },
    { h: 'Guest OS', get: (r) => r.inv.guestOS || '' },
    { h: 'vCPU', get: (r) => (fin(r.inv.cpuCount) ? r.inv.cpuCount : '') },
    { h: '메모리(GB)', get: (r) => (fin(r.inv.memMB) ? num1(r.inv.memMB / 1024) : '') },
    { h: '스토리지 사용(GB)', get: (r) => num1(r.inv.storageGB) },
    { h: 'IP', get: (r) => r.inv.ipAddress || '' },
    { h: '백업 판단', get: (r) => backupVerdict(r.view, { linked: r.linked }).text },
    { h: 'Veeam 백업', get: (r) => veeamStateText(r.view.v, r.linked) },
    { h: 'Veeam 진행률(%)', get: (r) => (r.view.v && fin(r.view.v.pg) ? r.view.v.pg : '') },
    { h: 'Veeam 작업', get: (r) => (r.view.v?.jobs || []).join(' | ') },
    { h: 'Veeam 복원 지점', get: (r) => (r.view.v && fin(r.view.v.rp) && r.view.v.rp >= 0 ? r.view.v.rp : '') },
    { h: `Veeam 마지막 백업 완료 ${tz}`, get: (r) => t(r.view.v?.lb) },
    { h: 'Veeam 마지막 결과', get: (r) => (r.view.v ? (r.view.v.lr || r.view.v.lastResult || '') : '') },
    { h: 'Veeam 임시 스냅샷(지금)', get: (r) => (r.view.s?.now ? r.view.s.now.n : '') },
    { h: `Veeam 임시 스냅샷 생성 ${tz}`, get: (r) => t(r.view.s?.now?.ts) },
    { h: 'Veeam 임시 스냅샷 잔존(하루+)', get: (r) => (r.view.s?.now?.stale ? '예' : '') },
    { h: `최근 ${snapDays}일 Veeam 스냅샷 생성 횟수`, get: (r) => (r.view.s?.ev === undefined ? '모름' : r.view.s.ev ? (r.view.s.ev.n ?? '') : 0) },
    { h: `Veeam 스냅샷 마지막 생성 ${tz}`, get: (r) => t(r.view.s?.ev?.ts) },
    { h: '스냅샷 수(전체)', get: (r) => (fin(r.inv.snapshotCount) ? r.inv.snapshotCount : '') },
    { h: '스냅샷 크기(GB)', get: (r) => num1(r.inv.snapshotSizeGB) },
    { h: `스냅샷 최근 생성 ${tz}`, get: (r) => t(r.inv.snapshotNewestTs) },
    { h: '스냅샷 이름', get: (r) => (Array.isArray(r.inv.snapshotNames) ? r.inv.snapshotNames.slice(0, 20).join(' | ') : '') },
  ];
}

/**
 * CSV 본문(BOM 포함, CRLF).
 * @param {{ vcName:string, rows:Array<{inv:object, view:object}>, linked:boolean, snapDays?:number, offsetMin?:number }} a
 */
export function vmListCsv({ vcName, rows, linked, snapDays = 7, offsetMin = DAY_OFFSET_MIN }) {
  const cols = vmListColumns({ snapDays, offsetMin, levels: folderLevels(rows) });
  const lines = [CSV_BOM + csvLine(cols.map((c) => c.h))];
  for (const r of rows || []) lines.push(csvLine(cols.map((c) => c.get({ ...r, vc: vcName, linked }))));
  return lines.join('\r\n');
}
/**
 * 같은 CSV 를 조각으로 — 요청 경로에서 쓴다(상한 2만 대면 약 130ms 를 한 번에 잡는다 · 작성 중 실측). maybeYield = util/timeSlice createYielder.
 */
export async function vmListCsvAsync({ vcName, rows, linked, snapDays = 7, offsetMin = DAY_OFFSET_MIN }, maybeYield = async () => {}) {
  const cols = vmListColumns({ snapDays, offsetMin, levels: folderLevels(rows) });
  const lines = [CSV_BOM + csvLine(cols.map((c) => c.h))];
  for (const r of rows || []) {
    await maybeYield();
    lines.push(csvLine(cols.map((c) => c.get({ ...r, vc: vcName, linked }))));
  }
  return lines.join('\r\n');
}
