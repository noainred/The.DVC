/**
 * bmusage/changes.js — **변경 이벤트 띠**(v2.929 예정 · 리눅스 성능 5단계 · 설계 PROFILES §14 ③ · 아트보드 Compare).
 *
 * 수집 노드(엣지 또는 중앙 직접 수집)가 매 주기 `##CHANGES` 사실 · 화이트리스트 sysctl · TuneD · SELinux · 실패 유닛 수 · iDRAC 인벤토리 펌웨어 ·
 *   CVP 수동 매핑 · 점검 소모품 칸 code 를 **직전 사실과 비교해 다를 때만** change_event 에 적는다(전이만 — 파트 장애 v2.548 와 같은 판단).
 *   직전 사실은 change_latest(서버당 1행)에 남긴다 — 재시작해도 같은 변화를 다시 적지 않는다.
 *
 * ⚠⚠ 내용 보관 금지: before/after 는 **짧은 값**뿐 — 커널 릴리스 · 파일 CRC 앞 8자 · 개수 · 프로파일 이름 · 화이트리스트 sysctl 값(숫자 · 짧은 값) ·
 *   dnf 트랜잭션 ID · 동작 · 바뀐 수. 설정 파일 내용 · crontab 줄 · dmesg 원문 · dnf 명령줄은 수집 단계에서 이미 없다(parse/linuxHealth.js) — 소스 스윕이 고정.
 * ⚠ 못 읽은 칸(null · 구획 missing)은 **비교하지 않는다**(직전 값을 그대로 들고 간다) — 못 읽은 것을 ‘바뀜’ 으로 세면 수집 실패마다 거짓 이벤트가 쌓인다.
 * ⚠ 첫 관찰(직전 사실 없음)은 이벤트 없이 기준만 남긴다.
 * ⚠ `sysctl -a` 전체 CRC 는 휘발성 키가 남아 매 주기 바뀔 수 있다(실장비 미확인) — **연속 3주기 바뀌면 휘발성(noisy)** 으로 보고 그 이벤트를 멈춘다(사실에 sxNoisy).
 * ‘영향 추정’ 은 하지 않는다 — 화면은 시각만 겹쳐 보인다(시각 일치만 · 인과 단정 금지).
 */
import { numOrNull } from '../util/numOrNull.js';

const n = numOrNull;
export const CHANGE_KINDS = Object.freeze(['reboot', 'kernel', 'needs-restart', 'package', 'sysctl', 'sysctl-file', 'sysctl-all', 'cron', 'tuned', 'selinux', 'firewalld', 'units-failed', 'firmware', 'cvp-map', 'health']);
/** 한 주기 한 서버 이벤트 상한(목록 폭주 방지 — 넘으면 ‘그 밖 n건’ 한 줄). */
export const EVENTS_PER_CYCLE_MAX = 24;
export const SX_NOISY_STREAK = 3;
const short = (v, len = 8) => (v == null ? null : String(v).slice(0, len));
const str = (v, len = 96) => (v == null ? null : String(v).slice(0, len));

/** 파일 맵(이름 → crc|'perm') 비교 — 추가 · 삭제 · 바뀜. 이름만 · CRC 앞 8자만. */
function diffFiles(kind, a, b, out) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return;
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const nm of names) {
    const x = Object.hasOwn(a, nm) ? a[nm] : null; const y = Object.hasOwn(b, nm) ? b[nm] : null;
    if (x === y) continue;
    if (x === 'perm' || y === 'perm') continue;   // 권한이 바뀐 것은 내용 변화가 아니다
    out.push({ kind, item: str(nm, 64), before: x == null ? '없음' : `crc ${short(x)}`, after: y == null ? '없음' : `crc ${short(y)}` });
  }
}

/**
 * 직전 사실 · 이번 사실 → { facts(다음 기준), events }. 순수.
 * @param {object|null} prev   change_latest.facts(없으면 첫 관찰)
 * @param {object} cur        { os: changeFacts|null, fw: {bios, idrac, list:{이름:버전}}|null, cvp: {nic: 'cvp|dev|port'}|null, health: {cell: code}|null }
 */
export function diffChangeFacts(prev, cur = {}, { now = Date.now() } = {}) {
  const P = prev && typeof prev === 'object' ? prev : null;
  const os = cur.os || null;
  // 다음 기준: 이번에 읽은 칸은 새 값, 못 읽은 칸은 직전 값(비교하지 않는다).
  const next = { ...(P || {}) };
  const events = [];
  const first = !P;
  const keepOr = (k, v) => { if (v != null) next[k] = v; };
  if (os) {
    for (const k of ['bootId', 'kernel', 'rpmdbAt', 'sysctlCrc', 'tuned', 'selinux', 'firewalld']) keepOr(k, os[k] ?? null);
    if (os.upS != null) next.upS = os.upS;
    if (os.needsRestart === true || os.needsRestart === false) next.needsRestart = os.needsRestart;
    if (os.unitsFailed != null) next.unitsFailed = os.unitsFailed;
    if (os.sysctl && typeof os.sysctl === 'object') next.sysctl = os.sysctl;
    if (os.sysctlFiles) next.sysctlFiles = os.sysctlFiles;
    if (os.cronFiles) next.cronFiles = os.cronFiles;
    if (os.spool) next.spool = os.spool;
    if (Array.isArray(os.dnf) && os.dnf.length) next.dnfTop = os.dnf[0];
  }
  if (cur.fw) next.fw = cur.fw;
  if (cur.cvp) next.cvp = cur.cvp;
  if (cur.health) next.health = cur.health;
  // sysctl 전체 CRC 휘발성 판정(연속 바뀜)
  const sxChanged = !first && os?.sysctlCrc != null && P.sysctlCrc != null && os.sysctlCrc !== P.sysctlCrc;
  next.sxStreak = sxChanged ? (n(P?.sxStreak) ?? 0) + 1 : (os?.sysctlCrc != null ? 0 : n(P?.sxStreak) ?? 0);
  next.sxNoisy = !!(P?.sxNoisy) || next.sxStreak >= SX_NOISY_STREAK;
  if (first) return { facts: next, events: [], first: true };

  if (os) {
    if (os.bootId && P.bootId && os.bootId !== P.bootId) events.push({ kind: 'reboot', item: '재부팅', before: P.upS != null ? `가동 ${Math.floor(P.upS / 86_400)}일` : null, after: os.upS != null ? `가동 ${Math.floor(os.upS / 3_600)}시간` : null });
    if (os.kernel && P.kernel && os.kernel !== P.kernel) events.push({ kind: 'kernel', item: '실행 커널', before: str(P.kernel, 80), after: str(os.kernel, 80) });
    if ((os.needsRestart === true || os.needsRestart === false) && (P.needsRestart === true || P.needsRestart === false) && os.needsRestart !== P.needsRestart) {
      events.push({ kind: 'needs-restart', item: '재부팅 필요', before: P.needsRestart ? '필요' : '불필요', after: os.needsRestart ? '필요' : '불필요' });
    }
    if (os.rpmdbAt != null && P.rpmdbAt != null && os.rpmdbAt !== P.rpmdbAt) {
      const d = Array.isArray(os.dnf) && os.dnf.length ? os.dnf[0] : null;
      events.push({ kind: 'package', item: d ? `dnf history #${d.id}` : '패키지 DB 변경', before: null, after: d ? [d.action, d.altered != null ? `${d.altered}개` : null, d.at].filter(Boolean).join(' · ').slice(0, 120) : 'dnf 기록 미확인' });
    }
    if (os.sysctl && P.sysctl) {
      for (const k of Object.keys({ ...P.sysctl, ...os.sysctl }).sort()) {
        const a = P.sysctl[k]; const b = os.sysctl[k];
        if (a == null || b == null || String(a) === String(b)) continue;   // 한쪽 못 읽음은 비교하지 않는다
        events.push({ kind: 'sysctl', item: str(k, 64), before: str(a, 60), after: str(b, 60) });
      }
    }
    diffFiles('sysctl-file', P.sysctlFiles, os.sysctlFiles, events);
    if (sxChanged && !next.sxNoisy && !events.some((e) => e.kind === 'sysctl' || e.kind === 'sysctl-file')) {
      events.push({ kind: 'sysctl-all', item: 'sysctl 전체', before: `crc ${short(P.sysctlCrc)}`, after: `crc ${short(os.sysctlCrc)}` });
    }
    diffFiles('cron', P.cronFiles, os.cronFiles, events);
    diffFiles('cron', P.spool, os.spool, events);
    if (os.tuned && P.tuned && os.tuned !== P.tuned) events.push({ kind: 'tuned', item: 'TuneD 프로파일', before: str(P.tuned, 60), after: str(os.tuned, 60) });
    if (os.selinux && P.selinux && os.selinux !== P.selinux) events.push({ kind: 'selinux', item: 'SELinux', before: str(P.selinux, 16), after: str(os.selinux, 16) });
    if (os.firewalld && P.firewalld && os.firewalld !== P.firewalld) events.push({ kind: 'firewalld', item: 'firewalld', before: str(P.firewalld, 16), after: str(os.firewalld, 16) });
    if (os.unitsFailed != null && P.unitsFailed != null && os.unitsFailed !== P.unitsFailed) events.push({ kind: 'units-failed', item: '실패 유닛 수', before: String(P.unitsFailed), after: String(os.unitsFailed) });
  }
  if (cur.fw && P.fw) {
    if (cur.fw.bios && P.fw.bios && cur.fw.bios !== P.fw.bios) events.push({ kind: 'firmware', item: 'BIOS', before: str(P.fw.bios, 40), after: str(cur.fw.bios, 40) });
    if (cur.fw.idrac && P.fw.idrac && cur.fw.idrac !== P.fw.idrac) events.push({ kind: 'firmware', item: 'iDRAC', before: str(P.fw.idrac, 40), after: str(cur.fw.idrac, 40) });
    const a = P.fw.list || {}; const b = cur.fw.list || {};
    if (Object.keys(a).length && Object.keys(b).length) {
      for (const nm of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (a[nm] === b[nm]) continue;
        const before = a[nm] == null ? '없음' : str(a[nm], 40); const after = b[nm] == null ? '없음' : str(b[nm], 40);
        // BIOS · iDRAC 은 위에서 이미 적었다(펌웨어 목록에도 같은 버전 변화로 나온다 — 두 번 적지 않는다).
        if (events.some((e) => e.kind === 'firmware' && e.before === before && e.after === after)) continue;
        events.push({ kind: 'firmware', item: str(nm, 64), before, after });
      }
    }
  }
  if (cur.cvp && P.cvp) {
    for (const nic of [...new Set([...Object.keys(P.cvp), ...Object.keys(cur.cvp)])].sort()) {
      if (P.cvp[nic] === cur.cvp[nic]) continue;
      events.push({ kind: 'cvp-map', item: str(nic, 64), before: P.cvp[nic] == null ? '없음' : str(P.cvp[nic], 96), after: cur.cvp[nic] == null ? '없음' : str(cur.cvp[nic], 96) });
    }
  }
  if (cur.health && P.health) {
    for (const cell of Object.keys(cur.health).sort()) {
      const a = P.health[cell]?.code; const b = cur.health[cell]?.code;
      if (!a || !b || a === b) continue;
      events.push({ kind: 'health', item: str(cell, 16), before: a, after: b });
    }
  }
  const capped = events.length > EVENTS_PER_CYCLE_MAX ? events.length - EVENTS_PER_CYCLE_MAX + 1 : 0;
  const out = capped ? [...events.slice(0, EVENTS_PER_CYCLE_MAX - 1), { kind: events[EVENTS_PER_CYCLE_MAX - 1].kind, item: `그 밖 ${capped}건`, before: null, after: null }] : events;
  return { facts: next, events: out.map((e) => ({ ...e, ts: now })), first: false };
}

/**
 * 점검 소모품 칸 code 의 ‘처음 주의가 된 시각’(since) — 함대 표 ‘며칠째’. 직전 health 맵과 이번 code 로 since 를 이어 간다(같은 code 면 유지 · 바뀌면 지금).
 * @param {object|null} prevHealth  { cell: { code, since } }
 * @param {object} cells           judgeHealth().cells
 */
export function healthSince(prevHealth, cells = {}, now = Date.now()) {
  const out = {};
  for (const [k, c] of Object.entries(cells || {})) {
    const p = prevHealth?.[k];
    out[k] = { code: c?.code || 'missing', since: p && p.code === c?.code && n(p.since) != null ? p.since : now };
  }
  return out;
}

/** iDRAC 인벤토리(이미 가진 캐시) → 펌웨어 사실(BIOS · iDRAC · 펌웨어 목록 이름 → 버전 — 상한 64). 없으면 null. */
export function firmwareFactsOf(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const bios = inv.system?.biosVersion || inv.bios?.version || null;
  const idrac = inv.idrac?.firmwareVersion || null;
  const list = {};
  for (const f of (Array.isArray(inv.firmware) ? inv.firmware : []).slice(0, 64)) {
    const nm = String(f?.name || '').slice(0, 64); const v = String(f?.version || '').slice(0, 40);
    if (nm && v && !Object.hasOwn(list, nm)) list[nm] = v;
  }
  if (!bios && !idrac && !Object.keys(list).length) return null;
  return { bios: bios ? String(bios).slice(0, 40) : null, idrac: idrac ? String(idrac).slice(0, 40) : null, list };
}
/** CVP 수동 매핑(portMap.js) → { nic: 'cvp|장비|포트' }. 매핑이 없으면 빈 객체(‘없음’ 이 사실이다 — 등록부를 못 읽었으면 호출부가 null). */
export function cvpFactsOf(list = []) {
  const out = {};
  for (const m of list || []) if (m?.nic) out[String(m.nic).slice(0, 64)] = `${String(m.cvpId || '').slice(0, 32)}|${String(m.deviceKey || '').slice(0, 64)}|${String(m.port || '').slice(0, 32)}`;
  return out;
}
