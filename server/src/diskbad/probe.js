/**
 * diskbad/probe.js — **실장비가 실제로 무엇을 주는지** 읽기 전용으로 확인한다(v3.8.2).
 *
 * 왜: 이 기능은 실장비 대조 없이 만들었고(설계 README §14.1 — 사용자 선택 '보수적으로'), 첫 실사용에서 가정이 깨졌다 —
 * iDRAC 가 Redfish 로 주는 Lifecycle 로그는 활성분뿐이고 한 서버는 하루치(3,853건)였다. 다음 수정(걸러 읽기 · 보관 로그 내보내기 ·
 * 디스크 누적 값)을 **추측이 아니라 그 장비의 답**으로 정하려고, 서버 한 대를 화면에서 직접 점검할 때(manual)만 아래를 묻는다.
 *
 * 규칙:
 *  · 전부 GET 이다(장비 상태를 바꾸지 않는다 — 내보내기 같은 동작은 **있는지만** 보고 부르지 않는다).
 *  · 단계마다 따로 잡는다 — 하나가 실패해도 나머지는 답한다. 실패는 상태 코드만 남긴다(본문 · 자격증명 없음).
 *  · 싣는 값은 펌웨어 판 · 모델 · 건수 · 기록 ID · 속성 **이름** 과, 이름이 정해진 꼴(LCLog · Aggregat · error · media · smart …)인 값뿐이다.
 *    iDRAC 속성 전체(계정 이름 · SNMP 커뮤니티가 들어 있다)는 엣지 밖으로 내보내지 않는다.
 *  · 중앙은 받은 것을 다시 자른다(ingest.js cleanProbe — 깊이 · 개수 · 길이 상한). 화면은 관리자 판본에만 보인다(라우트).
 */
import { redfishGetCapped } from '../idrac/redfish.js';
import { numOrNull } from '../util/numOrNull.js';
import { codeOf } from './classify.js';
import { orderOf, entryRow, safeMgrPath } from './lclog.js';

export const PROBE_VERSION = 1;
const t = (v, n = 120) => String(v ?? '').slice(0, n);
// 실패는 상태 코드만 남긴다. 상태 코드가 없는 오류(연결 · 시한 · JSON 아님)는 문구를 싣지 않고 종류만(본문 조각 · 리다이렉트 호스트가 실리지 않게 — 반증 3.8.2 #10).
const errOf = (e) => (Number.isFinite(e?.status) ? `HTTP ${e.status}` : (/시한|timeout|abort/i.test(String(e?.message || '').slice(0, 200)) ? '시한 초과' : '요청 실패'));
const isAuthErr = (e) => e?.authFailed === true || e?.status === 401;
/** 장비가 준 경로는 이 꼴일 때만 따라간다 — 같은 호스트의 /redfish/v1/ 아래 · 길이 상한 · `..` · `//` · 쿼리 없음. */
const SAFE_PATH_RE = /^\/redfish\/v1\/[A-Za-z0-9._:\/-]{1,280}$/;
const safePath = (v) => (typeof v === 'string' && v.length <= 300 && SAFE_PATH_RE.test(v) && !v.includes('..') && !v.includes('//') ? v : '');
const SAFE_ID_RE = /^[A-Za-z0-9.]{1,64}$/;
const ATTR_RE = /lclog|aggregat/i;
const PICK_RE = /error|media|predict|fail|smart|life|realloc|block|wear|endur|remain|spare|hours/i;
const LINK_RE = /smart|metric|sensor/i;

const members = (j) => (Array.isArray(j?.Members) ? j.Members : []);
const pageFacts = (j) => {
  const rows = members(j).map(entryRow).filter(Boolean);
  const count = numOrNull(j?.['Members@odata.count']);   // 못 읽은 건수는 0 이 아니다
  return { rows, n: rows.length, count: count != null && count >= 0 ? count : null, next: typeof j?.['Members@odata.nextLink'] === 'string' };
};
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** 값 하나를 보일 꼴로(숫자 · 불리언 · 짧은 글자만). */
const numBool = (v) => (typeof v === 'boolean' ? v : (typeof v === 'number' && Number.isFinite(v) ? v : undefined));
const scalar = (v) => (typeof v === 'number' || typeof v === 'boolean' ? v : (typeof v === 'string' ? t(v, 60) : (v === null ? null : undefined)));

/** 객체에서 이름이 PICK_RE 에 맞는 값만(얕게). */
function picks(obj, max = 24) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj || {})) {
    if (n >= max) break;
    if (!PICK_RE.test(k)) continue;
    const s = scalar(v);
    if (s !== undefined) { out[t(k, 48)] = s; n += 1; }
  }
  return out;
}

/** 응답 안의 '@odata.id' 가운데 SMART · 지표 쪽 링크(깊이 4까지). */
function links(obj, max = 8) {
  const out = [];
  const walk = (v, d) => {
    if (out.length >= max || d > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 40)) walk(x, d + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if (k === '@odata.id' && typeof x === 'string' && LINK_RE.test(x) && !out.includes(x)) out.push(t(x, 200));
      else if (x && typeof x === 'object') walk(x, d + 1);
    }
  };
  walk(obj, 0);
  return out;
}

/**
 * @param {{host:string, username:string, password:string}} entry
 * @param {{signal?:AbortSignal|null, getJson?:Function, now?:Function}} [o]
 * @returns {Promise<object>} 단계별 답(실패한 단계는 `{ error }`)
 */
export async function probeIdrac(entry, { signal = null, getJson = redfishGetCapped, now = Date.now } = {}) {
  const G = (p) => getJson(entry, p, { signal });
  const out = { v: PROBE_VERSION, at: now() };
  // 인증이 거부되면(401) **남은 단계를 묻지 않는다** — 단계마다 다시 로그인하면 계정 잠금 · IP 차단으로 이어진다(반증 3.8.2 #5 · 자동 재시도 금지).
  let authDenied = false;
  const step = async (key, fn) => {
    if (authDenied) { out[key] = { skipped: '인증 거부 뒤 건너뜀' }; return; }
    try { out[key] = await fn(); } catch (e) {
      out[key] = { error: errOf(e) };
      if (isAuthErr(e)) { authDenied = true; out.authDenied = true; }
    }
  };
  const firstOk = async (paths) => {
    let last = null;
    for (const p of paths) {
      try { return { path: p, json: await G(p) }; } catch (e) { last = e; if (e?.status !== 404) throw e; }
    }
    throw last || new Error('경로 없음');
  };

  let mgr = safeMgrPath(null);
  await step('manager', async () => {
    const list = await G('/redfish/v1/Managers');
    mgr = safeMgrPath(members(list)[0]?.['@odata.id']);
    const m = await G(mgr);
    return { firmware: t(m?.FirmwareVersion, 40), model: t(m?.Model, 60) };
  });

  // ── Lifecycle 로그 첫 쪽: 쪽 크기 · 건수 · 다음 쪽 링크 · 순서 · 시각 범위 · 기록 ID 꼴 ──
  let base = `${mgr}/LogServices/Lclog/Entries`;
  let sample = '';
  let lclogCount = null;
  let lclogPage = 0;
  await step('lclog', async () => {
    const r = await firstOk([base, `${mgr}/Logs/Lclog`]);
    base = r.path;
    const f = pageFacts(r.json);
    const ts = f.rows.map((x) => x.created).filter(Number.isFinite);
    const byCode = {};
    for (const x of f.rows) { const c = codeOf(x.messageId) || '(ID 없음)'; byCode[c] = (byCode[c] || 0) + 1; }
    // 시험에 쓸 기록 ID 는 첫 쪽에서 **가장 드문 것** — 가장 흔한 것(로그인 기록)으로 물으면 걸러 받기를 무시하는 장비의 첫 쪽도 '전부 맞는 답' 처럼 보인다.
    const byId = new Map();
    for (const x of f.rows) if (SAFE_ID_RE.test(x.messageId)) byId.set(x.messageId, (byId.get(x.messageId) || 0) + 1);
    sample = [...byId.entries()].sort((a, b) => a[1] - b[1])[0]?.[0] || '';
    lclogCount = f.count;
    const e0 = members(r.json)[0] || {};
    // 로그인 기록이 **어느 경로**로 온 것인가(REDFISH · GUI · SSH …) — 문장 끝의 낱말만 센다. 계정 이름 · 주소는 싣지 않는다.
    const via = {};
    for (const x of f.rows) {
      if (!/USR0030$/i.test(String(x.messageId))) continue;
      const m = /\band ([A-Za-z][A-Za-z0-9-]{1,15})\.?\s{0,4}$/.exec(String(x.message || '').slice(0, 300));
      const k = m ? m[1].toUpperCase() : '(모름)';
      via[k] = (via[k] || 0) + 1;
    }
    lclogPage = f.n;
    return {
      loginVia: Object.fromEntries(Object.entries(via).slice(0, 8)),
      path: base, pageLen: f.n, count: f.count, nextLink: f.next, order: orderOf(f.rows),
      newest: iso(ts.length ? Math.max(...ts) : NaN), oldest: iso(ts.length ? Math.min(...ts) : NaN),
      sampleMessageId: t(sample, 64), codes: Object.fromEntries(Object.entries(byCode).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      entryKeys: Object.keys(e0).slice(0, 30).map((k) => t(k, 40)), oemKeys: Object.keys(e0?.Oem?.Dell || {}).slice(0, 20).map((k) => t(k, 40)),
    };
  });

  // ── 가장 오래된 항목 한 건(건수를 믿을 수 있을 때만 — 요청 1번): 활성 로그가 어디서 시작하는가. 실장비에서 맨 끝이 LOG203 이었다.
  //    문장은 **LOG 계열일 때만** 싣는다(로그 자체에 대한 기록 — 계정 · 주소가 들어 있지 않다). 그 밖은 기록 ID 와 시각만.
  if (lclogCount != null && lclogPage > 0 && lclogCount > lclogPage && Number.isSafeInteger(lclogCount) && lclogCount < 5_000_000) {
    await step('lclogOldest', async () => {
      const f = pageFacts(await G(`${base}?$skip=${lclogCount - 1}`));
      const x = f.rows[f.rows.length - 1];
      if (!x) return { n: 0 };
      const code = codeOf(x.messageId);
      return { n: f.n, messageId: t(x.messageId, 64), created: iso(x.created), ...(/^LOG\d{1,6}$/.test(code) ? { message: t(x.message, 160) } : {}) };
    });
  }

  // ── 걸러 받기($filter): 첫 쪽에서 본 기록 ID 로 물어 **답이 맞는지** 본다(Dell 공식 스크립트가 쓰는 꼴 — MessageId eq '…') ──
  // 식은 **보낼 꼴 그대로** 만든다(공백 · 따옴표를 미리 %XX 로) — fetch 가 나중에 바꾸면 Digest 인증의 uri 와 실제 요청이 어긋나 401 이 된다.
  const enc = (expr) => encodeURIComponent(expr).replace(/'/g, '%27');
  // 판단은 셋을 함께 본다(반증 3.8.2 #3 — 하나만 보면 걸러 받기를 **무시하는** 장비가 '지원' 으로 보인다):
  //   ① 온 행이 전부 식에 맞는가(allMatch) ② 건수가 전체보다 줄었는가(narrowed — 건수를 모르면 null) ③ 없는 ID 로 물으면 0건인가(음성 대조).
  const filterTry = async (expr, okRow) => {
    const j = await G(`${base}?$filter=${enc(expr)}`);
    const f = pageFacts(j);
    const matched = f.rows.filter(okRow).length;
    return { n: f.n, matched, count: f.count, nextLink: f.next, allMatch: f.n > 0 && matched === f.n,
      narrowed: f.count != null && lclogCount != null ? f.count < lclogCount : null };
  };
  if (sample) {
    const code = codeOf(sample);
    const stem = sample.replace(/\d+$/, '');
    const head = code && sample.endsWith(code) ? sample.slice(0, sample.length - code.length) : '';
    // 음성 대조: 있을 수 없는 ID. 행이 오면 이 장비는 식을 무시한다 — 아래 '맞는 답' 은 믿지 않는다.
    await step('filterNone', async () => { const r = await filterTry(`MessageId eq '${head}ZZZ99999'`, () => false); return { n: r.n, count: r.count }; });
    const ignores = Number.isFinite(out.filterNone?.n) ? out.filterNone.n > 0 : null;
    const verdict = (r) => (r && !r.error && !r.skipped ? (ignores === true ? false : (r.allMatch && r.narrowed !== false && ignores === false ? true : (r.allMatch ? null : false))) : null);
    await step('filterExact', () => filterTry(`MessageId eq '${sample}'`, (x) => x.messageId === sample));
    if (stem && stem !== sample) {
      await step('filterPrefixEq', () => filterTry(`MessageId eq '${stem}'`, (x) => String(x.messageId).startsWith(stem)));
      await step('filterStartsWith', () => filterTry(`startswith(MessageId,'${stem}')`, (x) => String(x.messageId).startsWith(stem)));
    }
    // 디스크 기록: 머리말 일치(PDR 전부)와 정확한 ID(PDR54) — **맞는 행만** 센다(무시하는 장비의 첫 쪽 50건을 'PDR54 50건' 으로 읽지 않게).
    await step('filterPdr', async () => {
      const r = await filterTry(`MessageId eq '${head}PDR'`, (x) => /PDR\d{1,6}$/i.test(String(x.messageId)));
      const q = await filterTry(`MessageId eq '${head}PDR54'`, (x) => /PDR54$/i.test(String(x.messageId)));
      return { prefix: { n: r.n, matched: r.matched, count: r.count }, pdr54: { n: q.n, matched: q.matched, count: q.count } };
    });
    // 한 줄 결론: true = 맞는 답을 줬고 음성 대조도 통과 · false = 무시하거나 틀린 답 · null = 판단할 근거가 모자람(0건 등).
    out.filterVerdict = { ignoresFilter: ignores, exact: verdict(out.filterExact), prefixEq: verdict(out.filterPrefixEq), startsWith: verdict(out.filterStartsWith) };
  } else out.filterExact = { error: '첫 쪽에 쓸 수 있는 기록 ID 가 없음' };

  // ── 내보내기 동작이 있는가(부르지 않는다 — 이름과 받는 값만) ──
  await step('lcService', async () => {
    const r = await firstOk([`${mgr}/Oem/Dell/DellLCService`, `/redfish/v1/Dell/Managers/${mgr.split('/').pop()}/DellLCService`]);
    const actions = r.json?.Actions && typeof r.json.Actions === 'object' ? r.json.Actions : {};
    const names = Object.keys(actions).map((k) => t(k.replace(/^#?DellLCService\./, ''), 48));
    const res = { path: t(r.path, 160), exports: names.filter((k) => /export|lclog/i.test(k)).slice(0, 24), actionCount: names.length };
    for (const want of ['ExportLCLog', 'ExportCompleteLCLog']) {
      const a = actions[`#DellLCService.${want}`];
      if (!a) { res[want] = '없음'; continue; }
      const info = safePath(a['@Redfish.ActionInfo']);
      const inline = Array.isArray(a['ShareType@Redfish.AllowableValues']) ? a['ShareType@Redfish.AllowableValues'] : null;
      if (inline) { res[want] = { shareTypes: inline.slice(0, 10).map((x) => t(x, 16)) }; continue; }
      if (!info) { res[want] = '있음(받는 값 모름)'; continue; }
      try {
        const ai = await G(info);
        const params = Array.isArray(ai?.Parameters) ? ai.Parameters : [];
        const st = params.find((p) => p?.Name === 'ShareType');
        res[want] = { params: params.slice(0, 16).map((p) => t(p?.Name, 32)), shareTypes: Array.isArray(st?.AllowableValues) ? st.AllowableValues.slice(0, 10).map((x) => t(x, 16)) : null };
      } catch (e) { if (isAuthErr(e)) throw e; res[want] = { error: errOf(e) }; }
    }
    return res;
  });

  // ── 로그인 기록 묶기 설정(이름을 몰라 꼴로 찾는다 — LCLog · Aggregat). 속성 전체는 내보내지 않는다 ──
  await step('logAttributes', async () => {
    const id = mgr.split('/').pop();
    const r = await firstOk([`${mgr}/Oem/Dell/DellAttributes/${id}`, `${mgr}/Attributes`]);
    const attrs = r.json?.Attributes && typeof r.json.Attributes === 'object' ? r.json.Attributes : {};
    const hit = {};
    let n = 0;
    for (const [k, v] of Object.entries(attrs)) {
      if (n >= 16) break;
      if (!ATTR_RE.test(k)) continue;
      const s = scalar(v);
      if (s !== undefined) { hit[t(k, 64)] = s; n += 1; }
    }
    return { path: t(r.path, 160), total: Object.keys(attrs).length, matched: hit };
  });

  // ── 디스크 한 개: 누적 오류 값 · SMART 링크가 있는가 ──
  await step('drive', async () => {
    const sys = await G('/redfish/v1/Systems');
    const sysRaw = safePath(members(sys)[0]?.['@odata.id']);
    if (!sysRaw.startsWith('/redfish/v1/Systems/')) throw new Error('시스템 경로 없음');
    const sysId = sysRaw.endsWith('/') ? sysRaw.slice(0, -1) : sysRaw;
    const st = await G(`${sysId}/Storage`);
    let driveUrl = '';
    let ctrls = 0;
    for (const m of members(st).slice(0, 6)) {
      const cu = safePath(m?.['@odata.id']);
      if (!cu.startsWith(`${sysId}/`)) continue;
      ctrls += 1;
      // eslint-disable-next-line no-await-in-loop
      const c = await G(cu);
      const d = safePath((Array.isArray(c?.Drives) ? c.Drives : [])[0]?.['@odata.id']);
      if (d) { driveUrl = d; break; }
    }
    if (!driveUrl) return { controllers: ctrls, note: '디스크가 달린 컨트롤러를 찾지 못함' };
    const d = await G(driveUrl);
    const dell = d?.Oem?.Dell?.DellPhysicalDisk && typeof d.Oem.Dell.DellPhysicalDisk === 'object' ? d.Oem.Dell.DellPhysicalDisk : {};
    const res = {
      id: t(d?.Id, 80), mediaType: t(d?.MediaType, 16), protocol: t(d?.Protocol, 16),
      keys: Object.keys(d || {}).slice(0, 50).map((k) => t(k, 40)), dellKeys: Object.keys(dell).slice(0, 60).map((k) => t(k, 48)),
      values: { ...picks(d), ...picks(dell) }, links: links(d),
    };
    // SMART 링크는 **그 디스크 아래**의 것만 따라가고(다른 자원으로 새지 않게) 값은 수 · 불리언만 싣는다(계정 이름 같은 글자가 실리지 않게 — 반증 3.8.2 #10).
    const smart = res.links.map(safePath).find((x) => x && /smart/i.test(x) && x.startsWith(`${driveUrl}/`));
    if (smart) {
      try {
        const sj = await G(smart);
        const vals = {};
        let n = 0;
        for (const [k, v] of Object.entries(sj || {})) {
          if (n >= 40 || k.startsWith('@')) continue;
          const x = numBool(v);
          if (x !== undefined) { vals[t(k, 48)] = x; n += 1; }
        }
        res.smart = vals;
      } catch (e) { if (isAuthErr(e)) throw e; res.smart = { error: errOf(e) }; }
    }
    return res;
  });

  out.ms = Math.max(0, now() - out.at);
  return out;
}
