/**
 * diskbad/classify.js — iDRAC Lifecycle 로그 항목을 **배드 섹터 계열로 분류**하고 디스크 위치를 읽는다(순수, v3.8.0).
 *
 * 설계: `docs/design/idrac-disk-badsector/README.md` §4 · §12(근거) · §14(결정).
 *
 * 규칙(바꾸지 말 것):
 *  ① 분류는 메시지 **문장이 아니라 ID(MessageId 끝 토큰)** 로 한다 — 서버 세대마다 문구가 다르다.
 *  ② **근거 문서가 있는 ID 만** 표에 둔다(`ID_TABLE` 의 각 항목은 출처 URL · 확인 수준을 갖는다 — 테스트가 고정).
 *     문서를 못 찾은 ID(PDR56 · 디스크 삽입 ID 등)는 넣지 않는다. 표에 없는 PDR/VDR 은 'other' 로 **원문만 보관**한다
 *     (분류표가 바뀌면 다시 분류할 수 있게 — 원문을 버리지 않는다).
 *  ③ 판정은 중앙이 한다 — 엣지는 PDR/VDR 원문만 올린다(분류표를 고쳐도 엣지 업그레이드가 필요 없게. partfault 의 교훈).
 *  ④ 외부 입력(로그 문장)은 **길이를 먼저 자르고** 선형 정규식만 쓴다(루트 CLAUDE.md 정규식 규칙).
 */

/** 화면 · 메일 · 근거 화면이 같은 표를 쓴다(서버가 단일 소스로 내려준다). */
export const CLS = Object.freeze({
  unrecoverable: 'unrecoverable', // 복구 불가
  corrected: 'corrected',         // PDR54 — 미디어 오류를 복구 중에 고쳐 씀
  reassigned: 'reassigned',       // PDR59 — 불량 블록을 다른 블록으로 옮김
  remapTable: 'remapTable',       // PDR57 — 불량 블록 표가 차 감
  predictive: 'predictive',       // PDR16 — SMART 고장 예측(배드 섹터와 같은 뜻이 아니다 — 따로 센다)
  removed: 'removed',             // PDR5 — 디스크 그룹에서 빠짐(교체 판정 참고에만. 이것만으로 '교체' 라고 하지 않는다)
  vdisk: 'vdisk',                 // VDR — 가상 디스크 쪽 기록(물리 디스크를 가리키지 않는다 — 서버 단위 참고)
  other: 'other',                 // 표에 없는 PDR/VDR — 원문만 보관
});

/** 배드 섹터 기록으로 **세는** 분류(사용자 결정 2026-11-14: PDR54 · PDR59 · PDR57 포함). */
export const COUNTED = Object.freeze(new Set([CLS.unrecoverable, CLS.corrected, CLS.reassigned, CLS.remapTable]));

export const CLS_LABEL = Object.freeze({
  unrecoverable: '복구 불가', corrected: 'PDR54', reassigned: 'PDR59', remapTable: 'PDR57',
  predictive: '고장 예측', removed: '디스크 빠짐', vdisk: '가상 디스크 기록', other: '그 밖의 스토리지 기록',
});

const SRC = {
  vrtx: (page) => ({ title: `Dell PowerEdge VRTX 매뉴얼 ${page}쪽(사본)`, url: `https://www.manualsdir.com/manuals/620821/dell-poweredge-vrtx.html?page=${page}` }),
};

/**
 * ID → 분류 · 주석 · 출처 · 확인 수준. 확인 수준: 'dell'(Dell 문서) · 'community'(Dell 포럼 글).
 * 모두 **웹 검색 요약으로 확인**했고 원문 대조 · 실장비 대조는 하지 않았다(README §12 — 화면도 그렇게 말한다).
 */
export const ID_TABLE = Object.freeze({
  PDR46: { cls: CLS.unrecoverable, note: 'Patrol Read 가 고치지 못한 미디어 오류', action: '', level: 'dell', sources: [SRC.vrtx(450)] },
  PDR47: { cls: CLS.unrecoverable, note: '컨트롤러가 그 블록을 못 쓰는 곳으로 표시(puncture)', action: 'RAID puncture 복구 절차', level: 'dell',
    sources: [SRC.vrtx(451), { title: 'Dell KB 000139251 — Double Faults and Punctures in RAID Arrays', url: 'https://www.dell.com/support/kbdoc/el-gr/000139251/double-faults-and-punctures-in-raid-arrays' }] },
  PDR63: { cls: CLS.unrecoverable, note: '쓰기 중 불량 블록을 다른 블록으로 옮기지 못함', action: '디스크 교체', level: 'dell',
    sources: [{ title: 'Dell KB 000403212 — PDR63', url: 'https://www.dell.com/support/kbdoc/ar-bh/000403212/ppdma-dm5510-pdr63-a-bad-disk-block-on-arg1-cannot-be-reassigned-during-a-write-operation' }, SRC.vrtx(459)] },
  PDR64: { cls: CLS.unrecoverable, note: '리빌드 · 복구 중 고치지 못한 미디어 오류', action: '디스크 교체', level: 'dell',
    sources: [{ title: 'Dell KB 000218950 — Physical Disk Failure', url: 'https://www.dell.com/support/kbdoc/en-ca/000218950/gen5a-physical-disk-failure-eventid-52807' }] },
  PDR54: { cls: CLS.corrected, note: '미디어 오류를 복구 중에 고쳐 씀', action: '조치 없음(반복되면 교체 검토)', level: 'community',
    sources: [{ title: 'Dell 커뮤니티 — R720XD Correctable Disk Media Errors', url: 'https://www.dell.com/community/PowerEdge-HDD-SCSI-RAID/R720XD-Correctable-Disk-Media-Errors/td-p/5183008' }] },
  PDR59: { cls: CLS.reassigned, note: '불량 블록을 다른 블록으로 옮김(데이터 손실 없음)', action: '다른 이상 징후를 지켜봄', level: 'dell', sources: [SRC.vrtx(457)] },
  PDR57: { cls: CLS.remapTable, note: '불량 블록을 옮겨 적는 표가 차 감', action: '디스크 교체 · 백업에서 복원', level: 'dell', sources: [SRC.vrtx(456)] },
  PDR16: { cls: CLS.predictive, note: 'SMART 고장 예측(SSD 는 쓰기 수명 소진으로도 뜸)', action: '펌웨어 확인 뒤 교체', level: 'dell',
    sources: [{ title: 'Dell KB 000126418 — Predictive Drive Failure', url: 'https://www.dell.com/support/kbdoc/en-uk/000126418/poweredge-hdd-what-is-predicted-drive-failure-and-how-to-solve-it' },
      { title: 'Dell KB 000221846 — SSD SMART predictive failure', url: 'https://www.dell.com/support/kbdoc/000221846/sas-sata-ssd-smart-predictive-failure' }] },
  PDR5: { cls: CLS.removed, note: '디스크가 디스크 그룹에서 빠짐(케이블 · 인클로저 문제로도 뜸)', action: '다시 꽂거나 바꾼 뒤 다시 검색', level: 'dell',
    sources: [SRC.vrtx(429), { title: 'Dell KB 000481601 — Drives missing in iDRAC (PDR5)', url: 'https://www.dell.com/support/kbdoc/ru-lt/000481601/powerflex-drives-are-missing-in-idrac' }] },
  VDR57: { cls: CLS.vdisk, note: '가상 디스크 초기화 중 미디어 오류를 고치고 불량 블록을 옮김', action: '', level: 'dell', sources: [SRC.vrtx(888)] },
  VDR93: { cls: CLS.vdisk, note: '가상 디스크의 불량 블록 미디어 오류가 지워짐', action: '', level: 'dell', sources: [SRC.vrtx(888)] },
  VDR47: { cls: CLS.vdisk, note: '가상 디스크의 미디어 오류를 고침', action: '', level: 'community',
    sources: [{ title: 'Dell 커뮤니티 — R720XD Correctable Disk Media Errors', url: 'https://www.dell.com/community/PowerEdge-HDD-SCSI-RAID/R720XD-Correctable-Disk-Media-Errors/td-p/5183008' }] },
});

/** 엣지가 올리는 범위 — 물리 디스크(PDR) · 가상 디스크(VDR) 범주만. */
export const KEEP_PREFIXES = Object.freeze(['PDR', 'VDR']);

const CODE_RE = /^[A-Z]{2,5}\d{1,5}$/;
/**
 * MessageId 의 끝 토큰(Dell 은 `IDRAC.2.9.PDR46` 또는 `PDR46`). 못 읽으면 ''.
 * @param {string} messageId
 */
export function codeOf(messageId) {
  const s = String(messageId ?? '').slice(0, 96).trim().toUpperCase();
  if (!s) return '';
  const tail = s.slice(s.lastIndexOf('.') + 1);
  return CODE_RE.test(tail) ? tail : '';
}

/** 엣지에서 남길 항목인가(PDR/VDR). */
export function isStorageCode(code) {
  const c = String(code || '');
  return KEEP_PREFIXES.some((p) => c.startsWith(p));
}

/** 분류. 표에 없는 PDR/VDR 은 'other'. 저장소 계열이 아니면 null. */
export function classOf(code) {
  const c = String(code || '').toUpperCase();
  if (ID_TABLE[c]) return ID_TABLE[c].cls;
  return isStorageCode(c) ? CLS.other : null;
}

export const MESSAGE_MAX = 300;
const SCAN_MAX = 400;
const STOP_WORDS = [' was ', ' is ', ' has ', ' have ', ' reported', ' could ', ' cannot ', ' failed', ' on '];

/**
 * 로그 문장에서 디스크 위치를 읽는다. 못 읽으면 null(추측하지 않는다).
 * 읽는 모양(실장비 대조 전 — README §14.2):
 *   'Disk 5 in Backplane 1 of Integrated RAID Controller 1' · 'Solid State Disk 2 in Enclosure 0 of ...'
 *   'Physical Disk 0:1:5 Controller 0, Connector 0'(연결자:인클로저:슬롯)
 * @returns {null|{disk:number, bp:number|null, ctrl:string}}
 */
export function slotOf(message) {
  const s = String(message ?? '').slice(0, SCAN_MAX);
  if (!s) return null;
  let m = /\bDisk\s+(\d{1,3})\s+in\s+(?:Backplane|Enclosure)\s+(\d{1,3})/i.exec(s);
  if (m) {
    const disk = Number(m[1]); const bp = Number(m[2]);
    let ctrl = '';
    const rest = s.slice(m.index + m[0].length, m.index + m[0].length + 120);
    const of = /^\s+of\s+/i.exec(rest);
    if (of) {
      let c = rest.slice(of[0].length);
      let cut = c.length;
      for (const w of STOP_WORDS) { const i = c.toLowerCase().indexOf(w); if (i >= 0 && i < cut) cut = i; }
      for (const ch of ['.', ',', ';', '(']) { const i = c.indexOf(ch); if (i >= 0 && i < cut) cut = i; }
      ctrl = c.slice(0, Math.min(cut, 80)).trim();
    }
    return { disk, bp, ctrl };
  }
  m = /\bPhysical\s+Disk\s+(\d{1,2}):(\d{1,3}):(\d{1,3})/i.exec(s);
  if (m) return { disk: Number(m[3]), bp: Number(m[2]), ctrl: '' };
  return null;
}

/** 위치 → 비교 키(컨트롤러 이름은 표시에만 — 세대마다 표기가 달라 키에 넣지 않는다). */
export function slotKeyOf(slot) {
  if (!slot || !Number.isInteger(slot.disk)) return '';
  return `${Number.isInteger(slot.bp) ? `bp${slot.bp}` : 'bp?'}:d${slot.disk}`;
}

export function slotLabel(slot) {
  if (!slot) return '위치 모름';
  return [`Disk ${slot.disk}`, Number.isInteger(slot.bp) ? `Backplane ${slot.bp}` : '', slot.ctrl || ''].filter(Boolean).join(' · ');
}

/** 키 → 표시용(컨트롤러 없이). */
export function labelOfKey(key) {
  const m = /^bp(\d+|\?):d(\d+)$/.exec(String(key || ''));
  if (!m) return '위치 모름';
  return m[1] === '?' ? `Disk ${m[2]}` : `Disk ${m[2]} · Backplane ${m[1]}`;
}

/**
 * 인벤토리 디스크(Redfish Drive)의 위치. Id(`Disk.Bay.5:Enclosure.Internal.0-1:RAID.Integrated.1-1`) → 이름(`Physical Disk 0:1:5`) 순.
 * @returns {null|{disk:number, bp:number|null}}
 */
export function driveSlotOf(drive) {
  const id = String(drive?.id ?? '').slice(0, 200);
  let m = /Disk\.Bay\.(\d{1,3})/i.exec(id);
  if (m) {
    const bp = /Enclosure\.[A-Za-z]+\.\d{1,3}-(\d{1,3})/i.exec(id);
    return { disk: Number(m[1]), bp: bp ? Number(bp[1]) : null };
  }
  const name = String(drive?.name ?? '').slice(0, 200);
  m = /(\d{1,2}):(\d{1,3}):(\d{1,3})/.exec(name);
  if (m) return { disk: Number(m[3]), bp: Number(m[2]) };
  m = /\bDisk\s+(\d{1,3})\s+in\s+(?:Backplane|Enclosure)\s+(\d{1,3})/i.exec(name);
  if (m) return { disk: Number(m[1]), bp: Number(m[2]) };
  return null;
}

/**
 * 로그 위치 키에 맞는 지금 디스크. 디스크 번호가 같고, 둘 다 백플레인을 알면 그것도 같아야 한다.
 * **후보가 둘 이상이면 고르지 않는다**(추측 금지 — null).
 */
export function matchDrive(slotKey, drives) {
  const m = /^bp(\d+|\?):d(\d+)$/.exec(String(slotKey || ''));
  if (!m) return null;
  const disk = Number(m[2]); const bp = m[1] === '?' ? null : Number(m[1]);
  const cands = (Array.isArray(drives) ? drives : []).filter((d) => {
    const s = driveSlotOf(d);
    if (!s || s.disk !== disk) return false;
    return bp == null || s.bp == null || s.bp === bp;
  });
  return cands.length === 1 ? cands[0] : null;
}

/** 근거 화면 · API 가 내려주는 분류표(정적). */
export function refsTable() {
  return Object.entries(ID_TABLE).map(([id, v]) => ({
    id, cls: v.cls, clsLabel: CLS_LABEL[v.cls], counted: COUNTED.has(v.cls), note: v.note, action: v.action, level: v.level, sources: v.sources,
  }));
}

/**
 * 로그인 · 로그아웃 계열 기록 ID(v3.8.2 — 읽기 진단용. 판정에 쓰지 않는다).
 * USR0030 은 Dell 커뮤니티 글 제목('USR0030 Successfully logged in using … and REDFISH')으로, USR0036(묶인 로그인 기록)은
 * iDRAC9 사용자 안내서 검색 요약으로 확인했다. USR0031 · USR0032(로그인 실패 · 로그아웃)는 기억 기준이고 문서 대조 전이다 —
 * 그래서 화면은 비율과 함께 **상위 기록 ID 를 그대로** 보여 준다(이 목록이 틀려도 사용자가 구성을 직접 본다).
 */
export const LOGIN_CODES = Object.freeze(['USR0030', 'USR0031', 'USR0032', 'USR0036']);

/**
 * 읽은 항목 가운데 로그인 계열의 비율(0~1). 상위 목록에 든 것만 세므로 **하한**이다. 읽은 건수를 모르면 null.
 * @param {{read?:number|null, top?:Array<{code:string,n:number}>}|null} diag
 */
export function loginShareOf(diag) {
  const read = Number(diag?.read);
  if (!diag || !Number.isFinite(read) || read <= 0 || !Array.isArray(diag.top)) return null;
  let n = 0;
  for (const x of diag.top) if (x && LOGIN_CODES.includes(String(x.code)) && Number.isFinite(x.n)) n += x.n;
  return Math.min(1, n / read);
}

