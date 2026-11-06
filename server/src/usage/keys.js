/**
 * usage/keys.js — 기능 사용 추적이 받는 '화면 키' 등록부(v2.913, 설계 docs/design/feature-usage §4.1).
 *
 * 키 4종(주소가 바뀌는 화면 전환만 센다 — 검색어·입력 값·조회한 장비·화면 안 버튼은 세지 않는다):
 *   · `tab:<id>`          상단 탭(#/<id>) — 웹 App.jsx TABS 와 같은 목록
 *   · `tool:<k>`          특수 기능 도구(#/tools/<k>) — 서버가 아는 도구 키(tool-usage.js knownToolKeys) · 물리 서버는 `tool:serveranalysis/baremetal`
 *   · `settings:<k>`      설정 하위 탭(#/settings/<k>) — 웹 Settings.jsx SUB 와 같은 목록
 *   · `console:<page>`    관제 콘솔(#/console/<page>) — 웹 console/DvcConsole.jsx PAGES 와 같은 목록
 *
 * 규칙(회귀 방지):
 *  · **아는 키만** 받는다 — 예전 tool-usage 가 형식만 봐서 viewer 가 임의 키를 무제한으로 쌓던 것(v2.598 AUTHZ-2598-05)과 같은 함정을 막는다.
 *  · 웹 목록과 이 목록은 test/featureUsage2913.test.js 가 소스로 대조한다(웹에 탭·설정 하위·콘솔 페이지를 더하면 여기도 더할 것 —
 *    빠지면 그 화면의 신호는 'unknown-key' 로 버려지고 상태 화면의 '버린 신호' 에 보인다).
 *  · 도구 키는 바꾸지 않는다(권한 파일의 값) — 여기서도 이름을 바꾸지 않는다.
 */
import { knownToolKeys } from '../tool-usage.js';

/** 웹 App.jsx TABS 의 id(순서 무관). */
export const TAB_KEYS = Object.freeze(['overview', 'summary', 'vcenters', 'svcmon', 'hosts', 'vms', 'datastores', 'networks', 'ipam', 'alarms',
  'tools', 'board', 'issues', 'wiki', 'settings', 'upgrade']);

/** 웹 Settings.jsx SUB 의 k(순서 무관). */
export const SETTINGS_KEYS = Object.freeze([
  'datacenter-admin', 'vcenter-admin', 'vcenter-test', 'nsx-admin', 'horizon-admin', 'idrac-admin', 'idrac-scan-log',
  'veeam', 'bareos', 'backup', 'nfs-mounts',
  'metrics', 'storage-intervals', 'power-off-check', 'vmseries', 'sansw-perf', 'isilon-dirusage', 'guest-partition', 'dir-usage',
  'gpu-collect', 'gpu-guest', 'gpu-guest-diag', 'guest-account',
  'collectors', 'agent-deploy', 'proxy', 'remote',
  'users', 'edge-users', 'auth-ad', 'feature-usage',
  'session-security', 'secrets', 'api-keys', 'anomaly', 'host-access', 'peer-trust', 'security-self-check',
  'alerts', 'mail', 'ai-search', 'tool-categories',
  'vclogs', 'diagnostics', 'perf-monitor', 'log-analysis', 'audit', 'recent-logins', 'login-counts',
  'upgrade', 'about',
]);

/** 웹 console/DvcConsole.jsx PAGES 의 키. */
export const CONSOLE_KEYS = Object.freeze(['overview', 'compute', 'storage', 'network', 'facility', 'alarms']);

/** 도구 키 + 셋째 조각(topMenu.js 의 seg 항목) — 지금은 물리 서버 하나. */
export const TOOL_SEGS = Object.freeze({ serveranalysis: ['baremetal'] });

const TAB_SET = new Set(TAB_KEYS);
const SETTINGS_SET = new Set(SETTINGS_KEYS);
const CONSOLE_SET = new Set(CONSOLE_KEYS);
const SEG_RE = /^[a-z0-9-]{1,40}$/;

/** 키 상한(방어선) — 알려진 키 집합(약 190개)보다 넉넉히. tool-usage.js MAX_KEYS 와 같은 값. */
export const MAX_KEY_LEN = 90;

/**
 * 받은 키가 아는 화면인가. 문자열이 아니거나 형식이 틀리거나 목록 밖이면 false.
 * @param {unknown} k
 */
export function validUsageKey(k) {
  if (typeof k !== 'string' || !k || k.length > MAX_KEY_LEN) return false;
  const i = k.indexOf(':');
  if (i <= 0) return false;
  const kind = k.slice(0, i);
  const rest = k.slice(i + 1);
  if (kind === 'tab') return TAB_SET.has(rest);
  if (kind === 'settings') return SETTINGS_SET.has(rest);
  if (kind === 'console') return CONSOLE_SET.has(rest);
  if (kind === 'tool') {
    const [tk, seg, extra] = rest.split('/');
    if (extra !== undefined || !SEG_RE.test(tk || '')) return false;
    if (!knownToolKeys().has(tk)) return false;
    if (seg === undefined) return true;
    return Array.isArray(TOOL_SEGS[tk]) && TOOL_SEGS[tk].includes(seg);
  }
  return false;
}

/** 키 종류(tab·tool·settings·console) — 모르면 ''. */
export function usageKeyKind(k) {
  const s = typeof k === 'string' ? k : '';
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : '';
}
