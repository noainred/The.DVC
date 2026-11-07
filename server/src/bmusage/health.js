/**
 * bmusage/health.js — **점검 소모품** 8칸 판정(순수 · v2.929 예정 · 리눅스 성능 5단계 · 설계 PROFILES §14 ⑧ · 아트보드 Health).
 *
 * 판정은 **데이터를 가진 노드**(엣지 또는 중앙의 직접 수집분)가 이 노드의 기준값(`perfRules.health`)으로 한다 — 중앙은 엣지가 보낸 칸 code 를 그대로 전한다
 *   (v2.548 ‘중앙이 다시 판정하지 않는다’). 웹은 code → 문구만(bmHealthText — 판정 복제 금지).
 *
 * 칸 code: ok | warn | bad | missing(못 읽음) | absent(그 도구 · 구획이 없다 — chrony 대신 다른 시각 동기 등) | perm(권한 부족 또는 실패 — dmesg_restrict) |
 *   na(해당 없음 — 등록된 TLS 서비스가 없다 · 재부팅 필요 여부 도구 없음) | info(참고 — 판정하지 않는 사실).
 * ⚠⚠ ‘못 읽음’ · ‘없음’ · ‘해당 없음’ 은 정상에도 주의에도 넣지 않고 따로 센다(루트 CLAUDE.md ‘못 읽은 값은 0 이 아니다’).
 * ⚠ 기준값은 설정이고 응답에 함께 싣는다(화면에 숫자를 박지 않는다). 기본값은 아트보드의 ‘기준(설정)’ 열 — chrony ±100ms · FD/conntrack 80% ·
 *   dmesg 24시간 오류 0 · 인증서 30일. 공식 권고가 아닌 것은 ‘관행’(○)이라 화면이 그렇게 적는다.
 */
import { numOrNull } from '../util/numOrNull.js';

const n = numOrNull;
export const HEALTH_CELLS = Object.freeze(['chrony', 'units', 'oom', 'dmesg', 'uptime', 'fdct', 'cert', 'tuned']);
export const HEALTH_CODES = Object.freeze(['ok', 'warn', 'bad', 'missing', 'absent', 'perm', 'na', 'info']);
/** 근거 등급(아트보드 Health 표) — ● 원문 확인 · ◐ 발췌 · ○ 관행/공식 문서 없음. 웹은 이 값을 그대로 보인다. */
export const HEALTH_GRADE = Object.freeze({ chrony: '●', units: '○', oom: '◐', dmesg: '○', uptime: '●', fdct: '●', cert: '○', tuned: '●' });
export const HEALTH_DEFAULTS = Object.freeze({ chronyMs: 100, fdPct: 80, conntrackPct: 80, dmesgErr24h: 0, certDays: 30 });
/** 이 비율을 넘으면 bad(주의의 한 단계 위). chrony 는 기준 × 10 · FD/conntrack 은 95%. 추정 시작값. */
export const HEALTH_BAD = Object.freeze({ chronyFactor: 10, pct: 95 });

const abs = (v) => (v == null ? null : Math.abs(v));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * 한 서버의 소모품 8칸.
 * @param {object} p
 * @param {object|null} p.hfacts   detail.hfacts(usage.js buildPerf) — 없으면 OS 구획을 못 받은 서버
 * @param {object|null} p.tuning   tuning_json(실패 유닛 · SELinux · TuneD)
 * @param {object|null} p.row      최신 행(oom_kill_delta)
 * @param {object|null} p.cert     { days, count } | null(등록된 TLS 점검 없음) | { error }
 * @param {object} p.th            기준값(perfRules.health)
 */
export function judgeHealth({ hfacts = null, tuning = null, row = null, cert = null, th = {}, now = Date.now() } = {}) {
  const T = { ...HEALTH_DEFAULTS, ...(th || {}) };
  const hf = hfacts && typeof hfacts === 'object' ? hfacts : null;
  const sec = hf?.sections || {};
  const cells = {};

  // ① 시각 동기(chrony) — 구획 absent = chrony 없음 · 실패 = 못 읽음 · 소스 없음(동기 안 됨) = 주의 · |오프셋| 기준 × 10 이상 = 이상.
  {
    const c = hf?.chrony || null;
    if (!hf || sec.chrony === 'missing') cells.chrony = { code: 'missing' };
    else if (sec.chrony === 'absent') cells.chrony = { code: 'absent' };
    else if (!c) cells.chrony = { code: 'missing' };
    else {
      const off = abs(n(c.offsetMs));
      const lim = n(T.chronyMs);
      let code = 'ok'; let why = '';
      if (c.synced === false) { code = 'warn'; why = 'no-source'; }
      else if (off == null || lim == null) { code = c.synced == null ? 'missing' : 'ok'; }
      else if (off >= lim * HEALTH_BAD.chronyFactor) { code = 'bad'; why = 'offset'; }
      else if (off >= lim) { code = 'warn'; why = 'offset'; }
      cells.chrony = { code, offsetMs: n(c.offsetMs), stratum: n(c.stratum), leap: c.leap || null, synced: c.synced ?? null, limitMs: lim, ...(why ? { why } : {}) };
    }
  }
  // ② 실패 유닛(systemd) — 4단계 UNITS(R7: 실패 = missing) 그대로.
  {
    const f = n(tuning?.units?.failed);
    cells.units = f == null ? { code: 'missing' } : { code: f > 0 ? 'warn' : 'ok', failed: f };
  }
  // ③ OOM — 이번 주기 증가분(rates.js oom_kill_delta — 첫 표본 · 리셋은 null)과 부팅 이후 누적.
  {
    const d = n(row?.oom_kill_delta); const total = n(hf?.oomTotal);
    if (d == null && total == null) cells.oom = { code: 'missing' };
    else if (d != null && d > 0) cells.oom = { code: 'bad', delta: d, total };
    else if (d === 0) cells.oom = { code: 'ok', delta: 0, total };
    else cells.oom = { code: 'info', delta: null, total };   // 누적만 — 증가분은 다음 주기(첫 표본)
  }
  // ④ 커널 오류 메시지율(dmesg 개수만) — 실패(권한 · 옵션)는 perm, 24시간 오류 수 > 기준이면 주의.
  {
    const d = hf?.dmesg || null;
    if (!hf || sec.dmesg === 'missing' || !d) cells.dmesg = { code: 'missing' };
    else if (d.failed) cells.dmesg = { code: 'perm', rc: n(d.rc) };
    else {
      const e24 = n(d.err24); const lim = n(T.dmesgErr24h);
      cells.dmesg = { code: e24 != null && lim != null && e24 > lim ? 'warn' : 'ok', err24: e24, warn24: n(d.warn24), err: n(d.err), warn: n(d.warn), limit: lim };
    }
  }
  // ⑤ 가동 시간 · 재부팅 필요(needs-restarting -r 종료 코드) — 도구가 없으면 na(가동 시간은 보인다).
  {
    const up = n(hf?.upS);
    const days = up == null ? null : Math.floor(up / 86_400);
    if (!hf || sec.changes === 'missing' || (up == null && hf.needsRestart == null && !hf.nrAbsent)) cells.uptime = { code: 'missing' };
    else if (hf.needsRestart === true) cells.uptime = { code: 'warn', upDays: days, needsRestart: true, kernel: hf.kernel || null };
    else if (hf.needsRestart === false) cells.uptime = { code: 'ok', upDays: days, needsRestart: false, kernel: hf.kernel || null };
    else cells.uptime = { code: hf.nrAbsent ? 'na' : 'missing', upDays: days, needsRestart: null, kernel: hf.kernel || null, ...(hf.nrAbsent ? { why: 'no-tool' } : {}) };
  }
  // ⑥ 파일 디스크립터 · conntrack — 둘 중 높은 쪽. conntrack 모듈이 없으면 FD 만.
  {
    const fd = n(hf?.fd?.pct); const ct = n(hf?.conntrack?.pct);
    if (fd == null && ct == null) cells.fdct = { code: 'missing' };
    else {
      const worst = (v, lim) => (v == null || lim == null ? 'ok' : v >= HEALTH_BAD.pct ? 'bad' : v >= lim ? 'warn' : 'ok');
      const rank = { ok: 0, warn: 1, bad: 2 };
      const a = worst(fd, n(T.fdPct)); const b = worst(ct, n(T.conntrackPct));
      cells.fdct = { code: rank[a] >= rank[b] ? a : b, fdPct: r1(fd), conntrackPct: r1(ct), conntrackAbsent: hf?.conntrack == null, limitFd: n(T.fdPct), limitCt: n(T.conntrackPct) };
    }
  }
  // ⑦ 인증서 — 기존 성능 점검(svcmon) cert 결과 재사용. 이 서버 주소로 등록된 TLS 점검이 없으면 na(해당 없음 — 확인 불가와 구분).
  {
    if (!cert) cells.cert = { code: 'na', why: 'not-registered' };
    else if (cert.error) cells.cert = { code: 'missing' };
    else {
      const d = n(cert.days); const lim = n(T.certDays);
      cells.cert = d == null ? { code: 'missing', count: n(cert.count) }
        : { code: d <= 0 ? 'bad' : lim != null && d <= lim ? 'warn' : 'ok', days: d, count: n(cert.count), limit: lim };
    }
  }
  // ⑧ TuneD · SELinux · firewalld — 사실(참고). 프로파일 요구값 대조는 튜닝 · 용도 탭이 한다(판정 복제 금지).
  {
    const tuned = typeof tuning?.sysctl?.['tuned.active_profile'] === 'string' ? tuning.sysctl['tuned.active_profile'] : null;
    const selinux = tuning?.os?.selinux ?? null;
    const fw = hf?.firewalld ?? null;
    cells.tuned = tuned == null && selinux == null && fw == null ? { code: 'missing' } : { code: 'info', tuned, selinux, firewalld: fw };
  }

  const counts = { ok: 0, warn: 0, bad: 0, missing: 0, absent: 0, perm: 0, na: 0, info: 0 };
  for (const k of HEALTH_CELLS) counts[cells[k].code] += 1;
  return { v: 1, at: n(now), cells, counts, attention: counts.warn + counts.bad };
}

/** 목록(보드 · 함대 표)용 — code 와 since 만(값은 상세에서). */
export function compactHealth(h) {
  if (!h || typeof h !== 'object' || !h.cells) return null;
  const cells = {};
  for (const k of HEALTH_CELLS) if (h.cells[k]) cells[k] = { code: h.cells[k].code, ...(h.since?.[k] != null ? { since: h.since[k] } : {}) };
  return { cells, attention: n(h.attention) ?? 0, at: n(h.at) };
}

/**
 * svcmon cert 점검 결과에서 이 서버의 인증서 남은 일수(가장 짧은 것). 서버 주소 · 이름과 svcmon 대상 host 가 같을 때만(정확 일치 — 소문자).
 * @param {{targets:Array, results:Map, certDaysOf:Function}} src
 * @returns {{days:number|null, count:number}|null}  null = 등록된 TLS 점검 없음
 */
export function certForServer(target, { targets = [], results = new Map(), certDaysOf = () => null } = {}) {
  const names = new Set([target?.osHost?.host, target?.osHostName, target?.name, target?.idrac?.host].filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')));
  if (!names.size) return null;
  let best = null; let count = 0;
  for (const tg of targets || []) {
    const h = String(tg?.host || '').toLowerCase();
    if (!h || !names.has(h)) continue;
    for (const x of tg.tests || []) {
      if (x?.type !== 'cert') continue;
      count += 1;
      const d = certDaysOf(results.get(x.id)?.reply);
      if (d != null && (best == null || d < best)) best = d;
    }
  }
  return count ? { days: best, count } : null;
}
