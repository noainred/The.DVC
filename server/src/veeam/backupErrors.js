/**
 * veeam/backupErrors.js — Backup › Summary '통합 에러 로그'(v2.838 · 시안 ①). 순수 함수 — 행 모양 하나로 모은다.
 *   쓰는 곳: routes/api/veeam.js GET /tools/backup-summary/errors.
 *
 * 출처(시안 'Veeam 세션 + Bareos 실패·경고 잡 + 포탈 수집 오류 · 같은 모양으로'). 포탈이 읽는 것만 — 지어내지 않는다:
 *   · Veeam VM = 그 VM 의 **마지막** task 결과(lr Failed·Warning · 끝난 시각 lrt · 메시지는 호출부 msgOf — 원문 가림은 호출부가) — 더 이전 실패는 B&R 결과에 없다(VM 마다 1건)
 *   · Veeam 잡 세션 = EM 의 최근 실패·경고 세션(recentBad — EM 이 7일만 읽는다 · 전 법인 자료라 전체 범위 계정만 — 라우트가 정한다)
 *   · Bareos = 원장의 끝난 실행(lastRun + 최근 5건 — 오류 E·e·f · 취소 A · 경고 W) · joblog 원문은 2차(지금은 상태 · jobid · 레벨)
 *     + 멈춤 의심(진행 현황이 신선할 때만 — 지금의 상태)
 *   · 수집 오류 = Veeam B&R 서버 읽기 실패·인증 정지 · EM 읽기 실패·인증 정지 · Bareos Director 조회 실패
 *   · v2.840 오류 볼륨 = Bareos 정책 수집본의 VolStatus Error 볼륨(시각 = 볼륨 목록을 수집한 시각 — 그때 본 상태 · Director 에 접속하지 않는다)
 *   시각을 모르는 결과는 넣지 않는다(창 안인지 모른다). 수집 오류는 마지막 시도 시각.
 */

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);
export const ERROR_DAYS = Object.freeze([1, 7, 30]);
export const ERROR_ROWS_MAX = 1000;
const B_KIND = { E: 'fail', e: 'fail', f: 'fail', A: 'fail', W: 'warn' };
const B_LEVEL = { F: 'Full', I: 'Incremental', D: 'Differential', V: 'VirtualFull' };   // 카탈로그 한 글자 레벨을 사람이 읽는 이름으로(모르는 값은 그대로)
const B_TEXT = { E: '오류로 끝남', e: '오류로 끝남(비치명)', f: '치명 오류', A: '취소됨', W: '경고와 함께 끝남' };
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

/**
 * Veeam VM 마지막 결과 — 창 안에 끝난 실패·경고.
 * @param {(row:object) => string} msgOf 메시지(호출부가 관리자 판본이 아니면 가린다 — parse.js TASK_MSG · publicTaskMessage)
 */
export function veeamVmRows(rows, site, since, msgOf = () => '') {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = r?.v;
    if (!v || !isFin(v.lrt) || v.lrt < since) continue;
    const kind = /^fail/i.test(v.lr || '') ? 'fail' : /^warn/i.test(v.lr || '') ? 'warn' : null;
    if (!kind) continue;
    out.push({ at: v.lrt, vc: site.id, vcName: site.name, src: 'veeam', kind, job: str((v.jobs || [])[0], 128), vm: str(r.name, 128), vmId: r.id,
      msg: str(msgOf(r), 300) || (kind === 'fail' ? 'Veeam task 결과 Failed' : 'Veeam task 결과 Warning'), open: 'detail' });
  }
  return out;
}

/**
 * Bareos 원장 — 그 법인 잡(digest)의 끝난 실행 중 창 안의 오류·취소·경고(jobid 로 한 번만).
 * @param {Map<string,object>|null} digests vmId → jobDigest(원장을 못 읽으면 null — 행 없음 · 라우트가 '모름' 을 밝힌다)
 * @param {Set<string>} vmIds 범위(전원·제외) 안 VM
 */
export function bareosRows(digests, vmIds, site, since) {
  const out = [];
  if (!digests) return out;
  for (const j of digests.values()) {
    if (vmIds && !vmIds.has(j.vmId)) continue;
    const seen = new Set();
    for (const r of [j.lastRun, ...(Array.isArray(j.recentRuns) ? j.recentRuns : [])]) {
      if (!r || !isFin(r.endedAt) || r.endedAt < since || seen.has(r.jobid)) continue;
      const c = String(r.status || '').slice(0, 1);
      if (!B_KIND[c]) continue;
      seen.add(r.jobid);
      // v2.871 jobKey = 원장 잡 id — 화면의 '로그' 서랍 · '이력 →' 이 그 실행을 바로 연다(로그 라우트가 원장 id 를 받는다 · 예전에는 고정 주소로만 갔다)
      out.push({ at: r.endedAt, vc: site.id, vcName: site.name, src: 'bareos', kind: B_KIND[c], job: str(j.bareosJob, 128), vm: str(j.vmName, 128), vmId: j.vmId, jobKey: str(j.id, 64), ...(site.relay ? { relay: true } : {}),
        jobid: Number(r.jobid) || null, msg: `${B_TEXT[c]}${r.level ? ` · ${B_LEVEL[r.level] || str(r.level, 16)}` : ''}${isFin(r.errors) && r.errors > 0 ? ` · 오류 ${r.errors}건` : ''} — joblog 원문은 Bareos › 실행 이력`, open: 'bareos' });
    }
  }
  return out;
}

/**
 * EM 최근 실패·경고 세션(전체 범위 계정만 — 호출부가 정한다). 법인 칸은 백업 서버 매핑이 있는 세션만(vcNames).
 * @param {Array<{id,name,data:{sessions:{recentBad:[]}}}>} ems emData().ems
 */
export function emSessionRows(ems, since) {
  const out = [];
  for (const em of Array.isArray(ems) ? ems : []) {
    for (const s of em?.data?.sessions?.recentBad || []) {
      if (!isFin(s?.end) || s.end < since) continue;
      const kind = s.result === 'fail' ? 'fail' : s.result === 'warn' ? 'warn' : null;
      if (!kind) continue;
      // EM 세션에는 법인 id 가 없다 — em/view.js withVc 가 백업 서버 매핑으로 단 법인 이름(vcNames · 모르면 null)만 쓴다
      const names = Array.isArray(s.vcNames) ? s.vcNames.map((x) => str(x, 64)).filter(Boolean) : [];
      out.push({ at: s.end, vc: '', vcName: names.slice(0, 3).join(', ') + (names.length > 3 ? ` 외 ${names.length - 3}` : ''), src: 'veeam', kind, job: str(s.job, 128), vm: '', server: str(s.server, 128),
        msg: `EM 세션 결과 ${kind === 'fail' ? 'Failed' : 'Warning'}${s.server ? ` · ${str(s.server, 64)}` : ''}`, open: 'em', uid: str(s.uid, 200), em: em.id });
    }
  }
  return out;
}

/**
 * Bareos 멈춤 의심(시안 '멈춤 의심' 행) — 진행 현황(bareosLive.corpView)의 실행 중 행 중 stuck 이 달린 것. 지금의 상태라 기간과 무관하게 든다.
 *   호출부가 진행 현황 조회가 신선할 때만 넘긴다(Summary 배지와 같은 규칙 — 조회를 새로 일으키지 않는다 · 아니면 행 없음 = 모름).
 * @param {Array<{vmId, vmName, jobid, elapsed, stuck}>} rows corpView().rows
 * @param {number} at 진행 현황 조회 시각
 */
const STUCK_TEXT = { 'no-report': 'FD 진행 보고 없음', zero: '전송 속도 0' };
export function stuckRows(rows, site, at) {
  const out = [];
  if (!isFin(at)) return out;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.stuck) continue;
    const m = isFin(r.elapsed) ? Math.floor(r.elapsed / 60_000) : null;
    out.push({ at, vc: site.id, vcName: site.name, src: 'bareos', kind: 'stuck', job: '', vm: str(r.vmName, 128), vmId: r.vmId, jobid: Number(r.jobid) || null,
      msg: `${m == null ? '오래' : `${Math.floor(m / 60)}시간 ${m % 60}분째`} 실행 중 · ${STUCK_TEXT[r.stuck] || '진행 없음'}`, open: 'live' });
  }
  return out;
}

/**
 * 수집 오류 — 지금 읽지 못하는 출처(마지막 시도 시각). 오류 원문은 호출부가 관리자 판본일 때만 넘긴다(가림 규칙).
 * @param {Array<{at, vc, vcName, src:'veeam'|'bareos', name, error, auth}>} items
 */
export function collectRows(items, since) {
  const out = [];
  for (const x of Array.isArray(items) ? items : []) {
    const at = isFin(x?.at) ? x.at : null;
    if (at == null || at < since) continue;
    out.push({ at, vc: x.vc || '', vcName: x.vcName || '', src: 'collect', via: x.src, kind: 'collect', job: str(x.name, 128), vm: '',
      msg: x.auth ? `인증 실패 — 주기 수집 정지(자동 재시도 없음 · 계정 잠금 방지)${x.error ? ` · ${str(x.error, 200)}` : ''}` : `읽기 실패${x.error ? ` — ${str(x.error, 240)}` : ''}`,
      open: x.src === 'bareos' ? 'bareos-settings' : 'em' });
  }
  return out;
}

/**
 * v2.840 오류 볼륨 — 정책 수집본(bareos/policy.errorVolumeItems)의 VolStatus Error. 볼륨마다 한 줄(이름을 모르는 나머지는 한 줄로 묶는다).
 *   법인: Director 에 묶인 법인이 하나면 그 법인 · 여럿이면 이름만 잇는다(법인 · vCenter · Bareos 1:1:1 이 기본 — 예외 매핑을 지어내 나누지 않는다).
 * @param {Array<{ at, director, vcIds, pool, n, names }>} items @param {(id:string) => string} vcName
 */
export function volumeRows(items, since, vcName = (x) => x) {
  const out = [];
  for (const x of Array.isArray(items) ? items : []) {
    if (!isFin(x?.at) || x.at < since) continue;
    const ids = Array.isArray(x.vcIds) ? x.vcIds : [];
    const base = { at: x.at, vc: ids.length === 1 ? ids[0] : '', vcName: ids.map(vcName).slice(0, 3).join(', ') + (ids.length > 3 ? ` 외 ${ids.length - 3}` : ''), src: 'bareos', kind: 'volume', vm: '', open: 'pools' };
    const msg = `볼륨 상태 Error · 풀 ${str(x.pool, 64)} · Director ${str(x.director, 64)} — 정책 수집 때 본 상태(Director 에서 확인 후 다시 쓰거나 지우세요)`;
    const names = (Array.isArray(x.names) ? x.names : []).map((n) => str(n, 128)).filter(Boolean);
    for (const n of names) out.push({ ...base, job: n, msg });
    const rest = (Number(x.n) || 0) - names.length;
    if (rest > 0) out.push({ ...base, job: `그 밖 볼륨 ${rest}개`, msg });
  }
  return out;
}

/** v2.871 Bareos 실행 묶음 창 — 같은 모양이어도 1시간 넘게 떨어지면 다른 묶음(다른 회차가 섞이지 않게 · 시안 기본값 ①). */
export const SHAPE_WINDOW_MS = 3_600_000;
/**
 * 같은 모양 묶음(v2.871 — 예전 '같은 원인'). 각 행에 group(묶음 id) · same(묶음 크기)을 단다. 순수.
 *  · Bareos 끝난 실행(jobKey 가 있는 실패 · 경고 · 취소) = 법인 · 결과 · 메시지(레벨 · 오류 수 — VM 이름이 없다)가 같고, 새것부터 훑어 묶음의 가장 옛 행과
 *    SHAPE_WINDOW_MS 안이면 같은 묶음. 잡 이름은 VM 마다 달라 예전 키로는 한 번도 묶이지 않았다(사용자 스크린샷 — OC2 15건이 '—').
 *  · 그 밖(Veeam · 멈춤 의심 · 오류 볼륨 · 수집 오류) = 예전과 같은 키(출처 · 결과 · 잡 · 메시지 앞머리 40자) · 창 없음.
 *  ⚠ 같은 모양 ≠ 같은 원인 — 원장에는 오류 원문이 없다. 원인 대조는 '묶음 로그'(ops.logs · compareFirstErrors)가 로그를 읽은 뒤에만 한다.
 */
export function withShapeGroups(rows) {
  const list = (Array.isArray(rows) ? rows : []).map((r, i) => ({ r, i })).sort((a, b) => (b.r.at - a.r.at) || (a.i - b.i));
  const open = new Map();   // 키 → { id, oldest }
  const gid = new Array(list.length);
  let seq = 0;
  for (const { r, i } of list) {
    const run = r.src === 'bareos' && !!r.jobKey;
    const key = run ? `run|${r.vc}|${r.kind}|${String(r.msg || '').slice(0, 120)}` : `${r.src}|${r.kind}|${r.job}|${String(r.msg || '').slice(0, 40)}`;
    const g = open.get(key);
    if (g && (!run || (isFin(g.oldest) && isFin(r.at) && g.oldest - r.at <= SHAPE_WINDOW_MS))) { gid[i] = g.id; g.oldest = r.at; continue; }
    const id = `g${++seq}`;
    open.set(key, { id, oldest: r.at });
    gid[i] = id;
  }
  const size = new Map();
  for (const id of gid) size.set(id, (size.get(id) || 0) + 1);
  return (Array.isArray(rows) ? rows : []).map((r, i) => ({ ...r, group: gid[i], same: size.get(gid[i]) }));
}

/** 정렬(새것 먼저) · 상한 · 수(전부 센다). */
export function finishErrors(rows, max = ERROR_ROWS_MAX) {
  const all = withShapeGroups(rows).sort((a, b) => b.at - a.at || String(a.vcName).localeCompare(String(b.vcName)));
  const counts = { all: all.length, fail: 0, warn: 0, stuck: 0, collect: 0, volume: 0, veeam: 0, bareos: 0 };
  for (const r of all) { counts[r.kind]++; if (r.src === 'veeam' || r.src === 'bareos') counts[r.src]++; }
  return { rows: all.slice(0, max), counts, ...(all.length > max ? { truncated: true } : {}) };
}
