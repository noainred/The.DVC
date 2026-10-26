/**
 * storage/usageData.js — 스토리지 사용량 보고표의 **조회**(v2.788). 화면 라우트(`/tools/storage-usage`)와 예약 메일(`usageMail.js`)이
 * 이 함수 하나를 쓴다 — 두 벌이면 메일의 숫자와 화면의 숫자가 갈라진다. 판정·계산은 `usageReport.js`(순수)가 한다.
 *
 * ⚠ 장비 왕복 0 — 일 롤업(capacity_daily·resource_daily)과 최신 스냅샷만 읽는다. 그래도 장비 × 기간의 행을 읽으므로
 *   화면은 폴링하지 않는다(마운트 1회 + 버튼 — 증가량 화면 v2.531 과 같은 판단).
 * ⚠ 등록부를 읽지 못했으면 빈 표를 만들지 않는다(`registryUnreadable` — 호출부가 503·메일 생략으로 밝힌다).
 * ⚠ 관리자가 아니면 관리 주소를 가린다(증가량 라우트 v2.600 AUTHZ-2600-02 와 같은 함수 — 이름이 주소와 같으면 이름도).
 */
import { listDevices, registryLoadError } from './registry.js';
import { localSnapshots } from './store.js';
import { edgeStorageSnapshots } from '../central/storageEdge.js';
import { latestMapByDevice } from './latestSnapshots.js';
import { dailySeries, dailySpans, resourceDailyRange, dbAvailable, dayIndex, dayLabel, DAY_OFFSET_MIN } from './db.js';
import { STORAGE_TYPES } from './types.js';
import { listDatacenters } from '../datacenter/store.js';
import { maskDeviceAddress, maskSnapAddress } from '../auth/addressMask.js';
import { GRANS, WEEKDAY_LABELS, normalizeReportQuery, buildPeriods, buildUsageReport } from './usageReport.js';
import { RESOURCE_KINDS } from './resources.js';

/**
 * @param {{gran?:string, count?:number, weekday?:number, admin?:boolean, now?:number}} q
 * @returns {Promise<{ok:false, registryError:object}|{ok:true, [k:string]:any}>}
 */
export async function loadUsageReport({ gran, count, weekday, admin = false, now = Date.now() } = {}) {
  const regErr = registryLoadError();
  if (regErr) return { ok: false, registryError: regErr };
  const q = normalizeReportQuery({ gran, count, weekday });
  const asOfDay = dayIndex(now);
  const periods = buildPeriods({ ...q, asOfDay });
  const fromDay = periods[0]?.fromDay ?? asOfDay;
  const toDay = periods[periods.length - 1]?.toDay ?? asOfDay;

  const raw = listDevices();
  const hostById = new Map(raw.map((d) => [d.id, d.host || '']));
  const shown = admin ? raw : raw.map(maskDeviceAddress);
  const snaps = latestMapByDevice([localSnapshots(), edgeStorageSnapshots()]);
  const extraById = new Map();
  const devices = shown.map((d) => {
    const s = snaps.get(d.id);
    let name = d.name || d.id;
    // 장비가 보고한 이름이 있으면 그것(증가량·모니터링 화면과 같은 순서). 그 이름도 주소와 같으면 가린다.
    if (s?.name) name = (admin ? s.name : maskSnapAddress({ deviceId: d.id, type: s.type, name: s.name }, hostById.get(d.id)).name) || name;
    // 하위 항목 수집 표지 + 최신 스냅샷의 수집 성패 — 화면이 '표지가 없다' 의 이유를 단정하지 않게(실패한 수집은 표지를 싣지 않는다).
    if (s) extraById.set(d.id, { resourcesProbe: s.extra?.resourcesProbe || null, resourcesDropped: s.extra?.resourcesDropped || 0, snapOk: !!s.ok });
    return { id: d.id, name, type: d.type, datacenterId: d.datacenterId || '', enabled: d.enabled !== false };
  });
  const ids = devices.map((d) => d.id);
  const want = new Set(ids);
  const rows = (await dailySeries(null, fromDay)).filter((r) => want.has(r.device_id) && r.day <= toDay);
  const resRows = await resourceDailyRange(fromDay, toDay, { deviceIds: ids });
  const spans = await dailySpans();
  const report = buildUsageReport({ rows, resRows, periods, devices, spans, extraById });
  return {
    ok: true,
    db: await dbAvailable(),
    ...q,
    asOfDay, asOfLabel: dayLabel(asOfDay), dayOffsetMin: DAY_OFFSET_MIN,
    periods, devices: report,
    // 화면은 여기 값만 쓴다(단위별 기간 수·요일 이름·하위 항목 구분을 문구에 박지 않는다).
    grans: GRANS, weekdayLabels: WEEKDAY_LABELS, resourceKinds: RESOURCE_KINDS,
    types: STORAGE_TYPES.map((t) => ({ type: t.type, label: t.label })),
    datacenters: (() => { try { return listDatacenters(); } catch { return []; } })(),
    ...(admin ? {} : { addressHidden: true }),
  };
}
