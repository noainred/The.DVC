/**
 * mock/demo/users.js — 데모(DATA_SOURCE=mock) 합성 데이터: '사용자·게스트' 묶음(v2.708).
 *
 * 담당 화면: 현재 사용자(Windows 서버 · Horizon VDI · 합집합) · 라이선스 만료(Horizon 행) · 게스트 디스크 회수 ·
 * 실제 OS 확인 · 네트워크 이슈 분석 · 로그인 실패 분석 · 실시간 스파이크(vmseries).
 *
 * 규칙(mock/demo/flags.js 머리말과 같다)
 *  · **mock 모드에서만** 값을 만든다. 각 함수는 mock 이 아니면 아무것도 하지 않거나 입력을 그대로 돌려준다.
 *  · 장비·게스트·커넥션 서버에 **접속하지 않는다** — 값은 메인 스냅샷(VM·호스트 이름)에서 demoHash 로 결정적으로 만든다.
 *    시간이 흐르면 조금씩 달라지게(업무 시간대 곡선 · 시간 슬롯 해시) 하되, 같은 (입력, 시각) 은 언제나 같은 값이다.
 *  · 저장된 설정 파일은 바꾸지 않는다 — '켜진 것처럼' 은 판정 지점에서만(demoCurUserSettings · demoOn).
 *  · 등록부 시드(Horizon 커넥션 서버)는 **비어 있을 때만**, id 는 `mock-` 접두.
 *  · 정직 규칙은 그대로 통과시킨다 — 일부 서버는 일부러 no-agent·stale·guest-error 로 두어 화면의 정직 분기가 보이게 한다.
 */
import { isMockMode, demoHash, demoRand, demoIp } from './flags.js';

export { isMockMode };

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const KST = 9 * HOUR;

/**
 * 업무 시간대 곡선(0~1) — 한국 시각 14시 근처가 최대, 밤·주말은 낮다. 순수 함수.
 * 현재 사용자·Horizon 세션의 '시간에 따라 흔들리는' 값이 이 곡선을 따른다.
 */
export function diurnal(ts) {
  const d = new Date(Number(ts) + KST);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const wd = d.getUTCDay();
  const work = Math.exp(-((h - 14) ** 2) / 14);
  const base = 0.08 + 0.92 * work;
  return (wd === 0 || wd === 6) ? Math.round(base * 0.3 * 1000) / 1000 : Math.round(base * 1000) / 1000;
}

/** 한국 시각 날짜 'YYYY-MM-DD'(sessionDb dayKey 와 같은 기준). */
const kstDay = (ts) => new Date(Number(ts) + KST).toISOString().slice(0, 10);

/* ═════════════════════════ 현재 사용자(Windows 서버) ═════════════════════════ */

/** 데모 수집 범위 폴더 — mock 생성기의 VM_FOLDERS 상위 폴더들(Windows 서버가 섞여 있는 곳). */
export const DEMO_CURUSER_FOLDERS = Object.freeze(['Production', 'Infrastructure', 'DMZ', 'Test']);

/**
 * 현재 사용자 설정의 데모 판(저장하지 않는다). mock 이 아니면 입력 그대로.
 * 저장된 설정이 꺼져 있거나 폴더 범위가 비어 있는 vCenter 는 데모 폴더로 '켜진 것처럼' 본다 — 실제로 지정한 범위는 그대로 쓴다.
 */
export function demoCurUserSettings(s, snap) {
  if (!isMockMode() || !s) return s;
  const vcenters = { ...(s.vcenters || {}) };
  let added = 0;
  for (const vc of (snap?.vcenters || [])) {
    const cur = vcenters[vc.id];
    if (cur && cur.enabled === true && (cur.folders || []).length) continue;
    vcenters[vc.id] = { enabled: true, folders: [...DEMO_CURUSER_FOLDERS], excludeFolders: [], includeSubfolders: true };
    added++;
  }
  if (s.enabled === true && !added) return s;
  return { ...s, enabled: true, vcenters, demo: true };
}

const CU_ADMINS = ['DVC\\admin', 'DVC\\oper1', 'DVC\\oper2', 'backup_svc', 'DVC\\dba', 'monitor@dvc.local'];
const cuUser = (k) => (k < CU_ADMINS.length ? CU_ADMINS[k] : `DVC\\user${String(k).padStart(3, '0')}`);

/**
 * 게스트 발행값의 데모 판 — `curuser/collect.js` 의 레코드 모양 그대로.
 * 일부 서버는 일부러 no-agent(발행기 없음)·guest-error·stale 로 둔다(화면의 '확인하지 못한 서버' 분기가 보이게).
 * 세션 수는 서버마다 최대치가 정해져 있고 업무 시간대 곡선 × 10분 슬롯 흔들림으로 바뀐다.
 */
export function demoCurUserRecords(targets, { now = Date.now() } = {}) {
  const slot = Math.floor(now / (10 * MIN));
  const f = diurnal(now);
  return (targets || []).map((t, i) => {
    const key = String(t.vmId || i);
    const h = demoHash(`cu|${key}`);
    const base = { ...t, other: 0, unknownStates: [], omitted: 0, noUsers: false };
    if (h % 11 === 0) return { ...base, kind: 'no-agent', ok: false, at: null, ageMs: null, active: null, disc: null, other: null, sessions: null, users: [], error: '', guestHost: '', chunks: 0 };
    if (h % 13 === 0) return { ...base, kind: 'guest-error', ok: false, at: now - 300_000, ageMs: 300_000, active: null, disc: null, other: null, sessions: null, users: [], error: 'quser produced no output (command missing or blocked)', guestHost: `WIN-${(h % 9000) + 1000}`, chunks: 0 };
    const stale = h % 17 === 0;
    // RDS 성격 서버(1/5)는 동시 세션이 많다.
    const maxSess = h % 5 === 0 ? 6 + (h % 7) : 1 + (h % 3);
    const jit = 0.75 + 0.5 * demoRand(`cu|${key}|${slot}`);
    const n = Math.max(0, Math.min(maxSess, Math.round(maxSess * f * jit)));
    const users = [];
    for (let k = 0; k < n; k++) {
      // 같은 계정이 여러 서버에 있게(고유 계정 수 < 세션 수 — '여러 서버에 있으면 1명' 이 보이게) 풀을 60명으로 묶는다.
      const u = cuUser((h + k * 7) % 60);
      if (users.some((x) => x.name === u)) continue;
      users.push({ name: u, kind: demoRand(`cu|${key}|${slot}|${k}`) < 0.18 ? 'disc' : 'active' });
    }
    const at = stale ? now - 4 * HOUR : now - (h % 480_000);
    return {
      ...base, kind: stale ? 'stale' : 'ok', ok: !stale, at, ageMs: now - at,
      active: users.filter((u) => u.kind === 'active').length,
      disc: users.filter((u) => u.kind === 'disc').length,
      sessions: users.length, users, noUsers: users.length === 0,
      chunks: 1, guestHost: `WIN-${(h % 9000) + 1000}`, error: '',
    };
  });
}

/**
 * 현재 사용자 추이 백필 행(vc_series) — 지금 최신값(레코드)에서 법인별 '최대치' 를 추정해 과거 days 일을 주기마다 만든다.
 * 순수 함수(쓰기는 호출부). 행 모양은 curuser/db.js commitCurUser 의 series 원소.
 * @returns {Array<{ts:number, series:object[]}>}
 */
export function demoCurUserBackfillRows(records, { now = Date.now(), days = 7, intervalMs = 10 * MIN } = {}) {
  const byVc = new Map();
  for (const r of records || []) {
    const id = String(r.vcenterId || '');
    if (!id) continue;
    const e = byVc.get(id) || { ok: 0, failed: 0, users: new Set() };
    if (r.ok) { e.ok++; for (const u of r.users || []) e.users.add(String(u.name || '').toLowerCase()); } else e.failed++;
    byVc.set(id, e);
  }
  if (!byVc.size) return [];
  const fNow = Math.max(0.15, diurnal(now));
  // 법인별 최대치와 **전체 고유 계정** 최대치를 따로 추정한다 — 같은 계정이 여러 법인 서버에 있으므로 전체는 법인 합이 아니다.
  const allUsers = new Set([...byVc.values()].flatMap((e) => [...e.users]));
  const peak = new Map([...byVc].map(([id, e]) => [id, Math.max(1, Math.min(e.users.size * 2, Math.round(e.users.size / fNow)))]));
  const peakAll = Math.max(1, Math.min(allUsers.size * 2, Math.round(allUsers.size / fNow)));
  const step = Math.max(5 * MIN, Number(intervalMs) || 10 * MIN);
  const start = Math.floor((now - days * DAY) / step) * step;
  const out = [];
  for (let ts = start; ts < now - step; ts += step) {
    const f = diurnal(ts);
    const series = [];
    let tu = 0; let ta = 0; let ts_ = 0; let tsa = 0; let tsd = 0; let tok = 0; let tf = 0;
    for (const [id, e] of byVc) {
      const jit = 0.85 + 0.3 * demoRand(`cubf|${id}|${ts}`);
      const users = Math.round(peak.get(id) * f * jit);
      const active = Math.round(users * 0.82);
      const sessions = users + Math.round(users * 0.25);
      const sa = Math.round(sessions * 0.82);
      series.push({ vcenterId: id, users, usersActive: active, sessions, sessionsActive: sa, sessionsDisc: sessions - sa, vmsOk: e.ok, vmsFailed: e.failed, partial: false });
      tu += users; ta += active; ts_ += sessions; tsa += sa; tsd += sessions - sa; tok += e.ok; tf += e.failed;
    }
    // 전체(고유 계정 합집합) — 같은 계정이 여러 법인 서버에 있으므로 단순 합보다 작다(전체 고유 최대치 기준).
    const allU = Math.min(tu, Math.round(peakAll * f * (0.9 + 0.2 * demoRand(`cubf||${ts}`))));
    series.unshift({ vcenterId: '', users: allU, usersActive: Math.min(ta, Math.round(allU * 0.82)), sessions: ts_, sessionsActive: tsa, sessionsDisc: tsd, vmsOk: tok, vmsFailed: tf, partial: false });
    out.push({ ts, series });
  }
  return out;
}

/* ═════════════════════════ Horizon(VDI) ═════════════════════════ */

/** 데모 커넥션 서버 2대(주소는 합성 사설 대역 — 접속하지 않는다). */
export function demoHorizonServers() {
  return [
    { id: 'mock-hz-cs01', name: 'HZ-CS01 (본사)', host: `https://${demoIp('mock-hz-cs01', 10)}`, username: 'svc-horizon', domain: 'DVC', password: 'mock-demo' },
    { id: 'mock-hz-cs02', name: 'HZ-CS02 (R&D)', host: `https://${demoIp('mock-hz-cs02', 10)}`, username: 'svc-horizon', domain: 'DVC', password: 'mock-demo' },
  ];
}

let _hzSeedTried = false;
/**
 * Horizon 등록부 시드 — mock 이고 등록부가 **비어 있을 때만**(실등록을 덮지 않는다). 프로세스당 1회 시도.
 * 등록부 함수는 호출자가 넘긴다(horizon.js 가 이 모듈을 쓰므로 여기서 horizon.js 를 불러오면 순환이 된다 — arch2579).
 * @param {{loadHorizon:Function, upsertHorizon:Function}} hz
 * @returns {Promise<number>} 시드한 대수
 */
export async function ensureDemoHorizonSeed(hz) {
  if (!isMockMode() || _hzSeedTried || !hz?.loadHorizon || !hz?.upsertHorizon) return 0;
  _hzSeedTried = true;
  try {
    if (hz.loadHorizon().length) return 0;
    let n = 0;
    for (const s of demoHorizonServers()) { const r = hz.upsertHorizon(s); if (r?.ok) n++; }
    if (n) console.log(`[mock] Horizon 데모 시드: 커넥션 서버 ${n}대(접속하지 않음)`);
    return n;
  } catch (e) { _hzSeedTried = false; console.warn(`[mock] Horizon 데모 시드 실패: ${e.message}`); return 0; }
}
export function _resetDemoUsersForTest() { _hzSeedTried = false; }

/** 데모 등록 항목인가(접속 금지 대상). */
export const isDemoEntryId = (id) => String(id || '').startsWith('mock-');

/** 데모 카탈로그 원시 배열(앱 풀·데스크톱 풀·팜) — horizon/appUsage.normalizeCatalog 입력 모양. */
export function demoHorizonCatalogRaw() {
  return {
    apps: [
      { id: 'app-office', name: 'office', display_name: 'Microsoft Office 365', farm_id: 'farm-a' },
      { id: 'app-sap', name: 'sap', display_name: 'SAP GUI 8.0', farm_id: 'farm-a' },
      { id: 'app-erp', name: 'erp', display_name: 'ERP Client', farm_id: 'farm-a' },
      { id: 'app-chrome', name: 'chrome', display_name: 'Chrome (보안 브라우저)', farm_id: 'farm-a' },
      { id: 'app-cad', name: 'cad', display_name: 'AutoCAD 2024', farm_id: 'farm-b' },
    ],
    desktops: [
      { id: 'dp-win11', name: 'win11-general', display_name: 'Win11 일반 데스크톱' },
      { id: 'dp-dev', name: 'win11-dev', display_name: 'Win11 개발자 데스크톱' },
      { id: 'dp-gpu', name: 'gpu-cad', display_name: 'GPU CAD 워크스테이션' },
    ],
    farms: [
      { id: 'farm-a', name: 'RDSH-Farm-A' },
      { id: 'farm-b', name: 'RDSH-Farm-B' },
    ],
  };
}

const HZ_BASE = { 'mock-hz-cs01': 90, 'mock-hz-cs02': 55 };
const HZ_DESKTOPS = ['dp-win11', 'dp-win11', 'dp-win11', 'dp-dev', 'dp-gpu'];
const HZ_APPS = ['app-office', 'app-office', 'app-sap', 'app-erp', 'app-chrome', 'app-cad'];

/**
 * 한 커넥션 서버의 그 시각 세션 원시 배열(Horizon REST 세션 응답 모양 — 필드는 sessions.js 후보 체인의 첫 이름).
 * 사용자는 대체로 자기 서비스(데스크톱 풀 또는 앱)를 계속 쓴다(사용자 해시로 고정) — 누적 화면이 의미 있게.
 */
export function demoHorizonSessionsRaw(serverId, now = Date.now()) {
  const sid = String(serverId || '');
  const base = HZ_BASE[sid] ?? (30 + (demoHash(sid) % 40));
  const slot = Math.floor(now / (5 * MIN));
  const f = diurnal(now);
  const n = Math.max(1, Math.round(base * f * (0.85 + 0.3 * demoRand(`hz|${sid}|${slot}`))));
  const users = 140;   // 사용자 풀(서버마다 다른 부서 — 앞 40명은 두 서버에 겹친다)
  const off = sid.endsWith('02') ? 100 : 0;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < n * 2 && out.length < n; i++) {
    const r = demoHash(`hz|${sid}|${slot}|${i}`);
    const uRaw = (r % users);
    const u = uRaw < 40 ? uRaw : uRaw + off;
    // 앞 30명은 Windows 서버 계정 풀과 같은 이름 — '현재 사용자 › 전체(합집합)' 에서 양쪽에 있는 사람이 1명으로 보이게.
    const name = u < 30 ? cuUser(10 + u) : `DVC\\vdi${String(u).padStart(3, '0')}`;
    const uh = demoHash(`hzu|${u}`);
    const kindPick = uh % 100;
    const app = kindPick >= 45;
    const pick = demoHash(`hzs|${name}|${seen.has(name) ? 1 : 0}`);
    if (seen.has(name) && !app) continue;   // 데스크톱은 1인 1세션
    seen.add(name);
    const stR = demoRand(`hzst|${sid}|${slot}|${i}`);
    const state = stR < 0.8 ? 'CONNECTED' : stR < 0.97 ? 'DISCONNECTED' : 'PENDING';
    const s = {
      id: `sess-${sid}-${slot}-${i}`,
      user_name: name,
      session_state: state,
      session_type: app ? 'APPLICATION' : 'DESKTOP',
      client_name: `PC-${(uh % 9000) + 1000}`,
      start_time: now - ((uh % 360) + 5) * MIN,
    };
    if (!app) {
      s.desktop_pool_id = HZ_DESKTOPS[uh % HZ_DESKTOPS.length];
      s.machine_name = `VDI-${s.desktop_pool_id.slice(3).toUpperCase()}-${String(u).padStart(3, '0')}`;
    } else if (kindPick >= 93) {
      // 앱 세션인데 풀 ID 없이 팜만 오는 경우 — 팜 A(앱 여럿)는 '팜(앱 미구분)', 팜 B(앱 하나)는 그 앱으로 해석된다.
      s.farm_id = kindPick >= 97 ? 'farm-b' : 'farm-a';
      s.machine_name = `RDSH-${s.farm_id === 'farm-b' ? 'B' : 'A'}-${String((pick % 6) + 1).padStart(2, '0')}`;
    } else {
      s.application_pool_id = HZ_APPS[pick % HZ_APPS.length];
      s.farm_id = s.application_pool_id === 'app-cad' ? 'farm-b' : 'farm-a';
      s.machine_name = `RDSH-${s.farm_id === 'farm-b' ? 'B' : 'A'}-${String((pick % 6) + 1).padStart(2, '0')}`;
    }
    out.push(s);
  }
  return out;
}

/**
 * Horizon 추이·누적 백필 행(순수 — 쓰기는 sessionDb.backfillHzDemo).
 * series: 주기마다 서버별 + 전체(''), usage: (날짜, 서버, 사용자, 서비스) 행, cover: (날짜, 서버) 수집 횟수.
 * (async — 시간 기준 양보.) 누적은 시간당 1회 모사로 쌍을 모으고 관측 횟수는 주기 수로 환산한다(하루 cycles = 하루 / 주기 — '일부만 수집' 이 되지 않게).
 *
 * @param {object} p
 * @param {string[]} p.serverIds
 * @param {(raw:object[])=>object} p.normalize   sessions.normalizeSessions(raw) — 같은 판정을 쓴다
 * @param {(raw:object[], norm:object)=>object} p.usageOf  appUsage.usageFromSessions 래퍼(카탈로그 포함)
 * @param {(serverId:string)=>object} p.seriesRowOf  { users, usersConnected, sessions, connected, disconnected, pending }
 */
export async function demoHorizonBackfillRows({ serverIds = [], now = Date.now(), seriesDays = 7, usageDays = 30, intervalMs = 5 * MIN, normalize, usageOf, combine } = {}) {
  const series = []; const usage = []; const cover = [];
  const step = Math.max(MIN, Number(intervalMs) || 5 * MIN);
  const todayStart = Date.parse(`${kstDay(now)}T00:00:00Z`) - KST;
  // 추이(주기마다) — 지금 주기는 실수집이 채운다.
  const sStart = Math.floor((now - seriesDays * DAY) / step) * step;
  // 수천 주기를 합성한다(약 2~3초) — 이벤트 루프를 한 번에 막지 않게 시간 기준으로 양보한다(v2.672 규약).
  let slice = performance.now();
  const yieldNow = async () => { if (performance.now() - slice > 20) { await new Promise((r) => setImmediate(r)); slice = performance.now(); } };
  for (let ts = sStart; ts < now - step; ts += step) {
    await yieldNow();
    const per = serverIds.map((sid) => ({ sid, norm: normalize(demoHorizonSessionsRaw(sid, ts)) }));
    const tot = combine ? combine(per.map((p) => ({ ...p.norm, ok: true, serverId: p.sid }))) : null;
    for (const p of per) series.push({ serverId: p.sid, ts, users: p.norm.users, usersConnected: p.norm.usersConnected, sessions: p.norm.sessions, connected: p.norm.connected, disconnected: p.norm.disconnected, pending: p.norm.pending, serversOk: 1, serversFailed: 0 });
    if (tot) series.push({ serverId: '', ts, users: tot.users, usersConnected: tot.usersConnected, sessions: tot.sessions, connected: tot.connected, disconnected: tot.disconnected, pending: tot.pending, serversOk: per.length, serversFailed: 0 });
  }
  // 누적(하루 단위) — 오늘은 지금까지, 지난날은 하루 전체.
  const perHourCycles = Math.max(1, Math.round(HOUR / step));
  for (let d = usageDays; d >= 0; d--) {
    const dayStart = todayStart - d * DAY;
    const dayEnd = Math.min(dayStart + DAY, now - step);
    if (dayEnd <= dayStart) continue;
    const day = kstDay(dayStart + HOUR);
    for (const sid of serverIds) {
      const pairs = new Map();
      let hours = 0;
      for (let t = dayStart + 30 * MIN; t < dayEnd; t += HOUR) {
        await yieldNow();
        hours++;
        const raw = demoHorizonSessionsRaw(sid, t);
        const norm = normalize(raw);
        const u = usageOf(raw, norm);
        for (const p of u?.pairs || []) {
          const k = `${p.userKey}\u0001${p.serviceKey}`;
          const e = pairs.get(k) || { ...p, first: t, last: t, samples: 0, conn: 0 };
          e.last = t; e.samples += perHourCycles; if (p.connected) e.conn += perHourCycles;
          pairs.set(k, e);
        }
      }
      if (!hours) continue;
      const cycles = Math.max(1, Math.round((dayEnd - dayStart) / step));
      cover.push({ day, serverId: sid, cycles, okCycles: cycles, firstTs: dayStart, lastTs: dayEnd });
      for (const e of pairs.values()) {
        usage.push({ day, serverId: sid, userKey: e.userKey, serviceKey: e.serviceKey, user: e.user, service: e.service, kind: e.kind, basis: e.basis, firstTs: e.first, lastTs: e.last, samples: e.samples, connectedSamples: e.conn });
      }
    }
  }
  return { series, usage, cover };
}

/** 데모 Horizon 라이선스 — horizon.normalizeLicenses 결과 모양. 하나는 만료 임박(90일 안)이 되게. */
export function demoHorizonLicenses(serverId, now = Date.now()) {
  const h = demoHash(`hzlic|${serverId}`);
  const soon = String(serverId).endsWith('02');
  return [
    {
      name: soon ? 'Horizon Standard Subscription' : 'Horizon Enterprise Universal Subscription',
      usageModel: soon ? 'CONCURRENT_USER' : 'NAMED_USER',
      expiry: now + (soon ? 41 + (h % 20) : 260 + (h % 200)) * DAY,
      isExpired: false,
      key: `HZ${String(h % 1000).padStart(3, '0')}-…-${String((h >>> 10) % 100000).padStart(5, '0')}`,
    },
  ];
}

/* ═════════════════════════ 게스트 디스크 ═════════════════════════ */

/**
 * 한 vCenter 의 게스트 파티션 합성 — `guestdisk/service.js collectVcenterGuestDisk` 결과의 vms 원소 모양.
 * 켜져 있고 Tools 가 도는 VM 만(꺼진 VM 은 게스트가 보고하지 않는다) · 1/9 은 Tools 미보고로 뺀다.
 * 일부 VM 은 사용량이 하루 0.3~1.5% 씩 늘어난다(회수 '증가 중 보류' 판정이 보이게).
 */
export function demoGuestDiskVms(vcenterId, vms, ts = Date.now()) {
  const out = [];
  for (const vm of vms || []) {
    if (vm.vcenterId !== vcenterId || vm.template) continue;
    if (!/on/i.test(String(vm.powerState || '')) || !/running/i.test(String(vm.toolsStatus || '')) || /not/i.test(String(vm.toolsStatus || ''))) continue;
    const h = demoHash(`gd|${vm.id}`);
    if (h % 9 === 0) continue;
    const win = /windows/i.test(vm.guestOS || '');
    const total = Math.max(40, Math.round(Number(vm.storageGB) || 100));
    const shape = win
      ? [['C:\\', Math.max(60, Math.round(total * 0.35))], ['D:\\', Math.max(20, total - Math.max(60, Math.round(total * 0.35)))]]
      : [['/', Math.max(30, Math.round(total * 0.2))], ['/var', Math.max(10, Math.round(total * 0.15))], ['/data', Math.max(10, total - Math.max(30, Math.round(total * 0.2)) - Math.max(10, Math.round(total * 0.15)))]];
    const growing = h % 6 === 0;
    const daysAgo = Math.max(0, (Date.now() - ts) / DAY);
    const parts = shape.map(([path, cap], k) => {
      const r = demoRand(`gd|${vm.id}|${path}`);
      // 사용률 분포: 대부분 낮다(회수 후보) · 일부 높다.
      let pct = k === 0 ? 0.35 + 0.4 * r : (h % 4 === 0 ? 0.55 + 0.4 * r : 0.05 + 0.35 * r);
      if (growing && k === shape.length - 1) pct = Math.max(0.02, pct - daysAgo * (0.003 + 0.012 * r));
      const used = Math.round(cap * Math.min(0.98, pct) * 10) / 10;
      return { path, capGB: cap, usedGB: used };
    });
    const allocGB = parts.reduce((a, p) => a + p.capGB, 0);
    const usedGB = Math.round(parts.reduce((a, p) => a + p.usedGB, 0) * 10) / 10;
    out.push({
      vmId: vm.id, vmName: vm.name || vm.id,
      allocGB, usedGB, freeGB: Math.round((allocGB - usedGB) * 10) / 10,
      ratioPct: allocGB ? Math.round((usedGB / allocGB) * 1000) / 10 : null,
      partCount: parts.length, parts,
    });
  }
  return out;
}

/* ═════════════════════════ 실제 OS 확인 ═════════════════════════ */

const LINUX_REAL = [
  { os: 'Rocky Linux 9.4 (Blue Onyx)', osId: 'rocky', osVersion: '9.4', family: 'Rocky', kernel: 'Linux 5.14.0-427.13.1.el9_4.x86_64' },
  { os: 'Red Hat Enterprise Linux 9.3 (Plow)', osId: 'rhel', osVersion: '9.3', family: 'RHEL', kernel: 'Linux 5.14.0-362.8.1.el9_3.x86_64' },
  { os: 'Red Hat Enterprise Linux 8.9 (Ootpa)', osId: 'rhel', osVersion: '8.9', family: 'RHEL', kernel: 'Linux 4.18.0-513.5.1.el8_9.x86_64' },
  { os: 'Ubuntu 22.04.4 LTS', osId: 'ubuntu', osVersion: '22.04', family: 'Ubuntu', kernel: 'Linux 5.15.0-105-generic' },
  { os: 'Ubuntu 20.04.6 LTS', osId: 'ubuntu', osVersion: '20.04', family: 'Ubuntu', kernel: 'Linux 5.4.0-182-generic' },
  { os: 'Debian GNU/Linux 12 (bookworm)', osId: 'debian', osVersion: '12', family: 'Debian', kernel: 'Linux 6.1.0-21-amd64' },
  { os: 'SUSE Linux Enterprise Server 15 SP5', osId: 'sles', osVersion: '15.5', family: 'SUSE', kernel: 'Linux 5.14.21-150500.55.52-default' },
  { os: 'AlmaLinux 9.4 (Seafoam Ocelot)', osId: 'almalinux', osVersion: '9.4', family: 'AlmaLinux', kernel: 'Linux 5.14.0-427.16.1.el9_4.x86_64' },
  { os: 'CentOS Linux 7 (Core)', osId: 'centos', osVersion: '7', family: 'CentOS', kernel: 'Linux 3.10.0-1160.119.1.el7.x86_64' },
  { os: 'CentOS Stream 9', osId: 'centos', osVersion: '9', family: 'CentOS', kernel: 'Linux 5.14.0-447.el9.x86_64' },
];
const majorNum = (v) => (String(v || '').match(/\d+/) || [''])[0];

/**
 * 한 VM 의 '게스트에서 읽은 실제 OS' 합성 — osDetect 결과 모양({os, osId, osVersion, family, kernel}).
 * ESXi 보고(guestOS)와 대체로 맞지만 일부(약 1/6)는 일부러 다르게 둔다(불일치 탐지가 보이게) · 1/15 은 실패(error 문자열).
 * @returns {{detected:object|null, error:string}}
 */
export function demoRealOs(vm) {
  const h = demoHash(`os|${vm.id}`);
  if (h % 15 === 0) return { detected: null, error: h % 2 ? '게스트 계정 없음' : 'OS 정보 파싱 실패(빈 출력)' };
  const g = String(vm.guestOS || '');
  const mismatch = h % 6 === 0;
  if (/windows/i.test(g)) {
    const y = (g.match(/20\d\d/) || ['2022'])[0];
    const real = mismatch ? (y === '2022' ? '2019' : '2016') : y;
    const ver = { 2016: '10.0.14393', 2019: '10.0.17763', 2022: '10.0.20348' }[real] || '10.0.20348';
    return { detected: { os: `Microsoft Windows Server ${real} Standard`, osId: 'windows', osVersion: ver, family: 'Windows', kernel: ver.split('.').pop() }, error: '' };
  }
  const fam = /red hat|rhel/i.test(g) ? 'RHEL' : /ubuntu/i.test(g) ? 'Ubuntu' : /centos/i.test(g) ? 'CentOS' : /suse/i.test(g) ? 'SUSE' : /debian/i.test(g) ? 'Debian' : 'Other';
  // 일치 갈래는 계열·메이저 버전이 같은 것만(불일치 판정이 실제로 '일치' 로 읽게) — 없으면 계열만 같은 것.
  const gm = majorNum(g);
  const sameMajor = LINUX_REAL.filter((x) => x.family === fam && (!gm || majorNum(x.osVersion) === gm));
  const same = sameMajor.length ? sameMajor : LINUX_REAL.filter((x) => x.family === fam);
  const pool = mismatch || !same.length ? LINUX_REAL.filter((x) => x.family !== fam) : same;
  // CentOS Stream 9 로 보고된 VM 은 실제로 Rocky·Alma 로 이전된 경우가 흔하다(불일치 예시).
  return { detected: { ...pool[h % pool.length] }, error: '' };
}

/* ═════════════════════════ 네트워크 이슈 ═════════════════════════ */

/**
 * 게스트 인터페이스 드롭·에러 이슈 이력 합성(netIssueStore 의 이슈 레코드 모양) — 최근 days 일.
 * 저장소에 쓰지 않는다(호출부가 화면 분석에만 섞는다 — live 로 바꾸면 사라진다).
 */
export function demoNetIssues(snap, { now = Date.now(), days = 14 } = {}) {
  const vms = (snap?.vms || []).filter((v) => /on/i.test(String(v.powerState || '')) && !v.template);
  // 문제 VM 은 소수(약 4%) — 그중 몇 대는 반복적으로 드롭이 난다.
  const bad = vms.filter((v) => demoHash(`ni|${v.id}`) % 25 === 0).slice(0, 60);
  const out = [];
  const start = Math.floor((now - days * DAY) / HOUR) * HOUR;
  for (const v of bad) {
    const h = demoHash(`ni|${v.id}`);
    const win = /windows/i.test(v.guestOS || '');
    const ifaces = win ? ['Ethernet0', 'Ethernet1'] : ['ens192', 'ens224'];
    const heavy = h % 4 === 0;
    for (let t = start; t < now; t += HOUR) {
      const r = demoRand(`ni|${v.id}|${t}`);
      if (r > (heavy ? 0.22 : 0.05)) continue;
      const iface = ifaces[(h + Math.floor(t / HOUR)) % (heavy ? 1 : ifaces.length)];
      const pkts = 40_000 + Math.round(r * 400_000);
      const newDrop = Math.round((heavy ? 30 : 3) + r * (heavy ? 900 : 60));
      const newErr = r < 0.02 ? Math.round(1 + r * 400) : 0;
      out.push({ ts: t + Math.round(r * 50 * MIN), vcenterId: v.vcenterId, vm: v.name, os: v.guestOS || '', iface, newDrop, newErr, newPkts: pkts, dropRate: Number(((newDrop / pkts) * 100).toFixed(3)), demo: true });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/* ═════════════════════════ 로그인 실패(vCenter 이벤트) ═════════════════════════ */

const LF_USERS = ['administrator@vsphere.local', 'root', 'svc-backup@corp.local', 'CORP\\ops1', 'CORP\\jkim', 'admin', 'test', 'CORP\\svc-monitor'];

/**
 * vCenter 로그인 실패 이벤트 합성 — logs/poller.js 의 합성 이벤트 모양({key, ts, type, severity, user, entity, message, detail}).
 * 시간 슬롯(1시간)마다 결정적으로 0~2건, 일부 vCenter 는 6시간마다 같은 출처에서 무차별 대입(8건 · 30초 간격)이 난다.
 * 같은 (vCenter, 시각) 은 언제나 같은 이벤트·같은 key 라 겹친 구간을 다시 만들어도 DB 키가 중복을 막는다.
 */
export function demoLoginFailEvents(vcId, sinceTs, now = Date.now()) {
  const out = [];
  const id = String(vcId || '');
  const attacker = demoHash(`lfa|${id}`) % 3 === 0;
  const atkIp = demoIp(`lfa|${id}`, 192);
  for (let s = Math.floor(sinceTs / HOUR) * HOUR; s <= now; s += HOUR) {
    const r = demoHash(`lf|${id}|${s}`);
    const n = r % 7 === 0 ? 2 : r % 3 === 0 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const ts = s + ((r >>> (k * 5)) % 55) * MIN + k * 17_000;
      if (ts < sinceTs || ts > now) continue;
      const user = LF_USERS[(r + k) % LF_USERS.length];
      const ip = demoIp(`lfc|${id}|${(r >>> 3) % 9}`, 10);
      const type = k % 2 ? 'BadUsernameSessionEvent' : 'com.vmware.sso.LoginFailure';
      out.push({ key: `mock-lf-${id}-${ts}-${k}`, ts, type, severity: 'warning', user, entity: '', message: `Cannot login ${user}@${ip}`, detail: null });
    }
    if (attacker && Math.floor(s / HOUR) % 6 === demoHash(`lfa|${id}`) % 6) {
      for (let k = 0; k < 8; k++) {
        const ts = s + 20 * MIN + k * 30_000;
        if (ts < sinceTs || ts > now) continue;
        const user = ['admin', 'root', 'administrator', 'test'][k % 4];
        out.push({ key: `mock-lfa-${id}-${ts}-${k}`, ts, type: 'BadUsernameSessionEvent', severity: 'warning', user, entity: '', message: `Cannot login ${user}@${atkIp}`, detail: null });
      }
    }
  }
  return out;
}

/* ═════════════════════════ 실시간 스파이크(vmseries) ═════════════════════════ */

/**
 * 한 vCenter 의 스파이크 저장 행 합성 — vmseries/collect.js 결과 모양({spikes, cover, cursors}).
 * VM 20대 + 호스트 2대, 창 [fromTs, toTs) 를 시간 단위로 덮는다(cover 는 20초 표본 180개/시간).
 * 스파이크는 엔티티마다 하루 0~3회, 1~8분(3~24 순간) — 임계 이상 값만 순간으로 남긴다(저장 규칙과 같다).
 *
 * @param {object} p
 * @param {object[]} p.vms     스냅샷 VM(그 vCenter)
 * @param {object[]} p.hosts   스냅샷 호스트(그 vCenter)
 * @param {object[]} p.vmCols  VM_COUNTERS · p.hostCols HOST_COUNTERS
 * @param {Function} p.pack    spikes.packMoments
 * @param {object} p.thresholds
 */
export function demoVmSeriesRows({ vcenterId, vms = [], hosts = [], fromTs, toTs, vmCols, hostCols, pack, thresholds = {} }) {
  const spikes = []; const cover = []; const cursors = [];
  const ref = (id) => String(id).slice(String(vcenterId).length + 1);
  const on = vms.filter((v) => /on/i.test(String(v.powerState || '')) && !v.template)
    .sort((a, b) => demoHash(`vs|${a.id}`) - demoHash(`vs|${b.id}`)).slice(0, 20);
  const hs = hosts.filter((h) => !/disconnect/i.test(String(h.connectionState || ''))).slice(0, 2);
  const ents = [...on.map((v) => ({ kind: 'vm', e: v, cols: vmCols })), ...hs.map((h) => ({ kind: 'host', e: h, cols: hostCols }))];
  const h0 = Math.floor(fromTs / HOUR) * HOUR;
  const cpuT = Number(thresholds.cpuPct) || 50; const memT = Number(thresholds.memPct) || 50;
  for (const { kind, e, cols } of ents) {
    const r0 = ref(e.id);
    const names = cols.map((c) => c.name);
    const vcpu = Number(e.cpuCount) || 4; const memMB = Number(e.memMB) || 8192;
    for (let h = h0; h < toTs; h += HOUR) {
      cover.push({ kind, ref: r0, h, samples: 180 });
      const r = demoRand(`vsh|${e.id}|${h}`);
      // 시간당 확률 — 업무 시간에 더 자주.
      if (r > 0.04 + 0.08 * diurnal(h)) continue;
      const n = 3 + Math.floor(demoRand(`vsn|${e.id}|${h}`) * 22);
      const t0 = h + Math.floor(demoRand(`vst|${e.id}|${h}`) * (HOUR - n * 20_000));
      if (t0 + n * 20_000 > toTs) continue;   // 아직 오지 않은 순간은 만들지 않는다(다음 실행이 같은 값으로 채운다)
      const moments = [];
      let mxcpu = -1; let mxmem = -1;
      for (let i = 0; i < n; i++) {
        const q = demoRand(`vsm|${e.id}|${t0}|${i}`);
        const memSpike = demoHash(`vsk|${e.id}`) % 5 === 0;
        const cpuPct = memSpike ? 20 + q * 25 : Math.min(100, cpuT + 3 + q * (100 - cpuT - 3));
        const memPct = memSpike ? Math.min(99, memT + 5 + q * 40) : 30 + q * 15;
        const valOf = {
          cpuUsagePct: Math.round(cpuPct * 100), cpuUsageMhz: Math.round(vcpu * 2400 * cpuPct / 100),
          cpuReadyMs: kind === 'vm' ? Math.round(q * 300 * vcpu) : -1,
          memUsagePct: Math.round(memPct * 100), memActiveMB: Math.round(memMB * 1024 * (0.2 + q * 0.3)), memConsumedMB: Math.round(memMB * 1024 * 0.8),
          memBalloonMB: 0, memSwappedMB: 0, diskKBps: Math.round(q * 40_000), netKBps: Math.round(q * 9_000),
          powerW: kind === 'host' ? Math.round(300 + q * 250) : -1,
        };
        const vals = names.map((nm) => (valOf[nm] ?? -1));
        mxcpu = Math.max(mxcpu, valOf.cpuUsagePct); mxmem = Math.max(mxmem, valOf.memUsagePct);
        moments.push({ ts: t0 + i * 20_000, vals });
      }
      const p = pack(moments, names.length);
      if (p) spikes.push({ kind, ref: r0, t0: p.t0, t1: p.t1, n: p.n, cols: names, buf: p.buf, mxcpu, mxmem });
    }
    cursors.push({ kind, ref: r0, lastTs: toTs });
  }
  return { spikes, cover, cursors, entities: ents.length };
}
