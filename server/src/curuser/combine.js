/**
 * curuser/combine.js — Windows 서버 ∪ Horizon(VDI) **고유 사용자 합집합**(v2.525, 순수 모듈).
 *
 * 사용자 선택(2026-09-16, AskUserQuestion): **"한 화면에 합치기 — 소스 탭"**.
 * 즉 '현재 사용자' 화면이 두 출처를 한 화면에서 보여주고, **전체 고유 사용자 = Windows ∪ VDI** 다.
 *
 * ── 왜 합집합인가 ───────────────────────────────────────────────────────────────
 * 같은 사람이 Windows 서버(RDP)와 VDI 에 동시에 붙어 있으면 그건 **1명**이다
 * (2026-09-15 사용자 지시 "aaa 가 1개의 vcenter 의 여러 서버에 로그인해 있으면 그건 1명" 과 같은 축).
 * 단순히 두 수를 더하면 겹치는 사람이 두 번 세어져 '전체 사용자' 라는 말이 거짓이 된다.
 * 그래서 **합집합과 단순 합을 둘 다** 내고 겹친 인원(`both`)을 따로 밝힌다 — 그 차이 자체가
 * 사용자가 알아야 할 정보다.
 *
 * ── 정직성 규칙 ────────────────────────────────────────────────────────────────
 * 1. **한 출처를 읽지 못하면 합집합을 '전체' 라고 말하지 않는다.** `partial` 과
 *    `missingSources` 로 밝힌다 — 화면이 "VDI 를 못 읽었으므로 이 수는 하한입니다" 라고 말한다.
 * 2. **수집이 꺼진 출처와 실패한 출처를 구분한다**(`off` vs `failed`). 조치가 정반대다.
 * 3. **계정 이름 비교 규칙이 두 출처에서 다를 수 있음을 밝힌다.** Windows 는 `quser` 의
 *    로컬/도메인 계정이고 Horizon 은 AD 계정(또는 SID)이다. 같은 사람이 `CORP\aaa` 와 `aaa`
 *    두 표기로 나올 수 있는데, 우리는 **도메인 접두를 보존해 비교**하므로(v2.520 `userKey`)
 *    그 경우 2명으로 세어진다. 이름을 임의로 잘라 맞추면 **다른 사람을 한 사람으로 합칠** 위험이
 *    있어 그렇게 하지 않는다 — 대신 `nameFormNote` 로 그 전제를 화면이 적는다.
 * 4. **SID 로만 식별된 계정은 합집합에 이름으로 참여할 수 없다** — Windows 쪽은 이름이므로
 *    절대 매칭되지 않는다. 그 개수를 `sidOnly` 로 밝힌다(조용히 겹치지 않는 것으로 두지 않는다).
 */
import { userKey, splitAccount } from './aggregate.js';

export const NAME_FORM_NOTE = '계정 비교는 **도메인 접두를 보존**합니다 — 같은 사람이 `CORP\\aaa` 와 `aaa` 로 나오면 2명으로 셉니다(다른 사람을 한 명으로 합치는 것보다 안전한 쪽을 택했습니다).';

/**
 * @param {object} p
 * @param {{state:'ok'|'off'|'failed'|'unavailable', names:Array<{name:string}>, label?:string, reason?:string}} p.windows
 * @param {{state:'ok'|'off'|'failed'|'unavailable', names:Array<{name:string,isSid?:boolean}>, label?:string, reason?:string}} p.vdi
 * @returns {{
 *   union:number, sum:number, both:number, onlyWindows:number, onlyVdi:number,
 *   partial:boolean, missingSources:Array<{key:string,label:string,state:string,reason:string}>,
 *   sidOnly:number, names:Array<{name:string, sources:string[]}>, nameFormNote:string
 * }}
 */
export function combineSources({ windows = {}, vdi = {} } = {}) {
  const srcs = [
    { key: 'windows', label: windows.label || 'Windows 서버', ...windows },
    { key: 'vdi', label: vdi.label || 'Horizon(VDI)', ...vdi },
  ];
  const seen = new Map();          // userKey -> { name, sources:Set }
  let sidOnly = 0;
  for (const s of srcs) {
    if (s.state !== 'ok') continue;
    for (const u of s.names || []) {
      const k = userKey(u?.name);
      if (!k) continue;
      if (u.isSid) sidOnly++;
      let e = seen.get(k);
      if (!e) { e = { name: String(u.name).trim(), domain: splitAccount(u.name).domain, sources: new Set() }; seen.set(k, e); }
      e.sources.add(s.key);
    }
  }
  const names = [...seen.values()].map((e) => ({ name: e.name, domain: e.domain, sources: [...e.sources] }))
    .sort((a, b) => b.sources.length - a.sources.length || String(a.name).localeCompare(String(b.name), 'ko'));
  const okSrcs = srcs.filter((s) => s.state === 'ok');
  const missingSources = srcs.filter((s) => s.state !== 'ok')
    .map((s) => ({ key: s.key, label: s.label, state: s.state || 'unavailable', reason: s.reason || '' }));
  return {
    union: names.length,
    // 단순 합 — 겹침을 두 번 센 값. **'전체' 로 쓰지 말 것**(비교용으로만 표시한다).
    sum: okSrcs.reduce((a, s) => a + new Set((s.names || []).map((u) => userKey(u?.name)).filter(Boolean)).size, 0),
    both: names.filter((n) => n.sources.length > 1).length,
    onlyWindows: names.filter((n) => n.sources.length === 1 && n.sources[0] === 'windows').length,
    onlyVdi: names.filter((n) => n.sources.length === 1 && n.sources[0] === 'vdi').length,
    partial: missingSources.length > 0,
    missingSources,
    sidOnly,
    names,
    nameFormNote: NAME_FORM_NOTE,
  };
}
