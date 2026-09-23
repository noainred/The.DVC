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
import { localStamp } from '../util/dayKey.js';

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
  if (lr?.ok) return { installed: true, why: `배포 성공 기록(${localStamp(lr.at) || '시각 미상'})`, at: lr.at || 0 };
  if (lr && lr.ok === false) return { installed: false, why: `마지막 배포 실패 — ${lr.reason || ''}`.trim(), at: lr.at || 0 };
  return { installed: false, why: '배포 기록 없음(저장만 된 대상)', at: 0 };
}

export const STATUS = {
  linked: '연결됨',
  missing: '수집 서버 없음',
  'url-conflict': 'URL 중복',
  'url-mismatch': 'URL 불일치',
  'token-mismatch': '토큰 불일치',
  'no-token': '수집 토큰 없음',
  disabled: '대상 비활성',
  'orphan-collector': '수집 서버만 있음',
};

/** 행이 실행할 수 있는 조치(v2.436). add=수집 서버 생성 · align=토큰 정렬 · none=사람이 판단해야 함. */
export const ACTION = { add: '수집 서버 추가', align: '토큰 정렬', none: '수동 확인' };

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
  const usedCollector = new Map();   // collectorId → 먼저 차지한 대상(중복 매칭 감지, v2.436)
  const rows = [];
  const summary = { total: 0, linked: 0, missing: 0, noToken: 0, mismatch: 0, conflict: 0, disabled: 0, addable: 0, fixable: 0 };

  for (const t of targets) {
    const url = targetUrl(t);
    const key = urlKey(url);
    const wantId = collectorIdFor(t);
    const col = (key && byUrl.get(key)) || byId.get(String(wantId).toLowerCase()) || null;
    const hasToken = !!t.collectorToken || !!t.hasCollectorToken;   // redact() 를 거친 목록도 지원
    const row = {
      id: t.id, host: t.host, port: Number(t.port) || 22, agentName: t.agentName || '',
      datacenter: t.collectorDatacenter || '', url, portalPort: Number(t.portalPort) || 4000,
      enabled: t.enabled !== false, hasToken,
      collectorId: col?.id || '', collectorUrl: col?.url || '', collectorEnabled: col ? col.enabled !== false : null,
      wantId, ...installedHint(t),
      status: 'linked', issue: '', fix: '', action: 'none', canAdd: false, canFix: false,
    };
    const takenBy = col ? usedCollector.get(col.id) : null;
    if (col && !takenBy) usedCollector.set(col.id, row);

    if (t.enabled === false) {
      row.status = 'disabled'; row.issue = '배포 대상이 비활성(enabled=false)입니다.'; row.fix = '대상을 활성화한 뒤 다시 대조하세요.';
    } else if (takenBy) {
      /* v2.436: 두 배포 대상이 같은 수집 서버를 가리키는 경우. 실사용에서 잡힌 형태는 '중계 엣지 뒤의 IRS'
       * 인데, 그 대상의 수집 URL 이 host:portalPort 로 계산돼 **중계 엣지 자신의 포탈**을 가리킨다.
       * 중앙은 IRS 에 직접 닿지 않으므로 광고 URL(중계 포트)을 지정해야 별개 수집 서버가 된다. */
      row.status = 'url-conflict';
      row.issue = `수집 URL ${url} 이 '${takenBy.agentName || takenBy.host}' 대상과 같아 수집 서버 '${col.id}' 에 중복 매칭됩니다 — 이 대상의 데이터는 수집되지 않습니다.`;
      row.fix = row.port !== 22
        ? `이 대상은 SSH 포트가 ${row.port}(중계 경유)입니다. 중앙에서 닿는 실제 주소를 '광고 URL(advertiseUrl)' 에 지정하세요(중계 엣지의 포탈 포워딩 포트 — 토폴로지 표에서 확인).`
        : "두 대상의 host·포탈 포트가 같습니다. 하나를 '광고 URL(advertiseUrl)' 로 구분하거나 중복 등록을 정리하세요.";
    } else if (!col) {
      row.status = hasToken ? 'missing' : 'no-token';
      row.issue = `수집 서버 목록에 ${url} 이 없습니다 — 중앙이 이 엣지에서 데이터를 당겨오지 않습니다.`;
      row.fix = hasToken ? `수집 서버 '${wantId}' 로 추가` : `수집 토큰을 생성해 엣지에 반영한 뒤 '${wantId}' 로 추가`;
      row.action = 'add'; row.canAdd = true;
    } else if (key && urlKey(col.url) !== key) {
      row.status = 'url-mismatch';
      row.issue = `이름은 같은데 URL 이 다릅니다 — 수집 서버 '${col.id}' = ${col.url}, 이 대상은 ${url}.`;
      row.fix = '어느 쪽이 맞는지 확인 후 수집 서버 URL 또는 대상의 광고 URL/포탈 포트를 맞추세요.';
    } else if (!hasToken) {
      /* 수집 서버는 있는데 대상에 토큰이 없다 — 중앙 값을 대상에 복사하면 끝난다(SSH 불필요). */
      row.status = 'no-token';
      row.issue = `배포 대상에 수집 토큰이 없습니다. 지금 수집은 수집 서버 '${col.id}' 의 토큰으로 동작하지만, **이 대상을 재배포하면 엣지의 토큰이 빈 값으로 덮여 수집이 끊깁니다**.`;
      row.fix = "'중앙 → 대상' 으로 정렬(수집 서버의 토큰을 배포 대상에 복사 · SSH 불필요)";
      row.action = 'align'; row.canFix = true;
    } else if (t.collectorToken && col.token && t.collectorToken !== col.token) {
      /* v2.436 문구 정정: 예전에는 "pull 이 403 이 됩니다" 라고 단정했지만, 이 판정은 **두 저장소의 값만**
       * 비교할 뿐 엣지에 실제로 어떤 값이 있는지는 모른다. 수집 서버 화면에서 토큰을 재발급·강제 동기화하면
       * collectors.json 과 엣지만 갱신되고 배포 대상 기록은 남으므로, 대개 **지금 수집은 정상이고 낡은 것은
       * 배포 대상 기록** 이다. 진짜 위험은 재배포 시 그 낡은 값이 엣지를 덮는 것. '진단' 으로 확인할 수 있다. */
      row.status = 'token-mismatch';
      row.issue = `수집 서버 '${col.id}' 의 토큰과 이 대상에 저장된 값이 다릅니다. 지금 수집이 되는지는 이 표만으로 알 수 없습니다(엣지의 실제 값은 '진단' 으로 확인) — 다만 **이 대상을 재배포하면 엣지 토큰이 대상 값으로 덮여** 어느 한쪽이 끊깁니다.`;
      row.fix = "'진단' 으로 엣지가 받는 토큰을 확인한 뒤 방향을 골라 정렬하세요(대개 '중앙 → 대상').";
      row.action = 'align'; row.canFix = true;
    }
    summary.total++;
    if (row.status === 'linked') summary.linked++;
    if (row.status === 'missing') summary.missing++;
    if (row.status === 'no-token') summary.noToken++;
    if (row.status === 'url-mismatch' || row.status === 'token-mismatch') summary.mismatch++;
    if (row.status === 'url-conflict') summary.conflict++;
    if (row.status === 'disabled') summary.disabled++;
    if (row.canAdd) summary.addable++;
    if (row.canFix) summary.fixable++;
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
