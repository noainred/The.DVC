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
export function drCheckView({ vcenterId, snapshot, jobs, site, director, dirPoll, lastOkOf }) {
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
  checks.push(miss.length ? { key: 'site', state: 'bad', label: '사이트 매핑', detail: `${miss.join(' · ')} 이(가) 없습니다 — 설정 › 법인별 설정에서 채우세요(복원 명령에 싣는 값).` }
    : { key: 'site', state: 'ok', label: '사이트 매핑', detail: `vCenter ${site.vcserver} · FD ${site.client} · INI ${site.configFile}` });
  // 포탈이 읽지 못하는 것 — 단정하지 않는다
  checks.push({ key: 'fdIni', state: 'unknown', label: 'Bareos FD 의 vCenter 설정(INI)', detail: '포탈은 FD 의 INI(계정 · 인증서 지문)를 읽지 못합니다 — vCenter 를 다시 설치하면 인증서 지문이 바뀝니다. 설정 › 법인별 Director 의 FD INI 자동 설정으로 다시 쓰거나, 아래에서 1대를 먼저 복원해 확인하세요.' });
  checks.push({ key: 'perm', state: 'unknown', label: '포탈 vCenter 계정 권한', detail: '네트워크 끊기에 필요한 권한(장치 설정 · 연결)은 bareos-probe --vcenter 로 확인합니다(읽기 전용).' });
  return { checks, targets: { dcs, clusters, datastores }, counts: { jobs: mine.length, missing, vms: vms.length, hosts: hosts.length } };
}

