/**
 * storage/collectors/powermax.js — Dell EMC VMAX·PowerMax 공용 수집기(v2.310, 사용자 요구).
 *
 * 두 타입 모두 **Unisphere for PowerMax(구 Unisphere for VMAX)** REST API 로 조회한다:
 *   https://<unisphere>:8443/univmax/restapi/...  (Basic 인증)
 * 등록 host = Unisphere 서버 주소(어레이 자체가 아님 — VMAX/PowerMax 는 직접 REST 가 없다).
 * Unisphere 하나가 **여러 어레이(symmetrix)** 를 관리할 수 있어 로컬 어레이별 용량을 pools 로
 * 싣고 capacity 는 합산한다(XMS 다중 클러스터와 동일 패턴 — 공통 스키마 재사용).
 *
 * 버전 경로: sloprovisioning 등 버전형 리소스는 /univmax/restapi/<ver>/... 형태로 Unisphere
 * 버전마다 경로가 다르다(9.2=92, 9.1=91, 10.x=100 …) — tryAny 폴백으로 흡수한다.
 *
 * ⚠ 정직 표기:
 *  - 엔드포인트·필드는 Unisphere REST 문서 지식 기반으로 **실장비 검증 전**(섹션별 오류로 표시).
 *  - 용량 단위: system_capacity 의 *_tb 값을 **10진 TB(1e12)** 로 가정해 바이트 환산한다 —
 *    Unisphere 화면 표기와 2^40 환산 간 차이가 있으면 실장비에서 보정할 항목(주석 유지).
 *  - 관리 계정 목록은 Unisphere 사용자 API 가 버전 의존이라 이번엔 수집하지 않는다(sections.accounts='skip').
 *  - 401 즉시 중단(계정 잠금 예방) · 조회(GET) 전용.
 */
import { emptySnapshot } from '../types.js';
import { makeGetter, tryAny } from './restCommon.js';

const TB = 1e12; // Unisphere *_tb → 바이트(10진 가정 — 파일 머리말 정직 표기 참조)
const VERS = ['100', '92', '91', '90']; // Unisphere REST 버전 경로 폴백 순서(신버전 우선)

/**
 * 원시 응답 → 정규화(순수 — storageMon.test.js 픽스처 고정).
 * raw: { version: {version}|null, arrays: [{symmetrixId, model, ucode, local}...],
 *        caps: { [symmetrixId]: {usable_total_tb, usable_used_tb} }, alertCount: n|null }
 */
export function normalizePowermax(device, raw) {
  const snap = emptySnapshot(device);
  if (raw.version?.version) snap.version = String(raw.version.version).replace(/^V/, '');
  const arrays = Array.isArray(raw.arrays) ? raw.arrays.filter(Boolean) : [];
  if (arrays.length) {
    const a0 = arrays[0];
    snap.name = arrays.length === 1 ? (a0.symmetrixId || device.name) : `${a0.symmetrixId || device.name} 외 ${arrays.length - 1}`;
    snap.serial = a0.symmetrixId || '';
    snap.extra.model = a0.model || '';
    snap.extra.ucode = a0.ucode || a0.microcode || '';
    snap.extra.arrays = arrays.slice(0, 8).map((a) => ({ id: a.symmetrixId, model: a.model }));
    snap.sections.config = 'ok';
    // 어레이별 용량(TB→바이트) — 합산이 capacity, 개별은 pools(caps 에 없는 어레이는 0 이 아니라 제외).
    let total = 0, used = 0;
    const pools = [];
    for (const a of arrays.slice(0, 32)) {
      const c = raw.caps?.[a.symmetrixId];
      if (!c) continue;
      const t = (Number(c.usable_total_tb) || 0) * TB;
      const u = (Number(c.usable_used_tb) || 0) * TB;
      total += t; used += u;
      pools.push({ name: a.symmetrixId, totalBytes: t, usedBytes: u, pct: t ? Math.round((u / t) * 1000) / 10 : null });
    }
    snap.pools = pools;
    if (total > 0) {
      snap.capacity = { totalBytes: total, usedBytes: used, pct: Math.round((used / total) * 1000) / 10 };
      snap.sections.capacity = 'ok';
    }
  }
  if (raw.alertCount != null) { snap.alerts.unresolved = Number(raw.alertCount) || 0; snap.sections.alerts = 'ok'; }
  // nodes/accounts 는 이번 범위 밖(디렉터·보드 상세는 실장비 확인 후 후속) — 'skip' 정직 표기.
  snap.extra.collectMethod = 'api';
  snap.ok = snap.sections.config === 'ok' || snap.sections.capacity === 'ok';
  if (!snap.ok && !snap.error) snap.error = '수집 실패(섹션 오류 참조)';
  return snap;
}

export async function collect(device) {
  const get = makeGetter(device, { port: Number(process.env.STORAGE_UNISPHERE_PORT) || 8443 });
  const raw = { caps: {} };
  const snap = emptySnapshot(device); // 섹션 오류 임시 기록용
  try {
    // ① Unisphere 버전(무버전 경로 — 인증 확인 겸용, 401 이면 즉시 전체 중단).
    try { raw.version = await get('/univmax/restapi/version'); }
    catch (e) { if (/401/.test(e.message)) throw e; /* 버전 실패는 치명 아님 */ }
    // ② 어레이 목록 → 어레이별 상세(model/ucode). 원격(SRDF 상대) 어레이는 로컬만 남긴다 —
    //    원격 어레이는 상대 Unisphere 소관이라 여기서 용량 질의하면 오류/중복 집계가 된다.
    //    목록 실패는 섹션 오류로 기록하고 계속(v2.310 검증 반영 — 독립 섹션인 alerts 까지
    //    막지 않게. 401 만 전체 중단).
    let ids = [];
    try { ids = (await get('/univmax/restapi/system/symmetrix'))?.symmetrixId || []; }
    catch (e) { snap.sections.config = `오류: ${e.message}`; if (/401/.test(e.message)) throw e; }
    raw.arrays = [];
    for (const id of ids.slice(0, 8)) {
      try {
        const d = await get(`/univmax/restapi/system/symmetrix/${encodeURIComponent(id)}`);
        const a = Array.isArray(d?.symmetrix) ? d.symmetrix[0] : d?.symmetrix || d;
        if (a && a.local !== false) raw.arrays.push({ symmetrixId: a.symmetrixId || id, model: a.model, ucode: a.ucode, local: a.local });
      } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.config = `일부 어레이 오류: ${e.message}`; }
    }
    // ③ 어레이별 용량(sloprovisioning — 버전 경로 폴백). 실패 어레이는 caps 에서 빠져
    //    pools 에도 안 실린다(0 오표시 방지 — powerstore appliance 와 동일 원칙).
    for (const a of raw.arrays) {
      try {
        const d = await tryAny(get, VERS.map((v) => `/univmax/restapi/${v}/sloprovisioning/symmetrix/${encodeURIComponent(a.symmetrixId)}`));
        const s = Array.isArray(d?.symmetrix) ? d.symmetrix[0] : d?.symmetrix || d;
        const c = s?.system_capacity;
        if (c && (c.usable_total_tb != null)) raw.caps[a.symmetrixId] = { usable_total_tb: c.usable_total_tb, usable_used_tb: c.usable_used_tb };
        else snap.sections.capacity = '오류: system_capacity 필드 부재(Unisphere 버전 확인)';
      } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.capacity = `오류: ${e.message}`; }
    }
    // ④ 미해결 알람 수 — /system/alert 는 알람 ID 배열을 반환(버전에 따라 alert_summary 폴백).
    try {
      const d = await tryAny(get, ['/univmax/restapi/system/alert', '/univmax/restapi/system/alert_summary']);
      if (Array.isArray(d?.alertId)) raw.alertCount = d.alertId.length;
      else if (d?.serverAlertSummary || d?.symmAlertSummary) {
        // alert_summary 는 구조가 버전마다 달라 숫자 필드 합산으로 방어적으로 센다(정직: 근사치).
        const nums = JSON.stringify(d).match(/"(?:alert_count|critical|warning)":(\d+)/g) || [];
        raw.alertCount = nums.reduce((s, m) => s + Number(m.split(':')[1]), 0);
      }
    } catch (e) { if (/401/.test(e.message)) throw e; snap.sections.alerts = `오류: ${e.message}`; }
  } catch (e) {
    const out = normalizePowermax(device, raw);
    out.error = e.message;
    for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
    return out;
  }
  const out = normalizePowermax(device, raw);
  for (const [k, v] of Object.entries(snap.sections)) if (String(v).includes('오류')) out.sections[k] = v;
  return out;
}
