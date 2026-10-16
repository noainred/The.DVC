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
import { mergeGpuGuestSettings, redactGpuGuestSettings } from '../gpu/settings.js';
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
 *   생겼다. 엣지는 자기 이름과 정확히 같은 키를 먼저 받으므로(agentKeyOf) 'Edge-A' 엣지는 빈 사본을 받아 VM 자격증명과 수집 켜짐을
 *   지웠다(mergePulledGpuGuestSettings 는 중앙 사본에 없는 VM 계정을 지운다). 이제 쓰기도 기존 키에 쓰고, 이미 생긴 중복은 로드 때
 *   **가장 최근(_updatedAt) 것을 바탕**으로 합친다 — 그 사본에 없는 vCenter 만 옛 사본에서 가져온다(같은 vCenter 는 최근 것이 이긴다.
 *   필드 단위로 섞지 않는다 — 빈 칸이 '지움' 인지 '모름' 인지 사본만으로는 가를 수 없다). 합친 사실은 콘솔에 남긴다(조용히 버리지 않는다).
 *   파일은 다음 저장 때 합친 모양으로 다시 쓰인다(로드가 파일을 고쳐 쓰지 않는다).
 * @returns {{ map: object, merged: Array<{kept:string, dropped:string[]}> }}
 */
export function foldCaseDuplicateGpuGuest(map) {
  const src = map && typeof map === 'object' ? map : {};
  const groups = new Map();
  for (const k of Object.keys(src)) {
    const lo = k.toLowerCase(); // agentKeyOf 와 같은 비교(소문자)
    if (!groups.has(lo)) groups.set(lo, []);
    groups.get(lo).push(k);
  }
  const out = Object.create(null);
  const merged = [];
  for (const keys of groups.values()) {
    if (keys.length === 1) { out[keys[0]] = src[keys[0]]; continue; }
    const at = (k) => Number(src[k]?._updatedAt) || 0;
    const sorted = [...keys].sort((x, y) => at(y) - at(x) || (x < y ? -1 : x > y ? 1 : 0));
    const kept = sorted[0];
    const base = { ...(src[kept] || {}) };
    const vcs = { ...(base.vcenters && typeof base.vcenters === 'object' ? base.vcenters : {}) };
    for (const k of sorted.slice(1)) {
      const other = src[k]?.vcenters && typeof src[k].vcenters === 'object' ? src[k].vcenters : {};
      for (const [id, v] of Object.entries(other)) if (!Object.prototype.hasOwnProperty.call(vcs, id)) vcs[id] = v;
    }
    base.vcenters = vcs;
    out[kept] = base;
    merged.push({ kept, dropped: sorted.slice(1) });
  }
  return { map: out, merged };
}

// v2.296 배포 사본 계정 복호. ⚠ 손상 시 조용히 빈 객체로 출발하면 다음 persist()가 온전했던
// 원본(엣지 SSH/게스트 비밀번호 포함)을 덮어써 영구 유실된다 — preserveCorrupt 로 보존 후 빈 값.
try {
  if (fs.existsSync(FILE)) {
    const folded = foldCaseDuplicateGpuGuest(openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}));
    byAgent = Object.assign(Object.create(null), folded.map);
    for (const m of folded.merged) console.warn(`[central] central-agent-gpu-guest.json: 대소문자만 다른 엣지 이름 ${[m.kept, ...m.dropped].join(', ')} 의 배포 설정을 가장 최근 저장분(${m.kept})으로 합쳤습니다 — ${m.dropped.join(', ')} 에만 있던 vCenter 는 옮겼고 겹친 vCenter 는 최근 값을 씁니다. 배포 화면에서 확인하세요.`);
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
    return { agent, at: s._updatedAt || 0, vcenters: vcs.length, vmCreds, vmIps, enabled: !!s.enabled };
  }).sort((x, y) => (y.at || 0) - (x.at || 0));
}

/** 비밀번호를 가린 배포 설정(관리 UI용). 없으면 빈 기본 형태. */
export function redactAssignedGpuGuest(agent) {
  const s = getAssignedGpuGuest(agent);
  if (!s) return { assigned: false, settings: null };
  return { assigned: true, at: s._updatedAt || 0, settings: redactGpuGuestSettings(s) };
}
