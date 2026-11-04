/**
 * bareos/drPlan.js — 재해 복구(DR 1차 — 시안 ② 'vCenter 를 다시 설치한 뒤 법인째 되살리기' · 사용자 결정 '두 번에 나눠' · 2026-11-04) 순수 판정.
 *   1차: 새 vCenter 점검 · 백업 당시 폴더에서 고르기 · 위치 짝짓기 · 50대씩 보내기(묶음 복원 라우트 + dr 규칙). 2차(복구 순서 — 단계 실행기)는 따로.
 *   폴더는 플러그인이 만든다(bareos-fd-vmware find_or_create_vm_folder · 23~25 원문) — 포탈은 vCenter 에 폴더를 만들지 않는다.
 */
import { numOrNull } from '../util/numOrNull.js';

/** 재해 복구(DR 1차) 묶음 규칙 — 새 VM · 네트워크 끊은 채(끌 수 없음) · 클러스터(또는 호스트) 지정. 다시 설치한 vCenter 에는 백업 때 호스트가 없을 수 있어
 *   플러그인이 '백업 때 호스트' 로 갈 수 없다(bareos-fd-vmware create_vm — restore_cluster · restore_esxhost 가 없으면 백업 때 호스트). */
export function drItemIssue(r) {
  if (r?.mode !== 'newVm') return '재해 복구는 새 VM 으로만 복원합니다.';
  if (r?.nic !== 'disconnect') return '재해 복구는 네트워크 어댑터를 끊은 채로만 복원합니다(감염 여부를 확인한 뒤 사람이 연결).';
  if (!r?.plan?.target?.cluster && !r?.plan?.target?.esxHost) return '재해 복구는 복원할 클러스터(또는 호스트)를 정해야 합니다 — 다시 설치한 vCenter 에는 백업 때 호스트가 없을 수 있습니다.';
  return '';
}

/**
 * 재해 복구 대상 · 새 vCenter 점검(순수) — 포탈이 아는 것만 판정하고, 모르는 것은 '모름' 으로 둔다(지어내지 않는다).
 *  · Director: 폴러의 그 Director 마지막 조회(성공 · 실패 · 조회 전) · 원장 대상 수 · 마지막 성공 백업
 *  · 새 vCenter: 수집 상태 · 인벤토리 수(VM · 데이터센터 · 클러스터 · 데이터스토어) · 원장 대상 중 인벤토리에 없는 VM(다시 설치됨의 표지)
 *  · 사이트 매핑: vCenter 주소 · FD INI 경로 · FD 이름(복원 명령에 싣는다 — v2.866)
 *  · FD 의 INI(인증서 지문 · 계정)와 포탈 계정 권한은 포탈이 읽지 못한다 — 'unknown' + 확인 방법
 * @returns {{ checks: object[], targets: { dcs:string[], clusters:{name,dc}[], datastores:object[] }, counts: object }}
 */
/** 재해 복구 시험 1대가 성공한 지 이만큼 안이면 묶음(2대 이상)을 연다. */
export const DR_TRIAL_MS = 7 * 86_400_000;
const OK_STATES = new Set(['ok', 'warning']);
/**
 * 반증 R1(플러그인 원문 — 23~25 vmw2 restore): 디스크를 쓰는 덤퍼는 **백업 때 저장한 접속값**(vCenter 주소 · 계정 · 인증서 지문)을 쓰고 VM MoRef 만 새 것으로 바꾼다.
 *   다시 설치로 지문 · 계정이 바뀌면 VM 껍데기만 만들어지고 디스크 쓰기가 실패할 수 있다(실환경 미확인 — 추정). 그래서 그 법인에서 재해 복구 1대가
 *   **성공으로 끝난 뒤에만** 2대 이상 묶음을 보낸다(같은 법인 VM 은 같은 INI 로 백업됐다 — 1대가 되면 나머지도 같은 접속값).
 * @returns {string} 막는 사유('' = 보낼 수 있다)
 */
export function drTrialIssue(jobs, vcenterId, count, now = Date.now()) {
  if (!(count > 1)) return '';
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (String(j.vcenterId) !== String(vcenterId)) continue;
    for (const r of j.restores || []) if (r?.dr === true && OK_STATES.has(String(r.state || '')) && now - (Number(r.endedAt || r.at) || 0) < DR_TRIAL_MS) return '';
  }
  return '이 법인에서 재해 복구 1대가 성공으로 끝난 뒤에 여러 대를 보냅니다 — Bareos 플러그인은 백업 때 저장한 vCenter 접속값(인증서 지문 · 계정)으로 디스크를 씁니다. vCenter 를 다시 설치해 지문이 바뀌었으면 VM 껍데기만 생기고 실패할 수 있어, 먼저 1대로 확인합니다.';
}

export function drCheckView({ vcenterId, snapshot, jobs, site, director, dirPoll, lastOkOf, registryHost = '' }) {
  const vc = (snapshot?.vcenters || []).find((v) => String(v.id) === String(vcenterId)) || null;
  const vms = (snapshot?.vms || []).filter((v) => String(v.vcenterId) === String(vcenterId));
  const hosts = (snapshot?.hosts || []).filter((h) => String(h.vcenterId) === String(vcenterId));
  const dss = (snapshot?.datastores || []).filter((d) => String(d.vcenterId) === String(vcenterId));
  const vmIds = new Set(vms.map((v) => v.id));
  const mine = (Array.isArray(jobs) ? jobs : []).filter((j) => String(j.vcenterId) === String(vcenterId));
  const missing = mine.filter((j) => !vmIds.has(j.vmId)).length;
  let lastOk = null;
  for (const j of mine) { const t = lastOkOf(j.lastRun, j.finishedRuns)?.at ?? null; if (t && (!lastOk || t > lastOk)) lastOk = t; }
  const dcs = [...new Set(hosts.map((h) => h.vcDatacenter).filter((x) => typeof x === 'string' && x))].sort();
  const clusterKey = new Map();
  for (const h of hosts) if (h.cluster) clusterKey.set(`${h.vcDatacenter || ''}\u0000${h.cluster}`, { name: h.cluster, dc: h.vcDatacenter || null });
  const clusters = [...clusterKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const datastores = dss.map((d) => ({ name: d.name, freeGB: numOrNull(d.freeGB), capacityGB: numOrNull(d.capacityGB), accessible: d.accessible !== false })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const checks = [];
  // Director · 카탈로그
  if (!director) checks.push({ key: 'director', state: 'bad', label: 'Bareos Director · 카탈로그', detail: '이 vCenter 의 법인 Director 가 설정에 없습니다 — 설정 › 법인별 Director 에서 매핑하세요.' });
  else if (dirPoll?.ok === true) checks.push({ key: 'director', state: 'ok', label: 'Bareos Director · 카탈로그', detail: `‘${director.name}’ 마지막 조회 성공 · 이 법인 백업 대상 ${mine.length}대`, at: dirPoll.at ?? null, lastOk });
  else if (dirPoll?.ok === false) checks.push({ key: 'director', state: 'bad', label: 'Bareos Director · 카탈로그', detail: `‘${director.name}’ 마지막 조회 실패${dirPoll.code ? `(${dirPoll.code})` : ''} — 복원 지점을 읽지 못합니다`, at: dirPoll.at ?? null, lastOk });
  else checks.push({ key: 'director', state: 'unknown', label: 'Bareos Director · 카탈로그', detail: `‘${director.name}’ 아직 조회 전 — 복원 지점 읽기에서 확인됩니다 · 이 법인 백업 대상 ${mine.length}대`, lastOk });
  // 새 vCenter
  const status = vc?.status || (vc ? 'ok' : '');
  if (!vc) checks.push({ key: 'vcenter', state: 'bad', label: '새 vCenter 접속', detail: '이 vCenter 가 포탈 인벤토리에 없습니다 — 설정 › vCenter 에서 등록 · 수집을 확인하세요.' });
  else if (status === 'unreachable' || status === 'disabled' || status === 'pending') checks.push({ key: 'vcenter', state: 'bad', label: '새 vCenter 접속', detail: `수집 상태 ‘${status}’${vc.error ? ` — ${String(vc.error).slice(0, 160)}` : ''} — 인벤토리를 믿을 수 없어 짝짓기를 할 수 없습니다.` });
  else {
    const re = mine.length && missing === mine.length ? ' (원장 대상이 모두 인벤토리에 없음 — 다시 설치됨으로 보입니다)' : missing ? ` · 원장 대상 중 인벤토리에 없는 VM ${missing}대` : ' · 원장 대상이 모두 인벤토리에 있음 — 재해 복구가 아니라 일반 복원일 수 있습니다';
    checks.push({ key: 'vcenter', state: hosts.length ? (vc.stale ? 'warn' : 'ok') : 'bad', label: '새 vCenter 접속',
      detail: `${vc.name || vcenterId} · 인벤토리 VM ${vms.length} · 데이터센터 ${dcs.length} · 클러스터 ${clusters.length} · 데이터스토어 ${datastores.length}${vc.stale ? ' · 마지막 수집이 오래됨' : ''}${hosts.length ? '' : ' · 호스트가 없어 복원할 곳이 없습니다'}${re}` });
  }
  // 사이트 매핑(복원 명령에 싣는 값)
  const miss = [];
  if (!site?.vcserver) miss.push('vCenter 주소');
  if (!site?.configFile) miss.push('FD INI 경로');
  if (!site?.client) miss.push('FD 이름');
  // 반증 R2(플러그인 원문 — INI 값이 플러그인 옵션을 덮어쓴다): 실제로 붙는 곳은 FD INI 의 vcserver 다. 포탈 등록 주소와 매핑이 다르면 알린다(INI 는 포탈이 읽지 못한다).
  const regDiff = !miss.length && registryHost && String(site.vcserver).toLowerCase() !== String(registryHost).toLowerCase();
  checks.push(miss.length ? { key: 'site', state: 'bad', label: '사이트 매핑', detail: `${miss.join(' · ')} 이(가) 없습니다 — 설정 › 법인별 설정에서 채우세요(복원 명령에 싣는 값).` }
    : { key: 'site', state: regDiff ? 'warn' : 'ok', label: '사이트 매핑',
      detail: `vCenter ${site.vcserver} · FD ${site.client} · INI ${site.configFile}${regDiff ? ` — 포탈 등록 주소 ${registryHost} 와 다릅니다. 새 vCenter 주소로 맞추세요` : ''} · 실제 접속은 FD INI 의 vcserver 가 우선합니다(플러그인)` });
  // 포탈이 읽지 못하는 것 — 단정하지 않는다
  checks.push({ key: 'fdIni', state: 'unknown', label: 'Bareos FD 의 vCenter 설정(INI) · 백업 때 접속값', detail: '포탈은 FD 의 INI(계정 · 인증서 지문)를 읽지 못합니다 — vCenter 를 다시 설치하면 인증서 지문이 바뀝니다. INI 는 설정 › 법인별 Director 의 FD INI 자동 설정으로 다시 쓰세요. 그리고 플러그인은 디스크를 쓸 때 백업 때 저장한 접속값을 씁니다 — 그래서 먼저 1대를 복원해 성공을 확인한 뒤에 여러 대를 보냅니다(포탈이 막습니다).' });
  checks.push({ key: 'perm', state: 'unknown', label: '포탈 vCenter 계정 권한', detail: '네트워크 끊기에 필요한 권한(장치 설정 · 연결)은 bareos-probe --vcenter 로 확인합니다(읽기 전용).' });
  return { checks, targets: { dcs, clusters, datastores }, counts: { jobs: mine.length, missing, vms: vms.length, hosts: hosts.length } };
}


/**
 * 재해 복구 묶음을 보내기 전 법인 단위 막기(순수 — 라우트 bulkRestoreGate 가 dr 일 때 부른다).
 *   반증 R6: 점검의 ✕(Director · 새 vCenter · 매핑)는 화면만이 아니라 서버도 막는다 · R1: 시험 1대가 성공한 뒤에만 여러 대.
 * @returns {string} 사유('' = 보낼 수 있다)
 */
export function drGateBlock({ items, jobs, settings, snapshot, pollDirs = {}, regHosts = new Map(), lastOkOf, directorOf, now = Date.now() }) {
  const list = Array.isArray(items) ? items : [];
  const vcs = [...new Set(list.map((r) => r.vcenterId).filter(Boolean))];
  for (const vcId of vcs) {
    const site = (settings?.sites || []).find((x) => String(x.vcenterId) === String(vcId)) || null;
    const director = site?.directorId ? directorOf(site.directorId) : null;
    const view = drCheckView({ vcenterId: vcId, snapshot, jobs, site, director, dirPoll: director ? pollDirs[director.id] || null : null, lastOkOf, registryHost: regHosts.get(String(vcId)) || '' });
    const bad = view.checks.find((c) => c.state === 'bad');
    if (bad) return `재해 복구 점검 ✕ — ${bad.label}: ${bad.detail}`;
    const trial = drTrialIssue(jobs, vcId, list.filter((r) => String(r.vcenterId) === String(vcId)).length, now);
    if (trial) return trial;
  }
  return '';
}
