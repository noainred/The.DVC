/**
 * curuser/aggregate.js — '현재 사용자' 집계(v2.520, 순수 모듈).
 *
 * ── 사용자 결정(2026-09-15 사용자 지시) ─────────────────────────────────────────
 * **"aaa 라는 사용자가 1개의 vcenter 의 여러 서버에 로그인해 있으면 그건 1명인거야"**
 *
 * 그래서 사용자 수는 **세션 수가 아니라 고유 계정 수**다. 이 구분을 잃으면 RDP 환경에서
 * 수치가 몇 배로 부풀어 '사용자 수' 라는 말이 거짓이 된다. 두 값을 **함께** 싣는다 —
 * `users`(고유 계정) 와 `sessions`(세션 수). 화면은 사용자 수를 크게, 세션 수를 곁에 적는다.
 *
 * ── 계정 이름 정규화 ────────────────────────────────────────────────────────────
 * · Windows 계정명은 **대소문자를 구분하지 않는다** → 비교는 소문자.
 * · `DOMAIN\user` 의 도메인은 **보존한다** — 도메인이 다르면 다른 사람일 수 있다.
 *   단 `host\user` 처럼 로컬 계정이면 호스트마다 달라 같은 사람이 여러 명으로 세어진다.
 *   그래서 표시는 원문을 쓰고 **비교 키만** 정규화하며, 그 규칙을 화면이 각주로 밝힌다.
 * · 표시용 이름은 **처음 만난 원문**을 쓴다(대문자로 바꾸면 사용자가 자기 계정을 못 알아본다).
 *
 * ── '전체' 는 두 가지다 ─────────────────────────────────────────────────────────
 * 사용자 지시는 **vCenter 안에서** 1명이다. 전 vCenter 를 합칠 때 같은 이름이 다른 사람일
 * 수 있어 단정할 수 없으므로 **둘 다** 낸다:
 *   · `usersUnion`   — 전 vCenter 통합 고유(같은 계정이면 한 사람으로 본다)
 *   · `usersByVcSum` — vCenter별 고유의 **합**(법인이 다르면 다른 사람으로 본다)
 * 화면이 어느 쪽인지 밝히고 둘을 나란히 보여준다 — 하나만 보여주면 그 전제가 감춰진다.
 */

/** 비교 키 — 대소문자 무시, 앞뒤 공백 제거. 도메인 접두는 **보존**(다른 사람일 수 있다). */
export function userKey(name) {
  return String(name || '').trim().toLowerCase();
}

/** `DOMAIN\user` → `{ domain, user }`. 도메인이 없으면 domain 은 ''. */
export function splitAccount(name) {
  const s = String(name || '').trim();
  const i = s.indexOf('\\');
  if (i > 0) return { domain: s.slice(0, i), user: s.slice(i + 1) };
  const at = s.indexOf('@');       // user@domain 형태(UPN)
  if (at > 0) return { domain: s.slice(at + 1), user: s.slice(0, at) };
  return { domain: '', user: s };
}

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 한 VM 의 수집 결과(레코드) 형태:
 *   { vmId, vcenterId, name, folder, ts, ok, active, disc, other, sessions,
 *     users: [{name, kind}], error, reason }
 * `ok:false` 는 **수집하지 못한 것**이고 '사용자 0명' 이 아니다 — 아래 집계가 둘을 구분한다.
 */

/**
 * 고유 사용자 집계(한 범위: vCenter 하나 또는 전체).
 * @returns {{
 *   users:number, usersActive:number, usersDisc:number,
 *   sessions:number, sessionsActive:number, sessionsDisc:number, sessionsOther:number,
 *   vms:number, vmsOk:number, vmsFailed:number, vmsSkipped:number,
 *   names:Array<{name,domain,sessions,active,disc,vms:string[]}>
 * }}
 */
export function aggregate(records) {
  const list = (records || []).filter(Boolean);
  // 계정 키 → 집계. Map 은 삽입 순서를 지키므로 '처음 만난 원문' 이 표시 이름이 된다.
  const byUser = new Map();
  let sessions = 0; let sa = 0; let sd = 0; let so = 0;
  let vmsOk = 0; let vmsFailed = 0; let vmsSkipped = 0;
  for (const r of list) {
    if (r.ok === false) { vmsFailed++; continue; }
    if (r.skipped) { vmsSkipped++; continue; }
    vmsOk++;
    for (const u of (r.users || [])) {
      const key = userKey(u.name);
      if (!key) continue;
      sessions++;
      if (u.kind === 'active') sa++; else if (u.kind === 'disc') sd++; else so++;
      let e = byUser.get(key);
      if (!e) {
        const { domain, user } = splitAccount(u.name);
        e = { name: String(u.name).trim(), domain, user, sessions: 0, active: 0, disc: 0, other: 0, vms: [] };
        byUser.set(key, e);
      }
      e.sessions++;
      if (u.kind === 'active') e.active++; else if (u.kind === 'disc') e.disc++; else e.other++;
      // ⚠ 같은 VM 에 같은 계정이 여러 세션이면 VM 은 한 번만 넣는다(장비 수가 부풀지 않게).
      if (r.vmId && !e.vms.includes(r.vmId)) e.vms.push(r.vmId);
    }
  }
  const names = [...byUser.values()];
  // ⚠ v2.598 WEBUI-2598-02: 확인한 서버가 0대면 사용자·세션 수는 **모른다**(null) — 0 으로 두면
  //   수집이 꺼졌거나 전 서버가 stale/no-agent 일 때 머리 카드가 '전체 고유 사용자 0명' 이라는
  //   거짓을 말하고 추이 DB 에도 0 이 남는다(규칙: 확인하지 못한 서버를 '사용자 0명' 으로 뭉개지 않는다).
  const known = vmsOk > 0;
  return {
    users: known ? names.length : null,
    usersActive: known ? names.filter((u) => u.active > 0).length : null,
    usersDisc: known ? names.filter((u) => u.active === 0 && u.disc > 0).length : null,
    sessions: known ? sessions : null,
    sessionsActive: known ? sa : null,
    sessionsDisc: known ? sd : null,
    sessionsOther: known ? so : null,
    vms: list.length, vmsOk, vmsFailed, vmsSkipped,
    names: names.sort((a, b) => b.sessions - a.sessions || String(a.name).localeCompare(String(b.name), 'ko')),
  };
}

/**
 * vCenter별 + 전체 집계.
 *
 * `usersUnion` 과 `usersByVcSum` 을 **둘 다** 낸다(위 머리말 참조) — 같은 계정이 여러 법인에
 * 있으면 두 값이 달라지고, 그 차이 자체가 사용자가 알아야 할 정보다.
 */
export function aggregateAll(records, { vcNameOf = (id) => id } = {}) {
  const list = (records || []).filter(Boolean);
  const byVc = new Map();
  for (const r of list) {
    const id = String(r.vcenterId || '');
    if (!byVc.has(id)) byVc.set(id, []);
    byVc.get(id).push(r);
  }
  const vcenters = [...byVc.entries()].map(([id, rs]) => ({
    vcenterId: id, vcenterName: vcNameOf(id), ...aggregate(rs),
  })).sort((a, b) => (b.users ?? -1) - (a.users ?? -1) || String(a.vcenterName).localeCompare(String(b.vcenterName), 'ko'));
  const total = aggregate(list);
  // 값을 읽은 법인만 더한다 — 하나도 없으면 null(0 은 '0명' 이라는 거짓이다).
  const readVcs = vcenters.filter((v) => v.users != null);
  const byVcSum = readVcs.length ? readVcs.reduce((a, v) => a + v.users, 0) : null;
  return {
    total: { ...total, usersUnion: total.users, usersByVcSum: byVcSum },
    vcenters,
  };
}

/**
 * 추이 적재용 값(vCenter 하나). **DB 에 넣는 것은 집계 수치뿐**이고 계정명은 넣지 않는다 —
 * 계정명을 시계열에 쌓으면 (사용자 수 × 주기) 행이 되고, 개인정보가 장기 보존된다.
 * 계정 목록은 **최신 1건만** 보관한다(현재 누가 붙어 있나가 질문이므로 이력은 불필요).
 */
export function seriesRow(agg) {
  // v2.598 WEBUI-2598-02: 확인한 서버가 0대인 주기의 수치는 null 로 넘긴다(NULL 로 적재 — 0 이 아니다).
  const nn = (v) => (v == null ? null : n0(v));
  return {
    users: nn(agg.users), usersActive: nn(agg.usersActive),
    sessions: nn(agg.sessions), sessionsActive: nn(agg.sessionsActive), sessionsDisc: nn(agg.sessionsDisc),
    vmsOk: n0(agg.vmsOk), vmsFailed: n0(agg.vmsFailed),
  };
}
