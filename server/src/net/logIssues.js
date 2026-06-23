/**
 * 로그 자체 분석 — 장기 보관된 vCenter 로그에서 장애/이슈 패턴을 휴리스틱으로 찾아낸다.
 * 최근 기간의 오류/경고를 유형·대상별로 집계하고, 반복/집중/연결끊김/인증실패 등을 표면화.
 */

import { getLogsDb } from '../logs/db.js';

const DAY = 86_400_000;

export async function analyzeLogsForIssues({ vcenterId = '', days = 7 } = {}) {
  const db = await getLogsDb();
  const since = Date.now() - Math.max(1, days) * DAY;
  const base = { vcenterId: vcenterId || '', since };
  const errors = db.query({ ...base, severity: 'error' }, 5000, 0);
  const warnings = db.query({ ...base, severity: 'warning' }, 5000, 0);
  const totalErr = db.count({ ...base, severity: 'error' });
  const totalWarn = db.count({ ...base, severity: 'warning' });

  const byType = new Map(); const byEntity = new Map();
  const bump = (map, k) => { if (!k) return; map.set(k, (map.get(k) || 0) + 1); };
  for (const e of errors) { bump(byType, e.type); bump(byEntity, e.entity); }

  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => ({ key: k, count: c }));
  const topTypes = top(byType, 8);
  const topEntities = top(byEntity, 8);

  // 시간대별(시간 버킷) 오류 추세 — 스파이크 감지용.
  const hourly = new Map();
  for (const e of errors) { const h = Math.floor(e.ts / 3_600_000); hourly.set(h, (hourly.get(h) || 0) + 1); }
  const counts = [...hourly.values()];
  const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const peak = counts.length ? Math.max(...counts) : 0;

  // 패턴 진단
  const patterns = [];
  const reType = (re) => errors.filter((e) => re.test(`${e.type} ${e.message}`)).length;
  const connLost = reType(/ConnectionLost|Disconnect|NotResponding|lost connection|down/i);
  const authFail = reType(/Login.*fail|Authentication|Permission|AccessDenied|cannot.*login/i);
  const dsFull = reType(/Datastore.*full|space|capacity|usage/i);
  if (connLost >= 3) patterns.push({ sev: 'error', title: `연결 끊김/무응답 ${connLost}회`, detail: '호스트/서비스 연결 단절이 반복됩니다 — 네트워크·하드웨어·과부하 점검.' });
  if (authFail >= 3) patterns.push({ sev: 'warning', title: `인증 실패 ${authFail}회`, detail: '로그인/권한 오류 반복 — 자격증명 만료·브루트포스·계정 잠금 점검.' });
  if (dsFull >= 1) patterns.push({ sev: 'warning', title: `스토리지 용량 관련 ${dsFull}건`, detail: '데이터스토어 용량 이벤트 — 포화 임박 가능.' });
  if (topTypes[0] && topTypes[0].count >= 10) patterns.push({ sev: 'warning', title: `동일 오류 반복: ${topTypes[0].key} ${topTypes[0].count}회`, detail: '같은 유형 오류가 다수 발생 — 근본 원인 점검 필요.' });
  if (topEntities[0] && topEntities[0].count >= 10) patterns.push({ sev: 'warning', title: `오류 집중 대상: ${topEntities[0].key} ${topEntities[0].count}건`, detail: '특정 호스트/VM에 오류가 몰립니다 — 해당 자원 집중 점검.' });
  if (peak >= 20 && peak >= avg * 4) patterns.push({ sev: 'warning', title: `오류 스파이크 감지(최대 ${peak}건/시간)`, detail: `시간당 평균 ${avg.toFixed(1)}건 대비 급증 — 장애 시점 가능.` });
  if (!patterns.length) patterns.push({ sev: 'ok', title: '특이 패턴 없음', detail: `최근 ${days}일 오류 ${totalErr} · 경고 ${totalWarn}건, 반복/집중/스파이크 없음.` });

  return {
    window: { days, since },
    summary: { errors: totalErr, warnings: totalWarn, peakPerHour: peak, avgPerHour: Number(avg.toFixed(1)) },
    topTypes, topEntities, patterns,
    generatedAt: Date.now(),
  };
}
