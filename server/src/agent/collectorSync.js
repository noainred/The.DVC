/**
 * agent/collectorSync.js — 배포 대상(에이전트) ↔ 수집 서버(원격) 대조·연결(v2.434, 사용자 요구
 * '에이전트를 등록하면 자동으로 수집서버(원격)에 등록' + '에이전트가 설치되어 있는데 수집서버가
 * 설정되어 있지 않으면 추가').
 *
 * 배경(왜 어긋나는가): 엣지에 깔리는 프로그램은 하나(`vmware-portal`)지만 중앙은 그 하나를 두 곳에 적어 둔다 —
 *   · `agent-deploy-targets.json` : SSH 로 **설치**할 대상(host/port/계정/키)
 *   · `collectors.json`           : HTTP 로 **당겨올** 대상(url/token)
 * 배포 성공 시에만 후자가 자동 생성되므로(agent/autoRegister.js), **대상만 저장하고 배포는 나중에** 하거나
 * **수집 토큰 없이 배포**한 사이트는 영영 수집 서버에 안 뜬다. 여기서 그 차이를 표로 보여주고 메운다.
 *
 * 이 파일의 판정(diffTargets)은 **순수**하다 — 네트워크·SSH·파일 접근 없음(테스트로 고정).
 */
import { collectorIdFor } from './autoRegister.js';

/** 중앙이 이 대상에 접속할 URL(순수). v2.429 advertiseUrl(중계 엣지 경유)이 있으면 그것이 진실. */
export function targetUrl(t) {
  const adv = String(t?.advertiseUrl || '').trim().replace(/\/+$/, '');
  if (adv) return adv;
  const host = String(t?.host || '').trim();
  if (!host) return '';
  return `http://${host}:${Number(t?.portalPort) || 4000}`;
}

/** URL → 'host:port'(순수). 비교 키로만 쓴다. 파싱 실패면 ''. */
export function urlKey(u) {
  try {
    const x = new URL(/:\/\//.test(String(u)) ? u : `http://${u}`);
    const port = Number(x.port) || (x.protocol === 'https:' ? 443 : 80);
    return `${x.hostname.toLowerCase()}:${port}`;
  } catch { return ''; }
}

/**
 * 대상이 '설치되어 있다'고 볼 근거(순수). SSH 를 다시 열지 않고 기록으로만 판단한다 —
 * 24대를 매번 SSH 로 확인하면 화면이 수 분 멈춘다. 확실한 확인이 필요하면 화면의 '상태 확인'을 쓴다.
 */
export function installedHint(t) {
  const lr = t?.lastResult;
  if (lr?.ok) return { installed: true, why: `배포 성공 기록(${new Date(lr.at).toISOString().slice(0, 16).replace('T', ' ')})`, at: lr.at || 0 };
  if (lr && lr.ok === false) return { installed: false, why: `마지막 배포 실패 — ${lr.reason || ''}`.trim(), at: lr.at || 0 };
  return { installed: false, why: '배포 기록 없음(저장만 된 대상)', at: 0 };
}

export const STATUS = {
  linked: '연결됨',
  missing: '수집 서버 없음',
  'url-mismatch': 'URL 불일치',
  'token-mismatch': '토큰 불일치',
  'no-token': '수집 토큰 없음',
  disabled: '대상 비활성',
  'orphan-collector': '수집 서버만 있음',
};

/**
 * 대상 × 수집 서버 대조(순수). targets 는 **원본**(collectorToken 포함)을 받되 결과에는 토큰 값을 넣지 않는다.
 * 매칭 순서: ① 접속 URL(host:port) — 실제로 pull 이 쓰는 값이라 이게 진실 ② 수집 서버 id(=슬러그).
 * @returns {{rows:Array, orphans:Array, summary:object}}
 */
export function diffTargets(targets = [], collectors = []) {
  const byUrl = new Map(); const byId = new Map();
  for (const c of collectors) {
    const k = urlKey(c.url);
    if (k && !byUrl.has(k)) byUrl.set(k, c);
    byId.set(String(c.id).toLowerCase(), c);
  }
  const usedCollector = new Set();
  const rows = [];
  const summary = { total: 0, linked: 0, missing: 0, noToken: 0, mismatch: 0, disabled: 0, addable: 0 };

  for (const t of targets) {
    const url = targetUrl(t);
    const key = urlKey(url);
    const wantId = collectorIdFor(t);
    const col = (key && byUrl.get(key)) || byId.get(String(wantId).toLowerCase()) || null;
    if (col) usedCollector.add(col.id);
    const hasToken = !!t.collectorToken || !!t.hasCollectorToken;   // redact() 를 거친 목록도 지원
    const row = {
      id: t.id, host: t.host, port: Number(t.port) || 22, agentName: t.agentName || '',
      datacenter: t.collectorDatacenter || '', url, portalPort: Number(t.portalPort) || 4000,
      enabled: t.enabled !== false, hasToken,
      collectorId: col?.id || '', collectorUrl: col?.url || '', collectorEnabled: col ? col.enabled !== false : null,
      wantId, ...installedHint(t),
      status: 'linked', issue: '', fix: '', canAdd: false,
    };
    if (t.enabled === false) { row.status = 'disabled'; row.issue = '배포 대상이 비활성(enabled=false)입니다.'; row.fix = '대상을 활성화한 뒤 다시 대조하세요.'; }
    else if (!col) {
      row.status = 'missing';
      row.issue = `수집 서버 목록에 ${url} 이 없습니다 — 중앙이 이 엣지에서 데이터를 당겨오지 않습니다.`;
      row.fix = hasToken ? `수집 서버 '${wantId}' 로 추가` : `수집 토큰을 생성해 엣지에 반영한 뒤 '${wantId}' 로 추가`;
      row.canAdd = true;
      if (!hasToken) { row.status = 'no-token'; }
    } else if (key && urlKey(col.url) !== key) {
      row.status = 'url-mismatch';
      row.issue = `이름은 같은데 URL 이 다릅니다 — 수집 서버 '${col.id}' = ${col.url}, 이 대상은 ${url}.`;
      row.fix = '어느 쪽이 맞는지 확인 후 수집 서버 URL 또는 대상의 advertiseUrl/포탈 포트를 맞추세요.';
    } else if (!hasToken) {
      row.status = 'no-token';
      row.issue = '배포 대상에 수집 토큰이 없어 중앙 저장 토큰과 대조할 수 없습니다.';
      row.fix = '수집 토큰을 생성해 엣지에 반영하면 연결이 확정됩니다.';
    } else if (t.collectorToken && col.token && t.collectorToken !== col.token) {
      row.status = 'token-mismatch';
      row.issue = `수집 서버 '${col.id}' 의 토큰이 이 대상에 저장된 값과 다릅니다 — pull 이 403 이 됩니다.`;
      row.fix = "수집 서버 화면의 '토큰 강제 동기화' 또는 여기서 '엣지에 반영'";
    }
    summary.total++;
    if (row.status === 'linked') summary.linked++;
    if (row.status === 'missing') summary.missing++;
    if (row.status === 'no-token') summary.noToken++;
    if (row.status === 'url-mismatch' || row.status === 'token-mismatch') summary.mismatch++;
    if (row.status === 'disabled') summary.disabled++;
    if (row.canAdd) summary.addable++;
    delete row.collectorToken;   // 방어 — 토큰 값은 절대 싣지 않는다
    rows.push(row);
  }

  // 역방향: 수집 서버는 있는데 대응하는 배포 대상이 없음(수동 등록·자기등록 엣지 — 정보용, 조치 대상 아님)
  const orphans = collectors
    .filter((c) => !usedCollector.has(c.id))
    .map((c) => ({ id: c.id, name: c.name || '', url: c.url, datacenter: c.datacenter || '', enabled: c.enabled !== false, status: 'orphan-collector' }));

  return { rows, orphans, summary };
}

/** 수집 토큰 문자셋 — forceCollectorToken 의 셸 삽입 화이트리스트와 같은 집합만 쓴다. */
export const tokenOk = (t) => /^[A-Za-z0-9._~+/=-]{4,512}$/.test(String(t || ''));
