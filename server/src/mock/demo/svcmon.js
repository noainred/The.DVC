/**
 * mock/demo/svcmon.js — 데모(DATA_SOURCE=mock) Monitoring(성능점검 svcmon) 대상·결과(v2.716).
 *
 * 배경: v2.715 까지 데모에서 Monitoring 탭이 통째로 비어 있었다(등록된 대상 0 · 점검 0).
 * 규칙(mock/demo/flags.js 머리말과 같다)
 *  · mock 모드에서만, 저장소가 **비어 있을 때만** 1회 등록한다. 표지는 배치 태그 `SVCMON_DEMO_BATCH`
 *    (svcmon 대상 id 는 서버가 발급하므로 `mock-` 접두를 쓸 수 없다 — 대량 등록과 같은 batch 필드로 식별한다).
 *  · **데모 대상은 네트워크에 접속하지 않는다** — 폴러가 `isSvcmonDemoTarget` 인 항목을 합성 결과로 바꾼다.
 *    사람이 등록한 대상은 mock 모드에서도 예전처럼 실제로 점검한다.
 *  · 대상 이름·주소는 메인 스냅샷(vCenter·ESXi 호스트·VM)에서 결정적으로 만든다.
 */
import { isMockMode, demoHash } from './flags.js';

export const SVCMON_DEMO_BATCH = 'mock-demo';

let _tried = false;

/** 이 대상이 데모 대상인가 — mock 모드 + 데모 배치 태그 둘 다. */
export function isSvcmonDemoTarget(target) {
  return !!target && target.batch === SVCMON_DEMO_BATCH && isMockMode();
}

const T = (name, type, extra = {}) => ({ name, type, intervalSec: 60, ...extra });

/** 스냅샷에서 데모 대상 목록(순수). */
export function demoSvcmonTargets(snapshot) {
  const vcs = (snapshot?.vcenters || []).slice(0, 8);
  const hosts = snapshot?.hosts || [];
  const vms = (snapshot?.vms || []).filter((v) => v.powerState === 'POWERED_ON' && v.ipAddress && !v.template);
  const out = [];
  for (const vc of vcs) {
    const folder = String(vc.name || vc.id).replace(/[^\w.-]/g, '_').slice(0, 40);
    out.push({
      kind: 'infra', path: `vCenter\\${folder}`, name: `${vc.name || vc.id} (vCenter)`, host: String(vc.host || vc.name || vc.id).replace(/^https?:\/\//, '').split(/[/:]/)[0],
      tests: [T('ping', 'ping'), T('HTTPS 443', 'tcp', { port: 443 }), T('vSphere SDK', 'http', { url: `https://${String(vc.host || vc.name).replace(/^https?:\/\//, '').split(/[/:]/)[0]}/sdk/vimServiceVersions.xml`, insecure: true, warnMs: 800 })],
    });
    for (const h of hosts.filter((x) => x.vcenterId === vc.id).slice(0, 3)) {
      out.push({
        kind: 'infra', path: `vCenter\\${folder}\\ESXi`, name: h.name, host: h.name,
        tests: [T('ping', 'ping'), T('SSH 22', 'tcp', { port: 22 }), T('vpxa 902', 'tcp', { port: 902 })],
      });
    }
  }
  const SVC = [
    { re: /^(web|app)-/, tests: [T('HTTP', 'http', { warnMs: 500 }), T('인증서', 'cert', { port: 443 })] },
    { re: /^dns-/, tests: [T('DNS 조회', 'dns', { record: 'portal.corp.local' }), T('ping', 'ping')] },
    { re: /^(mail|smtp)-/, tests: [T('SMTP', 'smtp', { port: 25 }), T('IMAP', 'imap', { port: 143 })] },
    { re: /^(db|sql)-/, tests: [T('DB 1433', 'tcp', { port: 1433 }), T('ping', 'ping')] },
    { re: /^(dc|ad|ldap)-/, tests: [T('LDAP', 'ldap', { port: 389 }), T('NTP', 'ntp')] },
  ];
  const used = new Set();
  for (const s of SVC) {
    for (const v of vms.filter((x) => s.re.test(x.name)).slice(0, 4)) {
      if (used.has(v.name)) continue;
      used.add(v.name);
      const city = String(v.vcenterId || '').split('-').slice(-1)[0] || 'site';
      const tests = s.tests.map((t) => (t.type === 'http' ? { ...t, url: `http://${v.ipAddress}/health` } : t));
      out.push({ kind: 'service', path: `서비스\\${city}`, name: v.name, host: v.ipAddress, tests });
    }
  }
  return out;
}

/**
 * 데모 점검 결과(순수 · 결정적 + 시간에 따라 완만히 변한다). 약 4% 경고 · 2% 실패 · 비활성 대상 없음.
 * @returns {{status:'ok'|'warn'|'bad', reply:string, ms:number|null}}
 */
export function demoSvcmonResult(test, host, now = Date.now()) {
  const slot = Math.floor(now / 600_000);                 // 10분마다 상태가 바뀔 수 있다
  const h = demoHash(`${host}|${test.name}|${test.type}`);
  const roll = demoHash(`${h}|${slot}`) % 100;
  const base = 2 + (h % 40);
  const ms = Math.round(base * (1 + ((demoHash(`${h}|${Math.floor(now / 60_000)}`) % 30) / 100)));
  if (h % 37 === 0 || roll < 2) return { status: 'bad', reply: test.type === 'ping' ? '응답 없음(데모)' : '연결 거부(데모)', ms: null };
  if (h % 23 === 0 || roll < 6) return { status: 'warn', reply: `${ms * 12}ms(느림 · 데모)`, ms: ms * 12 };
  const reply = test.type === 'http' ? `HTTP 200 · ${ms}ms` : test.type === 'cert' ? `인증서 ${30 + (h % 300)}일 남음` : test.type === 'dns' ? `10.${h % 250}.${(h >> 8) % 250}.${(h % 200) + 10}` : `${ms}ms`;
  return { status: 'ok', reply: `${reply} (데모)`, ms };
}

/** 저장소가 비어 있으면 데모 대상을 1회 등록한다(mock 모드 · 스냅샷이 준비된 뒤). */
export async function ensureSvcmonDemo() {
  if (_tried || !isMockMode()) return { skipped: true };
  const { store } = await import('../../store.js');
  const snap = store.get?.();
  if (!snap?.vms?.length) return { skipped: 'no-snapshot' };     // 다음 틱에 다시
  _tried = true;
  const { listTargets, bulkAddTargets } = await import('../../svcmon/store.js');
  if (listTargets().length) return { skipped: 'not-empty' };    // 실데이터·사람이 등록한 것이 있으면 시드 안 함
  const r = bulkAddTargets(demoSvcmonTargets(snap), { atomic: false, batch: SVCMON_DEMO_BATCH });
  if (r.added) console.log(`[mock] Monitoring(svcmon) 데모 대상 ${r.added}개 · 점검 ${r.newTests}개 등록${r.errors?.length ? ` · 오류 ${r.errors.length}` : ''}`);
  return r;
}

export function _resetSvcmonDemoForTest() { _tried = false; }
