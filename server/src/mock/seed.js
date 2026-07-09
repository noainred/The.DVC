/**
 * 목업(DATA_SOURCE=mock) 데모용 보조 데이터 시더.
 *
 * 메인 스냅샷(generator.js)은 vCenter/호스트/VM/DS/네트워크/GPU/알람을 만들지만, 별도 저장소를
 * 쓰는 일부 화면(iDRAC 전력, 핑/네트워크 체크·vCenter 포트)은 라이브 콜렉터 전용이라 mock에서 빈다.
 * 여기서 mock 모드일 때만 그 저장소에 합성 시계열을 시드/갱신해 데모 화면이 채워지게 한다.
 *
 * 안전장치:
 *  - mock 모드(getDataSource()==='mock')에서만 동작. live/auto에는 절대 관여하지 않는다.
 *  - 레지스트리/대상은 '비어 있을 때만' 1회 시드(실데이터를 덮지 않음). id 접두사 'mock-'로 식별.
 *  - 폴러가 mock일 때 실제 폴 대신 이 틱을 호출한다(가드는 각 폴러가 유지 — 재진입/스로틀 그대로).
 */

import { getDataSource } from '../runtime-settings.js';

export function isMockMode() {
  try { return getDataSource() === 'mock'; } catch { return false; }
}

// 이름 기반 안정 해시(같은 서버는 항상 같은 기준값 → 틱마다 미세 흔들림만).
function hash(s) { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0; return Math.abs(h); }
function jitter(base, pct = 0.08) { return Math.max(0, Math.round(base * (1 + (Math.random() * 2 - 1) * pct))); }
const HOUR = 3_600_000;

/* ───────────────────────── iDRAC 전력 ───────────────────────── */

let idracSeeded = false;
function baseWatts(name, model = '') {
  const m = /R760|DL380|SR650|C240/i.test(model) ? 480 : /R750|DL360/i.test(model) ? 400 : 340;
  return m + (hash(name) % 140); // 모델 기준 + 서버별 고정 편차
}

// mock Dell 호스트를 iDRAC로 1회 등록(비어 있을 때만) + 24h 전력 백필.
async function ensureIdracSeed(snapshot) {
  if (idracSeeded) return;
  idracSeeded = true;
  const { loadRegistry, addServer } = await import('../idrac/registry.js');
  if (loadRegistry().length) return;                  // 실데이터 있으면 시드 안 함
  const hosts = (snapshot?.hosts || []).filter((h) => /dell/i.test(h.vendor || ''));
  if (!hosts.length) { idracSeeded = false; return; } // 스냅샷 아직이면 다음 틱 재시도
  let n = 0;
  for (const h of hosts) {
    const id = `mock-idrac-${h.vcenterId}-${h.name}`;
    // 사설 대역의 합성 iDRAC 주소(실제 폴은 mock 분기로 안 함).
    const ip = `10.${hash(h.vcenterId) % 250}.${hash(h.name) % 250}.${(hash(h.name) >> 4) % 254 + 1}`;
    addServer({ id, name: h.name, host: ip, username: 'root', password: 'mock', vcenterId: h.vcenterId,
      serviceTag: `MOCK${String(hash(h.name)).slice(0, 6)}`, hostNames: [h.name] });
    n++;
  }
  // 24h 백필(10분 간격) — 대시보드 24h 피크/평균·추세가 즉시 채워지게.
  const { getDb } = await import('../idrac/db.js');
  const db = await getDb();
  const reg = loadRegistry();
  const now = Date.now(); const step = 10 * 60_000; const samples = [];
  for (const s of reg) { const b = baseWatts(s.name, s.model); for (let t = now - 24 * HOUR; t <= now; t += step) samples.push({ serverId: s.id, watts: jitter(b, 0.12), ts: t }); }
  try { db.insertMany(samples); } catch { /* best effort */ }
  if (n) console.log(`[mock] iDRAC 전력 데모 시드: ${n}대 + 24h 시계열`);
}

/** mock 모드 iDRAC 폴 틱 — 실제 Redfish 폴 대신 등록 서버에 현재 전력 샘플 1개씩 적재. */
export async function mockIdracPollTick(snapshot) {
  if (!isMockMode()) return null;
  await ensureIdracSeed(snapshot);
  const { loadRegistry } = await import('../idrac/registry.js');
  const reg = loadRegistry();
  if (!reg.length) return { measured: 0 };
  const { getDb } = await import('../idrac/db.js');
  const db = await getDb();
  const ts = Date.now();
  const samples = reg.map((s) => ({ serverId: s.id, watts: jitter(baseWatts(s.name, s.model)), ts }));
  try { db.insertMany(samples); } catch { /* */ }
  return { measured: samples.length };
}

/* ───────────────────────── 핑 / 네트워크 ───────────────────────── */

let pingSeeded = false;
// 지역별 대략 RTT(ms) — 한국 사용자 기준(아시아 가깝고 유럽/미국 멀다). generator.region 사용.
const REGION_RTT = { '아시아': 28, '중국': 70, '북미': 175, '유럽': 255 };
function rttFor(region) { return jitter(REGION_RTT[region] || 120, 0.15); }

async function ensurePingSeed(snapshot) {
  if (pingSeeded) return;
  const { listTargets, addTarget } = await import('../ping/store.js');
  const vcs = snapshot?.vcenters || [];
  if (!vcs.length) return; // 스냅샷 아직
  pingSeeded = true;
  if (listTargets().length) return; // 실 대상 있으면 시드 안 함
  let n = 0;
  for (const vc of vcs) {
    const ip = `10.${hash(vc.id) % 250}.${hash(vc.name) % 250}.10`;
    // vCenter 도달(핑 모니터링) + 443/902 포트 응답(vCenter 포트)
    addTarget({ id: `mock-vc-${vc.id}`, name: vc.name, host: ip, kind: 'tcp', port: 443, source: 'vcenter', vcenterId: vc.id, datacenterId: vc.id });
    addTarget({ id: `mock-vcp443-${vc.id}`, name: `${vc.name}:443`, host: ip, kind: 'tcp', port: 443, source: 'vcport', vcenterId: vc.id });
    addTarget({ id: `mock-vcp902-${vc.id}`, name: `${vc.name}:902`, host: ip, kind: 'tcp', port: 902, source: 'vcport', vcenterId: vc.id });
    n++;
  }
  // 24h 백필(15분 간격) — 산점/추세 즉시 표시.
  const { getPingDb } = await import('../ping/db.js');
  const db = await getPingDb();
  const now = Date.now(); const step = 15 * 60_000; const recs = [];
  for (const vc of vcs) {
    const region = vc.region;
    for (const tid of [`mock-vc-${vc.id}`, `mock-vcp443-${vc.id}`, `mock-vcp902-${vc.id}`]) {
      for (let t = now - 24 * HOUR; t <= now; t += step) {
        const down = Math.random() < 0.01; // 1% 다운 표본
        recs.push({ target: tid, ts: t, rtt: down ? null : rttFor(region), ok: !down });
      }
    }
  }
  try { db.insertMany(recs); } catch { /* */ }
  if (n) console.log(`[mock] 핑/네트워크 데모 시드: vCenter ${n}개(도달+443+902) + 24h 시계열`);
}

/** mock 모드 핑 폴 틱 — 실제 probe 대신 대상별 합성 RTT 1개씩 적재. */
export async function mockPingPollTick(snapshot) {
  if (!isMockMode()) return null;
  await ensurePingSeed(snapshot);
  const { listTargets } = await import('../ping/store.js');
  const targets = listTargets().filter((t) => t.enabled !== false);
  if (!targets.length) return { measured: 0 };
  const vcRegion = new Map((snapshot?.vcenters || []).map((v) => [v.id, v.region]));
  const { getPingDb } = await import('../ping/db.js');
  const db = await getPingDb();
  const ts = Date.now();
  const recs = targets.map((t) => {
    const down = Math.random() < 0.01;
    return { target: t.id, ts, rtt: down ? null : rttFor(vcRegion.get(t.vcenterId)), ok: !down };
  });
  try { db.insertMany(recs); } catch { /* */ }
  return { measured: recs.length };
}
