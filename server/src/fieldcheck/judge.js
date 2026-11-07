/**
 * fieldcheck/judge.js — 법인별 실환경 확인(v2.938 · 사용자 요청 '개선 포인트 8번은 법인별로 적용').
 *
 * 왜: 여러 기능의 규칙 문서에 '실장비(실제 엣지)로 확인하지 못했다' 가 남아 있다 — 테스트는 가짜 서버·합성 입력으로만 돌았다. 그런데 운영 중인
 *   법인 엣지는 **실제 장비에서 읽은 결과**를 이미 중앙에 보내고 있다. 이 모듈은 그 결과를 근거로 법인(= vCenter = 그 법인 엣지)마다
 *   '실환경에서 그 경로가 동작했는가' 를 판정한다. 엣지에 새 명령을 보내지 않는다(왕복 0 — 중앙이 이미 가진 값만 읽는다).
 *
 * 판정(코드 — 문장은 웹 `views/tools/fieldCheckText.js`, 1:1 테스트):
 *  - confirmed  실환경 근거가 있다(그 법인에서 실제로 동작했다)
 *  - failed     실환경에서 시도했고 실패했다(사유 동봉)
 *  - pending    아직 근거가 없다(시도 기록이 없다 — 실패가 아니다)
 *  - na         이 법인에는 해당하지 않는다(중앙 직접 수집 · vDS 없음 · Bareos 미매핑 등)
 *  - unknown    판정할 수 없다(목 데이터 · 원본을 읽지 못함) — 확인됨에 넣지 않는다
 *
 * 항목(FIELD_CHECKS) — 문서의 '실장비 미확인' 기록에서 왔다:
 *  - upgrade-push  엣지 자동 업그레이드: 중앙 → 법인 엣지 번들 push 가 실제로 닿았는가(수집 서버 상태 upgrade — 받음 · 이미 최신이면 확인)
 *  - vapi-tags     vSphere 태그(vAPI REST) 응답을 실제로 읽었는가(인벤토리 vcenter.tagInv)
 *  - lacp-path     vDS 의 LACP 경로(config.lacpGroupConfig)를 실제로 읽었는가(vCenter 정보 dvpg — lagError 없음)
 *  - bareos-dir    법인 Bareos Director 콘솔에 실제로 접속했는가(Bareos 사전 점검 'Director 콘솔' 항목)
 *  ⚠ 아이실론 분리 실행(OneFS nohup)은 중앙이 실행 방식을 저장하지 않아 근거가 없다 — 항목에 넣지 않았다(지어내지 않는다).
 */

export const FIELD_STATES = Object.freeze(['confirmed', 'failed', 'pending', 'na', 'unknown']);
export const FIELD_CHECKS = Object.freeze(['upgrade-push', 'vapi-tags', 'lacp-path', 'bareos-dir']);

const lc = (s) => String(s ?? '').trim().toLowerCase();
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const txt = (v, n = 300) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const cell = (state, detail = null, at = null) => ({ state, detail: detail ? String(detail).slice(0, 300) : null, at: num(at) });

/** ① 엣지 자동 업그레이드 push — 그 법인 엣지(수집 서버)의 마지막 push 수신 기록. */
export function judgeUpgradePush({ site, agent, collector, status, centralVersion }) {
  if (!site) return cell('na', '중앙 직접 수집 vCenter — 법인 엣지가 없습니다');
  if (!agent) return cell('pending', '이 법인 vCenter 를 보내는 엣지를 아직 모릅니다(인벤토리 수신 전)');
  if (!collector) return cell('unknown', `엣지 '${agent}' 가 수집 서버로 등록돼 있지 않아 push 대상이 아닙니다`);
  const u = status?.upgrade;
  if (u && (u.ok === true || u.upToDate === true)) return cell('confirmed', `${u.upToDate ? '이미 최신이라고 회신' : `v${u.version || '?'} 받음`}${u.auto ? ' (자동)' : ''}`, u.at);
  if (u) return cell('failed', txt(u.reason) || '업그레이드 push 실패(사유 없음)', u.at);
  const v = txt(status?.version, 32);
  return cell('pending', `아직 push 기록이 없습니다${v ? ` — 엣지 v${v}${centralVersion ? ` · 중앙 v${centralVersion}` : ''}` : ''}`);
}

/** ② vAPI 태그 — 인벤토리 vcenter.tagInv. */
export function judgeVapiTags({ vc, mock }) {
  if (mock) return cell('unknown', '목 데이터 — 실장비 근거가 아닙니다');
  const t = vc?.tagInv;
  if (!t || typeof t !== 'object') return cell('pending', '태그 수집 기록이 아직 없습니다(수집 주기 6시간 · 옛 엣지는 보내지 않음)');
  if (t.tagsUnsupported) return cell('na', 'vCenter 가 vAPI 태그를 지원하지 않습니다');
  if (t.tagsError) return cell('failed', txt(t.tagsError), t.tagsAt || t.at);
  if (Array.isArray(t.categories) && num(t.tagsAt) != null) return cell('confirmed', `카테고리 ${t.categories.length} · 태그 ${Array.isArray(t.tags) ? t.tags.length : 0}`, t.tagsAt);
  return cell('pending', '태그를 아직 읽지 않았습니다', t.at);
}

/** ③ vDS LACP 경로 — vCenter 정보 dvpg. */
export function judgeLacpPath({ vcInfo, mock }) {
  if (mock) return cell('unknown', '목 데이터 — 실장비 근거가 아닙니다');
  const d = vcInfo?.dvpg;
  if (!d || typeof d !== 'object') return cell('pending', 'vDS 포트그룹 정보를 아직 받지 않았습니다(주기 6시간)');
  if (d.lagError) return cell('failed', `LACP(LAG) 경로를 읽지 못함 — ${txt(d.lagError, 200)}`, d.at);
  if (d.dvsError || d.error) return cell('failed', txt(d.dvsError || d.error, 200), d.at);
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) return cell('na', 'vDS 포트그룹이 없습니다', d.at);
  const lag = items.filter((x) => x && x.lacp && x.lacp.enabled === true).length;
  return cell('confirmed', `포트그룹 ${items.length} 읽음 · LACP 사용 ${lag}`, d.at);
}

/** ④ Bareos Director 콘솔 — 사전 점검의 'dir' 항목. */
export function judgeBareosDir({ corp }) {
  if (!corp) return cell('na', '이 법인에 Bareos Director 가 매핑되지 않았습니다');
  const it = (Array.isArray(corp.items) ? corp.items : []).find((x) => x && x.key === 'dir');
  const via = corp.from === 'edge' ? '엣지 대행' : corp.from === 'central' ? '중앙 직접' : '';
  if (!it) return cell('pending', '사전 점검 기록이 아직 없습니다', corp.at);
  if (it.status === 'ok') return cell('confirmed', `${txt(it.detail, 120) || '응답'}${via ? ` · ${via}` : ''}`, corp.at);
  if (it.status === 'bad') return cell('failed', txt(it.detail, 200) || '접속 실패', corp.at);
  return cell('pending', txt(it.detail, 200) || '아직 점검하지 않았습니다', corp.at);
}

/**
 * 법인별 표 — vCenter(= 법인) 한 줄에 항목 넷.
 * @param {object} o
 * @param {object[]} o.registry 등록 vCenter(id·name·collectMode)
 * @param {(id:string)=>object|null} o.vcOf 스냅샷 vCenter 객체(tagInv · collectedBy)
 * @param {(id:string)=>string} o.agentOf 그 vCenter 를 보내는 엣지 이름
 * @param {object[]} o.collectors 수집 서버 등록부 @param {Record<string,object>} o.statusById 수집 서버 상태
 * @param {(id:string)=>object|null} o.vcInfoOf · @param {(id:string)=>object|null} o.corpOf Bareos 사전 점검
 * @param {(id:string)=>boolean} o.isMock @param {string} o.centralVersion
 */
export function buildFieldChecks({ registry = [], vcOf = () => null, agentOf = () => '', collectors = [], statusById = {}, vcInfoOf = () => null, corpOf = () => null, isMock = () => false, centralVersion = '' } = {}) {
  const colByName = new Map();
  for (const c of Array.isArray(collectors) ? collectors : []) {
    if (!c || typeof c !== 'object') continue;
    for (const k of [c.name, c.id]) if (k && !colByName.has(lc(k))) colByName.set(lc(k), c);
  }
  const rows = [];
  for (const r of Array.isArray(registry) ? registry : []) {
    if (!r?.id || r.enabled === false) continue;
    const id = String(r.id);
    const site = r.collectMode === 'site';
    const vc = vcOf(id);
    const agent = site ? String(agentOf(id) || vc?.collectedBy || '') : '';
    const collector = agent ? colByName.get(lc(agent)) || null : null;
    const mock = !!isMock(id, vc);
    const cells = {};
    const safe = (k, fn) => { try { cells[k] = fn(); } catch (e) { cells[k] = cell('unknown', `판정 원본을 읽지 못함 — ${String(e?.message || e).slice(0, 120)}`); } };
    safe('upgrade-push', () => judgeUpgradePush({ site, agent, collector, status: collector ? statusById[collector.id] : null, centralVersion }));
    safe('vapi-tags', () => judgeVapiTags({ vc, mock }));
    safe('lacp-path', () => judgeLacpPath({ vcInfo: vcInfoOf(id), mock }));
    safe('bareos-dir', () => judgeBareosDir({ corp: corpOf(id) }));
    rows.push({ id, name: String(r.name || id).slice(0, 200), mode: site ? 'site' : 'direct', agent: agent || null, cells });
  }
  const counts = Object.fromEntries(FIELD_STATES.map((s) => [s, 0]));
  const byCheck = Object.fromEntries(FIELD_CHECKS.map((k) => [k, Object.fromEntries(FIELD_STATES.map((s) => [s, 0]))]));
  for (const row of rows) for (const k of FIELD_CHECKS) { const s = row.cells[k]?.state || 'unknown'; counts[s] += 1; byCheck[k][s] += 1; }
  return { rows, counts, byCheck, total: rows.length * FIELD_CHECKS.length, corps: rows.length, checks: FIELD_CHECKS };
}
