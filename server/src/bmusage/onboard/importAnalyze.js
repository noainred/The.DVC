/**
 * bmusage/onboard/importAnalyze.js — 서버 등록 행 판정(순수 · 7b단계 · 설계 PROFILES §18 '검증 — 적용 전 전부 표시').
 *
 * 판정(행마다 하나): new(신규) · update(갱신) · unchanged(변화 없음) · reject(거부) — 경고(warnings)는 신규 · 갱신에 붙고 적용은 된다.
 * 검증 규칙은 **저장 규칙 그대로**(복제 금지): OS = `bmstor/registry.js bmServerInputIssue`(주소 형식 · SSRF · 계정 글자 · 마운트 sanitizeMounts) ·
 * iDRAC = `idrac/registry.js idracInputIssue`(normalize — SSRF 포함) · 용도/역할 = 프로파일 · 튜닝 카탈로그 목록. 호출부가 주입한다.
 *
 * 보안(§19):
 *  · 비밀 원문 · 키 내용이 있는 행은 거부(비밀 칸 이름 · 칸 내용 판정 `keyParse.cellLooksSecret`). **자격 칸(os_cred · idrac_cred · os_key)의 값은
 *    판정 결과에 되싣지 않는다**(잘못 넣은 비밀번호가 결과 CSV · 화면으로 다시 나가지 않게) — 맞은 공통 계정 · 키 이름만 싣는다.
 *  · 범위 계정: 법인이 조회 범위 밖이면 '없는 법인' 과 같은 문구(corp-not-found — 404 꼴, 존재 은닉) · 조회는 되는데 쓰기 밖이면 corp-forbidden(403 꼴).
 *    바꾸려는 기존 항목의 법인이 쓰기 범위 밖이거나 귀속이 없으면(예전 항목) 그 행 거부.
 *  · 수집 경로: 엣지 노드에서는 자기 법인 · edge/auto 만(central 행 거부) · 중앙에서 edge 는 그 법인 엣지가 있어야 · auto 는 그 법인 엣지가
 *    **지금 접속 중일 때만** edge, 엣지가 없으면 central, **엣지가 있는데 접속을 모르거나 끊겼으면 판정 보류(거부)** — 엣지가 사라졌다고 central 로 정하지 않는다.
 *  · 못 읽은 값(XLSX 수식 결과 없음 · 오류 값 · 병합)은 빈 값으로 보지 않고 그 행을 거부한다.
 */
import crypto from 'node:crypto';
import { cellLooksSecret } from './keyParse.js';
import { NAME_RE } from './keyStore.js';
import { addrKey, bindDecision, bindOfWrite } from './bindRule.js';

const t = (v) => String(v ?? '').trim();
const lc = (v) => t(v).toLowerCase();
const INDIVIDUAL = new Set(['개별', 'individual']);
const VIA = ['edge', 'central', 'auto'];
const CLASSES = ['baremetal', 'virtualization', 'exclude'];
const TRUE = ['true', '1', 'y', 'yes', 'on', '켬', '사용', 'o'];
const FALSE = ['false', '0', 'n', 'no', 'off', '끔', '미사용', 'x', '비활성'];
/** 비밀 판정에서 빼는 칸(주소 · 포트 · 열거 값) — 오탐이 생기지 않는 칸. 나머지 칸은 전부 본다. */
const SECRET_SCAN_SKIP = new Set(['os_port', 'enabled', 'collect_via', 'class']);

export const ROW_CODE = Object.freeze({
  'secret-col': '비밀 칸에 값이 있습니다 — 파일에 비밀을 넣지 않습니다(공통 계정 · SSH 키 화면에서 한 번만 입력).',
  'secret-cell': '비밀 원문 · 키 내용으로 보이는 값이 있습니다 — 그 칸은 이름만 적습니다.',
  merged: '병합 셀이 걸친 행입니다 — 어느 행의 값인지 모호해 받지 않습니다(병합을 풀고 값마다 적으세요).',
  'no-result': '수식의 계산 결과가 저장돼 있지 않은 칸이 있습니다 — 엑셀에서 열어 저장하거나 값으로 붙여 넣으세요.',
  'cell-error': '오류 값(#N/A 등) 칸이 있습니다.',
  'too-long': '칸 글자 수가 너무 깁니다(1,024자).',
  'no-name': 'name 이 비어 있습니다.',
  'no-corp': 'corp 가 비어 있습니다(모르면 ‘미귀속’).',
  'corp-not-found': '법인을 찾을 수 없습니다.',
  'corp-forbidden': '이 법인에 쓰기 권한이 없습니다(조회 전용).',
  'unassigned-scoped': '법인을 찾을 수 없습니다.',
  'no-path': 'idrac_host 와 os_host 가 모두 비어 있습니다.',
  'bad-via': 'collect_via 는 edge · central · auto 중 하나입니다.',
  'via-central-on-edge': '엣지 포탈에서는 central 행을 받지 않습니다 — 중앙 포탈에서 등록하세요.',
  'corp-not-edge': '이 엣지가 수집하는 법인이 아닙니다.',
  'no-edge': '이 법인의 엣지를 찾을 수 없습니다 — central 로 등록하거나 엣지를 먼저 연결하세요.',
  'auto-unknown': 'auto 판정 보류 — 이 법인의 엣지가 지금 접속 중인지 모릅니다(끊겼거나 중앙 재시작 직후). edge 또는 central 을 직접 적으세요.',
  'idrac-cred-missing': 'iDRAC 공통 계정을 찾을 수 없습니다(값은 표시하지 않습니다).',
  'idrac-cred-required': '새 iDRAC 등록에는 idrac_cred(iDRAC 공통 계정 이름)가 필요합니다 — 개별 계정은 iDRAC 화면에서 등록하세요.',
  'bind-owner-only': '공통 계정 · SSH 키를 새 주소에 묶는(또는 바꾸는) 행은 설정 소유자(전체 범위) + 본인 OTP 로만 적용합니다 — 개별 계정(개별:계정명)으로 올리거나 소유자에게 맡기세요.',
  'class-full-scope': 'class(통합 서버 인벤토리 분류)는 전 법인 설정이라 전체 범위 계정만 바꿀 수 있습니다.',
  'purpose-forbidden': '이 service_tag 가 가리키는 서버의 법인에 쓰기 권한이 없어 용도 · 역할을 바꿀 수 없습니다(조회 전용).',
  'edge-to-central': '엣지 배포 목록에 있는 서버입니다 — 엣지 → 중앙 이동은 배포 목록에서 먼저 뺀 뒤(엣지가 반영한 뒤) central 로 다시 올리세요(두 곳이 같은 서버를 여는 구간을 만들지 않게).',
  'bad-mounts': '마운트 경로가 올바르지 않습니다.',
  'os-cred-missing': 'OS 공통 계정을 찾을 수 없습니다(값은 표시하지 않습니다).',
  'cred-other-corp': '다른 법인의 공통 계정입니다.',
  'os-cred-empty': 'os_cred 가 비어 있습니다(공통 계정 이름 또는 ‘개별:계정명’).',
  'key-missing': 'SSH 키 이름이 키 저장소에 없습니다(값은 표시하지 않습니다).',
  'key-retired': '회전으로 퇴역한 SSH 키입니다 — 새 키 이름을 적으세요.',
  'password-no-secret': 'os_key 가 password 인데 공통 계정에 비밀번호가 없습니다.',
  'dup-name': '같은 name 이 파일 안에 이미 있습니다.',
  'dup-tag': '같은 service_tag 가 파일 안에 이미 있습니다.',
  'dup-idrac': '같은 idrac_host 가 파일 안에 이미 있습니다.',
  'dup-os': '같은 os_host:os_port 가 파일 안에 이미 있습니다.',
  'existing-conflict': '기존 등록과 엇갈립니다(이름 · 서비스 태그 · 주소가 서로 다른 서버를 가리킵니다).',
  'existing-forbidden': '바꾸려는 기존 항목의 법인에 쓰기 권한이 없습니다.',
  'existing-unassigned': '법인 귀속이 없는 기존 항목은 전체 범위 계정만 바꿀 수 있습니다.',
  'bad-class': 'class 는 baremetal · virtualization · exclude 중 하나입니다(비우면 자동).',
  'bad-purpose': 'purposes 에 모르는 기능이 있습니다.',
  'bad-role': 'role 은 정해진 역할 중 하나입니다.',
  'bad-enabled': 'enabled 는 true/false(켬/끔)입니다.',
  'bad-note': 'note 는 500자까지입니다.',
  'bad-switch': 'switch_port 는 ‘NIC=스위치:포트’ 를 ; 로 구분합니다.',
});

/** 행 경고 문구. */
export const WARN = Object.freeze({
  'via-default': 'collect_via 가 비어 auto 로 봅니다.',
  'unassigned': '미귀속 — 법인 귀속이 없어 기본 수집에서 빠집니다.',
  'mounts-default': 'mounts 가 비어 / 만 측정합니다.',
  'idrac-no-cred': 'iDRAC 계정이 없습니다 — 등록 뒤 개별 입력해야 iDRAC 경로가 열립니다.',
  'os-no-auth': 'OS 인증 수단이 없습니다 — 키를 고르거나 비밀번호를 입력해야 수집됩니다.',
  'os-password-later': '비밀번호 인증 — 비밀번호는 서버 설정에서 입력합니다(파일에 넣지 않음).',
  'address-moved': '주소가 바뀌어 저장된 비밀번호 · 키 참조를 잇지 않습니다(이 행이 고른 키 · 계정만 씁니다).',
  'via-moved': '수집 경로가 바뀝니다 — 이력은 합치지 않고 바뀐 시각을 남깁니다.',
  'purpose-no-tag': 'service_tag 가 없어 class · purposes · role 은 적용하지 않습니다(수집 뒤 상세 화면에서).',
  'switch-later': 'switch_port 는 형식만 확인했습니다 — 포트 매핑은 수집 뒤 서버 상세에서 합니다.',
  'rtt-high': '중앙 직접 수집인데 이 법인 RTT 가 800ms 이상입니다 — 엣지 수집을 권합니다.',
  'rtt-unknown': '이 법인 RTT 를 모릅니다(핑 값 없음).',
  'edge-deploy': '엣지 배포 목록으로 갑니다 — 엣지가 다음 인출에서 자기 키 · 공통 계정 이름으로 등록합니다.',
  'os-only-untracked': '이 노드 함대(iDRAC · vCenter)에 없는 서버입니다 — OS 계정 등록부에는 들어가지만 리눅스 성능 수집 대상이 아닙니다(디스크 용량만 수집).',
  'purpose-common-tag': '이 service_tag 는 공통 값이라(같은 태그의 서버가 여럿 · 둘 이상 법인 · 화이트박스 기본값) 어느 서버 것인지 정할 수 없어 용도 · 역할은 적용하지 않습니다(수집 뒤 서버 상세 화면에서 서버마다 지정).',
  'purpose-unresolved': '이 service_tag 가 지금 수집 대상 서버로 해석되지 않아 용도 · 역할은 적용하지 않습니다(수집 뒤 서버 상세에서).',
  'rtt-stale': '이 법인 RTT 값이 오래됐습니다(핑 값이 30분보다 오래됨) — 지금 RTT 를 모릅니다.',
  'needs-owner': '공통 계정 · SSH 키를 이 주소에 묶습니다 — 적용 때 본인 OTP 를 묻습니다(설정 소유자).',
  'edge-names': '공통 계정 · 키 이름은 엣지가 자기 저장소에서 찾습니다(중앙은 이름 꼴만 확인 — 키는 법인 밖으로 나가지 않음).',
  'idrac-cred-kept': 'idrac_cred 가 비어 기존 iDRAC 계정을 그대로 둡니다.',
  'os-cred-kept': 'os_cred 가 비어 기존 OS 계정을 그대로 둡니다.',
});

const boolOf = (v) => { const s = lc(v); if (!s) return null; if (TRUE.includes(s)) return true; if (FALSE.includes(s)) return false; return undefined; };
const listOf = (v) => t(v).split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
/** 끝 '/' 들을 선형으로 뗀다(감사 L-10 — 앵커 끝 무제한 반복 정규식 금지). */
const trimSlashes = (x) => { let e = x.length; while (e > 0 && x.charCodeAt(e - 1) === 47) e -= 1; return x.slice(0, e); };
const hostKeyOf = (h) => trimSlashes(lc(h).slice(0, 300).replace(/^[a-z][a-z0-9+.-]*:\/\//, '')).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

/**
 * @param {object[]} rows  parseOnboardFile 의 rows
 * @param {object} ctx
 * @param {{id:string,name:string,dc?:string}[]} ctx.corps  알려진 법인(vCenter)
 * @param {(vc:string)=>boolean} ctx.canView   조회 범위(전체 범위면 늘 true)
 * @param {(vc:string)=>boolean} ctx.canWrite  쓰기 범위
 * @param {boolean} ctx.fullScope  전체 범위 계정인가(미귀속 · 귀속 없는 기존 항목)
 * @param {boolean} ctx.isEdge   @param {string[]} [ctx.myCorps] 엣지 노드의 자기 법인
 * @param {(vc:string)=>({agent:string, online:(boolean|null)}|null)} ctx.edgeOf  중앙: 법인의 엣지(없으면 null)
 * @param {(vc:string)=>({rttMs:number|null}|null)} [ctx.rttOf]
 * @param {object[]} ctx.idracRegistry  iDRAC 등록부 원본(비밀은 보지 않는다 — 존재 · 대조만)
 * @param {object[]} ctx.osRegistry     OS 등록부 원본
 * @param {object[]} [ctx.edgeRows]     중앙 엣지 배포 목록의 현재 행(경로 변경 판정)
 * @param {(kind:'os'|'idrac', name:string)=>object|null} ctx.accountByName
 * @param {(name:string)=>object|null} ctx.keyByName
 * @param {(body:object)=>string|null} ctx.osIssue    bmServerInputIssue
 * @param {(body:object, existing:object|null)=>{issue:string|null, host:string}} ctx.idracIssue  idracInputIssue
 * @param {(m:any)=>{mounts:string[], errors:string[]}} ctx.sanitizeMounts
 * @param {string[]} ctx.knownApps  @param {string[]} ctx.knownRoles
 */
export function analyzeOnboardRows(rows = [], ctx = {}) {
  const corps = Array.isArray(ctx.corps) ? ctx.corps : [];
  const byCorpKey = new Map();
  for (const c of corps) {
    for (const k of [c.id, c.name]) { const x = lc(k); if (x && !byCorpKey.has(x)) byCorpKey.set(x, c.id); }
  }
  const dcCount = new Map();
  for (const c of corps) { const d = lc(c.dc); if (d) dcCount.set(d, [...(dcCount.get(d) || []), c.id]); }
  const resolveCorp = (v) => {
    const k = lc(v);
    if (!k) return null;
    if (byCorpKey.has(k)) return byCorpKey.get(k);
    const dc = dcCount.get(k);
    return dc && dc.length === 1 ? dc[0] : null;
  };
  const canView = typeof ctx.canView === 'function' ? ctx.canView : () => true;
  const canWrite = typeof ctx.canWrite === 'function' ? ctx.canWrite : () => true;
  const idr = Array.isArray(ctx.idracRegistry) ? ctx.idracRegistry : [];
  const osr = Array.isArray(ctx.osRegistry) ? ctx.osRegistry : [];
  const idrByTag = new Map(); const idrByHost = new Map(); const idrByName = new Map();
  for (const e of idr) {
    if (t(e.serviceTag)) idrByTag.set(lc(e.serviceTag), e);
    if (t(e.host)) idrByHost.set(hostKeyOf(e.host), e);
    if (t(e.name)) idrByName.set(lc(e.name), e);
  }
  const osByHost = new Map(); const osByName = new Map();
  for (const e of osr) {
    if (t(e.host)) osByHost.set(`${hostKeyOf(e.host)}:${Number(e.port) || 22}`, e);
    if (t(e.name)) osByName.set(lc(e.name), e);
  }
  const edgeRowByName = new Map((Array.isArray(ctx.edgeRows) ? ctx.edgeRows : []).map((r) => [lc(r.name), r]));
  const seen = { name: new Map(), tag: new Map(), idrac: new Map(), os: new Map() };
  const out = [];
  const summary = { total: rows.length, new: 0, update: 0, unchanged: 0, reject: 0, warn: 0, edge: 0, central: 0, needOwner: 0 };
  // 범위 계정이 볼 수 없는 기존 항목(조회 밖 법인 · 귀속 없음)은 **없는 것과 같은 꼴**로 판정한다(감사 L-1 · 반증 F18 — 존재 오라클 차단).
  //   대신 그 행은 적용 단계에서 막는다(plan.hidden). 전체 범위 계정은 늘 보인다.
  const hiddenEx = (vcOf) => !ctx.fullScope && (!vcOf || !canView(vcOf));
  const pendingByName = new Map((Array.isArray(ctx.edgePending) ? ctx.edgePending : []).map((r) => [lc(r.name), r]));
  const idrById = new Map(idr.map((e) => [t(e.id), e]));
  const nameOfAcc = typeof ctx.accountNameById === 'function' ? ctx.accountNameById : () => '';
  const nameOfKey = typeof ctx.keyNameById === 'function' ? ctx.keyNameById : () => '';
  const idrCopyName = typeof ctx.idracCopyName === 'function' ? ctx.idracCopyName : () => '';   // 그 iDRAC 항목에 비밀번호 사본을 둔 공통 계정 이름

  for (const row of rows) {
    const c = row.cells || {};
    const f = row.flags || {};
    const res = { line: row.line, name: t(c.name).slice(0, 128), corp: '', corpName: '', via: '', agent: '', action: 'reject', code: '', reason: '', warnings: [], changes: [], idrac: 'none', os: 'none', key: '', cred: '' };
    const reject = (code, extra = '') => { res.action = 'reject'; res.code = code; res.reason = `${ROW_CODE[code] || code}${extra ? ` ${extra}` : ''}`; };
    const warn = (code, extra = '') => res.warnings.push({ code, text: `${WARN[code] || code}${extra ? ` ${extra}` : ''}` });
    out.push(res);
    const done = () => { summary[res.action] += 1; if (res.action !== 'reject' && res.warnings.length) summary.warn += 1; };

    // ① 못 읽은 칸 · 비밀
    if (f.secretCols?.length) { reject('secret-col', `(${f.secretCols.join(', ')})`); done(); continue; }
    const secretCol = Object.keys(c).find((k) => !SECRET_SCAN_SKIP.has(k) && cellLooksSecret(c[k]));
    if (secretCol) { reject('secret-cell', `(${secretCol})`); if (secretCol === 'name') res.name = ''; done(); continue; }
    if (f.merged) { reject('merged'); done(); continue; }
    if (f.noResult?.length) { reject('no-result', `(${f.noResult.join(', ')})`); done(); continue; }
    if (f.cellError?.length) { reject('cell-error', `(${f.cellError.join(', ')})`); done(); continue; }
    if (f.tooLong?.length) { reject('too-long', `(${f.tooLong.join(', ')})`); done(); continue; }
    // ② 필수 · 법인 · 범위
    const name = t(c.name);
    if (!name) { reject('no-name'); done(); continue; }
    if (!t(c.corp)) { reject('no-corp'); done(); continue; }
    const unassigned = ['미귀속', 'unassigned', '-'].includes(lc(c.corp));
    let vc = '';
    if (unassigned) {
      if (!ctx.fullScope) { reject('unassigned-scoped'); done(); continue; }
      warn('unassigned');
    } else {
      vc = resolveCorp(c.corp);
      if (!vc || !canView(vc)) { reject('corp-not-found'); done(); continue; }   // 조회 밖 = 없는 법인과 같은 문구(존재 은닉)
      if (!canWrite(vc)) { reject('corp-forbidden'); done(); continue; }
      res.corp = vc; res.corpName = (corps.find((x) => x.id === vc)?.name) || vc;
    }
    const idracHost = t(c.idrac_host); const osHost = t(c.os_host);
    if (!idracHost && !osHost) { reject('no-path'); done(); continue; }
    // ③ 파일 안 중복(먼저 나온 행이 이긴다 — 뒤 행 거부)
    const tag = t(c.service_tag);
    const dupOf = (map, k, code) => { if (!k) return false; const prev = map.get(k); if (prev) { reject(code, `(${prev}행)`); return true; } map.set(k, row.line); return false; };
    const osPort = t(c.os_port) ? Number(c.os_port) : 22;
    if (dupOf(seen.name, lc(name), 'dup-name') || dupOf(seen.tag, lc(tag), 'dup-tag') || dupOf(seen.idrac, idracHost ? hostKeyOf(idracHost) : '', 'dup-idrac')
      || dupOf(seen.os, osHost ? `${hostKeyOf(osHost)}:${osPort}` : '', 'dup-os')) { done(); continue; }
    // ④ 수집 경로
    let via = lc(c.collect_via);
    if (!via) { via = 'auto'; warn('via-default'); }
    if (!VIA.includes(via)) { reject('bad-via'); done(); continue; }
    let where = 'local'; let agent = '';
    if (ctx.isEdge) {
      if (via === 'central') { reject('via-central-on-edge'); done(); continue; }
      // 반증 F9: 자기 법인 목록이 비면 '모름' — 법인이 있는 행은 거부(검사를 끄지 않는다).
      if (vc && (!Array.isArray(ctx.myCorps) || !ctx.myCorps.includes(vc))) { reject('corp-not-edge'); done(); continue; }
      res.via = 'edge';
    } else {
      const edge = vc && typeof ctx.edgeOf === 'function' ? ctx.edgeOf(vc) : null;
      if (via === 'edge') { if (!edge) { reject('no-edge'); done(); continue; } where = 'edge'; agent = edge.agent; }
      else if (via === 'auto') {
        if (!edge) where = 'local';
        else if (edge.online === true) { where = 'edge'; agent = edge.agent; }
        else { reject('auto-unknown'); done(); continue; }
      }
      res.via = where === 'edge' ? 'edge' : 'central';
      if (where === 'local' && vc && typeof ctx.rttOf === 'function') {
        const r = ctx.rttOf(vc);
        if (r && r.fresh === false) warn('rtt-stale');   // 감사 Q3: 오래된 핑 값으로 경고 · 무경고를 가르지 않는다
        else if (r && Number.isFinite(r.rttMs) && r.rttMs >= 800) warn('rtt-high', `(${r.rttMs}ms)`);
        else if (!r || !Number.isFinite(r?.rttMs)) warn('rtt-unknown');
      }
    }
    res.agent = agent;
    // ⑤ 기존 항목 대조(서로 다른 서버를 가리키면 거부). 보이지 않는 항목(범위 밖)은 대조에서 빼고 hidden 으로 적용 단계에서 막는다.
    //   반증 F16: iDRAC 은 **id 충돌**도 기존 항목이다(새 행 id = service_tag 또는 name — 그 값이 남의 항목 id 면 merge 가 덮어쓴다).
    let hidden = false;
    const vis = (e) => { if (!e) return null; if (hiddenEx(t(e.vcenterId))) { hidden = true; return null; } return e; };
    const idrCands = [tag && idrByTag.get(lc(tag)), idracHost && idrByHost.get(hostKeyOf(idracHost)), idrByName.get(lc(name)), idracHost && idrById.get(tag || name)].map(vis).filter(Boolean);
    if (idrCands.some((e) => e.id !== idrCands[0].id)) { reject('existing-conflict', '(iDRAC 등록부)'); done(); continue; }
    const exIdr = idrCands[0] || null;
    const osCands = [osHost && osByHost.get(`${hostKeyOf(osHost)}:${osPort}`), osByName.get(lc(name))].map(vis).filter(Boolean);
    if (osCands.some((e) => e.id !== osCands[0].id)) { reject('existing-conflict', '(OS 계정 등록부)'); done(); continue; }
    const exOs = osCands[0] || null;
    // 반증 F17 · 감사 L-2: 엣지 배포 행도 범위 대조(행의 법인) · F14: 배포에서 뺐지만 엣지가 아직 반영하지 않은 행(제거 대기)도 같은 이름이면 겹친다.
    const exEdge0 = edgeRowByName.get(lc(name)) || null;
    const exEdge = exEdge0 && hiddenEx(t(exEdge0.corp)) ? ((hidden = true), null) : exEdge0;
    const pend0 = pendingByName.get(lc(name)) || null;
    const pend = pend0 && hiddenEx(t(pend0.corp)) ? ((hidden = true), null) : pend0;
    for (const ex of [exIdr, exOs, exEdge && { vcenterId: exEdge.corp }]) {
      if (!ex) continue;
      const exVc = t(ex.vcenterId);
      if (!exVc) { if (!ctx.fullScope) { reject('existing-unassigned'); break; } }
      else if (!canWrite(exVc)) { reject('existing-forbidden'); break; }
    }
    if (res.code) { done(); continue; }
    // 반증 F8 · 감사 M-3: 엣지 적용은 '이 배포가 만든 항목' 또는 자기 법인 귀속 항목만 갱신한다(엣지 관리자가 손으로 둔 항목은 이름이 같아도 건드리지 않는다).
    if (typeof ctx.canUpdateExisting === 'function' && ((exIdr && !ctx.canUpdateExisting(exIdr, 'idrac')) || (exOs && !ctx.canUpdateExisting(exOs, 'os')))) { reject('existing-conflict', '(이 배포가 만들지 않은 항목)'); done(); continue; }
    if (where !== 'edge' && (exEdge || pend)) { reject('edge-to-central'); done(); continue; }
    // ⑥ 자격 칸 — 공통 계정 · 키(값은 결과에 싣지 않는다).
    //   엣지 배포 행(중앙 → 엣지)은 이름을 **엣지가 자기 저장소에서** 찾는다 — 중앙은 이름 꼴만 본다(키 · 비밀은 법인 밖으로 나가지 않는다).
    const remote = where === 'edge';
    const nameOk = (v) => NAME_RE.test(v);
    /*
     * 메인 결정(감사 H-1 · 반증 F1 · F1-b): 저장된 비밀(공통 계정 · SSH 키)을 **주소에 묶는 것**은 그 비밀을 관리하는 등급과 같다 — 설정 소유자 등급 + 본인 OTP.
     *   판정은 bindRule.bindDecision **하나**(bm-storage 라우트 · 등록부 choke point 와 같은 함수 — r3 재검증 R-N1: 'os_cred 빈칸 + os_key=password + 새 주소'
     *   는 적용 계획이 기존 credRef 를 새 주소로 잇는데(plan.os.credRef) 예전 판정은 이름을 쓰는 행만 묶음으로 봤다).
     *   소유자가 아니면 **계정 · 키를 찾기 전에** 거부한다(다른 법인 계정 · 없는 키를 가르는 오라클을 만들지 않는다) — 그래서 여기는 이름 토큰으로 본다.
     *   찾은 뒤에는 적용 본문(osWriteOf) 그대로 bindOfWrite 로 한 번 더 본다(등록부 choke point 와 같은 입력 — 계정의 실제 계정명 등).
     */
    const ownerOk = typeof ctx.ownerTier === 'function' ? ctx.ownerTier(row) === true : !!ctx.ownerTier;   // 엣지 적용: 중앙이 승인한 행만(bindOk)
    const osCredRaw = t(c.os_cred); const osKeyRaw = t(c.os_key); const idracCredRaw = t(c.idrac_cred);
    const usesOsAcc = !!osHost && !!osCredRaw && !INDIVIDUAL.has(lc(osCredRaw)) && !/^(개별|individual|user)\s*:/i.test(osCredRaw);
    const usesKey = !!osHost && !!osKeyRaw && lc(osKeyRaw) !== 'password';
    const usesIdracAcc = !!idracHost && !!idracCredRaw && !INDIVIDUAL.has(lc(idracCredRaw));
    let binds = bindNameDecision({ remote, agent, exOs, exIdr, exEdge, osHost, osPort, idracHost, osCredRaw, osKeyRaw, idracCredRaw, usesOsAcc, usesKey, usesIdracAcc, nameOfAcc, nameOfKey, idrCopyName });
    if (binds && !ownerOk) { reject('bind-owner-only'); done(); continue; }
    const credOk = (acc) => !acc.corp || !vc || lc(acc.corp) === lc(vc);
    let idracAcc = null; let idracCredName = '';
    const idracCred = t(c.idrac_cred);
    if (idracHost) {
      if (idracCred && !INDIVIDUAL.has(lc(idracCred))) {
        if (remote) { if (!nameOk(idracCred)) { reject('idrac-cred-missing'); done(); continue; } idracCredName = idracCred; res.cred = idracCred; }
        else {
          idracAcc = typeof ctx.accountByName === 'function' ? ctx.accountByName('idrac', idracCred) : null;
          if (!idracAcc) { reject('idrac-cred-missing'); done(); continue; }
          if (!credOk(idracAcc)) { reject('cred-other-corp'); done(); continue; }
          res.cred = idracAcc.name; idracCredName = idracAcc.name;
        }
      } else if (!exIdr) { reject('idrac-cred-required'); done(); continue; }
      else if (!idracCred) warn('idrac-cred-kept');
    }
    let osAcc = null; let osUser = ''; let keyRef = ''; let osAuth = ''; let osCredName = ''; let osKeyName = '';
    const osCred = t(c.os_cred); const osKey = t(c.os_key);
    if (osHost) {
      const indiv = /^(개별|individual|user)\s*:\s*(.+)$/i.exec(osCred);
      if (indiv) osUser = indiv[2].trim().slice(0, 128);
      else if (osCred && !INDIVIDUAL.has(lc(osCred))) {
        if (remote) { if (!nameOk(osCred)) { reject('os-cred-missing'); done(); continue; } osCredName = osCred; }
        else {
          osAcc = typeof ctx.accountByName === 'function' ? ctx.accountByName('os', osCred) : null;
          if (!osAcc) { reject('os-cred-missing'); done(); continue; }
          if (!credOk(osAcc)) { reject('cred-other-corp'); done(); continue; }
          osCredName = osAcc.name;
        }
        res.cred = res.cred ? `${res.cred} · ${osCredName}` : osCredName;
      } else if (!exOs) { reject('os-cred-empty'); done(); continue; }
      if (lc(osKey) === 'password') {
        osAuth = 'password'; osKeyName = 'password';
        if (osAcc && !osAcc.hasPassword) { reject('password-no-secret'); done(); continue; }
        if (!osAcc && !osCredName) warn('os-password-later');
      } else if (osKey) {
        if (remote) { if (!nameOk(osKey)) { reject('key-missing'); done(); continue; } osKeyName = osKey; res.key = osKey; }
        else {
          const k = typeof ctx.keyByName === 'function' ? ctx.keyByName(osKey) : null;
          if (!k) { reject('key-missing'); done(); continue; }
          if (k.status === 'retired') { reject('key-retired'); done(); continue; }
          keyRef = k.id; res.key = k.name; osKeyName = k.name;
        }
      } else if (!osAcc && !osCredName && !(exOs && !osCred)) warn('os-no-auth');
      else if (!osCred && exOs) warn('os-cred-kept');
    }
    if (remote) warn('edge-names');
    // ⑦ 저장 규칙 검증(복제하지 않는다 — 등록부 함수)
    const mountsIn = listOf(c.mounts);
    const sm = typeof ctx.sanitizeMounts === 'function' ? ctx.sanitizeMounts(mountsIn.length ? mountsIn : ['/']) : { mounts: mountsIn, errors: [] };
    if (osHost && !mountsIn.length && !exOs) warn('mounts-default');
    const en = boolOf(c.enabled);
    if (en === undefined) { reject('bad-enabled'); done(); continue; }
    if (t(c.note).length > 500) { reject('bad-note'); done(); continue; }
    const osBody = osHost ? {
      host: osHost, port: osPort, username: osAcc ? osAcc.username : (osUser || (exOs ? exOs.username : '')),
      mounts: sm.mounts.length ? sm.mounts : (exOs?.mounts || ['/']),
    } : null;
    if (osBody) {
      if (sm.errors?.length) { res.action = 'reject'; res.code = 'bad-mounts'; res.reason = `mounts: ${String(sm.errors[0]).slice(0, 200)}`; done(); continue; }
      const issue = typeof ctx.osIssue === 'function' ? ctx.osIssue({ ...osBody, username: osBody.username || 'root' }) : null;
      if (issue) { res.action = 'reject'; res.code = 'os-invalid'; res.reason = `os_host: ${issue}`; done(); continue; }
    }
    // 반증 F3: keepCred 는 os_cred 와 os_key 가 **둘 다** 비었을 때만 — os_key 만 바꾼 행은 키 · 인증 방식을 실제로 바꾸고 공통 계정만 잇는다.
    const osPlan = osHost ? { id: exOs ? exOs.id : '', host: osHost, port: osPort, username: osBody.username, credRef: osAcc ? osAcc.id : (osCred ? '' : (exOs?.credRef || '')),
      keyRef: osKey ? keyRef : (osCred ? '' : (exOs?.keyRef || '')), osAuth: osKey ? osAuth : (osCred ? '' : (exOs?.osAuth || '')), keepCred: !osCred && !osKey && !!exOs, mounts: osBody.mounts, existing: !!exOs } : null;
    // r3(R-N1): 찾은 뒤 — 적용이 등록부에 보낼 본문 그대로 choke point 와 같은 함수로 본다(이름 판정이 놓친 묶음이 있으면 여기서 잡는다).
    if (osPlan && !remote && !binds && bindOfWrite(exOs, osWriteOf(osPlan, exOs)).binds) {
      if (!ownerOk) { reject('bind-owner-only'); done(); continue; }
      binds = true;
    }
    let idrHostNorm = '';
    if (idracHost) {
      const r = typeof ctx.idracIssue === 'function'
        ? ctx.idracIssue({ id: exIdr ? exIdr.id : (tag || name), name, host: idracHost, username: idracAcc ? idracAcc.username : (exIdr ? exIdr.username : 'pending'), serviceTag: tag, vcenterId: vc }, exIdr)
        : { issue: null, host: idracHost };
      if (r.issue) { res.action = 'reject'; res.code = 'idrac-invalid'; res.reason = `idrac_host: ${r.issue}`; done(); continue; }
      idrHostNorm = r.host;
    }
    // ⑧ 분류 · 용도 · 역할 · 스위치(형식)
    const cls = lc(c.class);
    if (cls && !CLASSES.includes(cls)) { reject('bad-class'); done(); continue; }
    const apps = listOf(c.purposes);
    if (apps.some((a) => !(ctx.knownApps || []).includes(a))) { reject('bad-purpose'); done(); continue; }
    const role = lc(c.role);
    if (role && !(ctx.knownRoles || []).includes(role)) { reject('bad-role'); done(); continue; }
    if ((cls || apps.length || role) && !tag) warn('purpose-no-tag');
    // 감사 M-2 · 반증 F10: class(함대 분류 — exclude 포함)는 전 법인 설정(기존 PUT /fleet/tag = fleetFullScopeOnly) → 전체 범위만.
    if (cls && tag && !ctx.fullScope) { reject('class-full-scope'); done(); continue; }
    // purposes · role 은 그 service_tag 가 **쓰기 범위 안 수집 대상**으로 해석될 때만(purposeWrite 와 같은 판정: 조회 밖 = 없음 · 쓰기 밖 = 403).
    let purposeOk = (apps.length || role) && !!tag;
    let purposeKey = ''; let purposeClearPair = '';
    if (purposeOk && typeof ctx.tagTarget === 'function') {
      const tt = ctx.tagTarget(tag);
      const tvc = tt ? t(tt.vcenterId) : '';
      if (!tt || (tvc ? !canView(tvc) : !ctx.fullScope)) { purposeOk = false; warn('purpose-unresolved'); }
      else if (tvc ? !canWrite(tvc) : false) { reject('purpose-forbidden'); done(); continue; }
      // 2차 재확인 G1: 공통 태그면(같은 태그 서버가 여럿 · 공통 기본값 · 둘 이상 법인) 어느 서버 것인지 몰라 적용하지 않는다 — 상세 화면에서 서버마다.
      else if (tt.common === true) { purposeOk = false; warn('purpose-common-tag'); }
      else { purposeKey = t(tt.purposeKey); purposeClearPair = t(tt.clearPair); }
    }
    // 반증 F4: OS 만 등록한 행이 이 노드 함대(iDRAC · vCenter)에 없으면 성능 수집 대상이 아니다 — 결과가 말한다(대상 집합은 바꾸지 않는다).
    if (osHost && !idracHost && where !== 'edge' && typeof ctx.fleetHas === 'function' && !ctx.fleetHas({ name, osHost, tag })) warn('os-only-untracked');
    const sw = t(c.switch_port);
    if (sw) {
      const parts = listOf(sw);
      if (parts.some((p) => !/^[A-Za-z0-9._-]{1,32}\s*=\s*[A-Za-z0-9._-]{1,64}\s*:\s*[A-Za-z0-9/._-]{1,32}$/.test(p))) { reject('bad-switch'); done(); continue; }
      warn('switch-later');
    }
    // ⑨ 무엇이 바뀌는가(갱신 · 변화 없음) — 경로 변경 · 주소 변경 경고
    const prevVia = exOs?.collectVia || (exEdge ? 'edge' : (exIdr || exOs ? 'central' : ''));
    if (prevVia && res.via && prevVia !== res.via && !(prevVia === 'auto')) warn('via-moved', `(${prevVia} → ${res.via})`);
    if (exOs && osHost && hostKeyOf(exOs.host) !== hostKeyOf(osHost)) warn('address-moved');
    if (where === 'edge') warn('edge-deploy', `(${agent})`);
    const changes = [];
    const differs = (a, b) => t(a) !== t(b);
    if (idracHost) {
      if (!exIdr) res.idrac = 'new';
      else {
        if (differs(exIdr.host, idrHostNorm)) changes.push('idrac_host');
        if (differs(exIdr.serviceTag, tag) && tag) changes.push('service_tag');
        if (differs(exIdr.vcenterId, vc)) changes.push('corp');
        if (idracAcc && differs(exIdr.username, idracAcc.username)) changes.push('idrac_cred');
        if (en !== null && (exIdr.enabled !== false) !== en) changes.push('enabled');
        res.idrac = 'update';
      }
    }
    if (osHost) {
      if (!exOs) res.os = 'new';
      else {
        if (hostKeyOf(exOs.host) !== hostKeyOf(osHost) || (Number(exOs.port) || 22) !== osPort) changes.push('os_host');
        if (osBody.username && differs(exOs.username, osBody.username)) changes.push('os_cred');
        if (keyRef && differs(exOs.keyRef, keyRef)) changes.push('os_key');
        if (osAcc && differs(exOs.credRef, osAcc.id)) changes.push('os_cred');
        if (osAuth && differs(exOs.osAuth, osAuth)) changes.push('os_key');
        if (mountsIn.length && sm.mounts.join(';') !== (exOs.mounts || []).join(';')) changes.push('mounts');
        if (differs(exOs.vcenterId, vc)) changes.push('corp');
        if (res.via && differs(exOs.collectVia, via)) changes.push('collect_via');
        if (en !== null && (exOs.enabled !== false) !== en) changes.push('enabled');
        if (t(c.note) && differs(exOs.note, c.note)) changes.push('note');
        res.os = 'update';
      }
    }
    if (where === 'edge' && (exIdr || exOs)) changes.push('collect_via');   // 중앙 항목 → 엣지 배포 목록
    let edgeBindKeep = false;
    if (where === 'edge' && exEdge) {
      const next = edgeRowFromPlan({ name, vc, tag, idracHost, osHost, osPort, mounts: osBody ? osBody.mounts : [], enabled: en, note: t(c.note), cls, apps, role,
        idracCred: idracCredName, osCred: osCredName, osUser, osKey: osKeyName }, agent);
      if (edgeRowDiffers(exEdge, next)) changes.push('edge-row');
      if (lc(exEdge.agent) !== lc(agent)) changes.push('collect_via');
      // r3: 묶음 칸(주소 · 이름)이 그대로인 행은 앞 배포의 승인(bindOk)을 잇는다 — 엣지가 그 행을 다시 적용할 때(앞 적용 실패 등) 승인 없이 거부되지 않게.
      edgeBindKeep = exEdge.bindOk === true && lc(exEdge.agent) === lc(agent) && !EDGE_BIND_KEYS.some((k) => JSON.stringify(exEdge[k] ?? null) !== JSON.stringify(next[k] ?? null));
    }
    if (where !== 'edge' && exEdge) changes.push('collect_via');           // 엣지 배포 목록 → 중앙
    if (cls || (purposeOk && (apps.length || role))) changes.push('tags');
    res.changes = [...new Set(changes)];
    const isNew = where === 'edge' ? (!exEdge && !exIdr && !exOs) : (res.idrac === 'new' || res.os === 'new');   // 반증 F17: 배포 행이 있으면 '갱신'
    res.action = isNew ? 'new' : (res.changes.length ? 'update' : 'unchanged');
    // 적용 계획(비밀 없음 — 이름 · id 참조만). apply 가 그대로 쓴다.
    res.plan = {
      where, agent, vc, name, tag,
      idrac: idracHost ? { id: exIdr ? exIdr.id : (tag || name), host: idracHost, accountId: idracAcc ? idracAcc.id : '', accountName: idracAcc ? idracAcc.name : '', keepCred: !idracAcc && !!exIdr, existing: !!exIdr } : null,
      os: osPlan,
      enabled: en, note: t(c.note), cls, apps: purposeOk ? apps : [], role: purposeOk ? role : '', via,
      ...(purposeOk && purposeKey ? { purposeKey } : {}), ...(purposeOk && purposeClearPair ? { purposeClearPair } : {}),   // G1: 저장 키(상세 화면과 같은 규칙)
      edgeNames: { idracCred: idracCredName, osCred: osCredName, osUser, osKey: osKeyName },
      moveFromEdge: where !== 'edge' && !!exEdge ? lc(exEdge.agent) : '', moveToEdge: where === 'edge' && !!(exIdr || exOs),
      hidden, binds, edgeBindKeep,
    };
    if (binds) { summary.needOwner += 1; warn('needs-owner'); }
    if (where === 'edge') summary.edge += 1; else summary.central += 1;
    done();
  }
  return { rows: out, summary };
}

/**
 * 엣지 배포 행(비밀 없음 — 공통 계정 · 키는 **이름**으로만. 엣지가 자기 저장소에서 같은 이름을 찾는다). 중앙 저장 · 엣지 적용이 같은 꼴을 쓴다.
 */
export function edgeRowFromPlan(p = {}, agent = '') {
  return {
    name: t(p.name).slice(0, 128), agent: lc(agent).slice(0, 64), corp: t(p.vc).slice(0, 128), serviceTag: t(p.tag).slice(0, 64),
    idracHost: t(p.idracHost).slice(0, 253), idracCred: t(p.idracCred).slice(0, 64),
    osHost: t(p.osHost).slice(0, 253), osPort: Number(p.osPort) || 22, osCred: t(p.osCred).slice(0, 64), osUser: t(p.osUser).slice(0, 128), osKey: t(p.osKey).slice(0, 64),
    mounts: (Array.isArray(p.mounts) ? p.mounts : []).slice(0, 64).map((m) => t(m).slice(0, 256)),
    enabled: p.enabled !== false, note: t(p.note).slice(0, 500), cls: t(p.cls), apps: (Array.isArray(p.apps) ? p.apps : []).slice(0, 16).map((x) => t(x).slice(0, 32)), role: t(p.role),
    // r3(R-N1): 중앙이 이 행의 묶음을 승인했는가(설정 소유자 + OTP 를 통과한 적용이 세운다 — 엄격한 true 만). 엣지 적용은 이 값이 true 인 행만 묶는다.
    bindOk: p.bindOk === true,
  };
}
const EDGE_ROW_KEYS = ['corp', 'serviceTag', 'idracHost', 'idracCred', 'osHost', 'osPort', 'osCred', 'osUser', 'osKey', 'mounts', 'enabled', 'note', 'cls', 'apps', 'role'];
export function edgeRowDiffers(a = {}, b = {}) { return EDGE_ROW_KEYS.some((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)); }
/** 엣지 배포 행에서 '비밀을 주소에 묶는' 칸(주소 · 공통 계정 · 키 이름). bindOk(중앙 승인)는 이 칸이 그대로일 때만 잇는다. */
const EDGE_BIND_KEYS = ['idracHost', 'idracCred', 'osHost', 'osPort', 'osCred', 'osUser', 'osKey'];

/**
 * 적용 계획(plan.os) → 등록부 쓰기 본문의 주소 · 참조 칸. applyOnboard 와 분석의 사후 판정이 **같은 본문**을 쓴다(choke point 와 같은 입력).
 * keepCred = 참조 칸을 주지 않는다(등록부가 같은 주소면 기존 유지 · 주소가 바뀌면 버린다).
 */
export function osWriteOf(planOs = {}, ex = null) {
  return {
    host: planOs.host, port: planOs.port, username: planOs.username || ex?.username || 'root',
    ...(planOs.keepCred ? {} : { keyRef: planOs.keyRef || '', credRef: planOs.credRef || '', osAuth: planOs.osAuth || '' }),
  };
}

/**
 * 계정 · 키를 **찾기 전** 묶음 판정(이름 토큰 · bindRule.bindDecision). 토큰은 적용 계획(plan.os)과 같은 규칙으로 '이 행이 쓰게 될 참조' 를 만든다:
 *  · os_cred 가 공통 계정 → 그 이름 · 다른 값(개별 등) → 없음 · **빈칸 + os_key 있음 → 기존 공통 계정을 잇는다**(R-N1) · 둘 다 빈칸 → 칸을 주지 않음.
 *  · 엣지 배포 행은 엣지 쪽 기존 항목을 중앙이 모른다 — '잇는' 행은 늘 묶음으로 본다(엣지에서 무엇이 이어질지 모르므로 소유자 승인 · bindOk 로만 간다).
 */
function bindNameDecision(o) {
  const { remote, agent, exOs, exIdr, exEdge: exEdge0, osHost, osPort, idracHost, osCredRaw, osKeyRaw, idracCredRaw, usesOsAcc, usesKey, usesIdracAcc, nameOfAcc, nameOfKey, idrCopyName } = o;
  const keyPw = lc(osKeyRaw) === 'password';
  const exEdge = exEdge0 && lc(exEdge0.agent) === lc(agent) ? exEdge0 : null;   // 다른 엣지의 행은 이 엣지에겐 새 항목
  const indivUser = (/^(개별|individual|user)\s*:\s*(.+)$/i.exec(osCredRaw)?.[2] || '').trim().slice(0, 128);
  const refTok = (id, nameOf) => (id ? (lc(nameOf(id)) || `#${id}`) : '');
  let exTok = null; let exUser = 'root';
  if (remote) {
    if (exEdge && t(exEdge.osHost)) {
      const k = lc(exEdge.osKey);
      exUser = t(exEdge.osUser) || (exEdge.osCred ? `\u0001${lc(exEdge.osCred)}` : 'root');
      exTok = { addr: addrKey(hostKeyOf(exEdge.osHost), exEdge.osPort, exUser), cred: lc(exEdge.osCred), key: k === 'password' ? '' : k, osAuth: k === 'password' ? 'password' : '' };
    }
  } else if (exOs) {
    exUser = t(exOs.username) || 'root';
    exTok = { addr: addrKey(hostKeyOf(exOs.host), exOs.port, exUser), cred: refTok(exOs.credRef, nameOfAcc), key: refTok(exOs.keyRef, nameOfKey), osAuth: exOs.osAuth === 'password' ? 'password' : '' };
  }
  let osBinds = false;
  if (osHost) {
    const accTok = usesOsAcc ? lc(osCredRaw) : '';
    const user = indivUser || (usesOsAcc ? (exTok && exTok.cred === accTok ? exUser : `\u0001${accTok}`) : exUser);
    const carry = remote ? '\u0001carry' : (exTok?.cred || '');
    const next = {
      addr: addrKey(hostKeyOf(osHost), osPort, user),
      cred: usesOsAcc ? accTok : (osCredRaw ? '' : (osKeyRaw ? carry : undefined)),
      key: usesKey ? lc(osKeyRaw) : (keyPw || osCredRaw ? '' : undefined),
      osAuth: osKeyRaw ? (keyPw ? 'password' : '') : (osCredRaw ? '' : undefined),
    };
    osBinds = bindDecision(exTok, next).binds;
  }
  let idrBinds = false;
  if (idracHost) {
    const ex = remote ? (exEdge && t(exEdge.idracHost) ? { addr: hostKeyOf(exEdge.idracHost), cred: lc(exEdge.idracCred) } : null)
      : (exIdr ? { addr: hostKeyOf(exIdr.host), cred: lc(idrCopyName(exIdr.id)) } : null);
    idrBinds = bindDecision(ex, { addr: hostKeyOf(idracHost), cred: usesIdracAcc ? lc(idracCredRaw) : (idracCredRaw ? '' : undefined) }).binds;
  }
  return osBinds || idrBinds;
}

/** 판정 서명 — 분석과 적용 사이에 등록부 · 키 · 범위가 바뀌었는지(적용은 같은 파일을 다시 분석해 이 값이 같을 때만). */
export function analysisSig(rows = [], regGen = '') {
  const parts = rows.map((r) => `${r.line}|${r.action}|${r.code}|${r.via}|${r.agent}|${r.corp}|${(r.changes || []).join(',')}|${r.key}|${r.cred}|${(r.warnings || []).map((w) => w.code).join(',')}|${r.plan?.hidden ? 'h' : ''}`);
  // 반증 F12: 등록부 세대(mtime · 크기)도 넣는다 — 분석과 적용 사이에 다른 쓰기가 끼면 판정이 같아 보여도 409.
  return `${rows.length}-${crypto.createHash('sha256').update(parts.join('\n')).update(`\n#${String(regGen)}`).digest('hex').slice(0, 24)}`;
}
