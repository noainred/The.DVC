/**
 * diskbad/verdict.js — 디스크 자리별 판정(아직 사용 중 / 교체됨 / 판단 불가)과 **근거 목록**을 한 번에 만든다(순수, v3.8.0).
 *
 * 판정 코어는 이것 하나다(루트 CLAUDE.md '판정 코어는 하나'). 화면은 근거를 지어내지 않고 여기서 받은 것을 그린다.
 * 설계: README §8.1 · §17.1(판단 근거) · `Basis.dc.html`.
 *
 * 확신 수준:
 *  · confirmed(확정) — 포탈이 직접 본 값끼리 맞춤(점검 때마다 적어 둔 시리얼).
 *  · estimated(추정) — 로그에 남은 기록으로 미룸(기록 뒤로 그 자리에 디스크 빠짐 기록이 없고, 그 구간 로그를 끊김 없이 봤다).
 *  · none(판단 안 함) — 근거가 모자라 어느 쪽으로도 말하지 않는다. '사용 중' 에도 '교체됨' 에도 넣지 않는다.
 *
 * ⚠ 디스크 삽입 ID 는 문서로 확인하지 못했다(README §12.5) — 그래서 **로그만으로 '교체됨' 을 말하지 않는다**.
 *   교체는 시리얼이 바뀐 것을 본 때만 확정한다. 빠짐(PDR5)만 있으면 '판단 불가'(다시 꽂았는지 바꿨는지 모른다).
 */
import { COUNTED, CLS, labelOfKey, matchDrive, driveSlotOf, slotKeyOf } from './classify.js';
import { redfishPartState } from '../partfault/classify.js';
import { PART_STATE, PART_STATE_LABEL } from '../partfault/types.js';

/**
 * iDRAC 가 **지금** 그 디스크에 대해 알리는 상태(v3.8.2 — 사용자 'iDRAC 정보만 가지고 판단하는 로직에 집중').
 * Lifecycle 로그의 과거 기록과는 별개의 근거다 — 활성 로그가 며칠치뿐이어도 iDRAC 가 지금 경고하는 디스크는 여기서 보인다.
 * 판정은 파트 장애 기능의 코어 하나(`partfault/classify.js redfishPartState` — Health OK/Warning/Critical · 고장 예측은 ok → 주의만 ·
 * 못 읽은 값은 '확인 불가' 이지 정상도 경고도 아니다)를 그대로 쓴다. 경고 · 위험이 아니면 null.
 * ⚠ 이것은 '배드 섹터가 났다' 는 뜻이 아니다 — 화면이 '배드 섹터 기록과 별개' 라고 밝힌다(고장 예측을 배드 섹터 수에 넣지 않는 사용자 결정과 같은 선).
 * @returns {{level:'warn'|'fault', raw:string, predictive:boolean}|null}
 */
export function driveAlert(d) {
  if (!d || typeof d !== 'object') return null;
  const st = redfishPartState({ health: d.health, state: d.state, predictiveFailure: d.predictive === true ? true : (d.predictive === false ? false : null) });
  if (st.state !== PART_STATE.warn && st.state !== PART_STATE.fault) return null;
  return { level: st.state === PART_STATE.fault ? 'fault' : 'warn', raw: String(st.raw || '').slice(0, 60), predictive: d.predictive === true };
}
// 낱말은 파트 장애 화면과 같게(같은 상태를 화면마다 다르게 부르지 않는다).
export const ALERT_LABEL = Object.freeze({ warn: PART_STATE_LABEL[PART_STATE.warn], fault: PART_STATE_LABEL[PART_STATE.fault] });

export const VERDICT = Object.freeze({ inUse: 'inUse', replaced: 'replaced', unknown: 'unknown' });
export const VERDICT_LABEL = Object.freeze({ inUse: '아직 사용 중', replaced: '교체됨', unknown: '판단 불가' });
export const CONFIDENCE = Object.freeze({ confirmed: 'confirmed', estimated: 'estimated', none: 'none' });
export const CONFIDENCE_LABEL = Object.freeze({ confirmed: '확정', estimated: '추정', none: '판단 안 함' });

const fmt = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

/**
 * 한 자리의 판정.
 * @param {object} p
 * @param {string} p.slotKey
 * @param {Array<{created:number, code:string, cls:string}>} p.records  그 자리의 기록(분류된 것 전부 — 세는 것 · 고장 예측 · 빠짐)
 * @param {object|null} p.drive   지금 그 자리의 디스크(최근 인벤토리 — 없으면 null)
 * @param {Array<{serial:string, firstSeen:number, lastSeen:number}>} p.serials  그 자리의 시리얼 이력
 * @param {number|null} p.continuousSince  이 시각 이후 로그를 끊김 없이 봤다(없으면 null)
 * @param {boolean} [p.driveKnown]  인벤토리를 읽었는가(못 읽었으면 '지금 디스크 없음' 을 말하지 않는다)
 */
export function judgeSlot({ slotKey, records = [], drive = null, serials = [], continuousSince = null, driveKnown = true, fmtTime = fmt }) {
  const recs = records.filter((r) => Number.isFinite(r.created)).sort((a, b) => a.created - b.created);
  const counted = recs.filter((r) => COUNTED.has(r.cls) || r.cls === CLS.predictive);
  const evidence = [];
  const out = (verdict, confidence, caveat) => ({ slotKey, label: labelOfKey(slotKey), verdict, confidence, evidence, caveat });
  if (!counted.length) return out(VERDICT.unknown, CONFIDENCE.none, '배드 섹터 기록이 없는 자리입니다.');
  const first = counted[0]; const last = counted[counted.length - 1];
  const ids = [...new Set(counted.map((r) => r.code))].join(' · ');
  evidence.push({ text: `기록 ${counted.length}건(${ids}) — ${fmtTime(first.created)} ~ ${fmtTime(last.created)}`, src: 'iDRAC Lifecycle 로그' });

  if (!drive) {
    if (!driveKnown) return out(VERDICT.unknown, CONFIDENCE.none, '이 서버의 디스크 목록을 읽지 못해 지금 그 자리에 무엇이 있는지 모릅니다.');
    evidence.push({ text: '지금 디스크 목록에서 이 자리에 맞는 디스크를 찾지 못했습니다', src: 'iDRAC 인벤토리' });
    return out(VERDICT.unknown, CONFIDENCE.none, '디스크를 뺐거나, 로그의 위치 표기를 인벤토리와 맞추지 못했을 수 있습니다.');
  }
  const serial = String(drive.serial || '').trim();
  const hist = (serials || []).filter((h) => h && h.serial && Number.isFinite(h.firstSeen)).sort((a, b) => a.firstSeen - b.firstSeen);
  const cur = serial ? hist.find((h) => h.serial === serial) : null;
  const seenTo = (h) => (Number.isFinite(h.lastSeen) ? h.lastSeen : h.firstSeen);
  const removals = recs.filter((r) => r.cls === CLS.removed && r.created > last.created);

  // ① 시리얼로 확정 — 기록 시각에 이미 지금 시리얼을 봤다. 확정은 **마지막으로 본 때까지**다(반증 #17):
  //    그 뒤에 이 자리의 빠짐 기록이 있으면 그 사이에 바꿨을 수 있다 — 판단 불가.
  if (cur && cur.firstSeen <= last.created) {
    const pulled = removals.filter((r) => r.created > seenTo(cur));
    if (pulled.length) {
      evidence.push({ text: `이 자리의 시리얼은 ${fmtTime(cur.firstSeen)} ~ ${fmtTime(seenTo(cur))} 에 ${serial} 였습니다`, src: '포탈이 점검 때마다 적어 둔 시리얼 이력' });
      evidence.push({ text: `그 뒤 ${fmtTime(pulled[0].created)} 에 이 자리의 디스크 빠짐 기록(${pulled[0].code})이 있습니다${pulled[0].posNote || ''}`, src: pulled[0].src || 'iDRAC Lifecycle 로그' });
      return out(VERDICT.unknown, CONFIDENCE.none, '마지막으로 시리얼을 본 뒤에 디스크가 빠졌습니다. 다음 점검의 디스크 목록으로 가립니다.');
    }
    evidence.push({ text: `이 자리의 시리얼은 ${fmtTime(cur.firstSeen)} 부터 ${fmtTime(seenTo(cur))}(마지막 점검)까지 ${serial} 로 같습니다`, src: '포탈이 점검 때마다 적어 둔 시리얼 이력' });
    const before = counted.filter((r) => r.created < cur.firstSeen).length;
    return out(VERDICT.inUse, CONFIDENCE.confirmed,
      before ? `${fmtTime(cur.firstSeen)} 이전 기록 ${before}건은 시리얼 이력이 없던 때라 이 디스크의 것인지 확정하지 못합니다.` : '');
  }
  // ② 시리얼로 확정 — 기록 시각에 **다른 시리얼을 실제로 보고 있었고**(처음 ~ 마지막 관찰 사이) 지금은 바뀌었다.
  //    반증 #6: 처음 본 때만 보면, 이전 디스크의 마지막 관찰과 새 디스크의 첫 관찰 사이에 난 기록(새 디스크가 리빌드 중 낸 오류)을
  //    이전 디스크의 것으로 잘못 확정한다. 지금 시리얼을 못 읽으면 '바뀌었다' 고 말할 수 없다.
  const others = serial ? hist.filter((h) => h.serial !== serial) : [];
  const prev = others.find((h) => h.firstSeen <= last.created && seenTo(h) >= last.created);
  if (prev) {
    evidence.push({ text: `기록 당시(${fmtTime(last.created)}) 이 자리의 시리얼은 ${prev.serial}(${fmtTime(prev.firstSeen)} ~ ${fmtTime(seenTo(prev))} 에 봄), 지금은 ${serial} 입니다`, src: '포탈이 적어 둔 시리얼 이력' });
    return out(VERDICT.replaced, CONFIDENCE.confirmed, '');
  }
  const gapPrev = others.filter((h) => seenTo(h) < last.created).sort((a, b) => seenTo(b) - seenTo(a))[0] || null;
  if (gapPrev && cur && cur.firstSeen > last.created) {
    evidence.push({ text: `마지막 기록(${fmtTime(last.created)})은 이전 디스크 ${gapPrev.serial} 를 마지막으로 본 ${fmtTime(seenTo(gapPrev))} 와 지금 디스크 ${serial} 를 처음 본 ${fmtTime(cur.firstSeen)} 사이에 났습니다`, src: '포탈이 적어 둔 시리얼 이력' });
    return out(VERDICT.unknown, CONFIDENCE.none, '그 사이에 디스크를 바꿨다면 새 디스크(리빌드 중)의 기록일 수도 있습니다. 어느 디스크의 기록인지 정하지 않습니다.');
  }
  // ②-b 기록 **뒤에** 이 자리에서 지금과 다른 시리얼을 봤다(반증 #7) — 기록 뒤 디스크가 적어도 한 번 바뀌었다.
  const after = others.filter((h) => seenTo(h) > last.created).sort((a, b) => seenTo(b) - seenTo(a))[0] || null;
  if (after) {
    evidence.push({ text: `마지막 기록 뒤 ${fmtTime(seenTo(after))} 에 이 자리에서 시리얼 ${after.serial} 를 봤고, 지금은 ${serial} 입니다`, src: '포탈이 적어 둔 시리얼 이력' });
    return out(VERDICT.replaced, CONFIDENCE.estimated, '같은 디스크를 뺐다가 나중에 다시 꽂은 경우가 아니라면 맞습니다. 기록 당시의 시리얼은 모릅니다.');
  }
  // ③ 로그로 추정 — 기록 뒤로 이 자리에 디스크 빠짐 기록이 없고, 그 구간을 끊김 없이 봤다.
  const continuous = Number.isFinite(continuousSince) && continuousSince <= last.created;
  if (removals.length) {
    evidence.push({ text: `마지막 기록 뒤 ${fmtTime(removals[0].created)} 에 이 자리의 디스크 빠짐 기록(${removals[0].code})이 있습니다${removals[0].posNote || ''}`, src: removals[0].src || 'iDRAC Lifecycle 로그' });
    return out(VERDICT.unknown, CONFIDENCE.none, '다시 꽂은 것인지 바꾼 것인지 로그만으로는 알 수 없습니다. 다음 점검부터 시리얼로 가립니다.');
  }
  if (continuous) {
    evidence.push({ text: `마지막 기록 뒤로 이 자리에 디스크 빠짐 기록이 없습니다(${fmtTime(continuousSince)} 이후 로그를 끊김 없이 읽음)`, src: 'iDRAC Lifecycle 로그' });
    if (serial) evidence.push({ text: `지금 시리얼 ${serial} — 기록 당시의 시리얼은 모릅니다`, src: 'iDRAC 인벤토리' });
    return out(VERDICT.inUse, CONFIDENCE.estimated, '디스크를 바꿨는데 그 기록이 로그에 남지 않았다면 틀립니다. 다음 점검부터는 시리얼로 확정합니다.');
  }
  evidence.push({ text: Number.isFinite(continuousSince)
    ? `마지막 기록(${fmtTime(last.created)}) 뒤의 로그는 ${fmtTime(continuousSince)} 부터만 남아 있습니다`
    : '마지막 기록 뒤 구간의 로그를 끊김 없이 읽었는지 모릅니다', src: '로그가 남아 있는 구간' });
  return out(VERDICT.unknown, CONFIDENCE.none, '그 사이에 디스크를 바꿨는지 알 방법이 없습니다. 사용 중에도 교체됨에도 넣지 않고 따로 셉니다.');
}

/**
 * 한 서버의 자리별 판정 + 서버 판정. 기록 · 디스크 · 시리얼 이력은 DB 행 그대로 받는다.
 * @returns {{status:string, slots:Array, unplaced:Array, drives:Array, counts:object}}
 */
export function judgeServer({ records = [], drives = null, serialRows = [], coverage = null, vals = null, sel = null }) {
  const bySlot = new Map();
  const unplaced = [];
  // SEL 의 디스크 빠짐(과거 기록 읽기 1단계)은 Lifecycle 로그의 빠짐(PDR5)과 같은 자리에서 **교체 판정의 근거**로만 쓴다 — 세지 않는다.
  //   장착 · 고장 항목은 판정에 넣지 않는다(전원을 켤 때 장착 항목이 쌓이는지 확인하지 못했다 — 넣으면 기록 뒤 '빠짐' 처럼 판정을 흔든다).
  //   시계가 빠른 장비의 항목(clockAhead — 날짜를 수신 시각으로 잘랐다)은 쓰지 않는다(반증 F3 — 잘린 날짜가 늘 '기록 뒤' 가 되어 확정 판정을 흔들었다).
  const selRemovals = (Array.isArray(sel?.events) ? sel.events : []).filter((e) => e && e.kind === 'removed' && e.slotKey && Number.isFinite(e.created) && e.clockAhead !== true)
    .map((e) => ({ created: e.created, code: 'SEL', cls: CLS.removed, slotKey: e.slotKey, src: 'iDRAC 시스템 이벤트 로그(SEL)', posNote: ' — SEL 문장의 위치 번호를 같은 자리로 본 것입니다(추정)' }));
  for (const r of [...records, ...selRemovals]) {
    if (!r.slotKey) { if (COUNTED.has(r.cls) || r.cls === CLS.predictive) unplaced.push(r); continue; }
    if (!bySlot.has(r.slotKey)) bySlot.set(r.slotKey, []);
    bySlot.get(r.slotKey).push(r);
  }
  const serialsBySlot = new Map();
  for (const s of serialRows || []) {
    if (!serialsBySlot.has(s.slotKey)) serialsBySlot.set(s.slotKey, []);
    serialsBySlot.get(s.slotKey).push(s);
  }
  const driveKnown = Array.isArray(drives);
  const valsBy = valsMap(vals);
  const valsTry = Number.isFinite(vals?.tryAt) ? vals.tryAt : null;
  const slots = [];
  for (const [slotKey, recs] of bySlot) {
    const counted = recs.filter((r) => COUNTED.has(r.cls) || r.cls === CLS.predictive);
    if (!counted.length) continue;
    const drive = driveKnown ? matchDrive(slotKey, drives) : null;
    const v = judgeSlot({ slotKey, records: recs, drive, serials: serialsBySlot.get(slotKey) || [], continuousSince: coverage?.continuousSince ?? null, driveKnown });
    const dv = drive ? valsFor(drive, valsBy, valsTry) : null;
    if (dv && hasCounterVal(dv)) v.evidence.push({ text: `지금 디스크가 적어 둔 누적 값 — ${valsText(dv)}(언제 생겼는지는 말해 주지 않습니다${dv.stale ? ` · ${fmt(dv.readAt)} 에 읽은 지난 값` : ''})`, src: VALS_SRC_LABEL[dv.src] || '디스크 값' });
    const byCode = {};
    for (const r of counted) byCode[r.code] = (byCode[r.code] || 0) + 1;
    const unrecoverable = counted.filter((r) => r.cls === CLS.unrecoverable).length;
    slots.push({
      ...v, byCode, total: counted.filter((r) => COUNTED.has(r.cls)).length, unrecoverable,
      predictive: counted.filter((r) => r.cls === CLS.predictive).length,
      first: Math.min(...counted.map((r) => r.created)), last: Math.max(...counted.map((r) => r.created)),
      drive: drive ? pickDrive(drive) : null, vals: dv ? pickVals(dv) : null,
    });
  }
  slots.sort((a, b) => b.last - a.last);
  const badSlots = slots.filter((s) => s.total > 0);
  const counts = {
    records: badSlots.reduce((a, s) => a + s.total, 0),
    traces: null, valsDisks: null, valsUnknown: null,
    slots: badSlots.length,
    inUse: badSlots.filter((s) => s.verdict === VERDICT.inUse).length,
    replaced: badSlots.filter((s) => s.verdict === VERDICT.replaced).length,
    unknown: badSlots.filter((s) => s.verdict === VERDICT.unknown).length + unplaced.filter((r) => COUNTED.has(r.cls)).length,
    unrecoverable: badSlots.reduce((a, s) => a + s.unrecoverable, 0),
    predictive: slots.reduce((a, s) => a + s.predictive, 0),
  };
  const unwatched = driveKnown ? drives.filter((d) => d && d.inVolume === false).length : 0;
  // iDRAC 가 지금 알리는 디스크(배드 섹터 기록과 별개). 디스크 목록을 못 읽었으면 '없음' 이 아니라 모름(null).
  let alerting = null;
  if (driveKnown) {
    alerting = [];
    const recSlots = new Set(badSlots.map((s) => s.slotKey));
    for (const d of drives) {
      const a = driveAlert(d);
      if (!a) continue;
      const p = pickDrive(d);
      alerting.push({ slotKey: p.slotKey, label: p.slotKey ? labelOfKey(p.slotKey) : (p.name || ''), model: p.model, serial: p.serial, media: p.media,
        level: a.level, levelLabel: ALERT_LABEL[a.level], raw: a.raw, predictive: a.predictive, hasRecords: !!p.slotKey && recSlots.has(p.slotKey) });
    }
    counts.alerting = alerting.length;
  } else counts.alerting = null;
  // 디스크 값(과거 기록 읽기 1단계) — 지금 꽂힌 디스크마다 값과 '흔적' 판정. 로그 기록이 있는 자리는 그 판정을 그대로 두고 값만 붙인다.
  const diskVals = buildDiskVals({ drives: driveKnown ? drives : null, valsBy, valsTry, recSlots: new Set(badSlots.map((s) => s.slotKey)) });
  if (diskVals) {
    // '값을 읽음' 은 재할당 · 보류 · 복구 불가 가운데 하나라도 읽은 디스크(반증 F10 — 가동 시간만은 아니다).
    counts.valsDisks = diskVals.filter((d) => d.valsRead).length;
    counts.valsUnknown = diskVals.length - counts.valsDisks;
    // 하나도 못 읽었으면 흔적 수는 0 이 아니라 모름(반증 F14).
    counts.traces = counts.valsDisks ? diskVals.filter((d) => d.trace === TRACE.trace || d.trace === TRACE.unrecoverable).length : null;
  }
  let status = 'unread';
  if (coverage && coverage.lastOkAt) {
    if (counts.records > 0 || unplaced.some((r) => COUNTED.has(r.cls))) status = 'records';
    else if (driveKnown && drives.length && unwatched === drives.length) status = 'unwatched';
    else status = coverage.complete === false ? 'partial' : 'clean';
  }
  return { status, slots, unplaced: unplaced.map((r) => ({ created: r.created, code: r.code, cls: r.cls })), drives: driveKnown ? drives.map(pickDrive) : null, counts, unwatched, alerting, diskVals };
}

/**
 * 디스크 값 판정(과거 기록 읽기 1단계 — README §22.2). 판정 코어는 이것 하나다(화면은 받은 것을 그린다).
 *  · records       — 그 자리에 Lifecycle 로그 기록이 있다(판정은 자리 표에서).
 *  · unrecoverable — 로그 기록은 없고, 디스크 값에 복구 불가가 1 이상.
 *  · trace         — 로그 기록은 없고, 재할당 · 보류가 1 이상(곧 고장이라는 뜻은 아니다 — 살펴볼 이유).
 *  · none          — 읽은 값이 모두 0(못 읽은 값은 '—' 로 따로 보인다).
 *  · unknown       — 값을 읽지 못했다. **0 이 아니다.**
 * 값은 누적이라 날짜가 없다 — '흔적 있음 · 날짜 모름' 이다.
 */
export const TRACE = Object.freeze({ records: 'records', unrecoverable: 'unrecoverable', trace: 'trace', none: 'none', unknown: 'unknown' });
export const TRACE_LABEL = Object.freeze({ records: '로그 기록 있음', unrecoverable: '복구 불가 흔적 · 날짜 모름', trace: '흔적 있음 · 날짜 모름', none: '흔적 없음', unknown: '값 모름' });
export const VALS_SRC_LABEL = Object.freeze({ telemetry: 'iDRAC 텔레메트리 보고서(StorageDiskSMARTData)', metrics: 'iDRAC 디스크 자원의 누적 오류 값(DriveMetrics)' });
const VAL_KEYS = ['realloc', 'pending', 'uncorrectable'];

export function traceOf(v) {
  if (!v) return TRACE.unknown;
  const read = VAL_KEYS.filter((k) => Number.isFinite(v[k]));
  if (!read.length) return TRACE.unknown;
  if (Number.isFinite(v.uncorrectable) && v.uncorrectable > 0) return TRACE.unrecoverable;
  if (read.some((k) => v[k] > 0)) return TRACE.trace;
  return TRACE.none;
}

export function valsText(v) {
  const f = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
  return `재할당 ${f(v.realloc)} · 보류 ${f(v.pending)} · 복구 불가 ${f(v.uncorrectable)}`;
}

function pickVals(v) {
  return { realloc: v.realloc ?? null, pending: v.pending ?? null, uncorrectable: v.uncorrectable ?? null, powerOnHours: v.powerOnHours ?? null,
    src: v.src || '', firstAt: v.firstAt ?? null, changedAt: v.changedAt ?? null, before: v.before || null, readAt: v.readAt ?? null, stale: v.stale === true };
}
const hasCounterVal = (v) => !!v && VAL_KEYS.some((k) => Number.isFinite(v[k]));

/**
 * 지금 디스크에 쓸 값(반증 F1). Dell Drive Id 는 **자리 이름**이라 값의 시리얼이 지금 디스크의 시리얼과 다르면 다른 디스크의 값이다 — 쓰지 않는다.
 * 시리얼을 한쪽이라도 모르면 **이번 점검에 읽은 값**(같은 점검의 디스크 목록)만 쓴다. 지난 값(readAt < 마지막 시도)에는 stale 을 단다 —
 * 누적 값이라 흔적(0 보다 큼)은 그대로 참이지만 '흔적 없음' 은 그 뒤에 바뀌었을 수 있다(화면이 날짜와 함께 밝힌다).
 */
function valsFor(drive, valsBy, valsTry) {
  const v = valsBy.get(String(drive?.id || '')) || null;
  if (!v) return null;
  const sn = String(drive?.serial || '').trim();
  const vs = String(v.serial || '').trim();
  if (sn && vs && sn !== vs) return null;
  const stale = Number.isFinite(valsTry) && (!Number.isFinite(v.readAt) || v.readAt < valsTry);
  if ((!sn || !vs) && stale) return null;
  return { ...v, stale };
}

/** 값 Id → 값. 저장된 디스크 값(db.js mergeVals 모양)을 받는다. */
function valsMap(vals) {
  const m = new Map();
  for (const d of (vals && Array.isArray(vals.drives) ? vals.drives : [])) if (d && d.id) m.set(String(d.id), d);
  return m;
}

/**
 * 디스크마다 한 줄. 디스크 목록을 읽었으면 그 목록 기준(값이 없는 디스크는 '값 모름'), 못 읽었으면 값이 온 디스크만.
 * 둘 다 없으면 null(모름).
 */
function buildDiskVals({ drives, valsBy, valsTry, recSlots }) {
  if (Array.isArray(drives)) {
    return drives.map((d) => {
      const p = pickDrive(d);
      const v = valsFor(d, valsBy, valsTry);
      const trace = p.slotKey && recSlots.has(p.slotKey) ? TRACE.records : traceOf(v);
      return { id: String(d.id || ''), slotKey: p.slotKey, label: p.slotKey ? labelOfKey(p.slotKey) : (p.name || '위치 모름'), model: p.model, serial: p.serial, media: p.media,
        health: p.health, inVolume: p.inVolume, vals: v ? pickVals(v) : null, valsRead: hasCounterVal(v), trace, traceLabel: TRACE_LABEL[trace] };
    });
  }
  // 디스크 목록을 못 읽었으면 **이번 점검에 읽은 값만**(어느 디스크 것인지 시리얼로 대조할 수 없다 — 지난 값은 그 사이에 바뀐 디스크의 것일 수 있다).
  const fresh = [...valsBy.values()].map((v) => valsFor({ id: v.id }, valsBy, valsTry)).filter(Boolean);
  if (!fresh.length) return null;
  return fresh.map((v) => {
    const sl = driveSlotOf({ id: v.id });
    const slotKey = sl ? slotKeyOf(sl) : '';
    const trace = slotKey && recSlots.has(slotKey) ? TRACE.records : traceOf(v);
    return { id: String(v.id), slotKey, label: slotKey ? labelOfKey(slotKey) : String(v.id).slice(0, 60), model: '', serial: '', media: '', health: '', inVolume: null,
      vals: pickVals(v), valsRead: hasCounterVal(v), trace, traceLabel: TRACE_LABEL[trace] };
  });
}

function pickDrive(d) {
  const s = driveSlotOf(d);
  return {
    slotKey: s ? slotKeyOf(s) : '', name: d.name || '', model: d.model || '', serial: d.serial || '', capacityGB: Number.isFinite(d.capacityGB) ? d.capacityGB : null,
    media: d.media || '', health: d.health || '', predictive: d.predictive === true ? true : (d.predictive === false ? false : null),
    inVolume: d.inVolume === true ? true : (d.inVolume === false ? false : null),
  };
}

export const SERVER_STATUS_LABEL = Object.freeze({
  records: '배드 섹터 기록 있음', clean: '남은 로그에 기록 없음', partial: '일부만 읽음 — 읽은 구간에 기록 없음',
  unwatched: '이 방법으로 볼 수 없음', unread: '아직 읽지 못함',
});
