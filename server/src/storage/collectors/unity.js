/**
 * storage/collectors/unity.js — Dell Unity(480 등) 수집기(v2.309, 사용자 요구).
 * Unisphere REST(https://<mgmt>/api/*, Basic + X-EMC-REST-CLIENT 헤더 필수)를 섹션별
 * best-effort 조회해 공통 스키마로 정규화. GET 은 CSRF 토큰 불필요(쓰기 없음 — 조회 전용).
 * ⚠ 실장비 검증 전: 경로·필드는 Unisphere REST 문서 지식 기반 — 섹션별 오류 문구로 드러남.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter } from './restCommon.js';
import { numOrNull } from '../../util/numOrNull.js';
import { healthWord } from '../healthWord.js';

const entries = (v) => (v?.entries || []).map((e) => e.content || {});
/** 미해결 알람 한 페이지 크기(v2.599 C2599-07). */
export const UNITY_ALERT_PER_PAGE = 100;

/**
 * Unisphere REST `HealthEnum` → 상태 단어(순수, v2.598 감사 IDRAC-2598-05).
 * ⚠ 열거값의 뜻은 Unisphere REST 문서 기반이고 **실장비 응답으로 확인하지 못했다**(이 파일 머리말과 같은 한계):
 *   0 UNKNOWN · 5 OK · 7 OK_BUT · 10 DEGRADED · 15 MINOR · 20 MAJOR · 25 CRITICAL · 30 NON_RECOVERABLE.
 * 단어는 `storage/healthWord.js`(ok/bad/unknown)와 `partfault/classify.js healthStringState`(warn 세분)가
 * 그대로 읽을 수 있는 것으로 고른다. 모르는 값은 예전처럼 `health:N` 원문을 남긴다(지어내지 않는다).
 */
// 20 이상(MAJOR·CRITICAL·NON_RECOVERABLE)은 예전처럼 'health:N' 원문을 남긴다 — 어느 판정에서도 이상(bad/fault)이고
// 화면·기존 테스트(storageMon 'health:20')가 원문 표기를 기대한다. 번역이 필요했던 것은 0·10·15 가 **이상으로
// 과대 판정**되던 것이다.
const UNITY_HEALTH = Object.freeze({ 0: 'unknown', 5: 'ok', 7: 'ok', 10: 'degraded', 15: 'minor' });
export function unityHealthWord(value) {
  if (value == null || value === '') return 'unknown';
  const v = Number(value);
  if (!Number.isInteger(v)) return 'unknown';
  return UNITY_HEALTH[v] || `health:${v}`;
}

/** 원시 응답 → 정규화(순수). raw: {system,sw,cap,pools,sps,users,alerts} */
export function normalizeUnity(device, raw) {
  const snap = emptySnapshot(device);
  const sys = entries(raw.system)[0];
  if (sys) {
    snap.name = sys.name || device.name;
    snap.serial = sys.serialNumber || '';
    snap.extra.model = sys.model || '';
    snap.sections.config = 'ok';
  }
  const sw = entries(raw.sw)[0];
  if (sw) snap.version = sw.version || '';
  const cap = entries(raw.cap)[0];
  if (cap) {
    // v2.597(감사 C2597-02 — 재현): 전체 용량을 못 읽으면 '정상 · 0 바이트' 가 아니라 섹션 오류다(Isilon C2595-05 와 같은 처리).
    const total = numOrNull(cap.sizeTotal) || 0;
    // v2.593(감사 DATA-01): 사용량을 못 읽으면 0 이 아니라 null — 0 은 '비었다' 는 거짓이고 증가량에 거짓 급변을 만든다(v2.561 규약).
    const used = numOrNull(cap.sizeUsed);
    if (total > 0) {
      snap.capacity = { totalBytes: total, usedBytes: used, pct: used != null ? Math.round((used / total) * 1000) / 10 : null };
      snap.sections.capacity = 'ok';
    } else {
      snap.sections.capacity = `오류: sizeTotal 없음(받은 키 ${Object.keys(cap).slice(0, 8).join(', ') || '없음'})`;
    }
  }
  const pools = entries(raw.pools);
  if (pools.length) {
    snap.pools = pools.slice(0, 32).map((p) => {
      const t = numOrNull(p.sizeTotal), u = numOrNull(p.sizeUsed);
      return { name: p.name || '', totalBytes: t, usedBytes: u, pct: t > 0 && u != null ? Math.round((u / t) * 1000) / 10 : null };
    });
  }
  const sps = entries(raw.sps);
  if (sps.length) {
    // v2.598(감사 IDRAC-2598-05): 열거값을 **단어로 번역**하고 비정상 계수는 공용 판정(healthWord)을 쓴다.
    //   예전에는 5·7 만 ok 이고 나머지는 전부 'health:N' 이라 0(UNKNOWN)이 **비정상 노드**·파트 장애 fault 로 세졌고
    //   10·15(DEGRADED·MINOR)도 fault 였다.
    const healthOf = (h) => unityHealthWord(h?.value);
    snap.nodes = { count: sps.length, unhealthy: sps.filter((s) => healthWord(healthOf(s.health)) === 'bad').length,
      unknown: sps.filter((s) => healthWord(healthOf(s.health)) === 'unknown').length, // v2.615 SF-R1-02
      list: sps.slice(0, 64).map((s, i) => ({ id: i + 1, ip: '', health: healthOf(s.health), inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0, name: s.name || s.id || '' })) };
    snap.sections.nodes = 'ok';
  }
  const users = entries(raw.users);
  if (users.length) { snap.accounts = users.slice(0, 200).map((u) => ({ name: u.name || u.id || '', enabled: true })); snap.sections.accounts = 'ok'; }
  if (raw.alerts) {
    // v2.599(감사 C2599-07): 조회는 per_page=UNITY_ALERT_PER_PAGE 한 페이지뿐이다. 컬렉션이 주는 전체 건수(entryCount)가
    //   있으면 그것을 쓰고, 없는데 한 페이지가 가득 찼으면 '그 이상일 수 있다' 고 밝힌다(조용한 상한 금지).
    const got = entries(raw.alerts).length;
    const total = numOrNull(raw.alerts.entryCount);
    if (total != null && total >= got) {
      snap.alerts.unresolved = total;
      if (total > got) snap.extra.alertsNote = `전체 ${total}건(장비 보고 entryCount) — 목록은 첫 ${got}건만 받았습니다`;
    } else {
      snap.alerts.unresolved = got;
      if (got >= UNITY_ALERT_PER_PAGE) {
        snap.extra.alertsTruncated = true;
        snap.extra.alertsNote = `조회 상한(${UNITY_ALERT_PER_PAGE}건)에 닿았고 장비가 전체 건수를 주지 않아 미해결 ${got}건 이상일 수 있습니다(하한)`;
      }
    }
    snap.sections.alerts = 'ok';
  }
  snap.extra.collectMethod = 'api';
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

export async function collect(device, { signal = null } = {}) {
  // 수집 방식 분기(v2.405) — 등록 시 고른 collectMethod 로 REST/SSH(uemcli) 를 가른다.
  // isilon.js 와 같은 패턴: 타입 파일이 자기 방식을 안다(poller 는 타입만 안다).
  if (device.collectMethod === 'ssh') {
    const { collectViaSsh } = await import('./unitySsh.js');
    return collectViaSsh(device);
  }
  const get = makeGetter(device, { port: Number(process.env.STORAGE_UNITY_PORT) || 443, headers: { 'X-EMC-REST-CLIENT': 'true' }, signal });
  const raw = {};
  const snap = emptySnapshot(device);
  const sect = { system: 'config', cap: 'capacity', sps: 'nodes', users: 'accounts', alerts: 'alerts' };
  const step = async (key, fn) => {
    try { raw[key] = await fn(); }
    catch (e) { if (sect[key]) snap.sections[sect[key]] = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
  };
  try {
    await step('system', () => get('/api/types/system/instances?fields=name,model,serialNumber'));
    await step('sw', () => get('/api/types/installedSoftwareVersion/instances?fields=version'));
    await step('cap', () => get('/api/types/systemCapacity/instances?fields=sizeTotal,sizeUsed,sizeFree'));
    await step('pools', () => get('/api/types/pool/instances?fields=name,sizeTotal,sizeUsed'));
    await step('sps', () => get('/api/types/storageProcessor/instances?fields=name,health'));
    await step('users', () => get('/api/types/user/instances?fields=name'));
    await step('alerts', () => get(`/api/types/alert/instances?fields=id&filter=state ne 2&per_page=${UNITY_ALERT_PER_PAGE}`));
  } catch (e) {
    const out = normalizeUnity(device, raw);
    out.error = e.message;
    for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
    return out;
  }
  const out = normalizeUnity(device, raw);
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).startsWith('오류')) out.sections[k] = v;
  return out;
}
