/**
 * bareos/groupSchedule.js — Bareos 백업 그룹 스케줄의 **판정 하나**(v2.830 · 사용자 결정 '포탈이 실행').
 *
 * 왜 포탈이 실행하나: Bareos 에는 이미 만든 잡의 Schedule 을 바꾸는 콘솔 명령이 없다(`configure add` 만 — 라우트 PATCH 가 거부하는 이유).
 *   그룹의 이름·스케줄·스토리지를 나중에 고칠 수 있게 하려고 그룹 잡은 Director 스케줄 없이 만들고, 시각이 되면 포탈이 `run` 을 보낸다
 *   (스토리지·풀은 `run … storage= pool=` 로 그때 지정). 대가: 포탈이 꺼져 있던 회차는 놓친다 — 다시 켜지면 CATCHUP_MS 안의 마지막 회차를 한 번만 돌린다.
 *
 * 시각은 **포탈 서버의 현지 시각**이다(Date 의 지역 시각 메서드 — 한국 설치는 KST). Director 현지 시각이 아니다(실행을 보내는 쪽이 포탈이다).
 * 순수 함수만 둔다(파일·타이머 없음) — 회차 열쇠(slot key)는 'YYYY-MM-DD HH:MM'(서버 현지) 글자라 같은 회차를 두 번 돌리지 않는 기준이 된다.
 */

export const LEVELS = Object.freeze(['Incremental', 'Differential', 'Full']);
export const DAY_NAMES = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
/** 포탈이 꺼져 있다 켜졌을 때 따라잡는 범위 — 이보다 오래된 회차는 '놓침' 으로 남기고 돌리지 않는다(낮 시간에 갑자기 전체 백업이 돌지 않게). */
export const CATCHUP_MS = 6 * 60 * 60_000;
/** 앞뒤로 찾는 범위 — 요일이 하나뿐이어도 7일 안에 회차가 있다(8일이면 경계도 덮는다). */
const SEARCH_DAYS = 8;

const pad = (n) => String(n).padStart(2, '0');
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const fail = (msg) => Object.assign(new Error(msg), { code: 'invalid' });

/** 요일 목록 정규화 — 0(일)~6(토) 정수만, 중복 제거, 오름차순. */
function dayList(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
}

/**
 * 입력 → 저장 모양. 틀리면 code 'invalid' 오류(사람이 읽는 사유).
 * @param {object} input { enabled, days:number[], time:'HH:MM', level, fullDays:number[] }
 * @returns {{ enabled:boolean, days:number[], time:string, level:string, fullDays:number[] }}
 */
export function normSchedule(input) {
  const s = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const enabled = s.enabled === true;
  const days = dayList(s.days);
  const time = String(s.time ?? '').trim();
  const level = LEVELS.includes(s.level) ? s.level : 'Incremental';
  const fullDays = dayList(s.fullDays).filter((d) => days.includes(d));
  if (!TIME_RE.test(time)) throw fail('실행 시각은 00:00 ~ 23:59 (HH:MM) 로 적으세요.');
  if (enabled && !days.length) throw fail('스케줄을 켜려면 실행할 요일을 하나 이상 고르세요.');
  return { enabled, days, time, level, fullDays: level === 'Full' ? [] : fullDays };
}

/** 그 날(서버 현지)의 회차 시각(ms). */
function slotAt(base, time) {
  const [h, m] = time.split(':').map(Number);
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m, 0, 0).getTime();
}
/** 회차 열쇠 — 서버 현지 'YYYY-MM-DD HH:MM'. */
export function slotKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 그 회차의 레벨 — Full 요일이면 Full, 아니면 스케줄 레벨. */
export function slotLevel(sched, at) {
  return sched.fullDays.includes(new Date(at).getDay()) ? 'Full' : sched.level;
}

/**
 * now 이전(같은 분 포함)의 가장 최근 회차. 없으면 null.
 * @returns {{ at:number, key:string, level:string } | null}
 */
export function lastDueSlot(sched, now) {
  if (!sched?.days?.length || !TIME_RE.test(sched.time || '')) return null;
  const d = new Date(now);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
    if (!sched.days.includes(day.getDay())) continue;
    const at = slotAt(day, sched.time);
    if (at <= now) return { at, key: slotKey(at), level: slotLevel(sched, at) };
  }
  return null;
}

/**
 * now 다음(같은 분 제외)의 회차. 꺼져 있거나 요일이 없으면 null.
 * @returns {{ at:number, key:string, level:string } | null}
 */
export function nextSlot(sched, now) {
  if (!sched?.enabled || !sched.days?.length || !TIME_RE.test(sched.time || '')) return null;
  const d = new Date(now);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    if (!sched.days.includes(day.getDay())) continue;
    const at = slotAt(day, sched.time);
    if (at > now) return { at, key: slotKey(at), level: slotLevel(sched, at) };
  }
  return null;
}

/**
 * 이번 틱에 이 그룹을 돌릴지 — 한 회차는 한 번만(lastKey), 스케줄을 바꾸기 전의 회차는 돌리지 않는다(anchorAt),
 * 따라잡는 범위(catchupMs)를 넘긴 회차는 돌리지 않고 '놓침' 으로 남긴다.
 * @param {{ schedule, lastKey?:string, anchorAt?:number }} g
 * @returns {{ action:'none' } | { action:'fire', slot } | { action:'miss', slot }}
 */
export function decideFire(g, now, catchupMs = CATCHUP_MS) {
  const sched = g?.schedule;
  if (!sched?.enabled) return { action: 'none' };
  const slot = lastDueSlot(sched, now);
  if (!slot) return { action: 'none' };
  // 스케줄을 만들거나 바꾼 시각보다 앞선 회차는 이 스케줄의 회차가 아니다(02:05 에 '02:00' 으로 저장하면 내일부터)
  const anchor = Number.isFinite(g.anchorAt) ? g.anchorAt : 0;
  if (slot.at < anchor) return { action: 'none' };
  // 회차 열쇠는 글자 순서 = 시각 순서('YYYY-MM-DD HH:MM'). 이미 처리한 회차보다 앞선 회차는 보지 않는다
  //   (v2.830 검토 L1 — 재현: 시계가 몇 초 거꾸로 가면 어제 회차가 '놓침' 으로 lastKey 를 덮어 오늘 회차가 다시 나갔다)
  if (g.lastKey && slot.key <= g.lastKey) return { action: 'none' };
  if (now - slot.at > catchupMs) return { action: 'miss', slot };
  return { action: 'fire', slot };
}

/** 사람이 읽는 스케줄 — '월·수·금 02:10 Incremental (Full: 금)' · 꺼짐이면 '스케줄 꺼짐(수동 실행만)'. */
export function scheduleText(sched) {
  if (!sched || !sched.enabled) return '스케줄 꺼짐(수동 실행만)';
  const days = sched.days.length === 7 ? '매일' : sched.days.map((d) => DAY_NAMES[d]).join('·');
  const full = sched.fullDays?.length ? ` (Full: ${sched.fullDays.map((d) => DAY_NAMES[d]).join('·')})` : '';
  return `${days} ${sched.time} ${sched.level}${full}`;
}
