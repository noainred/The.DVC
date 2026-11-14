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
      evidence.push({ text: `그 뒤 ${fmtTime(pulled[0].created)} 에 이 자리의 디스크 빠짐 기록(${pulled[0].code})이 있습니다`, src: 'iDRAC Lifecycle 로그' });
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
    evidence.push({ text: `마지막 기록 뒤 ${fmtTime(removals[0].created)} 에 이 자리의 디스크 빠짐 기록(${removals[0].code})이 있습니다`, src: 'iDRAC Lifecycle 로그' });
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
export function judgeServer({ records = [], drives = null, serialRows = [], coverage = null }) {
  const bySlot = new Map();
  const unplaced = [];
  for (const r of records) {
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
  const slots = [];
  for (const [slotKey, recs] of bySlot) {
    const counted = recs.filter((r) => COUNTED.has(r.cls) || r.cls === CLS.predictive);
    if (!counted.length) continue;
    const drive = driveKnown ? matchDrive(slotKey, drives) : null;
    const v = judgeSlot({ slotKey, records: recs, drive, serials: serialsBySlot.get(slotKey) || [], continuousSince: coverage?.continuousSince ?? null, driveKnown });
    const byCode = {};
    for (const r of counted) byCode[r.code] = (byCode[r.code] || 0) + 1;
    const unrecoverable = counted.filter((r) => r.cls === CLS.unrecoverable).length;
    slots.push({
      ...v, byCode, total: counted.filter((r) => COUNTED.has(r.cls)).length, unrecoverable,
      predictive: counted.filter((r) => r.cls === CLS.predictive).length,
      first: Math.min(...counted.map((r) => r.created)), last: Math.max(...counted.map((r) => r.created)),
      drive: drive ? pickDrive(drive) : null,
    });
  }
  slots.sort((a, b) => b.last - a.last);
  const badSlots = slots.filter((s) => s.total > 0);
  const counts = {
    records: badSlots.reduce((a, s) => a + s.total, 0),
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
  let status = 'unread';
  if (coverage && coverage.lastOkAt) {
    if (counts.records > 0 || unplaced.some((r) => COUNTED.has(r.cls))) status = 'records';
    else if (driveKnown && drives.length && unwatched === drives.length) status = 'unwatched';
    else status = coverage.complete === false ? 'partial' : 'clean';
  }
  return { status, slots, unplaced: unplaced.map((r) => ({ created: r.created, code: r.code, cls: r.cls })), drives: driveKnown ? drives.map(pickDrive) : null, counts, unwatched, alerting };
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
