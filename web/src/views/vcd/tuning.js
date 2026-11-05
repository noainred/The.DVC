/**
 * views/vcd/tuning.js — '성능 튜닝' 탭(VM · ESXi 호스트 개체 보기 — v2.895 · 승인 시안 ⑫⑬ · 기본값 11~13).
 *
 * 새 판정을 만들지 않는다 — 이미 있는 판정을 한 자리에 모은다(순수 · vitest 고정):
 *   · 자원 적정화 = 서버 라이트사이징(tools/rightsize.js analyzeRightsize — 정책 · 감축 금지 신호 포함)의 verdict 그대로
 *   · CPU 경합 · 디스크 지연 = `contention/contentionText.js vmContentionFindings`(서버 contention/parse.js 와 같은 규칙)
 *   · 구성 = `vmcfg/vmCfgText.js vmCfgFindings` · `hostcfg/hostCfgText.js hostCfgFindings`
 *   · 가상화율 = `vcdVirt.js ratioLevel`(트리 색과 같은 기준) · 사용률 색 = usageColor(75 · 90) · 데이터스토어 = 포탈 알람 규칙(90 · 95)
 * 축마다 'ok' | 'warn' | 'crit' | 'unknown'. 못 읽은 축은 unknown('—')이고 정상으로 세지 않는다. 점수 · 등급은 만들지 않는다.
 * 조치 계획은 축의 근거에서만 만든다(지어낸 효과 · 수치 없음). 적용은 지금 도구 · vSphere 에서 — 이 탭은 조회 + 계획.
 */
import { numOrNull } from '../../numOrNull.js';
import { unitText } from '../unitText.js';
import { vmContentionFindings, CONTENTION_TEXT, THRESHOLDS } from '../contention/contentionText.js';
import { vmCfgFindings, VM_CFG_TEXT } from '../vmcfg/vmCfgText.js';
import { hostCfgFindings, HOST_CFG_TEXT } from '../hostcfg/hostCfgText.js';
import { ratioLevel } from '../vcdVirt.js';

/** 기간 칩 — 서버 라이트사이징 라우트가 받는 값 중(7 · 30 · 90 · 180 · 365). VM 기본 30일(기본값 12). */
export const VM_TUNING_DAYS = Object.freeze([7, 30, 90]);
export const DEFAULT_VM_TUNING_DAYS = 30;

/** 사용률 단계 — 화면 막대 색(usageColor)과 같은 75 · 90. */
export function usageLevel(pct) {
  const v = numOrNull(pct);
  if (v == null) return null;
  return v >= 90 ? 'crit' : v >= 75 ? 'warn' : 'ok';
}
/** 데이터스토어 사용률 단계 — 포탈 알람 규칙(90 경고 · 95 심각)과 같다. */
export function dsLevel(pct) {
  const v = numOrNull(pct);
  if (v == null) return null;
  return v > 95 ? 'crit' : v > 90 ? 'warn' : 'ok';
}
const worst = (levels) => (levels.includes('crit') ? 'crit' : levels.includes('warn') ? 'warn' : levels.includes('ok') ? 'ok' : 'unknown');
const SEV_TO_LEVEL = { crit: 'crit', warn: 'warn', info: 'ok' };

/** 축 하나. state: ok | warn | crit | unknown. */
const axis = (k, label, state, title, detail) => ({ k, label, state, title, detail });

/**
 * VM 진단 — 5축. rs = 라이트사이징 응답(없으면 null), rsError = 그 조회 실패 문구, dsRows = vmDatastoreRows 결과(없으면 null).
 */
export function vmTuningAxes({ vm, rs = null, rsError = '', rsDenied = false, dsRows = null }) {
  const on = vm?.powerState === 'POWERED_ON';
  const cont = vmContentionFindings(vm);
  const cpuF = cont.filter((f) => f.code.startsWith('cpu-'));
  const diskF = cont.filter((f) => f.code.startsWith('disk-'));
  const measured = !!vm?.perfc && on;
  const out = [];

  // 1) 자원 적정화 — 서버 verdict 그대로
  if (!on) out.push(axis('rightsize', '자원 적정화', 'unknown', '— (꺼짐)', '꺼진 VM 은 사용량 근거가 없어 판정하지 않습니다.'));
  else if (rsDenied) out.push(axis('rightsize', '자원 적정화', 'unknown', '권한 없음', '특수 기능 ‘VM 라이트사이징’ 권한이 없어 조회하지 않았습니다.'));
  else if (rsError) out.push(axis('rightsize', '자원 적정화', 'unknown', '조회 실패', String(rsError).slice(0, 160)));
  else if (!rs) out.push(axis('rightsize', '자원 적정화', 'unknown', '불러오는 중', ''));
  else {
    const st = rs.verdict?.state;
    // 서버 verdict(tools/rightsize.js): reduce(감축 가능) · hold(압박 · 경합 신호로 보류) · keep(유지) · insufficient(근거 불충분).
    const level = st === 'reduce' ? 'warn' : st === 'hold' ? 'warn' : st === 'keep' ? 'ok' : 'unknown';
    const title = st === 'reduce' ? '과다 할당' : st === 'hold' ? '감축 보류(압박 신호)' : st === 'keep' ? '적정' : '근거 불충분';
    out.push(axis('rightsize', '자원 적정화', level, title, rs.verdict?.summary || rs.verdict?.title || ''));
  }

  // 2) CPU 경합 — contention 규칙
  if (!on) out.push(axis('cpu', 'CPU 경합', 'unknown', '— (꺼짐)', ''));
  else if (!measured) out.push(axis('cpu', 'CPU 경합', 'unknown', '측정하지 않음', '수집 서버가 아직 이 VM 의 실시간 통계를 읽지 않았습니다 — ‘경합 없음’ 이 아닙니다.'));
  else {
    const lv = worst(cpuF.map((f) => SEV_TO_LEVEL[f.sev] || 'ok'));
    const p = vm.perfc;
    out.push(axis('cpu', 'CPU 경합', cpuF.length ? lv : 'ok', cpuF.length ? (CONTENTION_TEXT[cpuF[0].code]?.title || cpuF[0].code) : '정상',
      `Ready ${unitText(p.readyPct?.avg, '%')} · Co-stop ${unitText(p.costopPct?.avg, '%')} (경고선 Ready ${THRESHOLDS.readyWarn}% · Co-stop ${THRESHOLDS.costopWarn}%)`));
  }

  // 3) 메모리 압박 — rightsize 의 벌룬 · 스왑(레벨 2 카운터 — 못 읽으면 unknown)
  const bal = rs?.mem?.balloon; const swp = rs?.mem?.swapped;
  const memKnown = rs && ((bal && bal.n > 0) || (swp && swp.n > 0));
  if (!on || !memKnown) {
    out.push(axis('mem', '메모리 압박', 'unknown', '—', on ? '벌룬 · 스왑은 vCenter 통계 수준 2 카운터입니다 — 받은 표본이 없어 판정하지 않습니다.' : ''));
  } else {
    const swapped = (swp?.samplesAbove0 || 0) > 0; const ballooned = (bal?.samplesAbove0 || 0) > 0;
    out.push(axis('mem', '메모리 압박', swapped ? 'crit' : ballooned ? 'warn' : 'ok', swapped ? '스왑 있음' : ballooned ? '벌룬 있음' : '없음',
      `벌룬 최대 ${unitText(bal?.max, ' MB')} · 스왑 최대 ${unitText(swp?.max, ' MB')}`));
  }

  // 4) 스토리지 지연 — contention 디스크 + 데이터스토어 사용률
  const dsLv = (dsRows || []).map((d) => dsLevel(d.dsUsagePct)).filter(Boolean);
  const diskLv = diskF.map((f) => SEV_TO_LEVEL[f.sev] || 'ok');
  const sLevels = [...dsLv, ...diskLv];
  if (!measured && !dsLv.length) out.push(axis('storage', '스토리지 지연', 'unknown', '—', '디스크 지연을 측정하지 않았고 데이터스토어를 아직 대조하지 못했습니다.'));
  else {
    const lv = worst(sLevels.length ? sLevels : ['ok']);
    const p = vm?.perfc;
    out.push(axis('storage', '스토리지 지연', lv, diskF.length ? (CONTENTION_TEXT[diskF[0].code]?.title || '디스크 지연') : lv !== 'ok' ? '데이터스토어 여유 부족' : '정상',
      `${measured ? `읽기 ${unitText(p.readMs?.avg, ' ms')} · 쓰기 ${unitText(p.writeMs?.avg, ' ms')}` : '지연 측정 없음'}${dsRows?.length ? ` · DS ${dsRows.map((d) => `${d.datastore} ${unitText(d.dsUsagePct, '%')}`).join(', ')}` : ''}`));
  }

  // 5) 구성 — vmcfg findings
  if (!vm?.cfg) out.push(axis('config', '구성', 'unknown', '아직 읽지 않음', 'vmcfg 가 아직 이 VM 을 읽지 않았습니다.'));
  else {
    const f = vmCfgFindings(vm);
    const lv = worst(f.map((x) => SEV_TO_LEVEL[x.sev] || 'ok'));
    out.push(axis('config', '구성', f.length ? lv : 'ok', f.length ? `확인 ${f.length}` : '확인할 항목 없음', f.slice(0, 3).map((x) => VM_CFG_TEXT[x.code]?.title || x.code).join(' · ')));
  }
  return out;
}

/**
 * VM 조치 계획 — 축의 근거에서만. 각 행: { k, action, why, risk, where, tool? }(tool 이면 그 특수 기능으로 링크).
 * 순서: 위험(crit) → 주의(warn), 같은 단계에서는 스토리지 · 스냅샷 · 적정화 · 경합 · 구성.
 */
export function vmTuningPlan({ vm, rs = null, dsRows = null, now = Date.now() }) {
  const rows = [];
  const cont = vmContentionFindings(vm);
  const add = (lv, r) => rows.push({ lv, ...r });
  for (const d of dsRows || []) {
    const lv = dsLevel(d.dsUsagePct);
    if (lv === 'warn' || lv === 'crit') add(lv, { k: `ds:${d.datastore}`, action: `데이터스토어 ${d.datastore} 여유 확보(사용률 ${d.dsUsagePct}%)`, why: '여유가 적으면 씬 디스크 증가 · 스냅샷이 실패할 수 있습니다', risk: '이 VM 만의 문제가 아닙니다 — 같은 DS 의 다른 VM 도 함께', where: '데이터스토어 · 경로 점검', tool: 'storage-paths' });
  }
  for (const f of cont.filter((x) => x.code.startsWith('disk-'))) {
    add(SEV_TO_LEVEL[f.sev] || 'warn', { k: f.code, action: `디스크 지연 원인 확인(${f.facts?.disk || '디스크'} 평균 ${unitText(f.facts?.avg, ' ms')})`, why: CONTENTION_TEXT[f.code]?.fix || '', risk: '데이터스토어 쪽 원인이면 이 VM 을 고쳐도 낫지 않습니다', where: 'CPU 경합 · 디스크 지연', tool: 'contention' });
  }
  const oldTs = numOrNull(vm?.snapshotOldestTs);
  const oldDays = oldTs ? Math.floor((now - oldTs) / 86_400_000) : null;
  if ((numOrNull(vm?.snapshotCount) || 0) > 0 && oldDays != null && oldDays > 7) {
    add(oldDays > 30 ? 'warn' : 'warn', { k: 'snapshot', action: `오래된 스냅샷 정리(${vm.snapshotCount}개 · 가장 오래된 것 ${oldDays}일)`, why: '델타 디스크가 쌓이면 쓰기 지연 · 공간이 늘어납니다', risk: '백업 솔루션이 쓰는 스냅샷인지 먼저 확인', where: '스냅샷 나이 감시 · vSphere', tool: 'snapshot-age' });
  }
  if (rs?.verdict?.state === 'reduce') {
    const c = rs.cpu || {}; const m = rs.mem || {};
    const parts = [];
    if (c.reductionVcpu > 0) parts.push(`vCPU ${c.vcpu} → ${c.recommendedVcpu}`);
    if (m.reductionMB > 0) parts.push(`메모리 ${Math.round(m.allocMB / 1024)} → ${Math.round(m.recommendedMB / 1024)} GB`);
    if (parts.length) add('warn', { k: 'rightsize', action: `사양 줄이기 — ${parts.join(' · ')}`, why: rs.verdict.summary || '관측 근거가 정책 기준을 충족합니다', risk: '피크 시각 · 담당자 확인 · 줄이는 데 전원 off 가 필요할 수 있습니다', where: '사양 변경(VM 개체 머리 버튼)', tool: null });
  }
  for (const f of cont.filter((x) => x.code.startsWith('cpu-'))) {
    add(SEV_TO_LEVEL[f.sev] || 'warn', { k: f.code, action: CONTENTION_TEXT[f.code]?.title || f.code, why: CONTENTION_TEXT[f.code]?.fix || '', risk: '호스트 과밀이면 이동(vMotion)은 vSphere 에서', where: 'CPU 경합 · 디스크 지연', tool: 'contention' });
  }
  for (const f of vmCfgFindings(vm).filter((x) => x.sev === 'warn' || x.sev === 'crit')) {
    add(SEV_TO_LEVEL[f.sev], { k: `cfg:${f.code}`, action: VM_CFG_TEXT[f.code]?.title || f.code, why: VM_CFG_TEXT[f.code]?.fix || '', risk: '', where: 'VM 구성 점검', tool: 'vm-hygiene' });
  }
  // v2.899: 구형 네트워크 어댑터 → VMXNET3(구성 점검에서는 '정보' 등급이지만 튜닝 계획에서는 성능 권장이라 주의로 올린다).
  const nicF = vmCfgFindings(vm).find((x) => x.code === 'nic-legacy');
  if (nicF) {
    add('warn', { k: 'cfg:nic-legacy', action: `네트워크 어댑터를 VMXNET3 로 — ${(nicF.facts.adapters || []).join(' · ')} ${nicF.facts.count}개`,
      why: VM_CFG_TEXT['nic-legacy'].fix, risk: '어댑터 교체는 게스트 안 NIC 이름 · IP 설정을 바꿀 수 있습니다 — 점검 창에서 · 콘솔 접근을 확보한 뒤', where: 'VM 사양 변경(vSphere) · VM 개체 › 네트워크 탭', tool: null });
  }
  return rows.sort((a, b) => (a.lv === b.lv ? 0 : a.lv === 'crit' ? -1 : b.lv === 'crit' ? 1 : 0));
}

/**
 * 호스트 진단 — 5축. vcpuAlloc = 이 호스트 위 VM vCPU 합(호출부의 'Off VM 포함' 기준), onHost = 이 호스트 VM, dsRows = hostDatastoresFromVms.rows.
 */
export function hostTuningAxes({ host, vcpuAlloc = null, memAllocMB = null, onHost = [], dsRows = [] }) {
  const out = [];
  const down = host?.connectionState === 'DISCONNECTED' || host?.connectionState === 'NOT_RESPONDING';
  const cores = numOrNull(host?.cpuCores);
  const ratio = cores && vcpuAlloc != null ? vcpuAlloc / cores : null;
  const cpuLv = down ? null : usageLevel(host?.cpuUsagePct);
  const rLv = ratioLevel(ratio, false);
  if (down) out.push(axis('cpu', 'CPU 여력 · 가상화율', 'unknown', '— (끊김)', '연결이 끊긴 호스트는 판정하지 않습니다.'));
  else out.push(axis('cpu', 'CPU 여력 · 가상화율', worst([cpuLv, rLv].filter(Boolean)), ratio != null ? `${(Math.round(ratio * 10) / 10).toFixed(1)}:1` : '—',
    `vCPU ${vcpuAlloc ?? '—'} / 코어 ${cores ?? '—'} · 사용 ${unitText(numOrNull(host?.cpuUsagePct), '%')} (가상화율 2.5 주의 · 4 위험 — 트리와 같은 기준)`));

  const ready = onHost.filter((v) => vmContentionFindings(v).some((f) => f.code === 'cpu-ready' || f.code === 'cpu-ready-crit'));
  const measuredN = onHost.filter((v) => v?.powerState === 'POWERED_ON' && v?.perfc).length;
  if (!measuredN) out.push(axis('contention', 'CPU 경합(VM)', 'unknown', '측정하지 않음', '이 호스트 VM 의 실시간 통계를 아직 읽지 않았습니다.'));
  else out.push(axis('contention', 'CPU 경합(VM)', ready.some((v) => vmContentionFindings(v).some((f) => f.code === 'cpu-ready-crit')) ? 'crit' : ready.length ? 'warn' : 'ok',
    ready.length ? `Ready 높은 VM ${ready.length}` : '정상', `측정한 켜진 VM ${measuredN}대 중 Ready 경고선(${THRESHOLDS.readyWarn}%) 이상 ${ready.length}대`));

  const memLv = down ? null : usageLevel(host?.memUsagePct);
  const memTotal = numOrNull(host?.memTotalMB);
  const mRatio = memTotal && memAllocMB != null ? memAllocMB / memTotal : null;
  if (down) out.push(axis('mem', '메모리', 'unknown', '— (끊김)', ''));
  else out.push(axis('mem', '메모리', worst([memLv, ratioLevel(mRatio, true)].filter(Boolean)), `${unitText(numOrNull(host?.memUsagePct), '%')}`,
    `할당 ${unitText(memAllocMB != null ? Math.round(memAllocMB / 1024) : null, ' GB')} / 물리 ${unitText(memTotal ? Math.round(memTotal / 1024) : null, ' GB')}${mRatio != null ? ` · ${(Math.round(mRatio * 10) / 10).toFixed(1)}:1` : ''} · 호스트 벌룬 · 스왑 합은 수집하지 않습니다`));

  const hf = down ? [] : hostCfgFindings(host);
  const pathF = hf.filter((f) => /^mp-|^vsan-/.test(f.code));
  const dsBad = dsRows.filter((d) => ['warn', 'crit'].includes(dsLevel(d.usagePct)));
  const sLv = worst([...pathF.map((f) => SEV_TO_LEVEL[f.sev] || 'ok'), ...dsBad.map((d) => dsLevel(d.usagePct)), 'ok']);
  out.push(axis('storage', '스토리지 · 경로', host?.hcfg || dsRows.length ? sLv : 'unknown', pathF.length ? (HOST_CFG_TEXT[pathF[0].code]?.title || pathF[0].code) : dsBad.length ? `여유 부족 DS ${dsBad.length}` : (host?.hcfg ? '정상' : '—'),
    `${pathF.length ? `경로 · vSAN 항목 ${pathF.length}` : '경로 항목 없음'} · VM 디스크가 있는 DS ${dsRows.length}개 중 90% 초과 ${dsBad.length}개`));

  const netF = hf.filter((f) => /^net-/.test(f.code));
  const nicDown = (host?.nics || []).filter((n) => n && n.link === false && (n.maxSpeedMb || 0) > 0);
  const nLevels = [...netF.map((f) => SEV_TO_LEVEL[f.sev] || 'ok'), ...(nicDown.length ? ['warn'] : [])];
  out.push(axis('net', '네트워크 · 하드웨어', host?.hcfg || (host?.nics || []).length ? worst([...nLevels, 'ok']) : 'unknown',
    netF.length || nicDown.length ? `확인 ${netF.length + (nicDown.length ? 1 : 0)}` : (host?.hcfg ? '정상' : '—'),
    `${nicDown.length ? `down NIC ${nicDown.map((n) => n.device).join(', ')}` : 'down NIC 없음'}${netF.length ? ` · ${netF.map((f) => HOST_CFG_TEXT[f.code]?.title || f.code).join(' · ')}` : ''}`));
  return out;
}

/** 호스트 조치 계획 — 축의 근거에서만. */
export function hostTuningPlan({ host, onHost = [], dsRows = [], vcpuAlloc = null }) {
  const rows = [];
  const add = (lv, r) => rows.push({ lv, ...r });
  const hf = hostCfgFindings(host);
  for (const f of hf.filter((x) => /^mp-|^vsan-|^net-/.test(x.code) && (x.sev === 'warn' || x.sev === 'crit'))) {
    add(SEV_TO_LEVEL[f.sev], { k: f.code, action: HOST_CFG_TEXT[f.code]?.title || f.code, why: HOST_CFG_TEXT[f.code]?.fix || '', risk: '복구 · 재스캔은 vSphere · 스토리지/네트워크 팀', where: 'ESXi 호스트 구성 점검', tool: 'host-hygiene' });
  }
  for (const d of dsRows.filter((x) => ['warn', 'crit'].includes(dsLevel(x.usagePct)))) {
    add(dsLevel(d.usagePct), { k: `ds:${d.datastore}`, action: `데이터스토어 ${d.datastore} 여유 확보(사용률 ${d.usagePct}%)`, why: `이 호스트 VM ${d.vms}대의 디스크가 있습니다`, risk: '같은 DS 를 쓰는 다른 호스트의 VM 도 함께', where: '데이터스토어 · 경로 점검', tool: 'storage-paths' });
  }
  const cores = numOrNull(host?.cpuCores);
  const ratio = cores && vcpuAlloc != null ? vcpuAlloc / cores : null;
  const rl = ratioLevel(ratio, false);
  if (rl === 'warn' || rl === 'crit') {
    add(rl, { k: 'ratio', action: `vCPU 가상화율 낮추기(${(Math.round(ratio * 10) / 10).toFixed(1)}:1)`, why: '과다 할당 VM 의 vCPU 를 줄이면 Ready · Co-stop 이 내려갑니다', risk: 'VM 마다 담당 확인 — 각 VM 의 성능 튜닝 탭에서 근거를 봅니다', where: 'Optimization · VM 개체 › 성능 튜닝', tool: 'waste' });
  }
  const ready = onHost.filter((v) => vmContentionFindings(v).some((f) => f.code === 'cpu-ready' || f.code === 'cpu-ready-crit'));
  if (ready.length) {
    add(ready.some((v) => vmContentionFindings(v).some((f) => f.code === 'cpu-ready-crit')) ? 'crit' : 'warn',
      { k: 'ready', action: `CPU 대기(Ready) 높은 VM ${ready.length}대 — ${ready.slice(0, 3).map((v) => v.name).join(', ')}${ready.length > 3 ? ' 외' : ''}`, why: CONTENTION_TEXT['cpu-ready'].fix, risk: '이동(vMotion · DRS)은 vSphere 에서', where: 'CPU 경합 · 디스크 지연', tool: 'contention' });
  }
  return rows.sort((a, b) => (a.lv === b.lv ? 0 : a.lv === 'crit' ? -1 : b.lv === 'crit' ? 1 : 0));
}

/** 같은 호스트의 무거운 VM — CPU 사용률(MHz 근사 = 사용률 × vCPU) 순 상위 n. 꺼진 VM · 사용률 모름은 뺀다. */
export function heavyNeighbors(onHost, n = 5) {
  return (Array.isArray(onHost) ? onHost : [])
    .filter((v) => v?.powerState === 'POWERED_ON' && numOrNull(v.cpuUsagePct) != null)
    .map((v) => ({ v, load: numOrNull(v.cpuUsagePct) * (numOrNull(v.cpuCount) || 1) }))
    .sort((a, b) => b.load - a.load).slice(0, n).map((x) => x.v);
}

/** 체크리스트 내보내기(사람이 들고 가는 목록 — 저장 없음 · 기본값 11). CSV 는 BOM 을 붙여 엑셀 한글이 깨지지 않게. */
const csvCell = (v) => { const s = String(v ?? ''); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
export function planCsv(rows, title = '') {
  const head = ['#', '단계', '조치', '근거', '위험 · 조건', '어디서', '상태'];
  const lv = { crit: '위험', warn: '주의', ok: '참고' };
  const lines = [head.join(',')];
  rows.forEach((r, i) => lines.push([i + 1, lv[r.lv] || r.lv, r.action, r.why, r.risk, r.where, '대기'].map(csvCell).join(',')));
  return `﻿${title ? `${csvCell(title)}\n` : ''}${lines.join('\n')}\n`;
}
export function planMarkdown(rows, title = '') {
  const lv = { crit: '위험', warn: '주의', ok: '참고' };
  const out = [title ? `## ${title}` : '', ''];
  rows.forEach((r, i) => out.push(`- [ ] ${i + 1}. [${lv[r.lv] || r.lv}] ${r.action} — ${r.why}${r.risk ? ` (위험 · 조건: ${r.risk})` : ''} · 어디서: ${r.where}`));
  return `${out.join('\n')}\n`;
}
