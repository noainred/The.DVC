/**
 * 중앙에서 지정하는 'agent(엣지)별 GPU 게스트 수집 설정' 저장소.
 *
 * 목적: 원격 엣지는 폐쇄망/NAT 뒤에 있어 중앙이 직접 push하기 어렵다. 그래서 중앙은 각 엣지에
 * '배포할 설정'을 여기에 보관하고, 엣지가 아웃바운드로 주기적으로 pull(GET /api/central/
 * gpu-guest-config?agent=이름)해 자기 로컬 gpu-guest.json에 병합 적용한다.
 *
 * 저장: CONFIG_DIR/central-agent-gpu-guest.json (0600, 비밀번호 포함 — 엣지가 실제 SSH/게스트
 * 작업 인증에 써야 하므로 평문 보관·원자적 쓰기). 클라이언트로 내보낼 때는 비밀번호를 가린다.
 * 값은 gpu/settings.js와 동일한 설정 스키마(mergeGpuGuestSettings 규칙 공유).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js'; // 자격증명 저장 방식(평문/암호화, v2.296) — 로드 시 복호·저장 시 봉인
import { mergeGpuGuestSettings, redactGpuGuestSettings, gpuGuestNonDefaultPatch } from '../gpu/settings.js';
// v2.743(RECENT-01): 대소문자 중복을 합칠 때 남길 키의 근거(엣지 실제 이름) — 중복이 있을 때만 읽는다(edgeNameEvidence).
import { listAgentTokens } from './agentTokens.js';
import { getAllGpuGuestDiag } from './gpuGuestDiag.js';
import { loadCollectors } from '../collector/registry.js';
import { agentKeyOf } from '../util/agentKey.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js'; // v2.727(감사 D-01): 손상 → 설정 pull 503(v2.631 규약)

const FILE = path.join(config.configDir, 'central-agent-gpu-guest.json');

// null-proto: agent 이름을 키로 쓰므로 '__proto__' 등 프로토타입 오염 방지.
let byAgent = Object.create(null); // agent -> gpuGuestSettings(전체 병합 객체) + { _updatedAt }
/*
 * v2.727(감사 D-01): 로드 오류 상태. 손상 → preserveCorrupt → 빈 배정이면 `GET /api/central/gpu-guest-config` 가 `200 assigned:false` 를
 *   내려 엣지(agent/gpuGuestConfigPull.js)가 '중앙 지정 없음' 으로 읽었다 — 로컬 설정은 유지되지만 **중앙이 지운 VM 자격증명이 엣지에
 *   그대로 남는 창**이 생기고, 서비스 점검(listSettingsLoadErrors)에도 나오지 않았다. v2.631 settingsLoadError 의 누락 지점.
 *   오류면 라우트가 503 settingsUnreadable 로 답한다. 재시작 뒤(원본이 .corrupt 로 옮겨져 ENOENT)도 보존본만 있으면 못 읽은 것이다.
 *   관리자 저장(persist)만 해제한다. confirm 은 지금 메모리 값(손상이면 빈 맵)을 그대로 쓴다.
 */
const _loadErr = makeSettingsLoadError(() => FILE, { label: 'GPU 게스트 수집 배포(엣지별)', confirm: () => persist() });
/** 배포 파일을 못 읽었으면 { at, reason }, 읽었으면 null — 라우트가 pull 응답 전에 본다. 파일이 없고 보존본만 있으면 오류다. */
export function gpuGuestConfigLoadError() { if (!_loadErr.get() && !fs.existsSync(FILE)) _loadErr.missing(); return _loadErr.get(); }
/**
 * v2.742(LEFT-01 — 재현): 대소문자만 다른 중복 키를 하나로 합친다(순수). 예전 저장(setAssignedGpuGuest)은 읽기와 달리 **글자 그대로**
 *   키를 써서, 'edge-a' 로 저장된 배포를 'Edge-A' 이름으로 일부만 고쳐 저장하면 비밀번호·다른 VM 계정·enabled 가 빠진 **새 사본**이
 *   생겼다. 이제 쓰기도 기존 키에 쓰고(setAssignedGpuGuest), 이미 생긴 중복은 로드 때 합친다. 합친 사실은 콘솔·상태에 남긴다
 *   (조용히 버리지 않는다). 파일은 다음 저장 때 합친 모양으로 다시 쓰인다(로드가 파일을 고쳐 쓰지 않는다).
 *
 * ⚠⚠ v2.743(RECENT-01 — 재현): v2.742 는 **가장 최근(_updatedAt) 사본을 통째로** 남기고 겹친 vCenter 도 최근 값으로 썼다. 그런데 중복을
 *   만든 바로 그 결함(빈 바탕 {} 위에 부분 본문만 얹은 저장)이 최근 사본을 만든다 — 그 사본의 최상위 enabled:false·기본 주기와 vCenter 의
 *   enabled:false·username:''·password:'' 는 관리자가 끈 값이 아니라 **바탕에서 온 기본값**이다. 그래서 이름이 옛 키와 글자 그대로 같은 엣지가
 *   (v2.741 까지 온전한 사본을 받던 엣지가) 업그레이드 뒤 첫 pull 에서 수집 끔·공용 계정 비움·VM 계정 삭제를 당했다(mergePulledGpuGuestSettings 는
 *   중앙 사본에 없는 VM 계정을 지운다). 이제 둘을 나눈다:
 *   ① 남길 **키**: 엣지 실제 이름과 글자 그대로 같은 키(인증된 이름 — 개별 토큰 바인딩·검증된 GPU 진단 push — 가 등록부 이름보다 먼저),
 *      근거가 없으면 **먼저 있던(옛) 키**. 키는 표시·이후 쓰기에만 쓰인다(읽기는 대소문자를 무시한다 — agentKeyOf).
 *   ② 남길 **값**: 옛 사본부터 시간 순서로, 최근 사본의 '빈 바탕 기본값이 아닌 값' 만 덮는다(gpu/settings.js gpuGuestNonDefaultPatch +
 *      mergeGpuGuestSettings — 판정 한 벌). 최상위·겹친 vCenter 의 enabled·계정·비밀번호·주기·방식은 최근 값이 기본값·빈 문자열이면 옛 값을 유지,
 *      VM 계정·고정 IP 는 합집합(같은 VM 은 최근 것 — 빈 비밀번호는 같은 계정이면 옛 값, 계정이 바뀌었으면 승계하지 않는다 v2.611).
 *   대가(정직 기록): 관리자가 'Edge-A' 행에서 **일부러** 끄거나 비운 값은 되살아난다 — 빈 바탕에서 온 기본값과 사본만으로는 가를 수 없어
 *   자격증명·수집을 잃지 않는 쪽을 골랐다. 그 사실(옛 값을 유지한 항목 경로)을 상태(gpuGuestFoldStatus)·목록 행(folded)·콘솔에 남긴다.
 * @param {object} map 파일에서 읽은 { agent: settings }
 * @param {{authNames?: Iterable<string>, regNames?: Iterable<string>}} [names] 엣지 실제 이름 근거(글자 그대로 비교)
 * @returns {{ map: object, merged: Array<{kept:string, dropped:string[], keptBy:'authenticated'|'registry'|'older', keptOlder:string[], vcentersFromOlder:string[], droppedSecrets:string[]}> }}
 */
export function foldCaseDuplicateGpuGuest(map, names = {}) {
  const src = map && typeof map === 'object' ? map : {};
  const nameSet = (it) => new Set([...(it && typeof it[Symbol.iterator] === 'function' ? it : [])].map((n) => String(n ?? '').trim()).filter(Boolean));
  const auth = nameSet(names.authNames);
  const reg = nameSet(names.regNames);
  const groups = new Map();
  for (const k of Object.keys(src)) {
    const lo = k.toLowerCase(); // agentKeyOf 와 같은 비교(소문자)
    if (!groups.has(lo)) groups.set(lo, []);
    groups.get(lo).push(k);
  }
  const out = Object.create(null);
  const merged = [];
  const at = (k) => Number(src[k]?._updatedAt) || 0;
  const lex = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  for (const keys of groups.values()) {
    if (keys.length === 1) { out[keys[0]] = src[keys[0]]; continue; }
    // 객체가 아닌 사본(손으로 고친 파일)은 값으로 쓰지 않고, 남길 키 후보에서도 뒤로 민다(시각 0 이라 '먼저 있던 키' 로 뽑히지 않게).
    const isCopy = (k) => !!(src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]));
    const rank = (k) => (auth.has(k) ? 2 : reg.has(k) ? 1 : 0);
    const kept = [...keys].sort((x, y) => Number(isCopy(y)) - Number(isCopy(x)) || rank(y) - rank(x) || at(x) - at(y) || lex(x, y))[0];
    const keptBy = rank(kept) === 2 ? 'authenticated' : rank(kept) === 1 ? 'registry' : 'older';
    // 값: 옛 사본부터 시간 순서로 합친다.
    const byTime = keys.filter(isCopy).sort((x, y) => at(x) - at(y) || lex(x, y));
    const droppedSecrets = [];
    let acc = byTime.length ? structuredClone(src[byTime[0]]) : src[kept];
    const keptOlder = new Set();
    const vcentersFromOlder = new Set();
    for (const k of byTime.slice(1)) {
      const newer = src[k];
      for (const p of olderValuesKept(acc, newer)) keptOlder.add(p);
      const nv = newer.vcenters && typeof newer.vcenters === 'object' ? newer.vcenters : {};
      for (const id of Object.keys(acc.vcenters && typeof acc.vcenters === 'object' ? acc.vcenters : {})) if (!Object.prototype.hasOwnProperty.call(nv, id)) vcentersFromOlder.add(id);
      const ts = Math.max(at(k), Number(acc._updatedAt) || 0);
      acc = mergeGpuGuestSettings(acc, gpuGuestNonDefaultPatch(newer), droppedSecrets);
      acc._updatedAt = ts;
    }
    out[kept] = acc;
    merged.push({ kept, dropped: keys.filter((k) => k !== kept), keptBy, keptOlder: [...keptOlder], vcentersFromOlder: [...vcentersFromOlder], droppedSecrets: [...new Set(droppedSecrets)] });
  }
  return { map: out, merged };
}

/**
 * 최근 사본의 빈 바탕 기본값 때문에 **옛 값을 유지한** 항목 경로(순수 — 상태·콘솔 보고용, 값은 싣지 않는다).
 * gpuGuestNonDefaultPatch 가 버린 칸 중 옛 사본에 기본값이 아닌 값이 있던 것만 센다.
 */
function olderValuesKept(older, newer) {
  const pNew = gpuGuestNonDefaultPatch(newer);
  const pOld = gpuGuestNonDefaultPatch(older);
  const out = [];
  for (const f of Object.keys(pOld)) if (f !== 'vcenters' && !(f in pNew)) out.push(f);
  const nv = newer?.vcenters && typeof newer.vcenters === 'object' ? newer.vcenters : {};
  for (const [id, ov] of Object.entries(pOld.vcenters || {})) {
    if (!Object.prototype.hasOwnProperty.call(nv, id)) continue; // 최근 사본에 없는 vCenter 는 통째로 옮긴 것(vcentersFromOlder)
    const npv = (pNew.vcenters || {})[id] || {};
    for (const f of ['enabled', 'username', 'password', 'winUsername', 'winPassword']) if (f in ov && !(f in npv)) out.push(`vcenters.${id}.${f}`);
    const nvms = nv[id] && typeof nv[id].vms === 'object' && nv[id].vms ? nv[id].vms : {};
    const nips = nv[id] && typeof nv[id].vmIps === 'object' && nv[id].vmIps ? nv[id].vmIps : {};
    for (const vmId of Object.keys(ov.vms || {})) if (!Object.prototype.hasOwnProperty.call(nvms, vmId)) out.push(`vcenters.${id}.vms.${vmId}`);
    for (const vmId of Object.keys(ov.vmIps || {})) if (!Object.prototype.hasOwnProperty.call(nips, vmId)) out.push(`vcenters.${id}.vmIps.${vmId}`);
  }
  return out;
}

/**
 * 엣지 실제 이름 근거(글자 그대로) — 중복이 있을 때만 로드가 부른다. 인증된 이름 = 개별 토큰 바인딩 이름(central-agent-tokens.json)
 *   + 검증된 GPU 진단 push 의 agent(인메모리 — 기동 직후에는 비어 있다). 등록부 이름 = 수집 서버 등록부 name·id.
 *   하나를 못 읽어도 다른 근거로 판정한다(못 읽은 근거는 없는 것으로 본다 — 그러면 옛 키를 남긴다).
 */
function edgeNameEvidence() {
  const authNames = []; const regNames = [];
  try { for (const t of listAgentTokens()) authNames.push(t.agent); } catch { /* 근거 없음 */ }
  try { for (const d of getAllGpuGuestDiag()) if (d && d.verified === true) authNames.push(d.agent); } catch { /* 근거 없음 */ }
  try { for (const c of loadCollectors()) { regNames.push(c?.name); regNames.push(c?.id); } } catch { /* 근거 없음 */ }
  return { authNames, regNames };
}

/** v2.743(RECENT-01): 마지막 로드에서 합친 결과 — { at, groups:[…] } 또는 null(합칠 중복이 없었다). 값·비밀번호는 싣지 않는다. */
let _foldReport = null;
export function gpuGuestFoldStatus() { return _foldReport ? structuredClone(_foldReport) : null; }
const foldOfKey = (k) => (_foldReport ? _foldReport.groups.find((g) => g.kept === k) || null : null);

// v2.296 배포 사본 계정 복호. ⚠ 손상 시 조용히 빈 객체로 출발하면 다음 persist()가 온전했던
// 원본(엣지 SSH/게스트 비밀번호 포함)을 덮어써 영구 유실된다 — preserveCorrupt 로 보존 후 빈 값.
try {
  if (fs.existsSync(FILE)) {
    const raw = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {});
    // 이름 근거는 대소문자 중복이 있을 때만 읽는다(등록부·토큰 파일을 매 기동 끌어오지 않게).
    const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
    const hasDup = new Set(keys.map((k) => k.toLowerCase())).size < keys.length;
    const folded = foldCaseDuplicateGpuGuest(raw, hasDup ? edgeNameEvidence() : {});
    byAgent = Object.assign(Object.create(null), folded.map);
    if (folded.merged.length) _foldReport = { at: Date.now(), groups: folded.merged };
    const BY = { authenticated: '엣지 인증 이름과 같은 키', registry: '수집 서버 등록부 이름과 같은 키', older: '이름 근거가 없어 먼저 있던 키' };
    for (const m of folded.merged) {
      const kept = m.keptOlder.length ? ` · 최근 사본의 빈 값 대신 옛 값을 유지한 항목 ${m.keptOlder.length}개(${m.keptOlder.slice(0, 8).join(', ')}${m.keptOlder.length > 8 ? ' 외' : ''})` : '';
      const moved = m.vcentersFromOlder.length ? ` · 옛 사본에만 있던 vCenter ${m.vcentersFromOlder.join(', ')} 을 옮김` : '';
      const drop = m.droppedSecrets.length ? ` · 계정이 바뀌어 비밀번호를 승계하지 않은 항목 ${m.droppedSecrets.join(', ')}` : '';
      console.warn(`[central] central-agent-gpu-guest.json: 대소문자만 다른 엣지 이름 ${[m.kept, ...m.dropped].join(', ')} 의 배포 설정을 ${m.kept} 하나로 합쳤습니다(${BY[m.keptBy] || m.keptBy}) — 버린 키 ${m.dropped.join(', ')} · 값은 옛 사본 위에 최근 사본의 기본값이 아닌 값을 얹었습니다(VM 계정·고정 IP 는 합집합)${kept}${moved}${drop}. 설정 › GPU 게스트 수집 배포 화면에서 확인하세요.`);
    }
    _loadErr.ok();
  } else _loadErr.missing();
} catch (err) { _loadErr.corrupt(err); preserveCorrupt(FILE, err.message); console.error(`[central] central-agent-gpu-guest.json 파싱 실패: ${err.message}`); byAgent = Object.create(null); }

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep(byAgent)), { mode: 0o600 }); // 암호화 모드면 password 봉인(복제 — byAgent 평문 유지)
  _loadErr.ok(); // v2.727(D-01): 관리자 저장이 로드 오류를 푼다(settingsLoadError 규약)
}

const cleanAgent = (a) => String(a || '').trim();

/** 지정된 배포 설정(비밀번호 포함) — 엣지 pull이 사용. 없으면 null. */
export function getAssignedGpuGuest(agent) {
  const a = cleanAgent(agent);
  const k = a ? agentKeyOf(byAgent, a) : null; // v2.597 L2597-03 — 대소문자만 다른 이름도 같은 엣지
  return k != null && byAgent[k] ? byAgent[k] : null;
}

/** 관리자 저장: partial을 기존 배포 설정에 병합(로컬 저장과 동일 규칙). 반환 병합 결과. */
//   v2.612 RECENT2612-05: dropped(선택 배열)에 폐기한 비밀 필드를 담는다 — 계정이 바뀌어 저장 비밀번호를 승계하지 않은 것을
//   라우트가 droppedSecrets 로 밝히게(로컬 PUT 과 같은 계약. 예전엔 버려져 화면이 '배포 저장됨' 만 말했다).
//   v2.742(LEFT-01): 읽기(getAssignedGpuGuest)와 같은 규칙으로 **기존 키**에 쓴다 — 대소문자만 다른 이름으로 저장해도 새 사본을 만들지 않는다.
export function setAssignedGpuGuest(agent, partial, dropped = []) {
  const a = cleanAgent(agent);
  if (!a) return null;
  const k = agentKeyOf(byAgent, a) ?? a;
  const cur = byAgent[k] || {};
  const next = mergeGpuGuestSettings(cur, partial || {}, dropped);
  next._updatedAt = Date.now();
  byAgent[k] = next;
  persist();
  return next;
}

/** 배포 설정이 지정된 agent 목록(요약). */
export function listAssignedGpuGuestAgents() {
  return Object.keys(byAgent).map((agent) => {
    const s = byAgent[agent] || {};
    const vcs = Object.keys(s.vcenters || {});
    const vmCreds = vcs.reduce((n, id) => n + Object.keys(s.vcenters[id]?.vms || {}).length, 0);
    const vmIps = vcs.reduce((n, id) => n + Object.keys(s.vcenters[id]?.vmIps || {}).length, 0);
    // v2.743(RECENT-01): 로드 때 대소문자 중복을 합친 키면 그 사실을 행에 싣는다(값·비밀번호는 싣지 않는다 — 개수·경로 수만).
    const f = foldOfKey(agent);
    const folded = f ? { from: f.dropped, by: f.keptBy, keptOlder: f.keptOlder.length, vcentersFromOlder: f.vcentersFromOlder.length, droppedSecrets: f.droppedSecrets.length } : null;
    return { agent, at: s._updatedAt || 0, vcenters: vcs.length, vmCreds, vmIps, enabled: !!s.enabled, ...(folded ? { folded } : {}) };
  }).sort((x, y) => (y.at || 0) - (x.at || 0));
}

/** 비밀번호를 가린 배포 설정(관리 UI용). 없으면 빈 기본 형태. */
export function redactAssignedGpuGuest(agent) {
  const s = getAssignedGpuGuest(agent);
  if (!s) return { assigned: false, settings: null };
  return { assigned: true, at: s._updatedAt || 0, settings: redactGpuGuestSettings(s) };
}
