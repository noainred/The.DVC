/**
 * storage/collectors/vplex.js — Dell EMC VPLEX·Metro Node 공용 수집기(v2.311, 사용자 요구).
 *
 * 두 타입 모두 관리 서버의 Element Manager REST 로 조회한다(장비 직접 아님 — 등록 host =
 * VPLEX 관리 서버/Metro Node 관리 IP). Metro Node 는 VPLEX 의 후속 제품(PowerStore/Unity
 * 메트로 구성용)으로 같은 계열 API v2 를 쓰므로 수집기를 공유한다(vmax/powermax 와 동일 축).
 *
 * API 세대 폴백:
 *  - v2(GeoSynchrony 6.x·Metro Node): /vplex/v2/... — Basic 인증, 평이한 JSON.
 *  - v1(구세대): /vplex/... — **Username/Password 커스텀 헤더** 인증(이 API 의 공식 방식),
 *    응답이 {response:{context:[{attributes:[{name,value}],children:[...]}]}} 구조라
 *    attrsToObj/childNames 헬퍼로 평탄화한다.
 *
 * ⚠ 정직 표기:
 *  - VPLEX/Metro Node 는 **스토리지 가상화 계층** — 자체 미디어 용량이 없다(백엔드 어레이
 *    용량은 각 어레이 수집기 소관). capacity 섹션은 의도적으로 'skip'(extra.capacityNote 로
 *    사유 노출). ok 판정은 config(클러스터 조회 성공) 기준.
 *  - 엔드포인트·필드는 REST 문서 지식 기반으로 **실장비 검증 전**(섹션별 오류가 모달에 표시).
 *  - 401 규칙: v1/v2 인증 방식이 달라 v2 의 401 은 자격증명 오류의 증거가 아니다 —
 *    세대별 정확히 1회씩(주기당 실패 인증 최대 2회)만 시도하고 중단한다(계정 잠금 예방,
 *    collect() 의 v1Mode/v2Dead 흐름 참조). 조회(GET) 전용.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter, tryAny } from './restCommon.js';

/** v1 컨텍스트의 attributes:[{name,value}] → 평탄 객체(순수 — 테스트 고정). */
export const attrsToObj = (ctx) => Object.fromEntries((ctx?.attributes || []).map((a) => [a.name, a.value]));
/** v1 컨텍스트의 children 에서 특정 type 이름 목록(type 미표기 응답은 전체 허용). */
export const childNames = (resp, type) => {
  const ctxs = resp?.response?.context;
  const c0 = Array.isArray(ctxs) ? ctxs[0] : ctxs;
  return (c0?.children || []).filter((c) => !type || !c.type || c.type === type).map((c) => c.name).filter(Boolean);
};

/** 헬스 문자열 정규화 — VPLEX 는 'ok'/'degraded'/'critical-failure' 등(모르는 값 그대로 노출). */
const healthOf = (v) => { const h = String(v || 'unknown').toLowerCase(); return h === 'ok' || h === 'healthy' ? 'ok' : h; };

/**
 * 원시 응답 → 정규화(순수 — storageMon.test.js 픽스처 고정).
 * raw: { version: string|'', clusters: [{name, health, operational}...], directors: [{name, health}...] }
 * (collect() 가 v1/v2 양쪽 응답을 이 중간 형태로 먼저 평탄화한다 — 정규화 계약을 API 세대와 분리)
 */
export function normalizeVplex(device, raw) {
  const snap = emptySnapshot(device);
  if (raw.version) snap.version = String(raw.version);
  const cls = Array.isArray(raw.clusters) ? raw.clusters.filter(Boolean) : [];
  if (cls.length) {
    snap.name = cls.length === 1 ? (cls[0].name || device.name) : `${cls[0].name || device.name} 외 ${cls.length - 1}`;
    snap.extra.clusters = cls.slice(0, 8).map((c) => ({ name: c.name, health: healthOf(c.health), operational: c.operational || '' }));
    snap.sections.config = 'ok';
  }
  const dirs = Array.isArray(raw.directors) ? raw.directors.filter(Boolean) : null;
  if (dirs) {
    snap.nodes = {
      count: dirs.length,
      unhealthy: dirs.filter((d) => { const h = healthOf(d.health); return h !== 'ok' && h !== 'unknown'; }).length,
      list: dirs.slice(0, 64).map((d, i) => ({ id: i + 1, ip: '', health: healthOf(d.health), inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0, name: d.name || '' })),
    };
    snap.sections.nodes = 'ok';
  }
  // 가상화 계층 — 자체 용량 없음(의도된 skip: 오류가 아니라 제품 특성. UI/사용자 오해 방지 사유 노출).
  snap.extra.capacityNote = 'VPLEX/Metro Node 는 가상화 계층 — 자체 용량 없음(백엔드 어레이에서 조회)';
  snap.extra.collectMethod = 'api';
  snap.ok = snap.sections.config === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

export async function collect(device) {
  // 수집 방식 분기(v2.405) — 등록 시 고른 collectMethod 로 REST/SSH(vplexcli) 를 가른다.
  // isilon.js 와 같은 패턴: 타입 파일이 자기 방식을 안다(poller 는 타입만 안다).
  if (device.collectMethod === 'ssh') {
    const { collectViaSsh } = await import('./vplexSsh.js');
    return collectViaSsh(device);
  }
  const port = Number(process.env.STORAGE_VPLEX_PORT) || 443;
  const getV2 = makeGetter(device, { port });
  // v1 인증은 Username/Password 커스텀 헤더(이 API 세대의 공식 방식 — Basic 은 무시된다).
  // makeGetter 가 헤더 값을 사전 검증(제어문자 차단·값 미포함 오류)한다 — restCommon 참조.
  const getV1 = makeGetter(device, { port, headers: { Username: device.username, Password: device.password || '' } });
  const raw = { version: '', clusters: null, directors: null };
  const snap = emptySnapshot(device); // 섹션 오류 임시 기록용(정규화 후 병합)
  // ⚠ 401 처리(v2.311 적대적 검증 반영): v1 과 v2 는 **인증 방식이 다르다**(v2=Basic,
  // v1=커스텀 헤더 — v1 장비는 Basic 을 무시). 따라서 v2 프로브의 401 은 자격증명 오류를
  // 증명하지 못한다(v1 전용 장비의 통상 응답일 수 있음) — xtremio 의 v3→v2(같은 Basic)와
  // 다른 점. v2 가 401 이면 v1 을 **정확히 1회** 시도하고, v1 도 401 이면 전체 중단한다:
  // 주기당 실패 인증 최대 2회(세대별 1회씩)로 계정 잠금 예방 불변조건은 유지된다.
  let v1Mode = false;  // v1 인증으로 확정되면 이후 섹션은 v1 만 사용(불필요한 v2 401 재발 방지)
  let v2Dead = false;  // v2 프로브가 401 이었음(폴백 실패 시 인증 실패로 종결하기 위한 표식)
  try {
    // ① 클러스터(=config·ok 판정 기준): v2 평이 JSON → v1 컨텍스트 순.
    try {
      const v2 = await getV2('/vplex/v2/clusters');
      // v2 는 배열 또는 {clusters:[...]} — 필드명도 세대별 편차가 있어 방어적으로 흡수.
      const list = Array.isArray(v2) ? v2 : v2?.clusters || [];
      raw.clusters = list.map((c) => ({ name: c.name, health: c.health_state || c['health-state'], operational: c.operational_status || c['operational-status'] || '' }));
      if (!raw.clusters.length) throw new Error('v2 응답에 클러스터 없음');
    } catch (e) {
      v2Dead = /401/.test(e.message);
      try {
        // v1: 목록(children) → 클러스터별 컨텍스트 attributes 조회.
        const listResp = await getV1('/vplex/clusters');
        const names = childNames(listResp, 'cluster').slice(0, 8);
        raw.clusters = [];
        for (const n of names) {
          try {
            const d = await getV1(`/vplex/clusters/${encodeURIComponent(n)}`);
            const ctxs = d?.response?.context;
            const a = attrsToObj(Array.isArray(ctxs) ? ctxs[0] : ctxs);
            raw.clusters.push({ name: a.name || n, health: a['health-state'], operational: a['operational-status'] || '' });
          } catch (e2) { if (/401/.test(e2.message)) throw e2; snap.sections.config = `일부 클러스터 오류: ${e2.message}`; }
        }
        v1Mode = true; // v1 인증 성공 — 이후 섹션은 v1 로 고정
      } catch (e1) {
        snap.sections.config = `오류: ${e1.message}`;
        if (/401/.test(e1.message)) throw e1; // 두 세대 모두 인증 거부 → 전체 중단(잠금 예방)
        // v2 가 401 이었고 v1 도(비-401로) 실패 — 동작하는 인증 경로가 없으므로 여기서 종결한다.
        // 계속 진행하면 이후 섹션의 v2 재시도가 주기마다 401 을 누적시킨다(잠금 위험).
        if (v2Dead) throw new Error(`인증 실패(401) — v2(Basic) 거부, v1 폴백도 실패(${e1.message})`);
      }
    }
    // ② 디렉터(=노드 상당) — v1 확정이면 v1 글롭만, 아니면 v2 → (비-401 시) v1 글롭 폴백.
    //    실패해도 다른 섹션과 독립. v2 인증이 이미 통한 세대에서의 401 은 진짜 이상 → 전체 중단.
    try {
      const d = v1Mode
        ? await getV1('/vplex/engines/*/directors/*') // v1 은 글롭 컨텍스트 조회 지원
        : await tryAny(getV2, ['/vplex/v2/directors']).catch(async (e) => {
          if (/401/.test(e.message)) throw e;
          return getV1('/vplex/engines/*/directors/*');
        });
      if (Array.isArray(d) || Array.isArray(d?.directors)) {
        const list = Array.isArray(d) ? d : d.directors;
        raw.directors = list.map((x) => ({ name: x.name, health: x.health_state || x['health-state'] }));
      } else if (d?.response?.context) {
        const ctxs = Array.isArray(d.response.context) ? d.response.context : [d.response.context];
        raw.directors = ctxs.map((c) => { const a = attrsToObj(c); return { name: a.name, health: a['health-state'] }; });
      }
    } catch (e) { snap.sections.nodes = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
    // ③ 버전 — 부가 정보(실패 비치명). v1 확정이면 v1 만, 아니면 v2 → v1 순.
    try {
      const v = v1Mode
        ? await getV1('/vplex/version')
        : await getV2('/vplex/v2/version').catch(() => getV1('/vplex/version'));
      raw.version = v?.version || v?.['product-version']
        || attrsToObj(Array.isArray(v?.response?.context) ? v.response.context[0] : v?.response?.context)['product-version'] || '';
    } catch { /* 버전 미확인 — '' 유지(정직) */ }
  } catch (e) {
    const out = normalizeVplex(device, raw);
    out.error = e.message;
    for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
    return out;
  }
  const out = normalizeVplex(device, raw);
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
  return out;
}
