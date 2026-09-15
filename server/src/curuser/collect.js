/**
 * curuser/collect.js — 한 vCenter 의 대상 VM 에서 `guestinfo.curuser.*` 를 읽는다(v2.520).
 *
 * **게스트 계정을 쓰지 않는다**(사용자 결정 "Guestos 계정 없이"). 하는 일은
 * `config.extraConfig` 한 속성의 배치 조회 하나다.
 *
 * ── 왜 스냅샷에 extraConfig 를 같이 담지 않는가(성능 근거) ──────────────────────
 * 메인 수집(`vcenter/soapClient.js collectFromVCenterSoap`)의 VM 속성 목록에
 * `config.extraConfig` 를 추가하면 **5,850 VM 전부**의 extraConfig(VM 당 수십 키 — nvram·svga·
 * sched.* 등)가 매 폴링마다 실려 온다. 우리가 필요한 것은 **설정에서 지정한 폴더의 Windows
 * 서버**뿐(기본 상한 400대)이고 주기도 10분이다. 그래서 이 모듈이 **대상 moref 만** 골라
 * 별도 배치로 읽는다 — 정상 운영 비용 0, 주기당 SOAP 왕복 1~2회(250개씩 청크).
 * (같은 판단: `vcenter/orphanScan.js` v2.505 — "가끔 쓰는 무거운 리포트는 상시 적재하지 않는다")
 *
 * ⚠ 실패는 **격리**한다. 한 법인이 로그인에 실패해도 다른 법인 수집을 막지 않고, 그 법인의
 *   결과를 '사용자 0명' 으로 만들지 않는다(레코드가 아예 없는 것과 0명은 다르다).
 */
import { VimSoapClient } from '../vcenter/soapClient.js';
import { morefOf } from '../vcenter/registry.js';
import { parseExtraConfig, readGuestInfo, PREFIX } from './guestinfoSource.js';

/** 한 번의 RetrieveProperties 에 넣는 VM 수. soapClient 기본(250)과 같게 둔다. */
const CHUNK = 250;

/**
 * @param {object} vc        vcenters.json 항목
 * @param {object[]} targets `scope.resolveTargets().targets`
 * @param {object} p
 * @param {number} p.now
 * @param {number} p.staleAfterMs
 * @param {number} [p.timeoutMs]  법인 단위 시한(SOAP 호출당 abort)
 * @returns {Promise<{records:object[], error:string|null, morefs:number, ms:number}>}
 */
export async function collectVcenterCurUsers(vc, targets, { now = Date.now(), staleAfterMs = 30 * 60_000, timeoutMs = 60_000 } = {}) {
  const t0 = Date.now();
  const list = (targets || []).filter((t) => t && t.vmId);
  if (!list.length) return { records: [], error: null, morefs: 0, ms: 0 };

  // 시한은 vc 객체의 timeoutMs 로 전달된다(`VimSoapClient.#call` 이 AbortSignal.timeout 에 쓴다).
  const c = new VimSoapClient({ ...vc, timeoutMs: Math.max(10_000, Number(timeoutMs) || 60_000) });
  try { await c.login(); } catch (e) { return { records: [], error: `vCenter 로그인 실패: ${String(e.message || e).slice(0, 200)}`, morefs: 0, ms: Date.now() - t0 }; }

  const byMoref = new Map();
  for (const t of list) byMoref.set(morefOf(t.vmId, vc.id), t);
  const records = [];
  let error = null;
  try {
    const objs = await c.retrieveManyObjectProps('VirtualMachine', [...byMoref.keys()], ['config.extraConfig'], CHUNK);
    const seen = new Set();
    for (const o of objs) {
      const t = byMoref.get(o.ref);
      if (!t) continue;
      seen.add(o.ref);
      const map = parseExtraConfig(o.props?.['config.extraConfig'], { prefix: PREFIX });
      records.push({ ...t, ...readGuestInfo(map, { now, staleAfterMs }) });
    }
    // 응답에 없는 VM — 조회 사이에 삭제·vMotion 되었거나 권한이 없다. **0명이 아니다**.
    for (const [ref, t] of byMoref) {
      if (seen.has(ref)) continue;
      records.push({
        ...t, kind: 'not-found', ok: false, at: null, ageMs: null, schema: null,
        active: null, disc: null, other: null, sessions: null, users: [], noUsers: false,
        unknownStates: [], omitted: 0, chunks: 0, guestHost: '', raw: '',
        error: 'vCenter 응답에 이 VM 이 없습니다(삭제·권한·조회 시점 차이).',
      });
    }
  } catch (e) {
    error = `extraConfig 조회 실패: ${String(e.message || e).slice(0, 200)}`;
  } finally {
    await c.logout().catch(() => {});
  }
  return { records, error, morefs: byMoref.size, ms: Date.now() - t0 };
}

/**
 * 데모(mock) 합성 — `DATA_SOURCE=mock` 에서만 쓴다.
 * 운영에서는 **절대 불리지 않는다**(없는 사용자를 지어내지 않는다 — v2.505 고아 VMDK 와 같은 규칙).
 * 값은 VM id 해시로 결정론적이고, 일부러 `no-agent`·`stale` 을 섞어 화면의 정직 분기를 실제로 보이게 한다.
 */
export function mockRecords(targets, { now = Date.now() } = {}) {
  const hash = (s) => { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0; return h; };
  const POOL = ['DVC\\admin', 'DVC\\oper1', 'DVC\\oper2', 'backup_svc', 'DVC\\dba', 'monitor@dvc.local'];
  return (targets || []).map((t, i) => {
    const h = hash(t.vmId || String(i));
    if (h % 11 === 0) return { ...t, kind: 'no-agent', ok: false, at: null, ageMs: null, active: null, disc: null, other: null, sessions: null, users: [], error: '', guestHost: '', chunks: 0, omitted: 0, unknownStates: [], noUsers: false };
    if (h % 13 === 0) return { ...t, kind: 'guest-error', ok: false, at: now - 300_000, ageMs: 300_000, active: null, disc: null, other: null, sessions: null, users: [], error: 'quser produced no output (command missing or blocked)', guestHost: `MOCK-${i}`, chunks: 0, omitted: 0, unknownStates: [], noUsers: false };
    const n = h % 4;                                  // 0~3 세션
    const users = Array.from({ length: n }, (_, k) => ({ name: POOL[(h + k) % POOL.length], kind: (h + k) % 3 === 0 ? 'disc' : 'active' }));
    const stale = h % 17 === 0;
    const at = now - (stale ? 4 * 3600_000 : (h % 500_000));
    return {
      ...t, kind: stale ? 'stale' : 'ok', ok: !stale, at, ageMs: now - at,
      active: users.filter((u) => u.kind === 'active').length,
      disc: users.filter((u) => u.kind === 'disc').length,
      other: 0, sessions: users.length, users, noUsers: users.length === 0,
      unknownStates: [], omitted: 0, chunks: users.length ? 1 : 1, guestHost: `MOCK-WIN-${i}`, error: '',
    };
  });
}
