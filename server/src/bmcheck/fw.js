/**
 * bmcheck/fw.js — 물리서버 **펌웨어 기준선 대조**의 판정 코어(v3.45 · 설계 docs/design/bm-feature-proposals ②). 순수 — 파일 · 네트워크 없음.
 *
 *  · 입력은 포탈이 이미 읽는 iDRAC 펌웨어 목록(`inv.firmware` — idrac/redfish.js fetchFirmwareInventory: { type, name, version }). 새 수집이 없다.
 *  · 구성요소 = (종류, 정규화한 이름). 같은 부품이 포트마다 다른 이름으로 나오는 부분은 **끝의 MAC/WWN 만** 걷어 낸다.
 *    숫자 토큰(슬롯 · 포트 번호)은 건드리지 않는다 — 첫 판본은 3자리 이하 숫자 토큰을 '#' 으로 바꿨는데 ‘HBA 330 / HBA 355’ · ‘10 Gb / 1 Gb’ 처럼
 *    **모델을 가르는 숫자**까지 지워 서로 다른 부품을 한 열쇠로 합쳤다(반증 A5 — 틀린 ‘뒤처짐’ · ‘섞임’). 못 묶는 쪽(‘기준 없음’)으로 기우는 것이 틀린 판정보다 낫다.
 *    디스크 · 전원 공급 장치(PSU)는 이름에 모델이 없어 같은 것끼리 묶을 수 없다(같은 서버 모델에 제조사 · 용량이 다른 PSU 가 들어간다) → 대조하지 않고 개수만 센다(`skipped`).
 *  · 기준 = ① 관리자가 그 모델에 지정한 버전(전 법인 공통 — 전체 범위 관리자가 정한다) ② 없으면 **같은 법인 · 같은 모델**의 다수 버전.
 *    다수를 법인 안에서만 내는 이유: 범위 계정의 응답에 다른 법인 서버의 버전이 섞이지 않게(가림 — 법인 밖 값으로 판정하지 않는다).
 *  · 줄 상태: same(같음) · behind(기준보다 낮음) · ahead(기준보다 높음) · differ(다른데 순서를 모름 — 숫자 . 꼴이 아닌 버전) ·
 *    none(기준 없음 — 판정 안 함) · mixed(한 서버 안에서 같은 부품의 버전이 갈림 — 판정 안 함).
 *  · 서버 상태: behind(뒤처진 줄 있음) > split(뒤처진 줄은 없지만 **버전이 갈려 다수가 없는 줄 · 섞인 줄**이 있다 — ‘뒤처진 것 없음’ 이라 하지 않는다: 반증 A2) > ok > none.
 *    ‘뒤처짐’ 은 기준과 다르다는 뜻이지 올려야 한다는 판정이 아니다(문구는 웹 checkText.js).
 *  · 못 읽은 것은 정상에도 뒤처짐에도 넣지 않는다: 서버 상태 unread(목록 없음) · unsent(엣지가 보내지 않음 — 구버전 엣지)를 따로 둔다.
 */
import { cmpVersion } from '../util/cmpVersion.js';
import { majorityOf } from '../util/majority.js';

/** 기준을 대조하는 종류(redfish.js classifyFw 의 값). 그 밖(PSU · Other · CPLD · 드라이버 팩 · 진단)은 대조하지 않는다. */
export const FW_TYPES = Object.freeze(['BIOS', 'iDRAC', 'NIC', 'Storage', 'HBA']);
export const FW_PER_SERVER_MAX = 40;   // 서버 한 대의 구성요소 상한(엣지 push 계약의 상한이기도 하다)
export const FW_LABEL_MAX = 96;
export const FW_VER_MAX = 48;
const NAME_SCAN_MAX = 200;             // 이름은 장비 · 엣지가 준 글자다 — 길이를 먼저 자르고 선형으로만 본다

const isHexByte = (s) => s.length === 2 && /^[0-9a-f]{2}$/i.test(s);
/** 'aa:bb:cc:dd:ee:ff'(MAC 6) · WWN 8 마디 — 구분자(: 또는 -) 있는 꼴, 또는 구분자 없는 16진 12 · 16자. */
function isHexAddr(s) {
  const x = String(s).trim();
  if (/^[0-9a-f]{12}$/i.test(x) || /^[0-9a-f]{16}$/i.test(x)) return true;
  const p = x.split(x.includes(':') ? ':' : '-');
  return (p.length === 6 || p.length === 8) && p.every(isHexByte);
}
const clean = (v, max) => {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  let s = String(v).slice(0, NAME_SCAN_MAX);
  let out = '';
  for (let i = 0; i < s.length; i += 1) { const c = s.charCodeAt(i); out += c < 32 || c === 127 ? ' ' : s[i]; }
  s = out.trim();
  return s.slice(0, max);
};

/**
 * 구성요소 이름 정규화 — 끝의 ' - <MAC/WWN>' 만 떼고 겹친 공백을 하나로. 숫자는 건드리지 않는다(모델을 가르는 숫자일 수 있다 — 머리 주석).
 *   'Intel(R) Ethernet 10G 2P X710 Adapter - 24:6E:96:00:11:22' → 'Intel(R) Ethernet 10G 2P X710 Adapter'
 *   'QLogic QLE2692 16Gb FC Adapter - 21000024FF7A1B2C' → 'QLogic QLE2692 16Gb FC Adapter'(주소가 이름에 남아 응답 · 엣지 push 에 실리지 않게)
 *   'Dell HBA 330 Adapter' · 'Backplane 1' · 'Power Supply.Slot.1' 은 그대로.
 */
export function fwLabelOf(name) {
  let s = clean(name, NAME_SCAN_MAX);
  if (!s) return '';
  const i = s.lastIndexOf(' - ');
  if (i > 0 && isHexAddr(s.slice(i + 3))) s = s.slice(0, i).trim();
  let out = '';
  for (let k = 0; k < s.length; k += 1) { const ch = s[k]; if (!(ch === ' ' && out.endsWith(' '))) out += ch; }
  return out.trim().slice(0, FW_LABEL_MAX);
}

/** 디스크 항목 — 이름에 모델이 없어 같은 것끼리 묶을 수 없다(classifyFw 는 이름의 'raid' · 'backplane' 때문에 Storage 로 분류한다). */
const DISK_RE = /^(disk|physical disk|solid state disk|ssd|pcie ssd|nvme) /i;
export const isDiskLabel = (label) => DISK_RE.test(String(label).slice(0, 40));

const verOf = (v) => clean(v, FW_VER_MAX);

/**
 * 서버 한 대의 펌웨어 목록 → 대조할 구성요소(순수).
 * @param {unknown} list inv.firmware
 * @returns {{ comps: {key:string,type:string,label:string,version:string|null,mixed:boolean}[], skipped:number } | null}
 *   목록이 배열이 아니거나 비었으면 null(= 못 읽음 — fetchFirmwareInventory 는 실패해도 [] 를 준다. '부품이 없다' 로 읽지 않는다).
 */
export function fwComponentsOf(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const m = new Map(); let skipped = 0;
  for (const f of list.slice(0, 400)) {
    if (!f || typeof f !== 'object') continue;
    const version = verOf(f.version);
    const label = fwLabelOf(f.name);
    if (!version || !label) continue;
    const type = FW_TYPES.includes(f.type) ? f.type : '';
    if (!type || isDiskLabel(label)) { skipped += 1; continue; }
    const key = `${type}|${label.toLowerCase()}`;
    let c = m.get(key);
    if (!c) { if (m.size >= FW_PER_SERVER_MAX) { skipped += 1; continue; } c = { key, type, label, versions: [] }; m.set(key, c); }
    if (!c.versions.some((x) => x.toLowerCase() === version.toLowerCase())) c.versions.push(version);
  }
  const comps = [...m.values()].map((c) => ({ key: c.key, type: c.type, label: c.label, version: c.versions.length === 1 ? c.versions[0] : null, mixed: c.versions.length > 1 }));
  return { comps, skipped };
}

const _compMemo = new WeakMap();   // 인벤토리 객체 → 구성요소(인벤토리는 다시 읽을 때 새 객체가 된다 — 주기마다 · 요청마다 같은 목록을 다시 훑지 않는다: 반증 A6 · A21)
/** 인벤토리 한 벌의 구성요소(메모). 인벤토리가 객체가 아니면 null. */
export function fwComponentsOfInv(inv) {
  if (!inv || typeof inv !== 'object') return null;
  let c = _compMemo.get(inv);
  if (c === undefined) { c = fwComponentsOf(inv.firmware); _compMemo.set(inv, c); }
  return c;
}
/** 엣지 push 에 싣는 꼴(작게) — [{ t, n, v }] · mixed 는 v '' + x:1. 인벤토리가 없거나 목록이 비면 undefined(키를 만들지 않는다). */
export function fwPushOf(inv) {
  const c = fwComponentsOfInv(inv);
  if (!c) return undefined;
  return { c: c.comps.map((x) => ({ t: x.type, n: x.label, v: x.version || '', ...(x.mixed ? { x: 1 } : {}) })), s: c.skipped };
}
/**
 * 저장본(central-fleet.json 재로드) · 메모리의 정제본을 **쓰기 직전에 다시 확인**한다 — 파일이 손으로 바뀌어 `comps:[null]` 같은 값이 들어와도
 *   판정이 던지지 않게(한 서버 때문에 목록 전체의 점검이 빠지고 상세가 500 이 됐다 — 반증 A14). 형식이 아니면 undefined(= 받지 못함).
 */
export function fwStoredOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.comps)) return undefined;
  let c = _compMemo.get(v);
  if (c !== undefined) return c || undefined;
  const comps = [];
  for (const x of v.comps.slice(0, FW_PER_SERVER_MAX)) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const type = typeof x.type === 'string' && FW_TYPES.includes(x.type) ? x.type : '';
    const label = typeof x.label === 'string' ? fwLabelOf(x.label) : '';
    if (!type || !label || isDiskLabel(label)) continue;
    const mixed = x.mixed === true;
    const version = mixed ? '' : (typeof x.version === 'string' ? verOf(x.version) : '');
    if (!mixed && !version) continue;
    comps.push({ key: `${type}|${label.toLowerCase()}`, type, label, version: mixed ? null : version, mixed });
  }
  c = comps.length ? { comps, skipped: typeof v.skipped === 'number' && Number.isFinite(v.skipped) && v.skipped >= 0 ? Math.min(400, Math.floor(v.skipped)) : 0 } : null;
  _compMemo.set(v, c);
  return c || undefined;
}

/**
 * 엣지가 보낸 펌웨어 요약 정제(중앙 — 아는 필드만 · 객체만 · 상한 · 글자만). 형식이 아니면 undefined(= 보내지 않음과 같다).
 *   이름은 다시 정규화한다(엣지가 정규화하지 않은 글자를 보내도 중앙의 묶음 열쇠가 같게).
 */
export function sanitizeFwPush(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.c)) return undefined;
  const m = new Map();
  for (const x of raw.c.slice(0, FW_PER_SERVER_MAX * 2)) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const type = typeof x.t === 'string' && FW_TYPES.includes(x.t) ? x.t : '';
    const label = typeof x.n === 'string' ? fwLabelOf(x.n) : '';
    if (!type || !label || isDiskLabel(label)) continue;
    const mixed = x.x === 1 || x.x === true;
    const version = mixed ? '' : (typeof x.v === 'string' ? verOf(x.v) : '');
    if (!mixed && !version) continue;
    const key = `${type}|${label.toLowerCase()}`;
    if (m.has(key) || m.size >= FW_PER_SERVER_MAX) continue;
    m.set(key, { key, type, label, version: mixed ? null : version, mixed });
  }
  if (!m.size) return undefined;
  const s = typeof raw.s === 'number' && Number.isFinite(raw.s) && raw.s >= 0 ? Math.min(400, Math.floor(raw.s)) : 0;
  return { comps: [...m.values()], skipped: s };
}

const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
/** 한 구성요소의 상태 — 설치 버전 vs 기준. */
export function fwRowState(installed, baseline, mixed = false) {
  if (mixed) return 'mixed';
  if (!baseline) return 'none';
  if (!installed) return 'none';
  if (lc(installed) === lc(baseline)) return 'same';
  const c = cmpVersion(installed, baseline);
  if (c == null) return 'differ';
  return c === 0 ? 'same' : c < 0 ? 'behind' : 'ahead';
}

/**
 * 함대 판정(순수).
 * @param {Array<{ id:string, corp:string, model:string, fw: {comps:object[],skipped:number}|null|undefined }>} servers
 *        fw: 객체 = 읽음 · null = 못 읽음(인벤토리는 있는데 목록 없음 · 인벤토리 없음) · undefined = 보내지 않음(엣지 구버전)
 * @param {{ admin?: (model:string, key:string) => string|'' }} opt  관리자 지정 기준(모델 · 구성요소 열쇠 → 버전)
 * @returns {Map<string, { state:'ok'|'behind'|'split'|'none'|'unread'|'unsent', rows:object[], behind:number, differ:number, ahead:number, judged:number, open:number, skipped:number, peers:number }>}
 *   behind 는 differ(다른데 순서를 모름)를 포함한다(점검 화면의 ‘기준과 다름’) · differ 는 그 안의 수
 *   peers = 같은 법인 · 같은 모델에서 펌웨어를 읽은 서버 수(이 서버 포함) · open = 갈림 · 섞임으로 판정하지 못한 줄 수
 */
export function judgeFirmware(servers, { admin = null } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  // 묶음 열쇠: 법인 id 는 글자 그대로(대소문자가 다른 id 는 다른 법인이다) · 모델은 소문자 · 구분자는 값에 들어올 수 없는 NUL(‘|’ 는 id · 모델 글자일 수 있다 — 반증 A13)
  const t = (v) => (typeof v === 'string' ? v.trim() : '');
  const groupOf = (s) => (t(s.corp) && lc(s.model) ? `${t(s.corp)}\u0000${lc(s.model)}` : '');
  // 1) 묶음(법인 · 모델) → 구성요소 열쇠 → 버전들
  const byGroup = new Map(); const groupN = new Map(); const orig = new Map();
  for (const s of list) {
    if (!s || !s.fw || !Array.isArray(s.fw.comps)) continue;
    const g = groupOf(s);
    if (!g) continue;
    groupN.set(g, (groupN.get(g) || 0) + 1);
    let m = byGroup.get(g);
    if (!m) { m = new Map(); byGroup.set(g, m); }
    for (const c of s.fw.comps) {
      if (!c || typeof c !== 'object' || typeof c.key !== 'string' || c.mixed || typeof c.version !== 'string' || !c.version) continue;
      const v = lc(c.version);
      const a = m.get(c.key); if (a) a.push(v); else m.set(c.key, [v]);
      const ok = `${g}\u0000${c.key}\u0000${v}`; if (!orig.has(ok)) orig.set(ok, c.version);   // 화면에는 처음 본 글자 그대로(대소문자)
    }
  }
  const majority = new Map();   // `${g}|${key}` → { value(lower), count, known }
  for (const [g, m] of byGroup) for (const [key, vers] of m) majority.set(`${g}\u0000${key}`, majorityOf(vers));
  // 2) 서버마다
  const out = new Map();
  for (const s of list) {
    if (!s) continue;
    if (s.fw === undefined) { out.set(s.id, { state: 'unsent', rows: [], behind: 0, ahead: 0, judged: 0, open: 0, skipped: 0, peers: 0 }); continue; }
    if (!s.fw || !Array.isArray(s.fw.comps)) { out.set(s.id, { state: 'unread', rows: [], behind: 0, ahead: 0, judged: 0, open: 0, skipped: 0, peers: 0 }); continue; }
    const g = groupOf(s);
    let behind = 0; let ahead = 0; let judged = 0; let open = 0; let differ = 0;
    const rows = s.fw.comps.filter((c) => c && typeof c === 'object' && typeof c.key === 'string').map((c) => {
      const adminVer = typeof admin === 'function' ? String(admin(s.model, c.key) || '') : '';
      const mj = g ? majority.get(`${g}\u0000${c.key}`) : null;
      // 다수 값은 소문자로 센다(대소문자만 다른 버전을 다른 값으로 세지 않게) — 화면에는 처음 본 글자 그대로
      const majorVer = mj?.value ? (orig.get(`${g}\u0000${c.key}\u0000${mj.value}`) || mj.value) : '';
      const baseline = adminVer || majorVer;
      const basis = adminVer ? 'admin' : majorVer ? 'majority' : null;
      const state = fwRowState(c.version, baseline, c.mixed);
      if (state === 'behind' || state === 'differ') behind += 1;
      if (state === 'differ') differ += 1;   // v3.49: behind 안의 ‘순서를 모름’ 수 — 건강 점수는 이것을 감점하지 않는다(반증 B8)
      if (state === 'ahead') ahead += 1;
      if (state !== 'none' && state !== 'mixed') judged += 1;
      // 판정하지 못했는데 ‘같다’ 고도 할 수 없는 줄 — 버전이 갈려 다수가 없다(tie) · 한 서버 안에서 섞였다(mixed)
      if (state === 'mixed' || (state === 'none' && mj && !mj.value && mj.tie)) open += 1;
      return { key: c.key, type: c.type, label: c.label, installed: c.version, mixed: !!c.mixed, baseline: baseline || null, basis, state,
        ...(basis === 'majority' ? { peers: mj.count, known: mj.known } : {}), ...(mj && !mj.value && mj.tie ? { tie: true } : {}) };
    });
    out.set(s.id, { state: behind ? 'behind' : open ? 'split' : judged ? 'ok' : 'none', rows, behind, differ, ahead, judged, open, skipped: Number(s.fw.skipped) || 0, peers: g ? groupN.get(g) || 0 : 0 });
  }
  return out;
}
