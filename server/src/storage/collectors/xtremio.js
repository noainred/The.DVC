/**
 * storage/collectors/xtremio.js — Dell EMC XtremIO 수집기(v2.310, 사용자 요구).
 *
 * XtremIO 는 장비 직접이 아니라 **XMS(XtremIO Management Server)** 의 REST API 로 조회한다:
 *   https://<xms>/api/json/v3/types/<type>  (Basic 인증, v3 실패 시 v2 폴백 — 구버전 XMS)
 * 등록 host = XMS 주소. XMS 하나가 **여러 클러스터**를 관리할 수 있어 클러스터별 용량을
 * pools 로 싣고 capacity 는 합산한다(공통 스키마 재사용 — 뷰가 타입을 몰라도 그린다).
 *
 * 단위: XMS 의 공간 값(ud-ssd-space 등)은 **KB(1024 기준)** — 바이트로 ×1024 환산한다.
 * 전체 플래시 어레이이므로 media.ssd = 전체 용량, hdd = null(뷰가 '—' 처리 — isilon 과 동일 의미).
 *
 * ⚠ 정직 표기: 엔드포인트·필드는 XMS REST 문서 지식 기반으로 **실장비 검증 전** —
 *   섹션별 성공/오류가 상세 모달에 그대로 표시되므로 첫 연결에서 확인·보정한다.
 *   401 은 즉시 중단(장비 계정 잠금 예방 — isilon/powerstore 와 동일 규칙). 조회(GET) 전용.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter, tryAny } from './restCommon.js';

const KB = 1024; // XMS 공간 값 단위(KB) → 바이트 환산 계수

/** 목록 응답에서 이름 배열 추출 — v3 는 {clusters:[{name,href}]} 형태(타입별 키가 다름). */
const namesOf = (resp, key) => (resp?.[key] || []).map((e) => e.name).filter(Boolean);

/**
 * 원시 응답 → 정규화(순수 — storageMon.test.js 픽스처 고정).
 * raw: { clusters: [content...], controllers: [{name,health}...], users: [...], alertCount: n|null }
 *  - clusters: 클러스터별 상세의 content 객체 배열(다중 클러스터 XMS 대응)
 */
export function normalizeXtremio(device, raw) {
  const snap = emptySnapshot(device);
  const cls = Array.isArray(raw.clusters) ? raw.clusters.filter(Boolean) : [];
  if (cls.length) {
    const c0 = cls[0];
    // 다중 클러스터면 이름에 개수 병기(어느 클러스터인지 오해 방지 — 상세는 pools 에서).
    snap.name = cls.length === 1 ? (c0.name || device.name) : `${c0.name || device.name} 외 ${cls.length - 1}`;
    snap.serial = c0['sys-psnt-part-number'] || c0['sys-serial-number'] || '';
    snap.version = c0['sys-sw-version'] || '';
    snap.extra.healthState = c0['sys-health-state'] || '';
    snap.extra.dataReduction = c0['data-reduction-ratio-text'] || (c0['data-reduction-ratio'] ? `${c0['data-reduction-ratio']}:1` : '');
    snap.extra.numBricks = Number(c0['num-of-bricks']) || 0;
    snap.sections.config = 'ok';
    // 클러스터별 용량(KB→바이트) — 합산이 capacity, 개별은 pools.
    let total = 0, used = 0;
    snap.pools = cls.slice(0, 32).map((c) => {
      const t = (Number(c['ud-ssd-space']) || 0) * KB;
      const u = (Number(c['ud-ssd-space-in-use']) || 0) * KB;
      total += t; used += u;
      return { name: c.name || '', totalBytes: t, usedBytes: u, pct: t ? Math.round((u / t) * 1000) / 10 : null };
    });
    if (total > 0) {
      snap.capacity = { totalBytes: total, usedBytes: used, pct: Math.round((used / total) * 1000) / 10 };
      // 전체 플래시 — SSD 풀 = 전체 용량(HDD 없음: null 로 '풀 없음' 표기, isilon 의미와 동일).
      snap.media = { hdd: null, ssd: { totalBytes: total, usedBytes: used, pct: snap.capacity.pct } };
      snap.sections.capacity = 'ok';
    }
  }
  if (Array.isArray(raw.controllers)) {
    const hOf = (c) => String(c['health-state'] || c['node-health-state'] || 'unknown').toLowerCase();
    snap.nodes = {
      count: raw.controllers.length,
      unhealthy: raw.controllers.filter((c) => { const h = hOf(c); return h !== 'healthy' && h !== 'unknown'; }).length,
      list: raw.controllers.slice(0, 64).map((c, i) => ({
        id: i + 1, ip: c['mgmt-addr'] || '', health: hOf(c) === 'healthy' ? 'ok' : hOf(c),
        inBps: null, outBps: null, hdd: null, ssd: null, l3Bytes: 0, name: c.name || '',
      })),
    };
    snap.sections.nodes = 'ok';
  }
  if (Array.isArray(raw.users)) {
    snap.accounts = raw.users.slice(0, 200).map((u) => ({ name: u.name || '', enabled: true, role: u.role || undefined }));
    snap.sections.accounts = 'ok';
  }
  if (raw.alertCount != null) { snap.alerts.unresolved = Number(raw.alertCount) || 0; snap.sections.alerts = 'ok'; }
  snap.extra.collectMethod = 'api';
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

export async function collect(device) {
  // 수집 방식 분기(v2.405) — 등록 시 고른 collectMethod 로 REST/SSH(xmcli) 를 가른다.
  // isilon.js 와 같은 패턴: 타입 파일이 자기 방식을 안다(poller 는 타입만 안다).
  if (device.collectMethod === 'ssh') {
    const { collectViaSsh } = await import('./xtremioSsh.js');
    return collectViaSsh(device);
  }
  const get = makeGetter(device, { port: Number(process.env.STORAGE_XMS_PORT) || 443 });
  const raw = {};
  const snap = emptySnapshot(device); // 섹션 오류 임시 기록용(정규화 후 병합)
  const sect = { clusters: 'config', controllers: 'nodes', users: 'accounts', alerts: 'alerts' };
  const step = async (key, fn) => {
    try { raw[key] = await fn(); }
    catch (e) { if (sect[key]) snap.sections[sect[key]] = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
  };
  try {
    // ① 클러스터 이름 목록(v3→v2 폴백) + ② 클러스터별 상세(?name= 조회).
    //    v2.310 적대적 검증 확정 결함 수정: 목록 조회가 try/catch 밖이라 비-401 오류(404·5xx·
    //    타임아웃)도 외부 catch 로 전파돼 독립 섹션(controllers/users/alerts)까지 통째로
    //    건너뛰고 sections.config 가 'skip' 으로 남았다(정직 표기 계약 위반). powerstore 와
    //    동일하게: 비-401 은 섹션 오류 기록 후 계속, 401 만 전체 중단(장비 계정 잠금 예방).
    raw.clusters = [];
    try {
      const list = await tryAny(get, ['/api/json/v3/types/clusters', '/api/json/v2/types/clusters']);
      const names = namesOf(list, 'clusters').slice(0, 8); // XMS 다중 클러스터 상한(요약 목적 — 초과분 무시 명시)
      for (const n of names) {
        try {
          const d = await tryAny(get, [
            `/api/json/v3/types/clusters?name=${encodeURIComponent(n)}`,
            `/api/json/v2/types/clusters?name=${encodeURIComponent(n)}`,
          ]);
          if (d?.content) raw.clusters.push(d.content);
        } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.config = `일부 클러스터 오류: ${e.message}`; }
      }
    } catch (e) { snap.sections.config = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
    // ③ 스토리지 컨트롤러(노드 상당) — full=1&prop 으로 목록+필드 한 번에(요청 수 절감).
    await step('controllers', async () => {
      const r = await tryAny(get, [
        '/api/json/v3/types/storage-controllers?full=1&prop=name&prop=health-state&prop=node-health-state&prop=mgmt-addr',
        '/api/json/v2/types/storage-controllers?full=1&prop=name&prop=health-state&prop=mgmt-addr',
      ]);
      return r?.['storage-controllers'] || [];
    });
    // ④ 관리 계정 · ⑤ 알람 수(목록 길이 — 상세는 XMS 화면에서).
    await step('users', async () => {
      const r = await tryAny(get, ['/api/json/v3/types/user-accounts?full=1&prop=name&prop=role', '/api/json/v2/types/user-accounts']);
      return r?.['user-accounts'] || [];
    });
    await step('alerts', async () => {
      const r = await tryAny(get, ['/api/json/v3/types/alerts', '/api/json/v2/types/alerts']);
      return (r?.alerts || []).length;
    });
    raw.alertCount = raw.alerts; delete raw.alerts;
  } catch (e) {
    const out = normalizeXtremio(device, raw);
    out.error = e.message;
    for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
    return out;
  }
  const out = normalizeXtremio(device, raw);
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
  return out;
}
