/**
 * veeam/vmListCatalog.js — VM 목록 내보내기 '필요한 항목만 고르기' 열 카탈로그(순수, v2.798).
 *
 * 사용자 요청(2026-10-27): "vm list export 하는 기능에서 메모, TAG, 디스크 파티션 종류 등의 구성 정보에서 내가 필요한 것만 선택해서 export"
 *   · 시안 https://claude.ai/artifact/FS8Uk5piEnbFJE7qvLRWQW 승인 · 결정: 저장값은 계정에 · 파일 시스템 종류 수집 포함 · 실시간 조회 항목(생성일·UUID·NIC) 제외.
 * ⚠ v2.800(사용자 지시 "vCenter 화면은 전체 VM, 백업 현황은 백업 — 분리 필요"): 이 카탈로그는 **백업 현황 › Detail 의 '백업 내보내기' 창 전용**이다.
 *   디스크·파티션·구성·자원(사용률·네트워크) 묶음은 지웠다 — 전체 VM 구성은 'VM 전체 정보 내보내기'(vcenter/vmExportCatalog.js · 도구 vm-export)가 맡는다.
 *   여기에 구성 항목을 다시 늘리지 말 것(같은 값을 두 카탈로그가 따로 만들게 된다). 남긴 자원 열(vCPU·메모리·스토리지·IP)은 v2.792 열(LEGACY_KEYS)이라서다.
 *
 * 열은 여기 하나다 — 웹 창(GET /veeam/vm-list/catalog 로 받는다)·CSV·엑셀 '데이터' 시트가 같은 key·머리·칸 값을 쓴다.
 *  · key 는 고정(저장값에 남는다 — 바꾸지 말 것. 지우면 저장값에서 조용히 빠지고 화면이 알린다).
 *  · v2.792 열(vmListCsv.vmListColumns)과 같은 항목은 머리·칸 글자가 같다(테스트가 대조 — cols 를 안 보내면 예전 그대로 그 열을 쓴다).
 *  · 못 읽은 값은 빈칸, 그 vCenter 에서 아직 모으지 않은 소스(태그 수집 전·파티션 수집 안 된 VM·구성 캐시 미도달)는 '수집 안 됨'(MISSING) — 0·'없음' 으로 쓰지 않는다.
 *  · avail = 채워짐 정도(화면 배지): snap 30초 인벤토리 · cache 주기 수집 캐시.
 *  · needs = 그 열이 읽는 추가 소스(veeam·tags·marks) — 라우트는 고른 열에 필요한 소스만 읽는다(Veeam 대조는 무겁다).
 */
import { folderParts, offsetLabel, veeamStateText } from './vmListCsv.js';
import { backupVerdict, recentBackupYn, recentBackupSnapYn, ynDaysOf, YN_DAYS, YN_DEFAULT_DAYS } from './backupStatus.js';
import { localStamp, DAY_OFFSET_MIN } from '../util/dayKey.js';

export const MISSING = '수집 안 됨';
export const MAX_COLS = 100;
const POWER_TEXT = Object.freeze({ POWERED_ON: '켜짐', POWERED_OFF: '꺼짐', SUSPENDED: '일시 중지' });
const TOOLS_TEXT = Object.freeze({ RUNNING: '실행 중', NOT_RUNNING: '꺼짐' });
const TOOLS_VS_TEXT = Object.freeze({ guestToolsCurrent: '최신', guestToolsNeedUpgrade: '업그레이드 필요', guestToolsNotInstalled: '설치 안 됨', guestToolsUnmanaged: '직접 관리', guestToolsTooOld: '너무 오래됨', guestToolsSupportedOld: '지원(구판)', guestToolsSupportedNew: '지원(신판)', guestToolsTooNew: '너무 새것', guestToolsBlacklisted: '차단 판' });
const CRIT_TEXT = Object.freeze({ high: '중요도 상', mid: '중요도 중', low: '중요도 하' });
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num1 = (v) => (fin(v) ? Math.round(v * 10) / 10 : '');
const join = (a) => (Array.isArray(a) ? a.filter((x) => x != null && x !== '').join(' | ') : '');

export const GROUPS = Object.freeze([
  { id: 'base', name: '기본' },
  { id: 'meta', name: '메모 · 태그 · 속성' },
  { id: 'res', name: '자원 · IP' },
  { id: 'snap', name: '스냅샷' },
  { id: 'veeam', name: 'Veeam 백업' },
]);
export const GROUP_NOTES = Object.freeze({
  meta: '태그·사용자 지정 속성은 vCenter 마다 주기(기본 6시간)로 모읍니다 — 재시작 직후 첫 수집 전에는 ‘수집 안 됨’ 입니다. 백업 표시는 포탈에서 사람이 적은 값입니다.',
  res: '디스크·파티션·구성·사용률은 VM 전체 정보 내보내기(vCenter 화면의 ‘⤓ VM 전체 정보 내보내기…’)에 있습니다.',
});

/* ── 소스 읽기 도우미(행 r 의 모양은 라우트 vmListExport 가 만든다) ──
 * r = { vc(이름), linked, inv(인벤토리 VM), view(vmBackupView — Veeam 열을 고른 때만), tg({tags,custom} | undefined = 수집 안 됨), mark(markView), marksOk }
 */
const tagsCell = (r) => (r.tg?.tags == null ? MISSING : join(r.tg.tags.map((t) => (t.category ? `${t.category}:${t.tag}` : t.tag))));
const customCell = (r) => (r.tg?.custom == null ? MISSING : join(r.tg.custom.map((c) => `${c.name}=${c.value}`)));

/**
 * 카탈로그 — 항목마다 { key, group, label(화면) , head(o)(파일 머리 — 없으면 label), avail, needs?, get(r, o) }.
 * o = { snapDays, offsetMin, tz, t(ms→포탈 시각) }.
 */
export const CATALOG = Object.freeze([
  // 기본
  { key: 'vc', group: 'base', label: 'vCenter', avail: 'snap', get: (r) => r.vc },
  { key: 'flv', group: 'base', label: '폴더 1~N단계(열 나눔)', avail: 'snap', get: () => '' },   // 열 펼침은 selectedColumns 가 한다
  { key: 'folder', group: 'base', label: '폴더 경로', avail: 'snap', get: (r) => folderParts(r.inv.folder).join('/') },
  { key: 'name', group: 'base', label: 'VM 이름', head: () => 'VM', avail: 'snap', get: (r) => r.inv.name || '' },
  { key: 'power', group: 'base', label: '전원', avail: 'snap', get: (r) => POWER_TEXT[r.inv.powerState] || r.inv.powerState || '' },
  { key: 'tmpl', group: 'base', label: '템플릿', avail: 'snap', get: (r) => (r.inv.template === true ? '예' : '') },
  { key: 'conn', group: 'base', label: '연결 상태', avail: 'snap', get: (r) => r.inv.connectionState || '' },
  { key: 'cluster', group: 'base', label: '클러스터', avail: 'snap', get: (r) => r.inv.cluster || '' },
  { key: 'host', group: 'base', label: '호스트', avail: 'snap', get: (r) => r.inv.host || '' },
  { key: 'rp', group: 'base', label: '리소스 풀', avail: 'snap', get: (r) => r.inv.resourcePool || '' },
  { key: 'os', group: 'base', label: 'Guest OS', avail: 'snap', get: (r) => r.inv.guestOS || '' },
  { key: 'hw', group: 'base', label: 'HW 버전', avail: 'snap', get: (r) => r.inv.hwVersion || '' },
  { key: 'tools', group: 'base', label: 'VMware Tools(상태·버전)', avail: 'snap',
    get: (r) => [TOOLS_TEXT[r.inv.toolsStatus] || r.inv.toolsStatus || '', r.inv.toolsVersion || '', TOOLS_VS_TEXT[r.inv.toolsVersionStatus] || ''].filter(Boolean).join(' · ') },
  // 메모 · 태그 · 속성
  { key: 'notes', group: 'meta', label: '메모(vCenter 주석)', avail: 'snap', get: (r) => String(r.inv.notes || '').trim() },
  { key: 'tags', group: 'meta', label: 'vSphere 태그(카테고리:태그)', avail: 'cache', needs: 'tags', get: tagsCell },
  { key: 'custom', group: 'meta', label: '사용자 지정 속성', avail: 'cache', needs: 'tags', get: customCell },
  { key: 'bmark', group: 'meta', label: '백업 표시(중요도·백업 필요·메모)', avail: 'snap', needs: 'marks',
    get: (r) => (!r.marksOk || !r.mark ? '' : [CRIT_TEXT[r.mark.crit] || '', r.mark.need ? '백업 필요' : '', r.mark.memo || ''].filter(Boolean).join(' · ')) },
  // 자원 · IP(v2.792 열 — 사용률·네트워크 상세는 VM 전체 정보 내보내기)
  { key: 'cpu', group: 'res', label: 'vCPU', avail: 'snap', get: (r) => (fin(r.inv.cpuCount) ? r.inv.cpuCount : '') },
  { key: 'mem', group: 'res', label: '메모리(GB)', avail: 'snap', get: (r) => (fin(r.inv.memMB) ? num1(r.inv.memMB / 1024) : '') },
  { key: 'stor', group: 'res', label: '스토리지 사용(GB)', avail: 'snap', get: (r) => num1(r.inv.storageGB) },
  { key: 'ip', group: 'res', label: 'IP', avail: 'snap', get: (r) => r.inv.ipAddress || '' },
  // 스냅샷
  { key: 'snN', group: 'snap', label: '스냅샷 수(전체)', avail: 'snap', get: (r) => (fin(r.inv.snapshotCount) ? r.inv.snapshotCount : '') },
  { key: 'snSize', group: 'snap', label: '스냅샷 크기(GB)', avail: 'snap', get: (r) => num1(r.inv.snapshotSizeGB) },
  { key: 'snOld', group: 'snap', label: '스냅샷 가장 오래된 생성', head: (o) => `스냅샷 가장 오래된 생성 ${o.tz}`, avail: 'snap', get: (r, o) => o.t(r.inv.snapshotOldestTs) },
  { key: 'snNew', group: 'snap', label: '스냅샷 최근 생성', head: (o) => `스냅샷 최근 생성 ${o.tz}`, avail: 'snap', get: (r, o) => o.t(r.inv.snapshotNewestTs) },
  { key: 'snNames', group: 'snap', label: '스냅샷 이름', avail: 'snap', get: (r) => (Array.isArray(r.inv.snapshotNames) ? r.inv.snapshotNames.slice(0, 20).join(' | ') : '') },
  // Veeam 백업(v2.792 열 — 판정은 vmBackupView · backupVerdict 그대로)
  { key: 'vjudge', group: 'veeam', label: '백업 판단', avail: 'snap', needs: 'veeam', get: (r) => (r.view ? backupVerdict(r.view, { linked: r.linked }).text : '') },
  { key: 'vstate', group: 'veeam', label: 'Veeam 백업', avail: 'snap', needs: 'veeam', get: (r) => (r.view ? veeamStateText(r.view.v, r.linked) : '') },
  { key: 'vpg', group: 'veeam', label: 'Veeam 진행률(%)', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.v && fin(r.view.v.pg) ? r.view.v.pg : '') },
  { key: 'vjob', group: 'veeam', label: 'Veeam 작업', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.v?.jobs || []).join(' | ') },
  { key: 'vrp', group: 'veeam', label: 'Veeam 복원 지점', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.v && fin(r.view.v.rp) && r.view.v.rp >= 0 ? r.view.v.rp : '') },
  { key: 'vlast', group: 'veeam', label: 'Veeam 마지막 백업 완료', head: (o) => `Veeam 마지막 백업 완료 ${o.tz}`, avail: 'snap', needs: 'veeam', get: (r, o) => o.t(r.view?.v?.lb) },
  { key: 'vres', group: 'veeam', label: 'Veeam 마지막 결과', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.v ? (r.view.v.lr || r.view.v.lastResult || '') : '') },
  { key: 'vtmp', group: 'veeam', label: 'Veeam 임시 스냅샷(지금)', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.s?.now ? r.view.s.now.n : '') },
  { key: 'vtmpTs', group: 'veeam', label: 'Veeam 임시 스냅샷 생성', head: (o) => `Veeam 임시 스냅샷 생성 ${o.tz}`, avail: 'snap', needs: 'veeam', get: (r, o) => o.t(r.view?.s?.now?.ts) },
  { key: 'vtmpStale', group: 'veeam', label: 'Veeam 임시 스냅샷 잔존(하루+)', avail: 'snap', needs: 'veeam', get: (r) => (r.view?.s?.now?.stale ? '예' : '') },
  { key: 'vsnapN', group: 'veeam', label: '최근 N일 Veeam 스냅샷 생성 횟수', head: (o) => `최근 ${o.snapDays}일 Veeam 스냅샷 생성 횟수`, avail: 'snap', needs: 'veeam',
    get: (r) => (!r.view ? '' : r.view.s?.ev === undefined ? '모름' : r.view.s.ev ? (r.view.s.ev.n ?? '') : 0) },
  { key: 'vsnapTs', group: 'veeam', label: 'Veeam 스냅샷 마지막 생성', head: (o) => `Veeam 스냅샷 마지막 생성 ${o.tz}`, avail: 'snap', needs: 'veeam', get: (r, o) => o.t(r.view?.s?.ev?.ts) },
  // v2.801 '여부' 두 칸 — 판정은 backupStatus.recentBackupYn·recentBackupSnapYn 하나(VM 전체 정보 카탈로그도 이 항목을 그대로 쓴다).
  //   N 은 화면에서 고른 기준 일수(o.ynDays — 1·2·3·7, 기본 1). Veeam 소스를 못 읽었으면(view 없음) '모름'.
  { key: 'vbkYn', group: 'veeam', label: '최근 N일 Veeam 백업 여부', head: (o) => `최근 ${o.ynDays}일 Veeam 백업`, avail: 'snap', needs: 'veeam', isNew: true,
    get: (r, o) => recentBackupYn(r.view, { linked: r.linked, days: o.ynDays, now: o.now }) },
  { key: 'vsnapYn', group: 'veeam', label: '최근 N일 백업용 스냅샷 생성 여부', head: (o) => `최근 ${o.ynDays}일 백업용 스냅샷 생성`, avail: 'snap', needs: 'veeam', isNew: true,
    get: (r, o) => recentBackupSnapYn(r.view, { days: o.ynDays, now: o.now }) },
]);
const BY_KEY = new Map(CATALOG.map((c) => [c.key, c]));
export const CATALOG_KEYS = Object.freeze(CATALOG.map((c) => c.key));

/** v2.792 열 순서 그대로의 key 목록 — cols 를 보내지 않은 요청(예전 화면·엑셀 기본)이 쓰는 '전체 열'. */
export const LEGACY_KEYS = Object.freeze(['vc', 'flv', 'folder', 'name', 'power', 'tmpl', 'cluster', 'host', 'os', 'cpu', 'mem', 'stor', 'ip',
  'vjudge', 'vstate', 'vpg', 'vjob', 'vrp', 'vlast', 'vres', 'vtmp', 'vtmpTs', 'vtmpStale', 'vsnapN', 'vsnapTs', 'snN', 'snSize', 'snNew', 'snNames']);

/** 빠른 조합(화면 버튼) — key 목록. */
export const PRESETS = Object.freeze([
  { id: 'base', name: '기본', keys: ['folder', 'name', 'power', 'host', 'ip', 'vjudge', 'vstate', 'vlast', 'vrp', 'snN'] },
  { id: 'backup', name: '백업 확인', keys: ['folder', 'name', 'power', 'vjudge', 'vstate', 'vlast', 'vres', 'snN', 'bmark'] },
  { id: 'snap', name: '스냅샷', keys: ['folder', 'name', 'power', 'snN', 'snSize', 'snOld', 'snNew', 'snNames', 'vtmp', 'vtmpTs', 'vtmpStale', 'vsnapN', 'vsnapTs'] },
  { id: 'mark', name: '백업 표시', keys: ['folder', 'name', 'power', 'bmark', 'notes', 'vjudge', 'vlast'] },
  { id: 'legacy', name: '예전 열 그대로', keys: [...LEGACY_KEYS] },
  { id: 'all', name: '전체', keys: CATALOG.map((c) => c.key) },
]);

/**
 * 요청의 cols 검증 — 배열 · 문자열 · 중복 없음 · 아는 key · 상한. 모르는 key 는 조용히 버리지 않고 거절한다(저장값·화면이 어긋난 것을 알린다).
 * @returns {{ok:true, keys:string[]} | {ok:false, reason:string}}
 */
export function resolveCols(cols) {
  if (cols == null) return { ok: true, keys: [...LEGACY_KEYS] };
  if (!Array.isArray(cols)) return { ok: false, reason: '열 목록 형식이 잘못됐습니다.' };
  if (!cols.length) return { ok: false, reason: '내보낼 항목을 하나 이상 고르세요.' };
  if (cols.length > MAX_COLS) return { ok: false, reason: `항목은 ${MAX_COLS}개까지입니다.` };
  const seen = new Set();
  for (const k of cols) {
    if (typeof k !== 'string' || !BY_KEY.has(k)) return { ok: false, reason: `모르는 항목입니다: ${String(k).slice(0, 40)}` };
    if (seen.has(k)) return { ok: false, reason: `같은 항목이 두 번 있습니다: ${k}` };
    seen.add(k);
  }
  return { ok: true, keys: [...cols] };
}
/** 저장값 정리용 — 모르는 key 를 빼고(사라진 항목) 남은 것과 뺀 수. */
export function knownKeys(cols) {
  const keys = (Array.isArray(cols) ? cols : []).filter((k) => typeof k === 'string' && BY_KEY.has(k));
  return { keys: [...new Set(keys)], dropped: (Array.isArray(cols) ? cols.length : 0) - [...new Set(keys)].length };
}
/** 고른 열이 읽는 추가 소스. */
export function needsOf(keys) {
  const s = new Set();
  for (const k of keys) { const n = BY_KEY.get(k)?.needs; if (n) s.add(n); }
  return s;
}

/** 시각 칸 도우미 묶음. */
export function timeCtx({ snapDays = 7, offsetMin = DAY_OFFSET_MIN, now = Date.now(), ynDays } = {}) {
  return { snapDays, offsetMin, now, ynDays: ynDaysOf(ynDays), tz: offsetLabel(offsetMin), t: (ms) => (fin(ms) && ms > 0 ? localStamp(ms, offsetMin) : '') };
}

/**
 * 고른 key → 실제 열 정의 [{ h, get(r), key, folderLevel? }].
 *  · flv → '폴더 1~N단계'(levels 개) · tagCols 면 tags → 카테고리마다 '태그: <카테고리>'(그 vCenter 의 카테고리 이름 순).
 */
export function selectedColumns(keys, { levels = 1, tagCols = false, tagCategories = [], ...tc } = {}) {
  const o = timeCtx(tc);
  const out = [];
  const lv = Math.max(1, Math.min(32, Number(levels) || 1));
  for (const k of keys) {
    const c = BY_KEY.get(k);
    if (!c) continue;
    if (k === 'flv') {
      for (let i = 0; i < lv; i++) out.push({ key: k, folderLevel: i + 1, h: `폴더 ${i + 1}단계`, get: (r) => folderParts(r.inv.folder)[i] || '' });
      continue;
    }
    if (k === 'tags' && tagCols) {
      const cats = [...new Set((tagCategories || []).map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
      if (!cats.length) { out.push({ key: k, h: c.label, get: (r) => tagsCell(r) }); continue; }
      for (const cat of cats) {
        out.push({ key: k, h: `태그: ${cat}`, get: (r) => (r.tg?.tags == null ? MISSING : join(r.tg.tags.filter((t) => t.category === cat).map((t) => t.tag))) });
      }
      continue;
    }
    out.push({ key: k, h: c.head ? c.head(o) : c.label, get: (r) => c.get(r, o) });
  }
  return out;
}

/** 화면용 카탈로그(웹은 목록을 복제하지 않는다). */
export function catalogView({ snapDays = 7 } = {}) {
  return {
    groups: GROUPS.map((g) => ({
      id: g.id, name: g.name, note: GROUP_NOTES[g.id] || '',
      items: CATALOG.filter((c) => c.group === g.id).map((c) => ({ key: c.key, label: c.key === 'vsnapN' ? `최근 ${snapDays}일 Veeam 스냅샷 생성 횟수` : c.label, avail: c.avail, ...(c.isNew ? { isNew: true } : {}) })),
    })),
    presets: PRESETS.map((p) => ({ id: p.id, name: p.name, keys: p.keys })),
    legacyKeys: LEGACY_KEYS, maxCols: MAX_COLS, missingText: MISSING, ynDays: [...YN_DAYS], ynDefault: YN_DEFAULT_DAYS,
  };
}
