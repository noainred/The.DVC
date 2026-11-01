/**
 * bareos/edgeResult.js — 엣지 대행 결과의 **정제**(v2.824 법인 엣지 대행).
 *
 * 법인 엣지가 자기 Director 에 실행한 작업(ops.js 표 · 자동 설정)의 결과는 엣지가 보낸 것이다 — 중앙은 그대로 믿지 않는다
 * (루트 CLAUDE.md '엣지가 보낸 것은 정제한다': 아는 필드만·객체만·상한·문자열 수치는 수로 · 못 읽은 값은 null).
 * 모양: 성공 `{ ok:true, value }` · 실패 `{ ok:false, code, reason, authFailed?, notSent?, unknown?, paths?, files? }`.
 * 새 작업 종류를 더하면 VALUE 표에도 넣는다(없으면 결과를 받지 않는다 — 실패로 닫힌다).
 */
import { numOrNull } from '../util/numOrNull.js';
import { isResourceName } from './names.js';
import { normPolicyResult, normVolumeRows } from './policyParse.js';

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
// eslint-disable-next-line no-control-regex
const str = (v, n = 256) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, n) : '');
const bool = (v) => v === true;
const int = (v) => { const n = numOrNull(v); return Number.isInteger(n) ? n : null; };
const posInt = (v) => { const n = int(v); return n !== null && n > 0 && n <= 2 ** 31 ? n : null; };
const nonNeg = (v) => { const n = numOrNull(v); return n !== null && n >= 0 ? n : null; };
const timeOf = (v) => { const n = numOrNull(v); return n !== null && n > 946_684_800_000 && n < 4_102_444_800_000 ? n : null; };
const names = (v, cap = 2000) => (Array.isArray(v) ? v.slice(0, cap).map((x) => str(x, 128)).filter(Boolean) : null);

/** 카탈로그 잡 행(director.js normalizeJobRow 모양). */
export function rowOut(v) {
  if (!v || typeof v !== 'object') return null;
  const r = obj(v);
  return {
    jobid: posInt(r.jobid), job: str(r.job, 200), name: str(r.name, 128), type: str(r.type, 1), level: str(r.level, 1),
    status: str(r.status, 1), state: str(r.state, 20), startedAt: timeOf(r.startedAt), endedAt: timeOf(r.endedAt),
    bytes: nonNeg(r.bytes), files: nonNeg(r.files), errors: nonNeg(r.errors), client: str(r.client, 128),
  };
}
const rows = (v, cap) => arr(v).slice(0, cap).map(rowOut).filter((x) => x && x.jobid);

/** 작업 종류 → 성공 값 정제. */
export const VALUE = Object.freeze({
  probe: (v) => { const r = obj(v); const t = obj(r.tls); return { director: str(r.director, 64), version: str(r.version, 40), tls: r.tls ? { protocol: str(t.protocol, 20), cipher: str(t.cipher, 80) } : null, clients: names(r.clients), clientsError: str(r.clientsError, 300) }; },
  catalog: (v) => {
    const r = obj(v); const out = {};
    for (const k of ['clients', 'storages', 'pools', 'schedules', 'jobdefs', 'filesets']) out[k] = names(r[k]);
    // v2.824 검토(S2): 자기 키만(`in` 은 constructor·toString 같은 프로토타입 키를 통과시켰다)
    out.errors = Object.fromEntries(Object.entries(obj(r.errors)).filter(([k]) => Object.hasOwn(out, k)).map(([k, m]) => [k, str(m, 300)]));
    return out;
  },
  // key: 부른 쪽이 준 순번(정수) 그대로 — 글자로 바꾸면 일괄 등록이 결과를 하나도 짝짓지 못했다(v2.824 검토 S1·C1 — 재현: Director 에 잡만 생기고 원장 0)
  // v2.825.1 버그 점검(G3 — 재현): 성공인데 잡 이름이 없거나 리소스 이름 규칙에 어긋나면 그 항목은 '결과 모름'(원장에 bareosJob 'undefined' 를 적지 않는다 —
  //   Director 에 잡이 생겼을 수 있다). 필수 값이 없으면 성공으로 받지 않는다(C9 와 같은 규칙).
  addJobs: (v) => arr(v).slice(0, 500).map((x0) => {
    const x = obj(x0);
    const key = Number.isInteger(x.key) && x.key >= 0 && x.key < 1_000_000 ? x.key : str(x.key, 200);
    if (bool(x.ok) && !isResourceName(x.name)) return { key, ok: false, code: 'unknown', message: '엣지가 잡 이름 없이(또는 형식이 틀린 이름으로) 성공을 회신했습니다 — Director 에 잡이 생겼을 수 있습니다. Director 에서 확인하세요.' };
    return { key, ok: bool(x.ok), ...(x.name ? { name: str(x.name, 128) } : {}), ...(x.code ? { code: str(x.code, 40) } : {}), ...(x.message ? { message: str(x.message, 300) } : {}) };
  }),
  disableJobs: (v) => arr(v).slice(0, 500).map((x0) => { const x = obj(x0); return { name: str(x.name, 128), ok: bool(x.ok) }; }),
  runJob: (v) => posInt(v),
  // v2.830 백업 그룹 일괄 실행 — 성공인데 jobid 가 없으면 그 항목은 '결과 모름'(실행됐을 수 있다 · 원장에 jobid 없는 실행을 남기지 않는다 — C9 와 같은 규칙)
  runJobs: (v) => arr(v).slice(0, 500).map((x0) => {
    const x = obj(x0);
    const key = Number.isInteger(x.key) && x.key >= 0 && x.key < 1_000_000 ? x.key : -1;
    const jobid = posInt(x.jobid);
    if (bool(x.ok) && !jobid) return { key, ok: false, code: 'unknown', message: '엣지가 jobid 없이 성공을 회신했습니다 — 실행됐을 수 있습니다. Director 에서 확인하세요.' };
    return { key, ok: bool(x.ok), ...(jobid ? { jobid } : {}), ...(x.code ? { code: str(x.code, 40) } : {}), ...(x.message ? { message: str(x.message, 300) } : {}) };
  }),
  // v2.831 보관 개수 정리 — 지운 jobid 는 숫자만(엣지가 다시 읽어 실제로 사라진 것). 성공인데 deleted 가 배열이 아니면 '결과 모름'(지웠는지 모른다)
  pruneJobs: (v) => arr(v).slice(0, 500).map((x0) => {
    const x = obj(x0);
    const key = Number.isInteger(x.key) && x.key >= 0 && x.key < 1_000_000 ? x.key : -1;
    if (bool(x.ok) && !Array.isArray(x.deleted)) return { key, ok: false, code: 'unknown', message: '엣지가 지운 목록 없이 성공을 회신했습니다 — 지웠는지 알 수 없습니다.' };
    if (!bool(x.ok)) return { key, ok: false, ...(x.code ? { code: str(x.code, 40) } : {}), ...(x.message ? { message: str(x.message, 300) } : {}), ...(Array.isArray(x.sent) ? { sent: x.sent.slice(0, 1000).map(posInt).filter(Boolean) } : {}) };
    return {
      key, ok: true, deleted: arr(x.deleted).slice(0, 1000).map(posInt).filter(Boolean),
      kept: nonNeg(x.kept), good: nonNeg(x.good), baseJobid: posInt(x.baseJobid), baseAt: timeOf(x.baseAt),
      ...(x.reason ? { reason: str(x.reason, 300) } : {}), ...(posInt(x.more) ? { more: posInt(x.more) } : {}), ...(posInt(x.notDeleted) ? { notDeleted: posInt(x.notDeleted) } : {}),
    };
  }),
  // v2.833 진행 현황판(읽기 전용) — 숫자는 음수·문자열을 버린다(못 읽은 값은 null · 0 이 아니다)
  liveStatus: (v) => ({
    ...(obj(v).director ? { director: (() => {
      const d = obj(obj(v).director);
      if (!bool(d.ok)) return { ok: false, ...(d.code ? { code: str(d.code, 40) } : {}), ...(d.message ? { message: str(d.message, 300) } : {}) };
      return { ok: true, raw: str(d.raw, 4096), jobs: arr(d.jobs).slice(0, 1000).map((x0) => { const x = obj(x0); return { jobid: posInt(x.jobid), name: str(x.name, 128), status: str(x.status, 200), reason: str(x.reason, 20) }; }).filter((x) => x.jobid) };
    })() } : {}),
    clients: arr(obj(v).clients).slice(0, 50).map((c0) => {
      const c = obj(c0);
      const client = str(c.client, 64);
      if (!bool(c.ok)) return { client, ok: false, ...(c.code ? { code: str(c.code, 40) } : {}), ...(c.message ? { message: str(c.message, 300) } : {}) };
      return {
        client, ok: true, raw: str(c.raw, 4096),
        jobs: arr(c.jobs).slice(0, 300).map((x0) => {
          const x = obj(x0);
          return { jobid: posInt(x.jobid), job: str(x.job, 200), name: str(x.name, 128), level: str(x.level, 1), bytes: nonNeg(x.bytes), files: nonNeg(x.files), aveRate: nonNeg(x.aveRate), lastRate: nonNeg(x.lastRate) };
        }).filter((x) => x.jobid),
      };
    }),
  }),
  setEnabled: () => null,
  history: (v) => rows(v, 200),
  // v2.839 정책 수집 — 아는 키 · 아는 필드만 · 상한(policyParse 정규화는 멱등 — 엣지가 이미 거른 값을 중앙이 같은 함수로 다시 거른다)
  policy: (v) => normPolicyResult(v),
  // v2.840 볼륨 목록 즉시 조회 — 아는 칸 · 행 상한(멱등 정규화를 중앙이 다시 돈다)
  volumes: (v) => normVolumeRows(v),
  cancel: (v) => { const r = obj(v); return r.final ? { final: rowOut(r.final) } : r.cleared ? { cleared: true } : { canceled: bool(r.canceled) }; },
  log: (v) => {
    const r = obj(v); const l = obj(r.log);
    return { log: { lines: arr(l.lines).slice(-4000).map((x) => str(x, 2000)), truncated: bool(l.truncated), total: nonNeg(l.total) }, row: rowOut(r.row) };
  },
  restore: (v) => { const r = obj(v); return { rid: posInt(r.rid), chain: arr(r.chain).slice(0, 400).map(posInt).filter(Boolean) }; },
  poll: (v) => {
    const r = obj(v); const f = obj(r.fault);
    return {
      rows: arr(r.rows).slice(0, 100).map((x0) => { const x = obj(x0); return { jobid: posInt(x.jobid), row: rowOut(x.row) }; }).filter((x) => x.jobid),
      attempted: nonNeg(r.attempted) ?? 0,
      ...(Array.isArray(r.states) ? { states: r.states.slice(0, 20_000).filter((p) => Array.isArray(p) && typeof p[0] === 'string').map((p) => [str(p[0], 128), p[1] === true ? true : p[1] === false ? false : null]) } : {}),
      // G5: 상한은 두되 **최신**을 남긴다(jobid 내림차순으로 자른다 — 앞 5000행만 남기면 넘칠 때 최신 실행을 놓쳤다 · 중앙 직접 경로는 상한이 없다)
      ...(Array.isArray(r.recent) ? { recent: rows([...r.recent].filter((x) => x && typeof x === 'object').sort((a, b) => (posInt(b.jobid) || 0) - (posInt(a.jobid) || 0)), 5000) } : {}),
      redisabled: arr(r.redisabled).slice(0, 2000).map((x) => str(x, 128)).filter(Boolean),
      itemErrors: nonNeg(r.itemErrors) ?? 0, cut: bool(r.cut), reconciled: bool(r.reconciled),
      ...(r.fault ? { fault: { code: str(f.code, 40) || 'error', message: str(f.message, 300) } } : {}),
    };
  },
  // 자동 설정 대행(엣지가 SSH 로 법인 서버를 설정) — 원격 출력은 엣지가 이미 가렸다(maskSecrets). 여기서는 모양·길이만.
  'setup.preflight': (v) => {
    const r = obj(v); const res = obj(r.resources);
    return {
      host: str(r.host, 255), pluginDir: str(r.pluginDir, 120),
      items: arr(r.items).slice(0, 60).map((x0) => { const x = obj(x0); return { key: str(x.key, 60), label: str(x.label, 80), status: ['ok', 'missing', 'warn', 'unknown'].includes(x.status) ? x.status : 'unknown', detail: str(x.detail, 200), hint: str(x.hint, 300) }; }),
      resources: Object.fromEntries(['client', 'storage', 'pool', 'schedule'].map((k) => [k, (names(res[k], 50) || [])])),
    };
  },
  'setup.director': (v) => {
    const r = obj(v);
    return { files: arr(r.files).slice(0, 20).map((x0) => { const x = obj(x0); return { path: str(x.path, 300), action: str(x.action, 20) }; }), test: str(r.test, 600), reload: str(r.reload, 600), probe: VALUE.probe(r.probe) };
  },
  'setup.fdPlugin': (v) => { const r = obj(v); return { action: r.action === 'updated' ? 'updated' : 'unchanged', pluginDir: str(r.pluginDir, 120), backup: str(r.backup, 300), added: arr(r.added).slice(0, 4).map((x) => str(x, 120)) }; },
  'setup.fdIni': (v) => { const r = obj(v); return { path: str(r.path, 300), action: str(r.action, 20), plugin: r.plugin === 'installed' ? 'installed' : 'missing', pluginText: str(r.pluginText, 200), ...(r.note ? { note: str(r.note, 200) } : {}) }; },
  'setup.thumbprint': (v) => { const r = obj(v); const tp = str(r.thumbprint, 40); return { thumbprint: /^[0-9A-F]{40}$/.test(tp) ? tp : '', subject: str(r.subject, 300), notAfter: str(r.notAfter, 60) }; },
});

/**
 * 성공 값에 꼭 있어야 하는 것(v2.824 검토 C9) — 없으면 '성공' 으로 받지 않는다. 상태를 바꾼 작업이라 실패로 단정하지 않고 '결과 모름'.
 * (runJob 의 jobid 가 null 이면 원장에 jobid 없는 실행이, restore 의 rid 가 null 이면 열린 복원이 남았다.)
 */
const REQUIRED = Object.freeze({
  runJob: (v) => v !== null,
  restore: (v) => v.rid !== null,
});

/** 엣지가 돌려줄 수 있는 오류 코드(그 밖은 'error'). */
const CODES = new Set(['invalid', 'conflict', 'not-configured', 'not-found', 'auth', 'pam', 'tls', 'connect', 'closed', 'timeout', 'aborted', 'protocol', 'too-large',
  'jsonrpc', 'blocked', 'remote', 'config-test', 'console-login', 'save', 'ssh-auth', 'ssh-hostkey', 'auth-stopped', 'not-sent', 'unknown', 'unavailable', 'error']);

/**
 * 결과 봉투 정제. kind 를 모르면 실패로 닫는다.
 * @returns {{ ok:true, value } | { ok:false, code, reason, authFailed?, notSent?, unknown?, paths?, files? }}
 */
export function sanitizeEdgeResult(kind, result) {
  const r = obj(result);
  const fn = VALUE[kind];
  if (!fn) return { ok: false, code: 'error', reason: `알 수 없는 작업 '${str(kind, 40)}'` };
  if (r.ok === true) {
    const value = fn(r.value);
    if (REQUIRED[kind] && !REQUIRED[kind](value)) return { ok: false, code: 'unknown', unknown: true, reason: '엣지가 성공이라고 회신했지만 결과 값(jobid)을 읽지 못했습니다 — 실행됐는지 알 수 없습니다. Director 에서 확인하세요.' };
    return { ok: true, value };
  }
  const code = CODES.has(r.code) ? r.code : 'error';
  return {
    ok: false, code, reason: str(r.reason, 1800) || '엣지가 사유 없이 실패를 회신했습니다.',
    ...(r.authFailed === true ? { authFailed: true } : {}), ...(r.notSent === true ? { notSent: true } : {}), ...(r.unknown === true ? { unknown: true } : {}),
    ...(Array.isArray(r.paths) ? { paths: r.paths.slice(0, 20).map((x) => str(x, 300)) } : {}),
    ...(Array.isArray(r.files) ? { files: r.files.slice(0, 20).map((x0) => { const x = obj(x0); return { path: str(x.path, 300), action: str(x.action, 20) }; }) } : {}),
  };
}
