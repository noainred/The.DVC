/**
 * views/veeamBadge.js — vCenter › VM 및 폴더 'Veeam 백업 VM 표시'(v2.751)의 배지·요약 문구(순수 — vitest 고정).
 *
 * 서버 `/api/veeam/badges` 응답: { configured, demo?, servers:[{name, ok, ts, lastOkTs, error, authStopped, notes, counts}],
 *   byVm: { [vmId]: { jobs[], run:0|1|2, pg, by:'task'|'job'|'', rp, lastRun, lastResult, servers[] } }, unmatched, otherVcenter, ambiguous }
 *
 * 문구 규약(CLAUDE.md 화면 규약):
 *  · 배지가 없는 VM 을 '백업 안 됨' 으로 단정하지 않는다 — 폴더·클러스터·태그 단위 작업에 든 VM 은 복원 지점이 생기기 전에는 VM 단위로
 *    보이지 않고, Veeam 이 적은 이름·vCenter 가 다르면 맞추지 못한다. 요약은 '표시 없음 = 확인되지 않음' 이라 말한다.
 *  · 값이 없으면 단위를 붙이지 않는다(진행률 null → '%' 없음). 백틱 금지 · 강조는 **만.
 */

/** 'YYYY-MM-DD HH:mm'(상세 창·툴팁 공용 — 화면마다 다른 날짜 모양을 쓰지 않는다). 값이 없으면 ''. */
export const fmtTime = (ms) => {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 결과 판정 한글(Veeam lastResult). 모르는 값은 원문. */
export function resultLabel(r) {
  const t = String(r || '');
  if (/^success$/i.test(t)) return '성공';
  if (/^warning$/i.test(t)) return '경고';
  if (/^failed$/i.test(t)) return '실패';
  if (!t || /^none$/i.test(t)) return '';
  return t;
}

/** 'MM-DD HH:mm'(배지 칸이 좁다 — 연도는 툴팁·상세 창에). 값이 없으면 ''. */
export function shortTime(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * VM 한 대의 배지. 없으면 null. progress 는 '백업 중' 일 때 진행률(0~100, 모르면 null — 막대를 그리지 않는다).
 * v2.751 사용자 요청: 'Veeam' 배지에 **백업이 완료된 날짜·시간** — 마지막 task 가 성공·경고로 끝난 시각(lbSrc 'task'),
 *   그것을 모르면 최신 복원 지점이 만들어진 시각(lbSrc 'rp' — 완료 시각이 아니라고 툴팁이 말한다).
 * @returns {null|{label:string, color:'green'|'amber'|'blue', title:string, progress:(number|null)}}
 */
export function veeamBadge(e) {
  if (!e || typeof e !== 'object') return null;
  const jobs = Array.isArray(e.jobs) ? e.jobs.filter((x) => typeof x === 'string' && x) : [];
  const lines = [];
  if (Number.isFinite(e.lb)) lines.push(e.lbSrc === 'rp' ? `최신 복원 지점 생성: ${fmtTime(e.lb)}(완료 시각은 Veeam 이 VM 단위로 알려 주지 않았습니다)` : `마지막 백업 완료: ${fmtTime(e.lb)}`);
  if (jobs.length) lines.push(`작업: ${jobs.slice(0, 5).join(', ')}${jobs.length > 5 ? ` 외 ${jobs.length - 5}개` : ''}`);
  const lr = fmtTime(e.lastRun);
  const res = resultLabel(e.lastResult);
  if (lr) lines.push(`작업 마지막 실행: ${lr}${res ? ` (${res})` : ''}`);
  if (Number.isFinite(e.rp) && e.rp > 0) lines.push(`복원 지점 ${e.rp}개`);
  else if (e.rp === -1) lines.push('복원 지점 있음(개수 모름)');
  if (Array.isArray(e.servers) && e.servers.length) lines.push(`Veeam 서버: ${e.servers.join(', ')}`);
  if (e.ag === 1) lines.push('에이전트 백업 — Veeam 이 vCenter 정보를 주지 않아 컴퓨터 이름으로 이 VM 과 맞췄습니다');
  lines.push('누르면 백업 상세(복원 지점·용량·마지막 결과)를 엽니다');
  if (e.run === 1) {
    const pg = Number.isFinite(e.pg) ? e.pg : null;
    const how = e.by === 'job' ? 'Veeam 작업이 실행 중입니다(이 VM 차례인지는 Veeam 이 VM 단위로 알려 주지 않았습니다)' : 'Veeam 이 이 VM 을 지금 백업하고 있습니다';
    return { label: pg != null ? `백업 중 ${pg}%` : '백업 중', color: 'amber', title: [how, ...lines].join('\n'), progress: pg };
  }
  if (e.run === 2) return { label: '대기', color: 'blue', title: ['Veeam 실행 중인 작업에서 차례를 기다리고 있습니다', ...lines].join('\n'), progress: null };
  const when = shortTime(e.lb);
  return { label: when ? `Veeam ${when}` : 'Veeam', color: 'green', title: ['Veeam 백업 대상(작업 포함 또는 복원 지점 있음)', ...lines].join('\n'), progress: null };
}

/** 배지 집계 — 화면 요약 줄. */
export function veeamCounts(byVm) {
  let total = 0; let running = 0; let pending = 0;
  for (const e of Object.values(byVm || {})) {
    if (!e || typeof e !== 'object') continue;
    total++;
    if (e.run === 1) running++; else if (e.run === 2) pending++;
  }
  return { total, running, pending };
}

/**
 * 요약 카드(v2.751 시안 — 체크했을 때만 보인다). tone: ok | warn | muted.
 * @param {object|null} d   /api/veeam/badges 응답
 * @param {{loading?:boolean, error?:string, vmTotal?:number}} o
 * @returns {{ tone:string, kind:'loading'|'error'|'unconfigured'|'ok', text:string, stats:null|{total:number, running:number, pending:number, vmTotal:(number|null)},
 *   source:string, basis:string, warnings:string[], details:string[], demo:boolean }}
 */
export function veeamSummary(d, { loading = false, error = '', vmTotal = null } = {}) {
  const base = { stats: null, source: '', basis: '', warnings: [], details: [], demo: false };
  if (error) return { ...base, tone: 'warn', kind: 'error', text: `Veeam 백업 상태를 읽지 못했습니다(백업이 없다는 뜻이 아닙니다): ${error}` };
  if (!d) return { ...base, tone: 'muted', kind: 'loading', text: loading ? 'Veeam 백업 상태를 읽는 중…' : '' };
  if (!d.configured) return { ...base, tone: 'muted', kind: 'unconfigured', text: '이 vCenter 에 연결된 Veeam 서버가 없습니다 — 설정 › vCenter 관리 › Veeam 백업 서버에서 등록하세요. 지금은 vCenter 스냅샷 기준 배지(📸 점선)만 보입니다.' };
  const c = veeamCounts(d.byVm);
  const servers = Array.isArray(d.servers) ? d.servers : [];
  const warnings = []; const details = [];
  for (const sv of servers) {
    if (sv.ok === false) {
      const last = sv.lastOkTs ? ` — 표시는 마지막 성공(${fmtTime(sv.lastOkTs)}) 기준입니다` : ' — 아직 성공한 적이 없어 이 서버의 VM 은 표시되지 않습니다';
      warnings.push(`${sv.name} ${sv.authStopped ? '인증 실패로 주기 수집을 멈췄습니다' : '읽기 실패'}: ${sv.error || '사유 미상'}${last}`);
    } else if (sv.ok == null) details.push(`${sv.name}: 아직 읽은 결과가 없습니다(담당 노드의 첫 수집을 기다리는 중)`);
    for (const n of Array.isArray(sv.notes) ? sv.notes : []) details.push(`${sv.name}: ${n}`);
  }
  if (d.otherVcenter) details.push(`Veeam 이 다른 vCenter 로 적은 VM ${d.otherVcenter}개는 이 목록에 표시하지 않았습니다(같은 Veeam 이 여러 vCenter 를 백업하면 정상)`);
  if (d.ambiguous) details.push(`이름이 같은 VM 이 둘 이상이라 고르지 못한 항목 ${d.ambiguous}개`);
  if (d.unmatched) details.push(`이 vCenter 에서 찾지 못한 Veeam 항목 ${d.unmatched}개(삭제·이름 변경된 VM 일 수 있습니다)`);
  const when = servers.map((sv) => sv.lastOkTs).filter((x) => Number.isFinite(x));
  return {
    tone: warnings.length ? 'warn' : 'ok', kind: 'ok', text: '',
    stats: { total: c.total, running: c.running, pending: c.pending, vmTotal: Number.isFinite(vmTotal) ? vmTotal : null },
    source: servers.length ? `서버 ${servers.map((sv) => sv.name).join(', ')}` : '',
    basis: when.length ? `기준 ${fmtTime(Math.min(...when))}` : '',
    warnings, details, demo: !!d.demo,
  };
}

/** 바이트 → 사람이 읽는 값(TB 까지). 못 읽은 값은 '—'(0 은 0 B). */
export function sizeText(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Number(n); let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
/** 초 → 'N시간 M분' · 'M분 S초'. 없으면 '—'. */
export function durationText(sec) {
  if (sec == null || !Number.isFinite(Number(sec)) || sec < 0) return '—';
  const s0 = Math.round(Number(sec));
  const h = Math.floor(s0 / 3600); const m = Math.floor((s0 % 3600) / 60); const r = s0 % 60;
  return h ? `${h}시간 ${m}분` : m ? `${m}분${r ? ` ${r}초` : ''}` : `${r}초`;
}

/**
 * 상세 창의 구획(순수 — 화면은 이것을 그대로 그린다). 값이 없으면 '—' 와 그 이유를 note 에 적는다(지어내지 않는다).
 * @returns {{ status:{tone:string,text:string,progress:(number|null)}, sections:Array<{title:string, rows:Array<[string,string]>, note?:string}>,
 *   recent:number[], backups:object[], jobs:object[] }}
 */
export function veeamDetailView(detail) {
  if (!detail) return { status: { tone: 'muted', text: '이 VM 에 대한 Veeam 백업 정보가 없습니다 — 백업 대상이 아니거나, 폴더·태그 단위 작업에 들어 있어 아직 복원 지점이 없을 수 있습니다(백업 안 됨으로 단정하지 않습니다).', progress: null }, sections: [], recent: [], backups: [], jobs: [] };
  let status;
  if (detail.running) status = { tone: 'amber', text: detail.running.by === 'job' ? 'Veeam 작업이 실행 중입니다(이 VM 차례인지는 모릅니다)' : `지금 백업하고 있습니다${Number.isFinite(detail.running.progress) ? ` · ${detail.running.progress}%` : ''}`, progress: Number.isFinite(detail.running.progress) ? detail.running.progress : null };
  else if (detail.pending) status = { tone: 'blue', text: '실행 중인 작업에서 차례를 기다리고 있습니다', progress: null };
  else status = { tone: 'green', text: detail.lastBackup ? `${detail.lastBackupSrc === 'rp' ? '최신 복원 지점' : '마지막 백업 완료'} ${fmtTime(detail.lastBackup)}` : 'Veeam 백업 대상입니다', progress: null };
  if (detail.agent) status = { ...status, text: `${status.text} · 에이전트 백업(컴퓨터 이름으로 맞춤)` };
  const lt = detail.lastTask;
  const sections = [];
  sections.push({
    title: '마지막 백업',
    rows: lt ? [
      ['결과', resultLabel(lt.result) || '—'], ['작업', lt.job || '—'], ['시작', fmtTime(lt.start) || '—'], ['완료', fmtTime(lt.end) || '—'],
      ['소요 시간', durationText(lt.durationSec)], ['처리한 데이터', sizeText(lt.processed)], ['읽은 데이터', sizeText(lt.read)], ['전송한 데이터', sizeText(lt.transferred)],
      ...(lt.message ? [['메시지', lt.message]] : []),
    ] : [['완료 시각', fmtTime(detail.lastBackup) || '—']],
    note: lt ? (lt.processed == null && lt.read == null && lt.transferred == null ? 'Veeam 이 이 판의 REST 응답에 VM 별 처리 용량을 주지 않았습니다.' : '') : 'Veeam 이 이 VM 의 마지막 작업 결과(task)를 주지 않아 복원 지점 시각만 보여 줍니다.',
  });
  const rp = detail.restorePoints || {};
  sections.push({
    title: '복원 지점',
    rows: [['개수', rp.count != null ? `${rp.count}개` : '—'], ['가장 최근', fmtTime(rp.latest) || '—'], ['가장 오래된', fmtTime(rp.oldest) || '—']],
    note: rp.count == null ? '복원 지점 목록을 읽지 못했습니다.' : '',
  });
  sections.push({
    title: '용량',
    rows: [['이 VM 의 백업 파일 합', sizeText(detail.vmSize)]],
    note: detail.vmSize == null ? 'VM 별 용량은 VM 마다 따로 저장하는 백업 파일(per-machine)일 때만 알 수 있습니다. 아래 백업(체인) 용량은 같은 작업의 다른 VM 과 공유합니다.' : '',
  });
  return { status, sections, recent: Array.isArray(rp.recent) ? rp.recent : [], backups: Array.isArray(detail.backups) ? detail.backups : [], jobs: Array.isArray(detail.jobs) ? detail.jobs : [] };
}

/* ── vCenter 스냅샷 기준(v2.753 사용자 요청 — Veeam 연동 없이, 메모는 보지 않고 스냅샷으로만) ───────────────────────── */

/** Veeam 이 백업하는 동안만 두는 임시 스냅샷 이름(Veeam KB1790). 서버 vcenter/soapParse.js VEEAM_SNAP_NAME 과 같은 값. */
export const VEEAM_SNAP_NAME = 'VEEAM BACKUP TEMPORARY SNAPSHOT';
/** 이보다 오래 남은 임시 스냅샷은 '백업 중' 이 아니라 '잔존(정리 실패 의심)' 으로 본다. 큰 VM 의 백업이 하룻밤을 넘는 일은 드물다. */
export const VEEAM_SNAP_STALE_MS = 24 * 3_600_000;

const ageText = (ms) => {
  const h = Math.floor(ms / 3_600_000);
  return h < 48 ? `${Math.max(1, h)}시간` : `${Math.floor(h / 24)}일`;
};

/**
 * VM 1대의 스냅샷 배지 — Veeam 임시 스냅샷이 없으면 null. Veeam 서버 배지(veeamBadge)와 **다른 모양**으로 그린다(사용자 요청):
 * 근거가 다르다 — 이것은 vCenter 가 보여 준 스냅샷 이름뿐이고, 백업 성공·이력은 알 수 없다.
 * @param {{veeamSnaps?:number, veeamSnapTs?:number|null}} vm
 */
export function veeamSnapBadge(vm, now = Date.now()) {
  const n = Number(vm?.veeamSnaps);
  if (!(n > 0)) return null;
  const ts = Number.isFinite(vm.veeamSnapTs) ? vm.veeamSnapTs : null;
  const age = ts != null ? Math.max(0, now - ts) : null;
  const stale = age != null && age >= VEEAM_SNAP_STALE_MS;
  const lines = [
    'vCenter 스냅샷 기준 — Veeam 서버에서 확인한 값이 아닙니다',
    `‘${VEEAM_SNAP_NAME}’${n > 1 ? ` ${n}개` : ''} · ${ts != null ? `생성 ${fmtTime(ts)}` : '생성 시각 모름'}`,
  ];
  if (stale) {
    lines.push(`만든 지 ${ageText(age)}이 지났습니다 — 백업이 끝났는데 Veeam 이 지우지 못한 잔재일 수 있습니다(Veeam KB1790). 남아 있는 동안 델타 디스크가 커지므로 확인하세요.`);
  } else {
    lines.push('Veeam 이 지금 이 VM 을 백업하고 있을 가능성이 큽니다. 백업 성공 여부와 지난 백업 이력은 스냅샷으로 알 수 없습니다.');
  }
  lines.push('vCenter 수집 주기 사이에 시작해 끝난 백업은 보이지 않습니다.');
  return { label: stale ? `📸 스냅샷 잔존 ${ageText(age)}` : '📸 백업 중', color: stale ? 'red' : 'purple', title: lines.join('\n'), stale, ts };
}

/** 스냅샷 배지 집계(요약 줄). */
export function veeamSnapCounts(vms, now = Date.now()) {
  let running = 0; let stale = 0;
  for (const v of Array.isArray(vms) ? vms : []) {
    const b = veeamSnapBadge(v, now);
    if (!b) continue;
    if (b.stale) stale++; else running++;
  }
  return { running, stale };
}

/* ── vCenter 이벤트 기준(v2.754 — 지금 스냅샷이 없어도 최근 Veeam 백업을 본다) ───────────────────────────────────── */

/**
 * VM 1대의 이벤트 배지 — 그 VM 에 최근 N일 'Veeam 계정이 만든 스냅샷 생성 이벤트' 가 없으면 null.
 * @param {[number, number]|null} entry  [마지막 시각, 횟수] (서버 /veeam/snap-events byVm 값)
 */
export function veeamEventBadge(entry, { days = 7, source = 'local' } = {}) {
  if (!Array.isArray(entry) || !Number.isFinite(entry[0])) return null;
  const [ts, n] = entry;
  const lines = [
    'vCenter 이벤트 기준 — Veeam 서버에서 확인한 값이 아닙니다',
    `Veeam 이 백업을 시도한(스냅샷을 만든) 마지막 시각: ${fmtTime(ts)}`,
    `최근 ${days}일 ${Number.isInteger(n) ? n : '?'}번`,
    '백업 성공 여부는 이벤트로 알 수 없습니다(스냅샷 생성은 백업 시작 단계입니다).',
  ];
  if (source === 'edge') lines.push('이 vCenter 를 수집하는 엣지가 보낸 요약입니다.');
  // v2.754 검토 #3: 녹색은 '성공' 으로 읽힌다 — 중립색(하늘색 점선). 성공은 Veeam 서버 배지(채운 녹색)만 말한다.
  return { label: `📸 ${shortTime(ts)}`, color: 'sky', title: lines.join('\n'), ts };
}

/** 이벤트 조회 상태 → 요약 줄 문구(ok 가 아니면 이유 — 이벤트가 없다고 '백업 없음' 으로 말하지 않는다). */
export function veeamEventStatusText(d) {
  if (!d) return '';
  const why = {
    'log-off': '이 포탈의 vCenter 이벤트 수집이 꺼져 있어 이벤트 기준으로는 볼 수 없습니다(설정 › vCenter 로그).',
    'severity-filter': 'vCenter 이벤트를 경고 이상만 저장하도록 설정돼 스냅샷(정보) 이벤트가 없습니다(설정 › vCenter 로그 › 최소 심각도).',
    'not-collected': '이 vCenter 는 지금 이벤트를 수집하지 않습니다(비활성·점검 중).',
    'no-edge-data': '이 vCenter 를 수집하는 엣지가 아직 이벤트 요약을 보내지 않았습니다 — 엣지가 이 버전 이상이고 개별 토큰을 쓰는지 확인하세요(중앙이 재시작한 직후라면 다음 push 까지 기다리세요).',
    'no-inventory': '이 vCenter 의 VM 목록을 아직 수집하지 않았습니다(포탈 시작 직후 등) — 수집이 끝나면 보입니다.',
    preparing: '최근 Veeam 스냅샷 이벤트를 전용 DB 로 옮기는 중입니다(업그레이드 뒤 한 번 · 몇 분) — 끝나면 바로 보입니다.',
    'stale-edge': `이 vCenter 를 수집하는 엣지의 이벤트 요약이 오래됐습니다(마지막 ${fmtTime(d.at) || '—'}) — 엣지가 멈췄거나 담당이 바뀌었을 수 있어 표시하지 않습니다.`,
  };
  if (d.status && d.status !== 'ok') return why[d.status] || '이벤트 기준 정보를 받지 못했습니다.';
  const notes = [];
  // 검토 #6: 0대를 '백업 없음' 으로 읽지 않게 — 계정을 모르거나 이벤트 수집이 멈췄으면 그 사실을 말한다.
  if (d.accounts === 0 && !Object.keys(d.byVm || {}).length) notes.push('Veeam 계정을 아직 모릅니다 — Veeam 이 쓰는 vCenter 계정 이름에 veeam 이 없으면 설정 › Veeam 백업 서버에 적으세요(지금 백업 중인 VM 이 2대 이상 보이면 자동으로 배웁니다).');
  if (Number.isFinite(d.collectedAt) && Number.isFinite(d.at) && d.at - d.collectedAt > 6 * 3_600_000) notes.push(`vCenter 이벤트를 마지막으로 수집한 시각이 ${fmtTime(d.collectedAt)} 입니다 — 그 뒤의 백업은 아직 반영되지 않았습니다.`);
  if (d.truncated) notes.push('이벤트가 많아 일부만 읽었습니다.');
  // v2.755: 공용 계정(administrator@vsphere.local 등 — 사람도 같이 쓴다)은 '만들고 12시간 안에 같은 계정이 지운' 스냅샷만 센다.
  if (d.unpaired > 0) notes.push(`공용 계정(administrator 등)이 만들고 12시간 안에 지우지 않은 스냅샷 ${d.unpaired}건은 사람이 만든 것일 수 있어 세지 않았습니다(지금 백업 중이면 보라 배지로 보입니다).`);
  return notes.join(' ');
}

/* ── vCenter 카드의 'VM 백업 수량'(v2.757 — 서버 /veeam/backup-counts byVc 값) ─────────────────────────────────── */

const BACKUP_REASON = {
  'veeam-pending': 'Veeam 서버의 첫 수집을 기다리는 중입니다.',
  'no-inventory': '이 vCenter 의 VM 목록을 아직 수집하지 않았습니다(포탈 시작 직후 등) — 수집이 끝나면 보입니다.',
  preparing: '최근 Veeam 스냅샷 이벤트를 전용 DB 로 옮기는 중입니다(업그레이드 뒤 한 번 · 몇 분) — 끝나면 바로 보입니다.',
  'veeam-failed': 'Veeam 서버를 아직 한 번도 읽지 못했습니다 — 설정 › Veeam 백업 서버에서 상태를 확인하세요.',
  'no-account': 'Veeam 이 쓰는 vCenter 계정을 아직 모릅니다 — 계정 이름에 veeam 이 없으면 설정 › Veeam 백업 서버에 적으세요.',
};

/**
 * 카드의 백업 칸 — 'n/전체' 형식(사용자 지정). 모르면 '—'(0 으로 쓰지 않는다) · 부분 값은 '*' 와 노란 칸.
 * tone: veeam(채운 녹색) | snap(하늘색 점선) | warn(부분) | none(모름). entry 가 없으면 null(칸을 그리지 않는다).
 * @param {object|null} e  byVc[vcenterId]
 * @param {number|null} vmFallback  서버가 전체 VM 수를 못 줬을 때 카드의 VM 수
 */
export function backupCell(e, vmFallback = null, now = Date.now()) {
  if (!e || typeof e !== 'object' || (e.src !== 'veeam' && e.src !== 'snap')) return null;
  const veeam = e.src === 'veeam';
  const total = Number.isFinite(e.vmTotal) ? e.vmTotal : (Number.isFinite(vmFallback) ? vmFallback : null);
  const label = veeam ? '백업 · Veeam' : '백업 · 스냅샷';
  if (!Number.isFinite(e.n)) {
    let why = BACKUP_REASON[e.reason];
    if (!why && e.reason === 'stale-events') why = `vCenter 이벤트를 마지막으로 수집한 시각이 ${fmtTime(e.collectedAt) || '—'} 입니다 — 그 뒤의 백업이 빠진 값이라 수량을 표시하지 않습니다.`;
    if (!why) why = veeamEventStatusText({ status: e.reason, at: e.at }) || '백업 정보를 읽지 못했습니다.';
    const lines = [`${veeam ? 'Veeam 기준' : '스냅샷 기준'} 백업 수량을 알 수 없습니다(0대가 아닙니다)`, why];
    if (!veeam && e.snapNow > 0) lines.push(`지금 Veeam 임시 스냅샷이 있는 VM ${e.snapNow}대`);
    return { text: '—', label: veeam ? label : '백업 · 확인 불가', tone: 'none', title: lines.join('\n') };
  }
  const text = `${e.n}/${total ?? '—'}${e.partial ? ' *' : ''}`;
  const lines = [];
  if (veeam) {
    lines.push(`Veeam 백업 ${e.n}대${total != null ? ` / VM ${total}대` : ''}${e.demo ? ' (데모)' : ''}`);
    lines.push('Veeam 작업에 포함됐거나 복원 지점이 있는 VM 수(VM 화면의 Veeam 배지와 같은 기준)');
    if (e.running || e.pending) lines.push(`지금 백업 중 ${e.running || 0} · 대기 ${e.pending || 0}`);
    if (Number.isFinite(e.basisTs)) lines.push(`기준 ${fmtTime(e.basisTs)}`);
    if (e.failed) lines.push(`* Veeam 서버 ${e.failed}대를 이번에 읽지 못해 마지막 성공 값을 썼습니다(사유는 설정 › Veeam 백업 서버).`);
    if (e.waiting) lines.push(`* Veeam 서버 ${e.waiting}대는 아직 첫 수집 전이라 빠졌습니다.`);
  } else {
    lines.push(`스냅샷 기준 ${e.n}대${total != null ? ` / VM ${total}대` : ''}`);
    lines.push('Veeam 서버와 연동되지 않아 vCenter 로 본 값입니다');
    lines.push(`최근 ${e.days || 7}일 Veeam 이 스냅샷을 만든 VM ${e.snapEv || 0} + 지금 Veeam 임시 스냅샷이 있는 VM ${e.snapNow || 0}${e.overlap ? ` (겹침 ${e.overlap})` : ''}`);
    lines.push('백업 성공 여부는 알 수 없습니다 — 스냅샷 생성은 백업 시작 단계입니다.');
    if (e.unpaired > 0) lines.push(`공용 계정이 만들고 12시간 안에 지우지 않은 스냅샷 ${e.unpaired}건은 사람이 만든 것일 수 있어 세지 않았습니다.`);
    if (e.partial) lines.push('* 이벤트가 많아 일부만 읽었습니다 — 실제보다 적을 수 있습니다.');
    if (e.source === 'edge') lines.push('이 vCenter 를 수집하는 엣지가 보낸 요약입니다.');
    if (Number.isFinite(e.collectedAt) && now - e.collectedAt > 3_600_000) lines.push(`vCenter 이벤트 마지막 수집 ${fmtTime(e.collectedAt)}`);
  }
  return { text, label, tone: e.partial ? 'warn' : (veeam ? 'veeam' : 'snap'), title: lines.join('\n') };
}

/** v2.759: 집계 준비 중(전용 DB 백필)인 vCenter 가 있는가 — 있으면 카드가 더 자주(30초) 다시 묻는다. */
export function backupPreparing(byVc) {
  return Object.values(byVc || {}).some((e) => e && e.reason === 'preparing');
}
