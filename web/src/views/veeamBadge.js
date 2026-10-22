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

const fmtTime = (ms) => {
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

/**
 * VM 한 대의 배지. 없으면 null.
 * @returns {null|{label:string, color:'green'|'amber'|'blue', title:string}}
 */
export function veeamBadge(e) {
  if (!e || typeof e !== 'object') return null;
  const jobs = Array.isArray(e.jobs) ? e.jobs.filter((x) => typeof x === 'string' && x) : [];
  const lines = [];
  if (jobs.length) lines.push(`작업: ${jobs.slice(0, 5).join(', ')}${jobs.length > 5 ? ` 외 ${jobs.length - 5}개` : ''}`);
  const lr = fmtTime(e.lastRun);
  const res = resultLabel(e.lastResult);
  if (lr) lines.push(`작업 마지막 실행: ${lr}${res ? ` (${res})` : ''}`);
  if (Number.isFinite(e.rp) && e.rp > 0) lines.push(`복원 지점 ${e.rp}개`);
  else if (e.rp === -1) lines.push('복원 지점 있음(개수 모름)');
  if (Array.isArray(e.servers) && e.servers.length) lines.push(`Veeam 서버: ${e.servers.join(', ')}`);
  if (e.run === 1) {
    const pg = Number.isFinite(e.pg) ? ` ${e.pg}%` : '';
    const how = e.by === 'job' ? '작업이 실행 중입니다(이 VM 차례인지는 Veeam 이 VM 단위로 알려 주지 않았습니다)' : '이 VM 을 지금 백업하고 있습니다';
    return { label: `Veeam 백업 중${pg}`, color: 'amber', title: [how, ...lines].join('\n') };
  }
  if (e.run === 2) return { label: 'Veeam 대기', color: 'blue', title: ['실행 중인 작업에서 차례를 기다리고 있습니다', ...lines].join('\n') };
  return { label: 'Veeam', color: 'green', title: ['Veeam 백업 대상(작업 포함 또는 복원 지점 있음)', ...lines].join('\n') };
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
 * 요약 줄(체크박스 옆 안내). tone: ok | warn | muted.
 * @returns {{ tone:string, text:string, details:string[] }}
 */
export function veeamSummary(d, { loading = false, error = '' } = {}) {
  if (error) return { tone: 'warn', text: `Veeam 백업 상태를 읽지 못했습니다(백업이 없다는 뜻이 아닙니다): ${error}`, details: [] };
  if (!d) return { tone: 'muted', text: loading ? 'Veeam 백업 상태를 읽는 중…' : '', details: [] };
  if (!d.configured) return { tone: 'muted', text: '이 vCenter 에 연결된 Veeam 서버가 없습니다 — 설정 › vCenter 관리 › Veeam 백업 서버에서 등록하세요.', details: [] };
  const c = veeamCounts(d.byVm);
  const servers = Array.isArray(d.servers) ? d.servers : [];
  const details = [];
  for (const s of servers) {
    if (s.ok === false) {
      const last = s.lastOkTs ? ` · 표시는 마지막 성공(${fmtTime(s.lastOkTs)}) 기준` : ' · 아직 성공한 적이 없어 이 서버의 VM 은 표시되지 않습니다';
      details.push(`${s.name}: ${s.authStopped ? '인증 실패로 주기 수집 정지' : '읽기 실패'} — ${s.error || '사유 미상'}${last}`);
    } else if (s.ok == null) details.push(`${s.name}: 아직 읽은 결과가 없습니다(담당 노드의 첫 수집을 기다리는 중)`);
    for (const n of Array.isArray(s.notes) ? s.notes : []) details.push(`${s.name}: ${n}`);
  }
  if (d.otherVcenter) details.push(`Veeam 이 다른 vCenter 로 적은 VM ${d.otherVcenter}개는 이 목록에 표시하지 않았습니다(같은 Veeam 이 여러 vCenter 를 백업하면 정상)`);
  if (d.ambiguous) details.push(`이름이 같은 VM 이 둘 이상이라 고르지 못한 항목 ${d.ambiguous}개`);
  if (d.unmatched) details.push(`이 vCenter 에서 찾지 못한 Veeam 항목 ${d.unmatched}개(삭제·이름 변경된 VM 일 수 있습니다)`);
  const when = servers.map((s) => s.lastOkTs).filter((x) => Number.isFinite(x));
  const at = when.length ? ` · 기준 ${fmtTime(Math.min(...when))}` : '';
  const demo = d.demo ? ' (데모 데이터)' : '';
  const run = c.running || c.pending ? ` · **백업 중 ${c.running}**${c.pending ? ` · 대기 ${c.pending}` : ''}` : ' · 지금 백업 중인 VM 없음';
  const tone = servers.some((s) => s.ok === false) ? 'warn' : 'ok';
  return { tone, text: `Veeam 백업 대상 **${c.total} VM**${run}${at}${demo} — 배지가 없는 VM 은 백업 여부가 확인되지 않은 것입니다(백업 안 됨이 아닙니다).`, details };
}
