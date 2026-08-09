/**
 * UAG(Unified Access Gateway) 관리 API 클라이언트 + 통계 정규화.
 *
 * 외부 의존성 없이 node:https 만 사용한다. TLS 검증 완화는 대상별 옵션
 * (insecureTls)을 요청 단위로만 적용한다 — 전역 디스패처/agent 로 프로세스
 * 전체 fetch 의 검증을 끄지 않는다(포탈 보안 불변조건과 동일).
 *
 * 데이터 소스: UAG 관리 인터페이스(기본 9443)의 모니터링 통계 엔드포인트
 *   GET /rest/v1/monitor/stats  (HTTP Basic 인증)
 * UAG 버전에 따라 JSON(Accept: application/json) 또는 XML(accessPointStatusAndStats)
 * 로 응답하므로 두 형식 모두 관용적으로 파싱하고, 모르는 필드는 버린다.
 */

import https from 'node:https';
import dns from 'node:dns';
import { hostBlockReason, parseIpv4 } from './guard.js';

const MAX_BODY = 2 * 1024 * 1024; // 통계 응답 상한(비정상 대량 응답 방어)

/**
 * 대상 UAG 의 모니터링 통계를 가져와 정규화해 반환. 실패해도 reject 하지 않는다.
 *
 * ## 연결 직전 SSRF 재검증 (M3)
 * host 가 호스트네임이면 **연결 직전 DNS 해석 결과를 hostBlockReason 으로 재검증**하고, 접속은
 * 해석된 IP 로 하되 TLS SNI·Host 헤더는 원래 호스트로 핀한다. 저장 시점 검증만으로는 DNS 가
 * 나중에 루프백/링크로컬/공개서버로 바뀌는 경우(또는 host 만 바꿔치기)를 놓쳐 UAG 관리자
 * 자격증명(Basic 헤더)이 공격자 서버로 선제 전송될 수 있다 — 그 경로를 여기서 봉인한다.
 */
export async function fetchUagStats(target, { timeoutMs = 10_000 } = {}) {
  const host = String(target.host || '');
  let connectHost = host;
  // 8진·16진 등 우회 표기까지 IP 로 인식(guard 규칙 재사용). IP 리터럴은 저장 검증이 이미 봤다.
  const looksIp = parseIpv4(host) != null || host.includes(':');
  if (!looksIp) {
    let resolved;
    try { resolved = await dns.promises.lookup(host, { verbatim: true }); }
    catch (e) { return { ok: false, error: `주소 해석 실패: ${e.message}` }; }
    const blocked = hostBlockReason(resolved.address);
    if (blocked) return { ok: false, error: `차단된 주소로 해석됨(${resolved.address}): ${blocked}` };
    connectHost = resolved.address;
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let req;
    try {
      const auth = Buffer.from(`${target.username || ''}:${target.password || ''}`).toString('base64');
      req = https.request({
        host: connectHost,          // 접속은 해석된 IP(재검증 통과분)
        servername: host,           // TLS SNI 는 원래 호스트(인증서 검증 유지)
        port: Number(target.port) || 9443,
        path: '/rest/v1/monitor/stats',
        method: 'GET',
        headers: { Host: host, Authorization: `Basic ${auth}`, Accept: 'application/json' },
        // 자체서명 UAG 대응 — 이 요청에만 적용(전역 완화 금지).
        rejectUnauthorized: !target.insecureTls,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (d) => { total += d.length; if (total <= MAX_BODY) chunks.push(d); });
        res.on('end', () => {
          if (total > MAX_BODY) return done({ ok: false, error: `응답이 너무 큽니다 (${total} bytes)` });
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 401 || res.statusCode === 403) {
            return done({ ok: false, error: `인증 실패 (HTTP ${res.statusCode}) — UAG 관리 계정을 확인하세요` });
          }
          if (res.statusCode !== 200) return done({ ok: false, error: `HTTP ${res.statusCode}` });
          done(parseStats(body));
        });
      });
    } catch (err) {
      return done({ ok: false, error: err.message });
    }
    req.on('timeout', () => req.destroy(new Error(`응답 없음 (${timeoutMs / 1000}s 초과)`)));
    req.on('error', (err) => done({ ok: false, error: err.message }));
    req.end();
  });
}

/* ------------------------------ 정규화 파서 ------------------------------ */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v) => (v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : v != null ? [v] : []);

/**
 * 통계 응답 본문(JSON 또는 XML)을 공통 형태로 정규화.
 * 반환: { ok, at, version, totalSessions, authenticatedSessions, highWaterMark,
 *         cpuPercent, memPercent, upSeconds, overall, services:[{id,status,sessions,high}] }
 * 필드는 응답에 없으면 null — UI 는 없는 값을 '—' 로 표시한다.
 */
export function parseStats(body) {
  const text = String(body || '').trim();
  let doc = null;
  if (text.startsWith('{')) {
    try { doc = JSON.parse(text); } catch { /* 아래 공통 실패 처리 */ }
  } else if (text.startsWith('<')) {
    doc = xmlToDoc(text);
  }
  if (!doc || typeof doc !== 'object') return { ok: false, error: '알 수 없는 응답 형식(JSON/XML 아님)' };

  const root = doc.accessPointStatusAndStats || doc;

  const services = arr(root.edgeServiceSessionStats).map((s) => ({
    id: str(s.identifier || s.edgeServiceId || s.id || '').toUpperCase() || 'UNKNOWN',
    status: str(s.edgeServiceStatus || s.status || '').toUpperCase(),
    sessions: num(s.totalSessionCount ?? s.activeSessionCount ?? s.sessionCount),
    high: num(s.highWaterMark),
  }));

  const sumSessions = services.reduce((a, s) => a + (s.sessions || 0), 0);
  const totalSessions = num(root.totalSessionCount) ?? (services.length ? sumSessions : null);

  const sys = root.systemStats || root;
  let memPercent = num(sys.memoryUtilPercent);
  if (memPercent == null) {
    const totalMb = num(sys.totalMemoryMb ?? sys.totalMemoryMB);
    const freeMb = num(sys.freeMemoryMb ?? sys.freeMemoryMB);
    if (totalMb && freeMb != null && totalMb > 0) memPercent = Math.round(((totalMb - freeMb) / totalMb) * 100);
  }

  // 전체 상태: 응답의 종합 상태 필드가 있으면 그대로, 없으면 서비스 상태로 유도.
  let overall = str(root.overAllStatus?.status ?? root.overAllStatus ?? root.overallStatus ?? '').toUpperCase();
  if (!overall) {
    const bad = services.filter((s) => s.status && !['UP', 'RUNNING', 'OK'].includes(s.status));
    overall = services.length === 0 ? '' : bad.length === 0 ? 'UP' : bad.length === services.length ? 'DOWN' : 'PARTIAL';
  }

  const upMs = num(root.upTime ?? sys.upTime);

  return {
    ok: true,
    at: Date.now(),
    version: str(root.apVersion || root.version || '') || null,
    totalSessions,
    authenticatedSessions: num(root.authenticatedSessionCount),
    highWaterMark: num(root.highWaterMark),
    cpuPercent: num(sys.cpuUtilPercent ?? sys.cpuUtilizationPercent),
    memPercent,
    upSeconds: upMs != null ? Math.floor(upMs / 1000) : null,
    overall: overall || null,
    services,
  };
}

/* ------------------------------ XML 폴백 ------------------------------ */
// 구버전 UAG 는 XML(<accessPointStatusAndStats>)로 답한다. 필요한 필드만
// 관용적으로 뽑는 최소 변환 — 완전한 XML 파서가 아니며 알려진 태그만 다룬다.

function tagValue(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1] : undefined;
}

function xmlToDoc(xml) {
  const doc = {};
  for (const t of ['totalSessionCount', 'authenticatedSessionCount', 'highWaterMark', 'upTime', 'apVersion', 'overAllStatus', 'cpuUtilPercent']) {
    const v = tagValue(xml, t);
    if (v !== undefined) doc[t] = v;
  }
  doc.edgeServiceSessionStats = [];
  const re = /<edgeServiceSessionStats>([\s\S]*?)<\/edgeServiceSessionStats>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    doc.edgeServiceSessionStats.push({
      identifier: tagValue(block, 'identifier'),
      edgeServiceStatus: tagValue(block, 'edgeServiceStatus') ?? tagValue(block, 'status'),
      totalSessionCount: tagValue(block, 'totalSessionCount') ?? tagValue(block, 'sessionCount'),
      highWaterMark: tagValue(block, 'highWaterMark'),
    });
  }
  return doc;
}
