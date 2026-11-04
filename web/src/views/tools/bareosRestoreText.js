/**
 * Bareos 복원(v2.861 — 사용자 요청 '백업처럼 폴더에서 선택해서 복원' · '네트워크 연결 끊고 시작' · '데이터스토어 선택' — 시안 docs/design/bareos-ui-v2 ⑦~⑪).
 *   판정은 서버(bareos/restore.js bulkRestorePlan — 미리 보기 POST restore-check/bulk)가 한다. 이 파일은 고르기 · 글자 · 화면 쪽 빠른 확인만.
 *   값이 없으면 '—'(0 이 아니다) · 문구에 백틱 금지(BoldText 는 강조만 해석).
 */
import { levelLabel, whenText } from './bareosText.js';
import { unitText } from '../unitText.js';

/** 한 번에 고를 수 있는 VM(서버 BULK_RESTORE_MAX 와 같다 — 사용자 결정 ⓑ). */
export const RESTORE_MAX = 50;
export const MODE_SHORT = Object.freeze({ newVm: '새 VM', original: '원래 VM 덮어쓰기', localVmdk: 'FD 로컬 VMDK' });
export const NIC_LABEL = Object.freeze({ disconnect: '끊은 채로', keep: '백업 때 그대로' });

const FINAL_STATES = new Set(['ok', 'warning', 'error', 'canceled']);
/** 아직 끝나지 않은 복원(서버 registry.restoreOpen 과 같은 뜻 — jobid 가 있고 끝난 상태가 아니면 진행 중 · 상태 'unknown' 도 진행 중). */
export const restoreIsOpen = (r) => !!r?.jobid && !r.abandoned && !FINAL_STATES.has(String(r.state || ''));
/**
 * v2.873(점검 B5-01) 결과 모름 복원(명령을 보낸 뒤 회신이 끊김 — jobid 없음)을 붙잡는 시간. 서버 bareos/registry.js RESTORE_UNKNOWN_HOLD_MS 와 같다
 *   (server/test/bareosRestoreUnknown2873.test.js 가 대조). 그동안 같은 VM 을 다시 고르지 못한다 — 두 번 돌지 않게(서버도 거부한다).
 */
export const RESTORE_UNKNOWN_HOLD_MS = 6 * 3600_000;
export const restoreUnknownHeld = (r, now = Date.now()) => r?.unknown === true && !r.jobid && now - (Number(r.at) || 0) < RESTORE_UNKNOWN_HOLD_MS;

/**
 * 고르기 트리 — 원장 대상(백업 대상으로 등록된 VM 만 복원할 수 있다) → 법인(vCenter) → 폴더 → VM.
 * @returns {{ vcenterId, directorId, n, folders: { folder, vms: object[] }[] }[]}
 */
export function restoreTree(jobs, { q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const byVc = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (needle && !`${j.vmName} ${j.folder} ${j.vcenterId}`.toLowerCase().includes(needle)) continue;
    const vc = byVc.get(j.vcenterId) || { vcenterId: j.vcenterId, directorId: j.directorId || '', n: 0, folders: new Map() };
    const f = String(j.folder || '/');
    if (!vc.folders.has(f)) vc.folders.set(f, []);
    vc.folders.get(f).push(j);
    vc.n += 1;
    byVc.set(j.vcenterId, vc);
  }
  const cmp = (a, b) => String(a).localeCompare(String(b), 'ko');
  return [...byVc.values()].sort((a, b) => cmp(a.vcenterId, b.vcenterId)).map((vc) => ({
    ...vc,
    folders: [...vc.folders.entries()].sort(([a], [b]) => cmp(a, b)).map(([folder, vms]) => ({ folder, vms: vms.slice().sort((x, y) => cmp(x.vmName, y.vmName)) })),
  }));
}

/**
 * 이 VM 을 고를 수 없는 사유('' = 고를 수 있다). lockedDir = 이미 고른 VM 의 Director(법인 — 한 번에 한 법인).
 */
export function pickBlock(job, { lockedDir = '', now = Date.now() } = {}) {
  if (!job) return '대상 없음';
  if (job.writable === false) return '조회 전용 범위';
  if ((job.restores || []).some(restoreIsOpen)) return '복원 진행 중';
  if ((job.restores || []).some((r) => restoreUnknownHeld(r, now))) return '직전 복원 결과 모름 — Director 에서 확인';   // v2.873 B5-01
  if (lockedDir && (job.directorId || '') !== lockedDir) return '다른 법인 — 복원은 한 법인씩';
  return '';
}

/** 마법사의 첫 값 — 새 VM · 이름 '{원래}-restored' · 데이터스토어 그대로 · 네트워크 끊기(사용자 결정 ⓓ). */
export function defaultItem(job) {
  return { id: job.id, jobid: null, mode: 'newVm', name: `${job.vmName}-restored`, datastore: '', nic: 'disconnect', confirmName: '', allowDisksMismatch: false };
}

/** 방식을 바꿀 때 네트워크 기본도 따라간다(새 VM 끊기 · 덮어쓰기 그대로) — 사람이 바꾼 값은 방식이 같으면 유지. */
export function withMode(it, mode) {
  if (it.mode === mode) return it;
  return { ...it, mode, nic: mode === 'newVm' ? 'disconnect' : mode === 'original' ? 'keep' : it.nic, ...(mode !== 'original' ? { allowDisksMismatch: false, confirmName: '' } : {}) };
}

/** 서버로 보낼 항목 모양(필요한 칸만). */
export function itemBody(it) {
  return {
    id: it.id, jobid: it.jobid, mode: it.mode,
    ...(it.mode === 'newVm' ? { newVm: { name: String(it.name || '').trim(), ...(it.datastore ? { datastore: it.datastore } : {}) } } : {}),
    ...(it.mode === 'original' ? { confirmName: it.confirmName, ...(it.allowDisksMismatch ? { allowDisksMismatch: true } : {}) } : {}),
    ...(it.mode !== 'localVmdk' ? { nic: it.nic } : {}),
  };
}

/** 복원 지점 한 줄 — '10-23 02:00 · 증분 · 체인 3' · 체인을 못 만들면 고를 수 없다. */
export function pointText(p) {
  if (!p) return '—';
  return `${whenText(p.startedAt)} · ${levelLabel(p.level)} · ${p.chain ? `체인 ${p.chain}` : '체인 없음(고를 수 없음)'}`;
}
/** 고를 수 있는 가장 최근 지점(체인이 있는 것). */
export const latestPoint = (points) => (Array.isArray(points) ? points : []).find((p) => p && p.chain) || null;

/**
 * 2단계 → 3단계로 넘어가기 전 화면 쪽 빠른 확인(서버가 다시 판정한다). '' = 넘어갈 수 있다.
 * @param {object[]} items  마법사 항목
 * @param {Map<string, object>} jobsById
 */
export function wizardIssue(items, jobsById) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '복원할 VM 을 고르세요.';
  if (list.length > RESTORE_MAX) return `한 번에 ${RESTORE_MAX}대까지입니다.`;
  for (const it of list) {
    const job = jobsById.get(it.id);
    const who = job?.vmName || it.id;
    if (!it.jobid) return `‘${who}’ 의 복원 지점을 고르세요.`;
    if (it.mode === 'original' && list.length > 1) return '여러 대를 함께 복원할 때는 원래 VM 덮어쓰기를 쓸 수 없습니다 — 덮어쓰기는 1대씩.';
    if (it.mode === 'original' && it.confirmName !== job?.vmName) return `덮어쓸 VM 이름 ‘${who}’ 을 그대로 입력하세요.`;
    if (it.mode === 'newVm' && !String(it.name || '').trim()) return `‘${who}’ 의 새 VM 이름을 입력하세요.`;
  }
  const names = list.filter((x) => x.mode === 'newVm').map((x) => String(x.name || '').trim().toLowerCase());
  if (new Set(names).size !== names.length) return '새 VM 이름이 겹칩니다.';
  return '';
}

/** 데이터스토어 한 줄 — '이름 · 여유 1.2TB / 4TB'(못 읽으면 '여유 —'). */
export function dsText(ds) {
  if (!ds) return '—';
  const gb = (v) => { const n = Number(v); if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return '—'; return n >= 1024 ? `${(n / 1024).toFixed(1)}TB` : `${Math.round(n)}GB`; };
  return `${ds.name} · 여유 ${gb(ds.freeGB)} / ${gb(ds.capacityGB)}`;
}

/** 서버 미리 보기의 데이터스토어 판정 한 줄. */
export function capacityText(c) {
  if (!c) return '';
  const n = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}GB`);
  if (c.verdict === 'short') return c.issue || `‘${c.datastore}’ 여유 부족`;
  if (c.verdict === 'unknown') return `‘${c.datastore}’ — ${c.needGB === null ? 'VM 용량을' : '여유를'} 읽지 못해 판정하지 않았습니다(필요 ${n(c.needGB)} · 여유 ${n(c.freeGB)})`;
  return `‘${c.datastore}’ — 필요 약 ${n(c.needGB)} · 여유 ${n(c.freeGB)}(남겨 둘 여유 포함 충분)`;
}

/** 복원 뒤 네트워크 끊기 상태(원장 restores[].nic · finish). 옛 복원(nic 없음)은 '—'. */
export function finishText(r) {
  if (!r || !r.nic) return '—';
  if (r.nic === 'keep') return '그대로';
  const f = r.finish;
  if (!f) return restoreIsOpen(r) ? '복원 끝나면 끊음' : '끊기 대기';
  if (f.nic === 'pending') return '끊는 중';
  if (f.nic === 'ok') return '끊음';
  if (f.nic === 'skipped') return '안 함(복원이 성공하지 않음)';
  return `실패 — ${String(f.detail || '사유 미상').slice(0, 160)}`;
}
export const finishTone = (r) => (r?.finish?.nic === 'failed' ? 'bad' : r?.finish?.nic === 'ok' ? 'ok' : 'info');

/**
 * 묶음 진행 — 원장 대상들의 restores 중 이 batchId 인 것.
 * @returns {{ rows: object[], total:number, open:number, ok:number, bad:number, nicFailed:number }}
 */
export function batchView(jobs, batchId) {
  const rows = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    for (const r of j.restores || []) if (batchId && r.batchId === batchId) rows.push({ id: j.id, vmName: j.vmName, vcenterId: j.vcenterId, r });
  }
  rows.sort((a, b) => String(a.vmName).localeCompare(String(b.vmName), 'ko'));
  const st = (x) => String(x.r.state || '');
  return {
    rows, total: rows.length,
    open: rows.filter((x) => restoreIsOpen(x.r)).length,
    ok: rows.filter((x) => st(x) === 'ok' || st(x) === 'warning').length,
    bad: rows.filter((x) => st(x) === 'error' || st(x) === 'canceled').length,
    unknown: rows.filter((x) => x.r.unknown === true && !x.r.jobid).length,   // v2.873 B5-01 보낸 뒤 끊김(결과 모름)
    nicFailed: rows.filter((x) => x.r.finish?.nic === 'failed').length,
  };
}

/**
 * v2.873(점검 B5-01 · B5-02): 묶음 복원 응답 → 화면 결과(순수). 시작하지 못한 · 결과 모름 항목을 사유와 함께 보인다 —
 *   예전에는 202 문구가 '아래 진행 표의 사유' 를 가리켰지만 표는 원장(시작한 것)만 그려 사유가 어디에도 없었고, 전부 결과 모름이면 502
 *   '시작하지 못했습니다' 로 보여 다시 누르게 했다(두 번째 복원이 나갔다 — 재현).
 * @param {object|null} body  응답 본문(202) 또는 실패 본문(e.body)
 * @param {{ unknown?: boolean, message?: string }} [o]  unknown = 결과 모름(504 · 시한 · 연결 끊김 — outcomeUnknown)
 * @returns {{ tone:'ok'|'warn'|'bad', text:string, items:{ vmName:string, reason:string, unknown:boolean }[], reset:boolean }}
 *   reset = 마법사를 비운다(시작했거나 결과를 모른다 — 같은 고르기로 다시 보내지 않게)
 */
export function bulkRestoreOutcome(body, { unknown = false, message = '' } = {}) {
  const items = (Array.isArray(body?.items) ? body.items : []).filter((x) => x && x.ok === false)
    .map((x) => ({ vmName: String(x.vmName || x.id || '—'), reason: String(x.reason || '').slice(0, 300), unknown: x.code === 'unknown' }));
  const started = Number(body?.started) || 0;
  const total = Number(body?.total) || 0;
  const unk = items.filter((x) => x.unknown).length;
  if (started > 0) {
    const miss = Math.max(0, total - started);
    const missText = miss ? ` 시작하지 못한 ${miss}대${unk ? `(결과 모름 ${unk}대 — Director 에서 확인)` : ''}는 아래 사유를 보세요.` : '';
    return { tone: miss || body?.saveError ? 'warn' : 'ok', items, reset: true,
      text: `복원을 시작했습니다 — ${started} / ${total}대.${missText} 끝나면 네트워크 끊기를 고른 VM 은 포탈이 연결을 끊습니다 — 끊음 표시가 나오기 전에는 켜지 마세요.${body?.saveError ? ` ${body.saveError}` : ''}` };
  }
  if (unknown || unk) {
    const m = String(message || body?.reason || '').slice(0, 300);
    return { tone: 'bad', items, reset: true,
      text: `복원 결과를 확인하지 못했습니다 — 이미 시작됐을 수 있습니다. 같은 복원이 두 번 돌지 않게 그 VM 은 잠시 다시 고를 수 없습니다 — 아래 최근 묶음 · 이력(또는 Director)에서 확인하세요.${m ? ` (${m})` : ''}` };
  }
  return { tone: 'bad', items, reset: false, text: String(body?.reason || message || '복원을 시작하지 못했습니다.') };
}
/** 가장 최근 묶음 id(복원 시작 시각 기준) — 없으면 ''. */
export function latestBatchId(jobs) {
  let best = null;
  for (const j of Array.isArray(jobs) ? jobs : []) for (const r of j.restores || []) if (r.batchId && !r.rehearsal && (!best || (r.at || 0) > (best.at || 0))) best = r;   // 검증 회차는 복원 검증 표에서
  return best?.batchId || '';
}

/**
 * 덮어쓰기 복원 뒤 첫 백업은 Full 권장(bareos-users — 디스크가 통째로 바뀌어 변경 블록 추적 증분이 맞지 않는다) — 그 뒤 실행이 아직 없으면.
 * @returns {string} 안내 한 줄('' = 해당 없음)
 */
export function fullAfterRestoreHint(job) {
  const r = (job?.restores || []).find((x) => x.mode === 'original' && (x.state === 'ok' || x.state === 'warning'));
  if (!r) return '';
  const since = Number(r.endedAt || r.at || 0);
  const last = Number(job?.lastRun?.startedAt || 0);
  if (last && since && last > since) return '';
  return '원래 VM 에 덮어쓰기 복원한 뒤 아직 백업이 없습니다 — 다음 백업은 Full 로 돌리세요(지금 백업 › Full).';
}

/** 남은 스냅샷 칩 — n>0 이면 글자, 모르면 null(0 으로 보지 않는다). */
export function snapshotChip(n) {
  const v = Number(n);
  if (n === null || n === undefined || n === '' || !Number.isFinite(v) || v <= 0) return null;
  return `스냅샷 ${v}개`;
}
export const SNAPSHOT_TITLE = '스냅샷이 남아 있습니다 — 백업이 실패한 뒤 남은 것일 수 있고, 남은 스냅샷은 다음 백업과 덮어쓰기 복원을 막습니다. vCenter 에서 확인하세요.';

/* ───────── v2.862 복원 검증(리허설) · 일일 요약 메일 ───────── */
export const WEEKDAYS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
/** 정책 한 줄 — '꺼짐' 이면 그 사실부터. */
export function rehearsalPolicyText(p) {
  if (!p) return '—';
  const when = `매주 ${WEEKDAYS[p.weekday] ?? '—'}요일 ${p.time || '—'}`;
  const dsN = Object.keys(p.datastores || {}).length;
  return `${p.enabled ? '켜짐' : '꺼짐'} · ${when} · 법인마다 ${unitText(p.perCorp, '대')} · 성공한 검증용 VM ${p.deleteOnOk === false ? '남김' : '지움'} · 실패는 남김${dsN ? ` · 데이터스토어 지정 ${dsN}곳` : ''}`;
}

/**
 * v2.863 복원 검증 정책의 vCenter 데이터스토어 선택지(순수). 첫 칸은 '고르지 않음(홈 데이터스토어)'.
 *   list 가 null 이면 목록을 못 읽었거나(loading 이면 읽는 중) — 지금 값을 그 사유로 남긴다(못 읽은 것을 '없음' 으로 단정하지 않는다).
 *   지금 값이 쓸 수 있는 목록에 없으면 지우지 않고 그 사유(접근 불가 · 인벤토리에 없음)를 붙여 남긴다 — 저장이 조용히 바꾸지 않게.
 * @param {{name:string, freeGB?:number|null, capacityGB?:number|null, accessible?:boolean}[]|null} list  그 vCenter 의 데이터스토어
 * @returns {{ value:string, label:string, warn?:boolean }[]}
 */
export function rehearsalDsOptions(list, current = '', { loading = false } = {}) {
  const all = Array.isArray(list) ? list.filter((x) => x && x.name) : [];
  const usable = all.filter((x) => x.accessible !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const out = [{ value: '', label: '고르지 않음 — VM 의 홈 데이터스토어' }, ...usable.map((x) => ({ value: x.name, label: dsText(x) }))];
  const cur = String(current || '');
  if (cur && !usable.some((x) => x.name === cur)) {
    const known = all.find((x) => x.name === cur);
    const why = list === null ? (loading ? '목록을 읽는 중' : '목록을 읽지 못함') : known ? '접근 불가(인벤토리 기준)' : '인벤토리에 없음 — 검증 때 건너뜁니다';
    out.splice(1, 0, { value: cur, label: `${cur} · ${why}`, warn: true });
  }
  return out;
}
/**
 * v2.873(점검 B4-02): 법인(Director)별 마지막 회차(순수) — 서버 상태가 Director 마다 최근 몇 건을 남긴다(앞이 최신).
 *   예전에는 회차 기록(runs · weeks)을 화면이 그리지 않아, 매주 0대로 끝나는 정기 검증이 화면에서 보이지 않았다(무음 실패).
 * @returns {{ directorId:string, run:object, older:number }[]}  directors 순서 · 기록 없는 Director 는 뺀다
 */
export function rehearsalLastRuns(runs, directors = []) {
  const by = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    const k = String(r?.directorId || '');
    const cur = by.get(k);
    if (!cur) by.set(k, { directorId: k, run: r, older: 0 }); else cur.older += 1;
  }
  const order = (Array.isArray(directors) ? directors : []).map((x) => String(x.id));
  const known = order.filter((id) => by.has(id)).map((id) => by.get(id));
  const rest = [...by.values()].filter((x) => !order.includes(x.directorId)).sort((a, b) => (Number(b.run.at) || 0) - (Number(a.run.at) || 0));
  return [...known, ...rest];
}
/** 회차 한 줄 — '11-07 03:17 · 정기 · 시작 2대 · 건너뜀 1대 — 사유'. */
export function rehearsalRunText(run) {
  if (!run) return '—';
  const items = Array.isArray(run.items) ? run.items : [];
  const ok = items.filter((x) => x?.ok).length;
  const skip = items.filter((x) => x && !x.ok).length + (Number(run.moreItems) || 0);
  return `${whenText(run.at)} · ${run.trigger === 'timer' ? '정기' : '지금 검증'} · 시작 ${unitText(ok, '대')}${skip ? ` · 건너뜀 · 실패 ${unitText(skip, '대')}` : ''}${run.reason ? ` — ${String(run.reason).slice(0, 200)}` : ''}`;
}
export const rehearsalRunTone = (run) => {
  const items = Array.isArray(run?.items) ? run.items : [];
  if (items.some((x) => x?.ok)) return items.some((x) => x && !x.ok) ? 'warn' : 'ok';
  return 'bad';
};
/**
 * 검증용 VM 정리 칸 — 지움 · 남김 · 모름. v2.873(점검 B3-01): 옛 엣지 회신에는 deleted 가 없다 — 성공했는데 지웠는지 모르면 '남김' 으로 단정하지 않는다.
 */
export function cleanupText(finish) {
  if (!finish) return '—';
  if (finish.deleted === true) return '지움';
  if (finish.verify === 'ok' && finish.deleted !== false) return '모름(회신에 없음 — vCenter 에서 확인)';
  return finish.verify ? '남김' : '—';
}
/** Tools 응답 시간 — 모르면 '—'(0 이 아니다). */
export function toolsText(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || ms === '' || !Number.isFinite(n) || n < 0) return '—';
  return n < 60_000 ? `${Math.round(n / 1000)}초` : `${Math.floor(n / 60_000)}분 ${Math.round((n % 60_000) / 1000)}초`;
}
/** 검증 결과 한 칸 — 복원 진행 · 켜 보는 중 · 성공 · 실패 · 복원 실패. */
export function verifyText(row) {
  const f = row?.finish;
  if (f?.verify === 'ok') return '성공 — VMware Tools 응답';
  if (f?.verify === 'failed') return '실패';
  if (f?.nic === 'skipped' || row?.state === 'error' || row?.state === 'canceled') return '복원 실패 — 켜 보지 못함';
  if (f?.nic === 'failed') return '실패';
  if (f?.nic === 'pending') return '켜 보는 중';
  return restoreIsOpen({ jobid: row?.rid, state: row?.state }) ? '복원 중' : '켜 보기 대기';
}
/**
 * 복원 검증 한 행의 결과 — 'ok' | 'failed' | 'pending'(v2.870 감사 A2-02 — 판정 코어 하나).
 *   서버 bareos/digest.js verifyOutcome 과 한 쌍(server/test/bareosVerifyOutcome2870.test.js 가 같은 입력으로 대조).
 *   리허설 표(verifyTone) · 복원 › 폴더 표(restoreStateText) · 일일 요약 메일이 같은 판정을 쓴다(예전에는 켜 보는 중 · 재시도 소진이 폴더 표에서 '검증 성공').
 */
export function verifyOutcome(r) {
  const f = r?.finish;
  if (f?.verify === 'ok') return 'ok';
  if (f?.verify === 'failed' || f?.nic === 'failed' || f?.nic === 'skipped' || r?.state === 'error' || r?.state === 'canceled' || r?.abandoned) return 'failed';
  return 'pending';
}
export const verifyTone = (row) => ({ ok: 'ok', failed: 'bad' }[verifyOutcome(row)] || 'info');
/** 일일 요약 마지막 발송 한 줄. */
export function digestStatusText(st) {
  if (!st || !st.day) return '아직 보낸 적 없음';
  return `${st.day} ${st.ok ? '보냄' : `실패(${st.tries || 0}번 — ${st.reason || '사유 미상'})`}`;
}
