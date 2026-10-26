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
    const how = e.by === 'job' ? 'Veeam 작업이 실행 중입니다(이 VM 차례인지는 Veeam 이 VM 단위로 알려 주지 않았습니다)'
      // v2.778.1: 배지의 % 는 이 VM(task)의 진행률 — Veeam 콘솔 작업 목록의 % 는 작업 전체라 다를 수 있다(실서버: VM 28% · 작업 49%).
      : `Veeam 이 이 VM 을 지금 백업하고 있습니다${pg != null ? ` — ${pg}% 는 이 VM 의 진행률입니다(Veeam 콘솔 작업 목록의 % 는 작업 전체라 다를 수 있습니다)` : ''}`;
    return { label: pg != null ? `백업 중 ${pg}%` : '백업 중', color: 'amber', title: [how, ...lines].join('\n'), progress: pg };
  }
  if (e.run === 2) return { label: '대기', color: 'blue', title: ['Veeam 실행 중인 작업에서 차례를 기다리고 있습니다', ...lines].join('\n'), progress: null };
  const when = shortTime(e.lb);
  return { label: when ? `Veeam ${when}` : 'Veeam', color: 'green', title: ['Veeam 백업 대상(작업 포함 또는 복원 지점 있음)', ...lines].join('\n'), progress: null };
}

/**
 * v2.762(F5): '다른 vCenter 로 적힌 VM' 의 수는 관리자 판본만 온다(서버 전체 기준이라 다른 법인 vCenter 쪽 수가 섞인다) — 그 밖에는
 *   otherVcenter=null 과 hostMismatch 불리언만. 수가 있으면 'VM 120개가', 없으면 'VM 이'.
 */
const otherCount = (n) => (Number.isInteger(n) && n > 0 ? n : null);
const otherSubject = (n) => (otherCount(n) != null ? `VM ${n}개가` : 'VM 이');

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
 * v2.778.1: 실행 중 작업 한 줄 — '이름 N%' · 서버가 둘 이상이면 서버 이름을 앞에 붙인다(한 vCenter 에 Veeam 서버 여럿 — 작업 이름이 겹칠 수 있다).
 * @param {Array<{name:string, pg:(number|null), server:string}>} list
 */
export function runningJobsText(list) {
  const xs = Array.isArray(list) ? list : [];
  const multi = new Set(xs.map((j) => j.server)).size > 1;
  return xs.map((j) => `${multi && j.server ? `${j.server} › ` : ''}${j.name}${Number.isFinite(j.pg) ? ` ${j.pg}%` : ''}`).join(' · ');
}

/**
 * 요약 카드(v2.751 시안 — 체크했을 때만 보인다). tone: ok | warn | muted.
 * @param {object|null} d   /api/veeam/badges 응답
 * @param {{loading?:boolean, error?:string, vmTotal?:number, refreshError?:string}} o
 * @returns {{ tone:string, kind:'loading'|'error'|'unconfigured'|'pending'|'ok', text:string, stats:null|{total:number, running:(number|null), pending:(number|null), vmTotal:(number|null)},
 *   source:string, basis:string, warnings:string[], details:string[], demo:boolean }}
 */
export function veeamSummary(d, { loading = false, error = '', vmTotal = null, refreshError = '' } = {}) {
  const base = { stats: null, source: '', basis: '', warnings: [], details: [], demo: false, runningJobs: [] };
  if (error) return { ...base, tone: 'warn', kind: 'error', text: `Veeam 백업 상태를 읽지 못했습니다(백업이 없다는 뜻이 아닙니다): ${error}` };
  if (!d) return { ...base, tone: 'muted', kind: 'loading', text: loading ? 'Veeam 백업 상태를 읽는 중…' : '' };
  if (!d.configured) return { ...base, tone: 'muted', kind: 'unconfigured', text: '이 vCenter 에 연결된 Veeam 서버가 없습니다 — 설정 › vCenter 관리 › Veeam 백업 서버에서 등록하세요. 지금은 vCenter 스냅샷 기준 배지(📸 점선)만 보입니다.' };
  const c = veeamCounts(d.byVm);
  const servers = Array.isArray(d.servers) ? d.servers : [];
  const warnings = []; const details = [];
  // v2.761(D8): 첫 응답 뒤 갱신이 실패해도 옛 값을 '지금' 처럼 보이지 않는다 — 마지막으로 받은 값이라고 말한다.
  if (refreshError) warnings.push(`최근 갱신에 실패했습니다 — 마지막으로 받은 값을 보여 줍니다: ${refreshError}`);
  for (const sv of servers) {
    if (sv.ok === false) {
      const last = sv.lastOkTs ? ` — 표시는 마지막 성공(${fmtTime(sv.lastOkTs)}) 기준입니다` : ' — 아직 성공한 적이 없어 이 서버의 VM 은 표시되지 않습니다';
      warnings.push(`${sv.name} ${sv.authStopped ? '인증 실패로 주기 수집을 멈췄습니다' : '읽기 실패'}: ${sv.error || '사유 미상'}${last}`);
    } else if (sv.ok == null) {
      // v2.762(F1): 카드는 이 경우 '부분(*)' 이다 — 같은 조건이면 VM 화면도 경고(예전에는 접힌 '자세히' 안에만 있어 요약이 녹색이었다).
      warnings.push(`${sv.name}: 아직 읽은 결과가 없습니다(담당 노드의 첫 수집을 기다리는 중) — 이 서버의 VM 은 아직 표시되지 않습니다`);
    }
    // v2.761(B2): 오래된 결과(엣지가 멈췄거나 배정이 바뀜) — 수는 그대로 두고 경고한다.
    if (sv.stale) warnings.push(`${sv.name}: 마지막으로 받은 결과가 오래됐습니다(${fmtTime(sv.lastOkTs) || '시각 모름'}) — 그 뒤의 백업 변화는 반영되지 않았습니다`);
    for (const n of Array.isArray(sv.notes) ? sv.notes : []) details.push(`${sv.name}: ${n}`);
  }
  // v2.761(D1): 쓸 수 있는 결과가 하나도 없으면(첫 수집 전 · 실패만) '0 / N VM' 이 아니라 모름.
  if (servers.length && servers.every((sv) => !Number.isFinite(sv.lastOkTs))) {
    return { ...base, tone: 'warn', kind: 'pending', warnings, details,
      text: '연결된 Veeam 서버를 아직 한 번도 읽지 못했습니다(첫 수집 대기 또는 읽기 실패) — 백업 대상 수는 0대가 아니라 아직 모릅니다.' };
  }
  // v2.761(A5): 맞은 VM 이 하나도 없고 Veeam 이 다른 vCenter 로 적은 VM 만 있으면 주소 표기(IP·FQDN) 불일치일 수 있다.
  const other = otherCount(d.otherVcenter);
  if (c.total === 0 && (d.hostMismatch === true || other != null)) warnings.push(`Veeam 이 적은 ${otherSubject(other)} 모두 다른 vCenter 로 되어 있어 이 vCenter 와 맞은 VM 이 없습니다 — 포탈에 등록한 vCenter 주소(IP·FQDN)가 Veeam 이 쓰는 이름과 다를 수 있습니다`);
  else if (other != null) details.push(`Veeam 이 다른 vCenter 로 적은 VM ${other}개는 이 목록에 표시하지 않았습니다(같은 Veeam 이 여러 vCenter 를 백업하면 정상)`);
  // v2.778: Veeam 이 이 vCenter 를 다른 이름으로 적었지만 moref·VM 이름이 맞아 같은 vCenter 로 본 경우(서버 parse.js learnHostAliases) — 이름은 관리자 판본만.
  if (Array.isArray(d.aliasHosts) && d.aliasHosts.length) details.push(`Veeam 이 이 vCenter 를 ${d.aliasHosts.map((h) => `‘${h}’`).join(', ')} 로 적었습니다 — 포탈에 등록한 주소와 다르지만 VM 의 moref·이름이 맞아 같은 vCenter 로 맞췄습니다`);
  else if (d.hostAliased === true) details.push('Veeam 이 이 vCenter 를 포탈에 등록한 주소와 다른 이름으로 적었습니다 — VM 의 moref·이름이 맞아 같은 vCenter 로 맞췄습니다');
  if (d.ambiguous) details.push(`이름이 같은 VM 이 둘 이상이라 고르지 못한 항목 ${d.ambiguous}개`);
  if (d.unmatched) details.push(`이 vCenter 에서 찾지 못한 Veeam 항목 ${d.unmatched}개(삭제·이름 변경된 VM 일 수 있습니다)`);
  // v2.761(D5): 서버가 오래된 '백업 중' 표지를 지웠으면 실행 중·대기 0 은 사실이 아니다 — 모름.
  //   v2.762(F1): 첫 수집 전인 서버가 있어도 그 서버의 실행 상태를 모른다 — 모름.
  const waiting = servers.some((sv) => sv.ok == null);
  const runKnown = !d.runningStale && !waiting;
  if (d.runningStale) details.push('지금 백업 중·대기는 최신 결과가 아니라 표시하지 않습니다(Veeam 서버를 최근에 읽지 못했습니다)');
  else if (waiting) details.push('첫 수집 전인 Veeam 서버가 있어 지금 백업 중·대기는 표시하지 않습니다');
  const when = servers.map((sv) => sv.lastOkTs).filter((x) => Number.isFinite(x));
  return {
    tone: warnings.length ? 'warn' : 'ok', kind: 'ok', text: '',
    stats: { total: c.total, running: runKnown ? c.running : null, pending: runKnown ? c.pending : null, vmTotal: Number.isFinite(vmTotal) ? vmTotal : null },
    source: servers.length ? `서버 ${servers.map((sv) => sv.name).join(', ')}` : '',
    basis: when.length ? `기준 ${fmtTime(Math.min(...when))}` : '',
    warnings, details, demo: !!d.demo,
    // v2.778.1: 지금 도는 Veeam 작업과 작업 전체 진행률(콘솔 작업 목록의 %) — 서버가 관리자 판본에만 싣는다.
    runningJobs: runKnown ? servers.flatMap((sv) => (Array.isArray(sv.runningJobs) ? sv.runningJobs : []).filter((j) => j && typeof j.name === 'string' && j.name)
      .map((j) => ({ name: j.name, pg: Number.isFinite(j.pg) ? j.pg : null, server: sv.name }))) : [],
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
  // v2.795: 출처가 모두 Enterprise Manager 면 EM 이 주지 않는 값(처리 용량·복원 지점 수·백업 파일)을 그렇게 말한다(B&R 판 문구 대신)
  const emOnly = Array.isArray(detail.servers) && detail.servers.length > 0 && detail.servers.every((x) => x?.src === 'em');
  const sections = [];
  sections.push({
    title: '마지막 백업',
    rows: lt ? [
      ['결과', resultLabel(lt.result) || '—'], ['작업', lt.job || '—'], ['시작', fmtTime(lt.start) || '—'], ['완료', fmtTime(lt.end) || '—'],
      ['소요 시간', durationText(lt.durationSec)], ['처리한 데이터', sizeText(lt.processed)], ['읽은 데이터', sizeText(lt.read)], ['전송한 데이터', sizeText(lt.transferred)],
      ...(lt.message ? [['메시지', lt.message]] : []),
    ] : [['완료 시각', fmtTime(detail.lastBackup) || '—']],
    note: lt ? (lt.processed == null && lt.read == null && lt.transferred == null ? (emOnly ? 'Enterprise Manager 기록에는 VM 별 처리 용량이 없습니다.' : 'Veeam 이 이 판의 REST 응답에 VM 별 처리 용량을 주지 않았습니다.') : '')
      : (emOnly ? 'Enterprise Manager 가 최근 기간의 작업 결과를 주지 않아 복원 지점 시각만 보여 줍니다.' : 'Veeam 이 이 VM 의 마지막 작업 결과(task)를 주지 않아 복원 지점 시각만 보여 줍니다.'),
  });
  const rp = detail.restorePoints || {};
  sections.push({
    title: '복원 지점',
    rows: [['개수', rp.count != null ? `${rp.count}개` : '—'], ['가장 최근', fmtTime(rp.latest) || '—'], ['가장 오래된', fmtTime(rp.oldest) || '—']],
    note: rp.count == null ? (emOnly ? 'Enterprise Manager 기록은 복원 지점 수를 주지 않습니다(최근 시각만 — 아래 목록).' : '복원 지점 목록을 읽지 못했습니다.') : '',
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

/**
 * v2.765(실서버 OC2 — 수집이 13일 뒤처졌는데 화면은 시각만 보여 '왜' 를 알 길이 없었다): 수집이 얼마나 뒤처졌는지(일 · 하루 미만은 시간)와
 *   원인을 볼 곳(설정 › Log — vCenter 로그 보관 화면의 수집 상태·실패 사유). 시각을 모르면 ''(지어내지 않는다).
 */
export function collectLagText(collectedAt, now = Date.now()) {
  if (!Number.isFinite(collectedAt) || !Number.isFinite(now)) return '';
  const ms = Math.max(0, now - collectedAt);
  const d = Math.floor(ms / 86_400_000);
  const lag = d >= 1 ? `${d}일` : `${Math.max(1, Math.floor(ms / 3_600_000))}시간`;
  return `수집이 ${lag} 뒤처짐 — 설정 › Log(vCenter 로그 보관)에서 원인을 확인하세요.`;
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
    'no-collect-yet': '이 포탈이 시작된 뒤 이 vCenter 의 이벤트를 아직 한 번도 수집하지 못했습니다(접속 실패·인증 정지 등) — 0대가 아니라 모릅니다.',
    'stale-edge': `이 vCenter 를 수집하는 엣지의 이벤트 요약이 오래됐습니다(마지막 ${fmtTime(d.at) || '—'}) — 엣지가 멈췄거나 담당이 바뀌었을 수 있어 표시하지 않습니다.`,
  };
  if (d.status && d.status !== 'ok') return why[d.status] || '이벤트 기준 정보를 받지 못했습니다.';
  const notes = [];
  // 검토 #6: 0대를 '백업 없음' 으로 읽지 않게 — 계정을 모르거나 이벤트 수집이 멈췄으면 그 사실을 말한다.
  if (d.accounts === 0 && !Object.keys(d.byVm || {}).length) notes.push('Veeam 계정을 아직 모릅니다 — Veeam 이 쓰는 vCenter 계정 이름에 veeam 이 없으면 설정 › Veeam 백업 서버에 적으세요(지금 백업 중인 VM 이 2대 이상 보이면 자동으로 배웁니다).');
  // v2.762(F6): 한도는 서버가 준 staleMs(로그 수집 주기 반영 — 판정 코어는 서버 backupCounts.snapVerdict). 없으면(옛 서버·엣지 요약) 6시간.
  const staleMs = Number.isFinite(d.staleMs) && d.staleMs > 0 ? d.staleMs : 6 * 3_600_000;
  if (Number.isFinite(d.collectedAt) && Number.isFinite(d.at) && d.at - d.collectedAt > staleMs) notes.push(`vCenter 이벤트를 마지막으로 수집한 시각이 ${fmtTime(d.collectedAt)} 입니다 — 그 뒤의 백업은 아직 반영되지 않았습니다. ${collectLagText(d.collectedAt, d.at)}`);
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
  'no-collect-yet': '이 포탈이 시작된 뒤 이 vCenter 의 이벤트를 아직 한 번도 수집하지 못했습니다(접속 실패·인증 정지 등) — 0대가 아니라 모릅니다.',
  'veeam-failed': 'Veeam 서버를 아직 한 번도 읽지 못했습니다 — 설정 › Veeam 백업 서버에서 상태를 확인하세요.',
  'no-account': 'Veeam 이 쓰는 vCenter 계정을 아직 모릅니다 — 계정 이름에 veeam 이 없으면 설정 › Veeam 백업 서버에 적으세요.',
  // v2.762(F4): 등록부를 못 읽으면 어느 vCenter 가 연동인지 모른다 — 스냅샷 기준으로 조용히 바꾸지 않는다.
  'registry-unreadable': 'Veeam 서버 등록부를 읽지 못해 이 vCenter 가 Veeam 과 연동돼 있는지 알 수 없습니다 — 관리자가 설정 › Veeam 백업 서버에서 확인해야 합니다.',
};

/*
 * v2.772(Z3 I1): 서버 snapCollector 사유 코드(snap-events·backup-counts 의 snapCollector — 계정 이름 없음) → 무엇을 하면 되는지 한 줄.
 *   stale 문구('설정 › Log 에서 원인을 확인하세요')는 로그 폴러만 말한다 — Veeam 계정 전용 수집기가 왜 이 vCenter 를 보완하지 못했는지가 화면에 없었다.
 *   모르는 코드·코드 없음은 ''(지어내지 않는다). 백틱 금지 · 값 인용은 ‘ ’.
 */
const ACCOUNT_FIELD = '설정 › Veeam 백업 서버의 ‘Veeam 이 vCenter 에 접속하는 계정’';
export const SNAP_COLLECTOR_TEXT = {
  failed: '이 vCenter 의 Veeam 계정 이벤트를 읽지 못했습니다(접속 실패·시한 초과·인증 정지) — vCenter 연결 상태를 확인하세요.',
  'no-account': `읽을 Veeam 계정을 모릅니다 — 이름에 veeam 이 든 계정도 적어야 따로 읽습니다. ${ACCOUNT_FIELD} 에 계정을 이벤트 원문(CORP\\계정 또는 계정@도메인) 그대로 적으세요.`,
  'accounts-over-limit': `적힌 Veeam 계정이 너무 많아 일부를 읽지 못합니다 — ${ACCOUNT_FIELD} 에서 쓰지 않는 계정을 정리하세요.`,
  'not-covered': `이 vCenter 에서 본 Veeam 계정 중 적히지 않은 계정이 있어(이름 규칙으로만 알려진 계정 등) 따로 읽은 값을 쓰지 않습니다 — 그 계정을 ${ACCOUNT_FIELD} 에 이벤트 원문(CORP\\계정) 그대로 적으세요.`,
  'shared-only': `적힌 계정이 공용 계정(administrator 등)뿐이라 따로 읽을 수 없습니다 — 공용 계정은 사람도 쓰므로 Veeam 의 것으로 확정할 수 없습니다. Veeam 전용 계정을 쓰고 그 계정을 ${ACCOUNT_FIELD} 에 적는 것을 권장합니다.`,
  unseen: `적힌 Veeam 계정으로 이 vCenter 의 이벤트를 한 건도 읽지 못했습니다 — 계정 표기를 이벤트 원문(CORP\\계정 또는 계정@도메인) 그대로 적으세요(${ACCOUNT_FIELD}).`,
  refilling: '계정 목록이 바뀌어 지난 8일을 다시 읽는 중입니다 — 끝나면 최신으로 보입니다.',
};
/** 사유 코드 → 'Veeam 계정 전용 수집으로도 보완하지 못했습니다: …' 한 줄. 모르는 코드면 ''. */
export function snapCollectorText(code) {
  const t = typeof code === 'string' ? SNAP_COLLECTOR_TEXT[code] : null;
  return t ? `Veeam 계정 전용 수집으로도 보완하지 못했습니다: ${t}` : '';
}

/** v2.763(V4-2): 다른 vCenter 에서 배운 Veeam 계정이 이 vCenter 이벤트에는 한 번도 없다(서버 verdict.accountUnseen) — 0대가 확정이 아니다. */
export const ACCOUNT_UNSEEN = '이 vCenter 에서는 아는 Veeam 계정의 스냅샷이 최근 이벤트에 한 건도 보이지 않습니다 — Veeam 이 이 vCenter 에 다른 계정으로 접속하면 설정 › Veeam 백업 서버의 ‘Veeam 이 vCenter 에 접속하는 계정’ 에 적으세요(정말 0대일 수도 있습니다).';

/**
 * 카드의 백업 칸 — 'n/전체' 형식(사용자 지정). 모르면 '—'(0 으로 쓰지 않는다) · 부분 값은 '*' 와 노란 칸.
 * tone: veeam(채운 녹색) | snap(하늘색 점선) | warn(부분) | none(모름). entry 가 없으면 null(칸을 그리지 않는다).
 * @param {object|null} e  byVc[vcenterId]
 * @param {number|null} vmFallback  서버가 전체 VM 수를 못 줬을 때 카드의 VM 수
 */
export function backupCell(e, vmFallback = null, now = Date.now(), { refreshError = '' } = {}) {
  if (!e || typeof e !== 'object' || (e.src !== 'veeam' && e.src !== 'snap')) return null;
  // v2.763(V5-I1): 첫 응답 뒤 갱신이 실패하면 usePolling 은 옛 값을 그대로 둔다 — 옛 'n/전체'·색을 표지 없이 그리지 않는다(VM 화면 D8 과 같은 방식).
  if (refreshError) {
    const c = backupCell(e, vmFallback, now);
    return c && { ...c, tone: c.tone === 'none' ? 'none' : 'warn', refreshFailed: true, title: `최근 갱신에 실패했습니다 — 마지막으로 받은 값입니다: ${String(refreshError).slice(0, 120)}\n${c.title}` };
  }
  const veeam = e.src === 'veeam';
  const total = Number.isFinite(e.vmTotal) ? e.vmTotal : (Number.isFinite(vmFallback) ? vmFallback : null);
  const label = veeam ? '백업 · Veeam' : '백업 · 스냅샷';
  if (!Number.isFinite(e.n)) {
    let why = BACKUP_REASON[e.reason];
    if (!why && e.reason === 'stale-events') why = `vCenter 이벤트를 마지막으로 수집한 시각이 ${fmtTime(e.collectedAt) || '—'} 입니다 — 그 뒤의 백업이 빠진 값이라 수량을 표시하지 않습니다.${Number.isFinite(e.collectedAt) ? ` ${collectLagText(e.collectedAt, now)}` : ''}`;   // v2.765
    if (!why) why = veeamEventStatusText({ status: e.reason, at: e.at }) || '백업 정보를 읽지 못했습니다.';
    const unknownSrc = e.reason === 'registry-unreadable';   // v2.762(F4): Veeam 기준인지 스냅샷 기준인지도 모른다
    const lines = [`${unknownSrc ? '' : veeam ? 'Veeam 기준 ' : '스냅샷 기준 '}백업 수량을 알 수 없습니다(0대가 아닙니다)`, why];
    // v2.762(F3): 실패 서버를 먼저 말하고(사유 코드), 첫 수집 전인 서버도 함께 센다.
    if (veeam && e.reason === 'veeam-failed' && e.waiting > 0) lines.push(`Veeam 서버 ${e.waiting}대는 아직 첫 수집 전입니다.`);
    if (!veeam && e.snapNow > 0) lines.push(`지금 Veeam 임시 스냅샷이 있는 VM ${e.snapNow}대`);
    // v2.772(Z3 I1): 이벤트 수집이 늦어(또는 못 해) 수를 못 낸 칸 — 전용 수집기가 보완하지 못한 이유(코드가 있을 때만)
    if (!veeam && (e.reason === 'stale-events' || e.reason === 'no-collect-yet')) { const sc = snapCollectorText(e.snapCollector); if (sc) lines.push(sc); }
    return { text: '—', label: veeam && !unknownSrc ? label : '백업 · 확인 불가', tone: 'none', title: lines.join('\n') };
  }
  const text = `${e.n}/${total ?? '—'}${e.partial ? ' *' : ''}`;
  const lines = [];
  if (veeam) {
    lines.push(`Veeam 백업 ${e.n}대${total != null ? ` / VM ${total}대` : ''}${e.demo ? ' (데모)' : ''}`);
    lines.push('Veeam 작업에 포함됐거나 복원 지점이 있는 VM 수(VM 화면의 Veeam 배지와 같은 기준)');
    if (e.running || e.pending) lines.push(`지금 백업 중 ${e.running || 0} · 대기 ${e.pending || 0}`);
    if (Number.isFinite(e.basisTs)) lines.push(`기준 ${fmtTime(e.basisTs)}`);
    // v2.762(F2): 한 번도 성공하지 못한 서버는 '마지막 성공 값' 이 없다 — 그 서버의 VM 이 빠졌다고 말한다(옛 서버 응답은 failedNoLast 없음 = 0).
    const noLast = Number.isInteger(e.failedNoLast) && e.failedNoLast > 0 ? Math.min(e.failedNoLast, e.failed || 0) : 0;
    if ((e.failed || 0) - noLast > 0) lines.push(`* Veeam 서버 ${(e.failed || 0) - noLast}대를 이번에 읽지 못해 마지막 성공 값을 썼습니다(사유는 설정 › Veeam 백업 서버).`);
    if (noLast > 0) lines.push(`* Veeam 서버 ${noLast}대는 아직 한 번도 읽지 못해 그 서버의 VM 이 빠졌습니다(사유는 설정 › Veeam 백업 서버).`);
    if (e.waiting) lines.push(`* Veeam 서버 ${e.waiting}대는 아직 첫 수집 전이라 빠졌습니다.`);
    if (e.stale > 0) lines.push(`* Veeam 서버 ${e.stale}대의 결과가 오래됐습니다 — 그 뒤의 백업 변화는 반영되지 않았습니다.`);   // v2.761(B2)
    if (e.hostMismatch) lines.push(`Veeam 이 적은 ${otherSubject(e.otherVcenter)} 모두 다른 vCenter 로 되어 있습니다 — 포탈의 vCenter 주소(IP·FQDN)가 Veeam 이 쓰는 이름과 다를 수 있습니다(0대가 아닐 수 있음).`);   // v2.761(A5) · v2.762(F5) 수는 관리자만
  } else {
    lines.push(`스냅샷 기준 ${e.n}대${total != null ? ` / VM ${total}대` : ''}`);
    lines.push('Veeam 서버와 연동되지 않아 vCenter 로 본 값입니다');
    lines.push(`최근 ${e.days || 7}일 Veeam 이 스냅샷을 만든 VM ${e.snapEv || 0} + 지금 Veeam 임시 스냅샷이 있는 VM ${e.snapNow || 0}${e.overlap ? ` (겹침 ${e.overlap})` : ''}`);
    lines.push('백업 성공 여부는 알 수 없습니다 — 스냅샷 생성은 백업 시작 단계입니다.');
    if (e.unpaired > 0) lines.push(`공용 계정이 만들고 12시간 안에 지우지 않은 스냅샷 ${e.unpaired}건은 사람이 만든 것일 수 있어 세지 않았습니다.`);
    if (e.partial && !e.ambiguous) lines.push('* 이벤트가 많아 일부만 읽었습니다 — 실제보다 적을 수 있습니다.');
    if (e.ambiguous > 0) lines.push(`* 이름이 같은 VM 이 둘 이상이라 고르지 못한 이벤트 ${e.ambiguous}건은 세지 않았습니다 — 실제보다 적을 수 있습니다.`);   // v2.761(C6)
    if (e.snapStale > 0) lines.push(`하루 넘게 남은 Veeam 임시 스냅샷 ${e.snapStale}대는 백업으로 세지 않았습니다(정리 실패 의심 — VM 화면의 빨간 '스냅샷 잔존').`);   // v2.761(C3)
    if (e.accountUnseen) lines.push(`* ${ACCOUNT_UNSEEN}`);   // v2.763(V4-2) — 수는 그대로, 0대가 확정이 아님을 알린다
    if (e.source === 'edge') lines.push('이 vCenter 를 수집하는 엣지가 보낸 요약입니다.');
    if (Number.isFinite(e.collectedAt) && now - e.collectedAt > 3_600_000) lines.push(`vCenter 이벤트 마지막 수집 ${fmtTime(e.collectedAt)}`);
  }
  return { text, label, tone: (e.partial || e.hostMismatch || e.stale > 0 || e.accountUnseen) ? 'warn' : (veeam ? 'veeam' : 'snap'), title: lines.join('\n') };
}

/**
 * v2.778.1(사용자 요청: 카드의 백업 칸을 'veeam/snapshot' 으로 — Veeam 으로 백업 받는 수량과 스냅샷 수량을 함께): 'A/B' 한 칸.
 *   A = Veeam 서버 기준 백업 대상 VM 수(연동 없음·모름이면 '—') · B = vCenter 스냅샷·이벤트 기준 VM 수(모름이면 '—').
 *   각 수의 근거·사유는 backupCell 그대로(툴팁에 두 단락) — 판정을 새로 만들지 않는다. VM 전체 수는 툴팁에.
 * @param {object|null} e  /veeam/backup-counts 의 byVc 원소(src 'veeam' 이면 snap 하위 객체가 붙는다 · src 'snap' 이면 그 자체가 스냅샷 값)
 */
export function backupPairCell(e, vmFallback = null, now = Date.now(), { refreshError = '' } = {}) {
  if (!e || typeof e !== 'object' || (e.src !== 'veeam' && e.src !== 'snap')) return null;
  const vE = e.src === 'veeam' ? e : null;
  const sE = e.src === 'snap' ? e : (e.snap && typeof e.snap === 'object' && e.snap.src === 'snap' ? e.snap : null);
  const unknownSrc = vE && vE.reason === 'registry-unreadable';
  const vc = vE ? backupCell(vE, vmFallback, now, { refreshError }) : null;
  const sc = sE && !unknownSrc ? backupCell(sE, vmFallback, now, { refreshError }) : null;
  const num = (x) => (x && Number.isFinite(x.n) ? `${x.n}${x.partial ? '*' : ''}` : '—');
  const total = Number.isFinite(vE?.vmTotal) ? vE.vmTotal : Number.isFinite(sE?.vmTotal) ? sE.vmTotal : (Number.isFinite(vmFallback) ? vmFallback : null);
  const lines = [`veeam/snapshot — Veeam 백업 대상 ${num(vE)} / 스냅샷 기준 ${num(sE)}${total != null ? ` (VM ${total}대 중)` : ''}`];
  lines.push('', '[Veeam]', vc ? vc.title : 'Veeam 서버와 연동되지 않았습니다 — 설정 › vCenter 관리 › Veeam 백업 서버에서 등록하면 Veeam 기준 수가 나옵니다.');
  lines.push('', '[스냅샷]', sc ? sc.title.replace('Veeam 서버와 연동되지 않아 vCenter 로 본 값입니다', 'vCenter 스냅샷·이벤트로 본 값입니다(Veeam 서버 값과 별개)') : (unknownSrc ? '확인 불가(위 사유)' : '이 응답에 스냅샷 기준 값이 없습니다(포탈이 옛 판이거나 VM 목록 수집 전).'));
  const tones = [vc?.tone, sc?.tone];
  const tone = tones.includes('warn') ? 'warn' : vc && vc.tone !== 'none' ? vc.tone : sc && sc.tone !== 'none' ? sc.tone : 'none';
  return { text: `${num(vE)}/${num(sE)}`, label: 'veeam/snapshot', tone, title: lines.join('\n'), ...((vc?.refreshFailed || sc?.refreshFailed) ? { refreshFailed: true } : {}) };
}

/**
 * v2.778.1(사용자 요청: 상단 요약 '활성 알람' 자리에 전체 VM·Veeam 백업 수·스냅샷으로 파악한 수): vCenter 별 백업 수를 더한다(순수).
 *   못 읽은 vCenter 의 수는 0 으로 더하지 않고 따로 센다('못 읽은 값은 0 이 아니다'). 부분 합이면 partial.
 * @param {object|null} byVc  /veeam/backup-counts 의 byVc
 * @param {string[]} ids  지금 화면의 vCenter id(범위·검색과 무관한 전체 목록)
 * @returns {null|{ veeam:(number|null), snap:(number|null), veeamVcs:number, veeamUnknown:number, snapUnknown:number, partial:boolean }}
 */
export function backupTotals(byVc, ids) {
  if (!byVc || typeof byVc !== 'object') return null;
  let veeam = 0; let snap = 0; let veeamVcs = 0; let veeamUnknown = 0; let snapUnknown = 0; let veeamKnown = 0; let snapKnown = 0; let partial = false;
  for (const id of Array.isArray(ids) ? ids : []) {
    const e = byVc[id];
    if (!e || typeof e !== 'object') { snapUnknown++; continue; }
    const vE = e.src === 'veeam' ? e : null;
    const sE = e.src === 'snap' ? e : (e.snap && typeof e.snap === 'object' && e.snap.src === 'snap' ? e.snap : null);
    if (vE) {
      veeamVcs++;
      if (Number.isFinite(vE.n)) { veeam += vE.n; veeamKnown++; if (vE.partial) partial = true; } else veeamUnknown++;
    }
    if (sE && Number.isFinite(sE.n)) { snap += sE.n; snapKnown++; if (sE.partial) partial = true; } else snapUnknown++;
  }
  return { veeam: veeamKnown ? veeam : null, snap: snapKnown ? snap : null, veeamVcs, veeamUnknown, snapUnknown, partial };
}

/**
 * v2.761(D4): VM 화면 '최근 7일 Veeam 백업 시도 N대' 칩 — 숫자를 낼지는 서버 판정(snap-events verdict — 카드 snapCount 와 같은 조건)을 따른다.
 *   판정을 웹에 따로 두지 않는다(옛 서버라 verdict 가 없으면 예전처럼 status 만 본다). n=null 이면 칩을 그리지 않고 why 로 이유를 말한다.
 * @returns {{ n: (number|null), why: string }}
 */
export function veeamEventChip(ev) {
  if (!ev) return { n: null, why: '' };
  const v = ev.verdict && typeof ev.verdict === 'object' ? ev.verdict : null;
  const ok = v ? v.ok === true : ev.status === 'ok';
  const n = ok ? Object.keys(ev.byVm || {}).length : null;
  let why = veeamEventStatusText(ev);
  if (v && !v.ok && ev.status === 'ok') {
    if (v.reason === 'stale-events') why = `vCenter 이벤트를 마지막으로 수집한 시각이 ${fmtTime(ev.collectedAt) || '—'} 입니다 — 그 뒤의 백업이 빠진 값이라 수를 표시하지 않습니다.${Number.isFinite(ev.collectedAt) ? ` ${collectLagText(ev.collectedAt, Number.isFinite(ev.at) ? ev.at : Date.now())}` : ''}`;   // v2.765: 며칠 뒤처졌는지 + 원인을 볼 곳
    else why = BACKUP_REASON[v.reason] || why || '이벤트 기준 수를 표시할 수 없습니다.';
    // v2.772(Z3 I1): 카드와 같은 한 줄 — 전용 수집기가 보완하지 못한 이유
    if (v.reason === 'stale-events' || v.reason === 'no-collect-yet') { const sc = snapCollectorText(ev.snapCollector); if (sc) why = `${why} ${sc}`; }
  }
  if (v?.ok && v.accountUnseen && n === 0) why = ACCOUNT_UNSEEN;   // v2.763(V4-2)
  return { n, why };
}
