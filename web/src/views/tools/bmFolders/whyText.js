/**
 * 물리서버 폴더 값 없음 사유 문구(v2.994 · 설계 docs/design/bm-folders §12). 판정은 서버(`bmfolders/usageWhy.js`) — 여기는 코드 → 글자만.
 * 분류(점 색): none = 수집 대상 아님(회색) · stale = 오래됨(호박색) · fail = 수집 실패/기록 없음(빨강) · unknown = 확인 못 함(빈 원).
 * 문구에 계정 · 주소 · 엣지 이름을 넣지 않는다(판본 구분 없이 같은 글자).
 */
export const WHY_TEXT = Object.freeze({
  off: { s: '수집 꺼짐', cls: 'none', l: '이 포탈의 베어메탈 사용률 수집이 꺼져 있습니다.', a: '설정 › 베어메탈 사용률에서 수집을 켜면 다음 주기부터 보입니다.' },
  'corp-off': { s: '법인 수집 꺼짐', cls: 'none', l: '이 법인은 베어메탈 사용률 수집을 켜지 않았습니다.', a: '설정 › 베어메탈 사용률에서 이 법인을 켜십시오.' },
  unassigned: { s: '법인 귀속 없음', cls: 'none', l: '어느 법인 서버인지 몰라 기본으로 수집하지 않습니다.', a: '통합 서버 인벤토리에서 법인(vCenter)을 정하십시오.' },
  'no-idrac': { s: 'iDRAC 등록 없음', cls: 'none', l: '이 서버의 iDRAC 등록이 없고 OS 경로도 없습니다.', a: '설정 › iDRAC 에 등록하거나 OS 계정을 등록하십시오.' },
  'no-idrac-cred': { s: 'iDRAC 계정 없음', cls: 'none', l: 'iDRAC 등록에 계정 · 비밀번호가 없습니다.', a: '설정 › iDRAC 에서 계정을 넣으십시오.' },
  'no-os-cred': { s: 'OS 계정 없음', cls: 'none', l: 'OS(SSH) 계정 등록이 없고 iDRAC 경로도 쓸 수 없습니다.', a: 'IP 관리 › IP 스캔 › 물리서버 OS 주소 제안에서 주소를 찾거나 베어메탈 스토리지에 계정을 등록하십시오.' },
  'both-off': { s: '수집 경로 꺼짐', cls: 'none', l: 'iDRAC 텔레메트리와 OS SSH 수집이 모두 꺼져 있습니다.', a: '설정 › 베어메탈 사용률에서 경로를 켜십시오.' },
  'os-ambiguous': { s: 'OS 등록 모호', cls: 'none', l: 'OS 계정 등록을 하나로 정하지 못했습니다(같은 이름 · 주소의 등록이 여럿이거나 법인 미지정).', a: '베어메탈 스토리지에서 그 등록에 법인을 지정하십시오.' },
  'os-foreign': { s: 'OS 등록이 다른 법인', cls: 'none', l: 'OS 계정 등록이 다른 법인으로 지정돼 있어 쓰지 않습니다.', a: '베어메탈 스토리지에서 법인을 확인하십시오.' },
  'key-conflict': { s: '식별 키 겹침', cls: 'none', l: '식별 키가 다른 서버와 겹쳐 값이 섞이지 않게 수집하지 않습니다.', a: 'iDRAC 등록에서 서비스 태그를 채우면 다음 주기부터 수집합니다.' },
  'remote-collector-unknown': { s: '수집 서버 모름', cls: 'unknown', l: '원격 수집 서버가 맡은 서버인데 그 수집 서버를 등록부에서 확인하지 못했습니다.', a: '설정 › 엣지 · 원격 › 수집 서버를 확인하십시오.' },
  'edge-no-record': { s: '엣지 값 없음', cls: 'fail', l: '엣지가 수집하는 서버인데 중앙에 그 엣지의 값이 없습니다(엣지 수집 꺼짐 · 보관분 전송 전 · 연결 끊김 중 하나 — 어느 것인지는 여기서 모릅니다).', a: '베어메탈 사용률 › 엣지 보관분에서 그 엣지 상태를 보십시오.' },
  'no-record': { s: '기록 없음', cls: 'fail', l: '수집 대상인데 값이 없습니다(등록 직후 · 첫 주기 전 · 수집 실패 중 하나).', a: '베어메탈 사용률 › 수집 건강에서 실패 사유별 개수를 보십시오.' },
  stale: { s: '오래됨', cls: 'stale', l: '마지막 값이 오래돼 지금 값으로 치지 않습니다.', a: '수집이 다시 성공하면 다음 주기부터 보입니다.' },
  'powered-off': { s: '꺼져 있음', cls: 'none', l: '서버 전원이 꺼져 있습니다.', a: '' },
  'vc-unread': { s: 'vCenter 못 읽음', cls: 'stale', l: '이 ESXi 호스트의 vCenter 를 지금 읽지 못해 마지막 값을 쓰지 않습니다.', a: 'vCenter 수집 상태를 보십시오.' },
  unknown: { s: '확인 못 함', cls: 'unknown', l: '이유를 확인하지 못했습니다 — 원인을 단정하지 않습니다.', a: '베어메탈 사용률 › 누락 점검에서 이 서버를 찾아보십시오.' },
});
export const WHY_DOT = Object.freeze({ none: 'var(--text-faint)', stale: 'var(--amber)', fail: 'var(--red)', unknown: 'transparent' });

/** 사유 → 글자(모르는 코드는 '확인 못 함'). */
export function whyOf(code) { return WHY_TEXT[code] || WHY_TEXT.unknown; }

/** 오래됨 '2시간 14분 전' — 마지막 값 시각이 있을 때만. */
export function agoText(at, now = Date.now()) {
  const ms = Number(at) > 0 ? now - Number(at) : NaN;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}시간 ${m % 60}분 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 칸 안 짧은 사유(오래됨이면 '오래됨 · 2시간 14분 전'). */
export function whyShort(why, now = Date.now()) {
  if (!why?.code) return '';
  const w = whyOf(why.code);
  const ago = why.code === 'stale' || why.code === 'vc-unread' ? agoText(why.at, now) : '';
  return ago ? `${w.s} · ${ago}` : w.s;
}

/** 값이 없는 행의 사유별 개수(묶음 띠) — 많은 순. */
export function whyBands(rows = []) {
  const c = new Map();
  for (const r of rows) { const code = r?.why?.code; if (code && r.cpu == null && r.mem == null) c.set(code, (c.get(code) || 0) + 1); }
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([code, n]) => ({ code, n, ...whyOf(code) }));
}

/** 고르기 버튼(서버 찾아 등록) — 찾은 서버 전부(보이지 않는 줄 포함)에 적용. 폴더에 없는 서버 = 손 등록이 없는 서버(기본 선택과 같은 기준). */
export function pickAll(rows = []) { return new Set(rows.map((x) => x.key)); }
export function pickNotInFolder(rows = []) { return new Set(rows.filter((x) => x.place !== 'manual').map((x) => x.key)); }
export function pickNote(kind, rows = [], picked = new Set()) {
  const n = picked.size; const out = rows.length - n;
  if (kind === 'all') return `찾은 ${rows.length}대를 모두 골랐습니다.`;
  if (kind === 'none') return '선택을 모두 풀었습니다.';
  const auto = rows.filter((x) => x.place === 'auto' && picked.has(x.key)).length;
  return `폴더에 없는 ${n}대를 골랐습니다${out ? ` — 이미 폴더에 있는 ${out}대는 뺐습니다` : ''}${auto ? `(자동 규칙으로만 놓인 ${auto}대 포함)` : ''}.`;
}
