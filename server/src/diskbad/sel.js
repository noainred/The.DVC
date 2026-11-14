/**
 * diskbad/sel.js — iDRAC 시스템 이벤트 로그(SEL)에서 **디스크 항목만** 읽는다(과거 기록 읽기 1단계 — README §22).
 *
 * 왜: Lifecycle 로그가 로그인 기록으로 며칠치만 남아도, SEL 은 하드웨어 이벤트만 따로 쌓는 로그라 더 오래 남을 수 있다(추정 — 서버마다
 *   다르다. 화면이 '본 기간' 을 서버마다 밝힌다). 디스크 탈거 · 장착 · 고장 · 고장 예측이 언제였는지를 준다.
 *   배드 섹터 기록 자체가 SEL 에 오는지는 확인하지 못했다 — 그래서 SEL 은 **교체 판정의 보조 근거**로만 쓴다(verdict.js).
 *
 * 규칙:
 *  · GET 만. `$skip` 으로 쪽을 넘긴다(lclog.js 와 같은 방식). 쪽 수 · 시간에 상한이 있고, 장비가 `$skip` 을 무시하면 멈춘다.
 *  · 남기는 것은 디스크 항목뿐이다(센서 종류가 Drive/Disk 이거나, 문장이 drive/disk 와 bay/backplane/slot 을 함께 말할 때).
 *  · 위치는 문장의 'Drive N … bay B' 를 읽는다 — Dell SEL 문장 꼴은 기억 기준이고 실장비 대조 전이다. 이 번호가 Lifecycle 로그의
 *    'Disk N in Backplane B' 와 같은 자리라는 것도 **추정**이다(verdict.js 가 근거 문장에 그렇게 밝힌다).
 *  · 문장은 길이를 먼저 자르고 앵커 없는 무제한 반복을 쓰지 않는다(루트 CLAUDE.md 정규식 규칙).
 */
import { redfishGetCapped } from '../idrac/redfish.js';
import { numOrNull } from '../util/numOrNull.js';
import { slotKeyOf } from './classify.js';

export const SEL_PAGES_MAX = 40;        // 50건 × 40쪽 = 2,000건(SEL 은 작다 — 넘으면 일부만 읽음으로 남긴다)
export const SEL_EVENTS_MAX = 100;      // 결과에 싣는 디스크 항목 수(가장 새 것부터)
export const SEL_KINDS = Object.freeze(['removed', 'installed', 'fault', 'predictive', 'other']);
const MSG_MAX = 300;
const PAGE_MAX = 2_000;
const t = (v, n) => String(v ?? '').slice(0, n);

const SENSOR_RE = /drive|disk/i;
const WORD_RE = /\b(?:drive|disk)\b/i;
const WHERE_RE = /\b(?:bay|backplane|slot)\b/i;
// 'Drive 2 is removed from disk drive bay 1.' · 'Fault detected on drive 2 in disk drive bay 1.' — 사이 60자로 묶는다(선형).
const POS_RE = /\bdrive\s+(\d{1,3})\b[^.]{0,60}?\bbay\s+(\d{1,3})\b/i;

/**
 * SEL 항목 하나 → 디스크 항목(순수). 디스크 항목이 아니면 null.
 * @returns {null|{created:number|null, kind:string, disk:number|null, bp:number|null, slotKey:string, messageId:string, message:string, severity:string, sensor:string}}
 */
export function selDriveEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const message = t(e.Message, MSG_MAX);
  const sensor = t(e.SensorType, 40);
  const isDrive = SENSOR_RE.test(sensor) || (WORD_RE.test(message) && WHERE_RE.test(message));
  if (!isDrive) return null;
  let kind = 'other';
  if (/\bremoved\b/i.test(message)) kind = 'removed';
  else if (/\b(?:installed|inserted)\b/i.test(message)) kind = 'installed';
  else if (/\bpredictive\b/i.test(message)) kind = 'predictive';
  else if (/\bfault|\bfail/i.test(message)) kind = 'fault';
  const m = POS_RE.exec(message);
  const disk = m ? Number(m[1]) : null;
  const bp = m ? Number(m[2]) : null;
  const created = Date.parse(t(e.Created, 40));
  return {
    created: Number.isFinite(created) ? created : null, kind, disk, bp,
    slotKey: m ? slotKeyOf({ disk, bp }) : '',
    messageId: t(e.MessageId, 64), message, severity: t(e.Severity, 16), sensor,
  };
}

/**
 * 서버 한 대의 SEL. 401 은 던진다(호출자가 인증 정지로).
 * @param {object} entry 등록부 항목
 * @param {{mgr:string, signal?:AbortSignal|null, getJson?:Function, now?:Function, budgetMs?:number}} o  mgr = Lifecycle 로그를 읽은 관리자 경로(lclog.js 가 검사한 값)
 * @returns {Promise<{at:number, status:string, read:number, total:number|null, pages:number, stopped:string, oldest:number|null, newest:number|null, kinds:object, events:Array}>}
 *   status: ok · empty(항목 없음) · absent(404 — SEL 경로 없음) · forbidden · error
 */
export async function readSel(entry, { mgr, signal = null, getJson = redfishGetCapped, now = Date.now, budgetMs = 60_000 } = {}) {
  const t0 = now();
  const out = { at: t0, status: 'ok', read: 0, total: null, pages: 0, stopped: '', oldest: null, newest: null, kinds: {}, events: [] };
  const base = `${mgr}/LogServices/Sel/Entries`;
  const events = [];
  let skip = 0;
  let firstIds = null;
  try {
    while (out.pages < SEL_PAGES_MAX) {
      if (now() - t0 > budgetMs) { out.stopped = 'budget'; break; }
      // eslint-disable-next-line no-await-in-loop
      const j = await getJson(entry, skip ? `${base}?$skip=${skip}` : base, { signal });
      out.pages += 1;
      const mem = Array.isArray(j?.Members) ? j.Members.slice(0, PAGE_MAX) : null;
      if (!mem) { if (out.pages === 1) out.status = 'empty'; break; }
      if (out.pages === 1) {
        const c = numOrNull(j['Members@odata.count']);
        out.total = c != null && c >= 0 && c <= 1_000_000 ? Math.floor(c) : null;
        firstIds = mem.slice(0, 3).map((e) => t(e?.Id, 64)).join('|');
      } else if (mem.length && mem.slice(0, 3).map((e) => t(e?.Id, 64)).join('|') === firstIds) {
        out.stopped = 'skip'; break;      // 장비가 $skip 을 무시하고 첫 쪽을 다시 줬다
      }
      for (const e of mem) {
        out.read += 1;
        const c = Date.parse(t(e?.Created, 40));
        if (Number.isFinite(c)) {
          if (out.oldest == null || c < out.oldest) out.oldest = c;
          if (out.newest == null || c > out.newest) out.newest = c;
        }
        const ev = selDriveEvent(e);
        if (ev) { events.push(ev); out.kinds[ev.kind] = (out.kinds[ev.kind] || 0) + 1; }
      }
      skip += mem.length;
      const hasNext = typeof j['Members@odata.nextLink'] === 'string';
      if (!mem.length) { if (out.total != null && skip < out.total) out.stopped = 'short'; break; }
      if (!hasNext && (out.total == null || skip >= out.total)) break;
      if (out.pages >= SEL_PAGES_MAX) out.stopped = 'max';
    }
  } catch (e) {
    if (e?.status === 401 || e?.authFailed === true) throw e;
    if (out.pages <= 1 && !out.read) {
      out.status = e?.status === 404 ? 'absent' : (e?.status === 403 ? 'forbidden' : 'error');
      return out;
    }
    out.stopped = out.stopped || 'error';   // 읽은 데까지는 남긴다
  }
  if (out.status === 'ok' && !out.read) out.status = 'empty';
  out.events = events.sort((a, b) => (b.created ?? -Infinity) - (a.created ?? -Infinity)).slice(0, SEL_EVENTS_MAX);
  return out;
}
