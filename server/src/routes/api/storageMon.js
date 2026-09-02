// 스토리지 모니터링 라우트(v2.302) — 특수기능 '스토리지 모니터링(Isilon 등)' 화면용.
// 조회: 전체 범위 계정만(스토리지는 vCenter 귀속이 없는 인프라 장비 — 'vCenter 귀속 없는
// 데이터는 범위 계정에 노출 금지' 규칙, fleet 과 동일 403 패턴). 변경: adminOnly + 감사로그.
import { requireRole } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { STORAGE_TYPES } from '../../storage/types.js';
import { listDevices, listDevicesWithSecrets, saveDevice, deleteDevice, deviceInputIssue } from '../../storage/registry.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { localSnapshots, dropSnapshot } from '../../storage/store.js';
import { collectDeviceNow, storagePollerStatus, pollStorageOnce } from '../../storage/poller.js';
import { edgeStorageSnapshots } from '../../central/storageEdge.js';
import { listActivity } from '../../storage/activityLog.js';
import { areaSummary, areaJson, capacityHistory, capacityHistoryAll, dbAvailable } from '../../storage/db.js';
import { AREA_LABEL } from '../../storage/onefsCatalog.js';
import { listDatacenters } from '../../datacenter/store.js';
import { knownAgentNames } from '../../central/knownAgents.js';
import { devicesToCsv, sampleCsv, parseDevicesCsv, analyzeImport } from '../../storage/csv.js';
import { requestCollect, hasPendingRequest } from '../../storage/collectRequests.js';

const adminOnly = requireRole('admin');
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: '스토리지 모니터링은 전체 범위(vCenter 제한 없는) 계정만 조회할 수 있습니다.' });
  }
  next();
};

export function registerStorageMon(api) {

/**
 * 통합 조회 — 이 노드(중앙) 직접 수집분 + 전 엣지 push 분을 합쳐 장비별 최신 스냅샷을 반환.
 * 같은 deviceId 가 양쪽에 있으면 최신 collectedAt 우선. 법인/타입별 뷰는 프론트가 이 평탄
 * 목록을 그룹핑한다(뷰 추가가 서버 변경 없이 가능 — 확장 요구 반영).
 */
api.get('/tools/storage', fullScopeOnly, (_req, res) => {
  const byId = new Map();
  for (const s of [...localSnapshots(), ...edgeStorageSnapshots()]) {
    const cur = byId.get(s.deviceId);
    if (!cur || (s.collectedAt || 0) > (cur.collectedAt || 0)) byId.set(s.deviceId, s);
  }
  const devices = listDevices().map((d) => ({ ...d, snap: byId.get(d.id) || null }));
  // 등록부에 없는데 스냅샷만 있는 항목(엣지 잔존 push 등)도 정직하게 노출(orphan 표기).
  const known = new Set(devices.map((d) => d.id));
  const orphans = [...byId.values()].filter((s) => !known.has(s.deviceId));
  res.json({
    devices, orphans,
    types: STORAGE_TYPES,
    datacenters: (() => { try { return listDatacenters(); } catch { return []; } })(),
    // 엣지 목록: per-agent 토큰뿐 아니라 중앙과 통신 중인 모든 알려진 엣지를 병합(v2.312 —
    // iDRAC 위임과 동일 소스). 토큰 미발급(공유 CENTRAL_TOKEN) 환경에서도 엣지를 고를 수 있다.
    agents: knownAgentNames(),
    poller: storagePollerStatus(),
  });
});

api.post('/tools/storage/devices', adminOnly, (req, res) => {
  try {
    const d = saveDevice(req.body || {});
    logAudit({ user: req.user?.username, action: '스토리지 장비 저장', target: `${d.type}/${d.name}`, detail: `${d.host} · 수집=${d.agent || '중앙'}` });
    res.status(201).json({ ok: true, device: d });
  } catch (e) { res.status(400).json({ ok: false, reason: e.message }); }
});

api.delete('/tools/storage/devices/:id', adminOnly, (req, res) => {
  if (!deleteDevice(req.params.id)) return res.status(404).json({ ok: false, reason: '장비를 찾을 수 없습니다.' });
  dropSnapshot(req.params.id); // 지운 장비의 낡은 스냅샷이 화면에 유령으로 남지 않게
  logAudit({ user: req.user?.username, action: '스토리지 장비 삭제', target: req.params.id });
  res.json({ ok: true });
});

/**
 * 수집 작업 로그(v2.315, 사용자 요구 '진행중/완료 창').
 * poller.inFlight = 지금 수집 중인 장비('진행중'), events = 최근 완료 이벤트('완료', newest-first).
 * 조회 전용이라 fullScopeOnly(스토리지는 vCenter 범위 밖 — 다른 스토리지 조회와 동일 게이트).
 */
api.get('/tools/storage/activity', fullScopeOnly, (req, res) => {
  res.json({ poller: storagePollerStatus(), events: listActivity(Number(req.query.limit) || 100) });
});

/**
 * 전체 새로고침(v2.315, 사용자 요구) — 중앙 직접(agent 빈) 장비를 즉시 재수집한다.
 * pollStorageOnce 를 재사용해 폴러의 재진입 가드·병렬 3개 제한을 그대로 탄다(부하 평탄화).
 * 엣지 위임 장비는 원격에서 강제할 수 없어 수를 세어 '다음 주기 반영'으로 안내만 한다(정직).
 */
api.post('/tools/storage/collect-all', adminOnly, async (req, res) => {
  try {
    const all = listDevices().filter((d) => d.enabled !== false);
    const edge = all.filter((d) => (d.agent || '').trim()).length;
    const central = all.length - edge;
    const result = await pollStorageOnce(); // { ok, fail } 또는 { skipped:true }(이미 진행 중)
    logAudit({ user: req.user?.username, action: '스토리지 전체 새로고침',
      detail: `중앙 ${central}대 재수집(${result.skipped ? '이미 진행중' : `성공 ${result.ok}·실패 ${result.fail}`})·엣지 ${edge}대 다음주기` });
    res.json({ ok: true, central, edge, result });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});

/**
 * 지금 수집(연결 테스트 겸) — 중앙 수집 장비는 즉시, 엣지 위임 장비는 **재수집 요청 등록**.
 * v2.316(사용자 버그 신고): 과거엔 엣지 장비에 안내 메시지만 반환하고 아무것도 하지 않았다 —
 * collectRequests 큐에 요청을 남기면 엣지가 다음 config pull(≤5분) 때 즉시 수집 + 즉시 push 한다.
 */
api.post('/tools/storage/devices/:id/collect', adminOnly, async (req, res) => {
  try {
    const dev = listDevices().find((d) => d.id === req.params.id);
    if (!dev) return res.status(404).json({ ok: false, reason: '장비를 찾을 수 없습니다.' });
    if ((dev.agent || '').trim()) {
      const dup = hasPendingRequest(dev.id);
      requestCollect(dev.id, dev.agent);
      logAudit({ user: req.user?.username, action: '스토리지 재수집 요청(엣지)', target: `${dev.name}(${dev.id})`, detail: `엣지 ${dev.agent}` });
      return res.status(202).json({ ok: true, requested: true,
        reason: dup
          ? `이미 재수집 요청이 대기 중입니다 — 엣지 '${dev.agent}' 의 다음 pull(≤5분) 시 즉시 수집·push 됩니다.`
          : `재수집 요청 등록 — 엣지 '${dev.agent}' 가 다음 pull(≤5분) 시 즉시 수집하고 바로 push 합니다.` });
    }
    await collectDeviceNow(req.params.id);
    logAudit({ user: req.user?.username, action: '스토리지 즉시 수집', target: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ ok: false, reason: e.message }); }
});


/* ── CSV 일괄 관리(v2.313, 사용자 요구) — 내보내기·샘플·가져오기. 전부 adminOnly(장비 구성). ── */

const dcNameMap = () => { try { const m = new Map(listDatacenters().map((x) => [x.id, x.name || x.id])); return (id) => m.get(id) || id || ''; } catch { return (id) => id || ''; } };

/**
 * 현재 등록 장비를 CSV 로 내보내기. 기본은 비밀번호 제외(listDevices 계약).
 * ?passwords=1(v2.317, 사용자 요구 '포함 여부 선택'): 평문 비밀번호 포함 — 자격증명 일괄
 * 덤프이므로 **requireSettingsOwner**(백업 라우트와 동일 게이트 — server/CLAUDE.md 규칙)를
 * 추가로 통과해야 하고 감사로그를 남긴다. admin 이어도 소유자가 아니면 403.
 */
api.get('/tools/storage/devices/export.csv', adminOnly, (req, res) => {
  const withPw = String(req.query.passwords || '') === '1';
  const send = () => {
    const devices = withPw ? listDevicesWithSecrets() : listDevices();
    const csv = devicesToCsv(devices, dcNameMap(), { includePasswords: withPw });
    logAudit({ user: req.user?.username, action: withPw ? '스토리지 CSV 내보내기(비밀번호 포함)' : '스토리지 CSV 내보내기', detail: `${devices.length}대` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="storage-devices${withPw ? '-with-passwords' : ''}.csv"`);
    res.send(csv);
  };
  if (withPw) return requireSettingsOwner(req, res, send);
  send();
});

/** 샘플 CSV 템플릿 다운로드 — 헤더 + 컬럼 설명 주석 + 예시 2행. */
api.get('/tools/storage/devices/sample.csv', adminOnly, (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="storage-devices-sample.csv"');
  res.send(sampleCsv());
});

/**
 * CSV 일괄 가져오기 — body.csv 텍스트를 파싱해 행마다 saveDevice.
 * (host+type) 동일 장비는 수정(update), 없으면 추가. datacenter 는 이름/ID 모두 해석.
 * 행별 성공/실패를 정직하게 반환(부분 성공 허용 — 한 행 오류가 전체를 막지 않음).
 *
 * body.dryRun=true(v2.317, 사용자 요구 '무결성 검사'): **저장하지 않고** 행별 판정만 반환.
 * 검증 규칙은 실제 저장과 동일(registry.deviceInputIssue 단일 소스 — analyzeImport 주석) +
 * 파일 내 중복(host+type) 검출. UI 는 검증 통과 후에만 실행 버튼을 활성화한다.
 */
api.post('/tools/storage/devices/import', adminOnly, (req, res) => {
  const { rows, error } = parseDevicesCsv(String(req.body?.csv || ''));
  if (error) return res.status(400).json({ ok: false, reason: error });
  if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 행이 없습니다.' });

  // datacenter 이름/ID → ID 해석 준비(이름 매칭은 대소문자 무시).
  let dcs = [];
  try { dcs = listDatacenters(); } catch { /* 목록 실패 시 원문 그대로 저장 */ }
  const resolveDc = (v) => {
    const s = String(v || '').trim();
    if (!s) return '';
    if (dcs.some((d) => d.id === s)) return s;
    const byName = dcs.find((d) => String(d.name || '').toLowerCase() === s.toLowerCase());
    return byName ? byName.id : s; // 못 찾으면 원문 유지(유효 ID 일 수 있음)
  };
  // (host+type) → 기존 장비 id 맵(멱등 update). 구분자 '|' — host 정규식(RE_HOST)이 배제하는
  // 문자라 host/type 경계가 모호해지지 않는다(과거 NUL 구분자는 소스 NUL 금지 규칙 위반).
  const key = (h, t) => `${h}|${t}`;
  const existing = new Map(listDevices().map((d) => [key(d.host, d.type), d.id]));

  // 무결성 분석(드라이런·실제 가져오기 공용) — 실제 저장과 같은 검증 규칙을 탄다.
  const { report, summary } = analyzeImport(rows, {
    existingKey: (h, t) => existing.get(key(h, t)),
    resolveDc,
    validate: deviceInputIssue,
  });
  if (req.body?.dryRun) {
    return res.json({ ok: true, dryRun: true, report, summary, total: rows.length });
  }

  let added = 0, updated = 0; const failed = [];

  const verdictByLine = new Map(report.map((r) => [r.line, r])); // O(rows²) find → O(rows) (v2.342 성능)
  for (const row of rows) {
    const verdict = verdictByLine.get(row._line);
    if (verdict?.action === 'error') { failed.push({ line: verdict.line, name: verdict.name, reason: verdict.reason }); continue; }
    const id = existing.get(key(row.host, row.type));
    const input = {
      id, type: row.type, name: row.name, host: row.host, username: row.username,
      collectMethod: row.collectMethod, sshPort: row.sshPort, datacenterId: resolveDc(row.datacenter),
      agent: row.agent, enabled: row.enabled, note: row.note,
    };
    if (row._hasPassword) input.password = row.password; // 비우면 기존 유지(saveDevice 규칙)
    try {
      saveDevice(input);
      if (id) updated++; else added++;
    } catch (e) { failed.push({ line: row._line, name: row.name || row.host, reason: e.message }); }
  }
  logAudit({ user: req.user?.username, action: '스토리지 장비 CSV 가져오기', detail: `추가 ${added}·수정 ${updated}·실패 ${failed.length}` });
  res.json({ ok: true, added, updated, failed, total: rows.length });
});

/** 영역별 수집 현황 + 원문(이 노드 DB — 중앙 수집 장비 전용. 엣지 장비 원문은 엣지 DB 에 있음). */
api.get('/tools/storage/devices/:id/areas', adminOnly, async (req, res) => {
  res.json({ db: await dbAvailable(), labels: AREA_LABEL, rows: await areaSummary(req.params.id) });
});

/** 영역 원문 JSON 1건 — ?endpoint= (DB api_latest 최신본, 512KB 절단 표기). */
api.get('/tools/storage/devices/:id/areas/json', adminOnly, async (req, res) => {
  const row = await areaJson(req.params.id, String(req.query.endpoint || ''));
  if (!row) return res.status(404).json({ ok: false, reason: '해당 엔드포인트의 저장된 원문이 없습니다(엣지 수집 장비면 원문은 엣지 DB 에 있습니다).' });
  res.json({ ok: true, ...row });
});

/**
 * 용량 시계열(추이) — ?days=N (기본 30, 1~400).
 * v2.318(추이 그래프): 7일 초과 구간은 ~800점 목표로 시간 버킷 평균 다운샘플 — raw 는
 * LIMIT 5000 에 앞부분만 잘려 장기 구간에서 최근 데이터가 안 보였다(db.js selCapBucket 주석).
 */

/**
 * 추이 기간 프리셋(v2.380) — 12시간·24시간·1주를 사용자 요구로 추가.
 * 기존 days 파라미터도 계속 받는다(하위호환: 링크·북마크가 깨지지 않게).
 *  - 24시간 이하: 원본(raw) 조회 — 10분 수집 주기라 12h=72점·24h=144점으로 충분히 가볍다.
 *  - 1주 이상: 버킷 평균으로 ~800점 목표 다운샘플(raw 는 LIMIT 5000 에 앞부분만 남아
 *    장기 구간에서 최근이 잘려 나갔다 — db.js selCapBucket 주석 참조).
 */
const USAGE_RANGES = {
  '12h': { spanMs: 12 * 3_600_000, bucketMs: 0 },
  '24h': { spanMs: 24 * 3_600_000, bucketMs: 0 },
  '7d': { spanMs: 7 * 86_400_000, bucketMs: 3_600_000 },
  '30d': { spanMs: 30 * 86_400_000, bucketMs: 6 * 3_600_000 },
  '90d': { spanMs: 90 * 86_400_000, bucketMs: 12 * 3_600_000 },
  '400d': { spanMs: 400 * 86_400_000, bucketMs: 86_400_000 },
};
function usageRange(query = {}) {
  const key = String(query.range || '');
  if (USAGE_RANGES[key]) return { range: key, ...USAGE_RANGES[key] };
  // 하위호환: ?days=N (1~400). 기존 규칙(7일 초과면 ~800점 버킷)을 유지한다.
  const days = Math.max(1, Math.min(400, Number(query.days) || 30));
  return { range: `${days}d`, spanMs: days * 86400e3, bucketMs: days <= 7 ? 0 : Math.ceil((days * 86400e3) / 800) };
}

api.get('/tools/storage/devices/:id/history', fullScopeOnly, async (req, res) => {
  const { spanMs, bucketMs, range } = usageRange(req.query);
  res.json({ db: await dbAvailable(), range, spanMs, bucketMs, points: await capacityHistory(req.params.id, Date.now() - spanMs, bucketMs) });
});

/**
 * 전체 장비 합산 용량 추이(v2.380) — 목록 화면의 통합 추이 탭.
 * 장비별 수집 시각이 달라 항상 버킷 평균 후 장비 합산으로 계산한다(db.capacityHistoryAll).
 * 각 점의 devices(그 버킷에 데이터가 있던 장비 수)를 함께 반환해, 일부 장비만 수집된 구간을
 * '전체 용량 급감' 으로 오독하지 않게 화면이 표시한다.
 */
api.get('/tools/storage/history', fullScopeOnly, async (req, res) => {
  const { spanMs, bucketMs, range } = usageRange(req.query);
  // 전체 합산은 버킷이 필수 — 12시간 구간이라도 10분 버킷으로 시각을 정렬한다.
  const b = bucketMs || 600_000;
  res.json({ db: await dbAvailable(), range, spanMs, bucketMs: b, points: await capacityHistoryAll(Date.now() - spanMs, b) });
});
}
