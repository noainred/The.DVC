/**
 * views/horizonAdminText.js — Horizon 연결 테스트 결과 문구(v2.685, v2.686 재작성 · 순수).
 *
 * v2.685 사용자 신고: 등록 뒤 연결 테스트가 '라이선스 조회 실패 (HTTP 404)' 한 줄만 말해 로그인이 된 건지 알 수 없었다.
 * v2.686 사용자 신고(실장비 Connection Server 7.13.1): 결과가 "실시간 사용자·앱별 사용 수집은 이 등록으로 동작할 수
 *   있습니다" 라고 말했는데 그 서버의 세션 경로는 404 였다(사용자 curl 확인) — 테스트가 라이선스만 보고 추측한 것이다.
 *   그래서 서버(`horizon/featureProbe.js`)가 같은 로그인으로 기능별 경로를 실제로 조회하고, 여기는 그 결과를
 *   **기능마다 한 줄**로 만든다. 확인하지 않은 것을 말하지 않는다.
 *
 * 판정 종류(`kind`)는 서버 `PROBE_KINDS` 와 1:1 이다(서버 테스트가 이 파일의 FEATURE_KIND_TEXT 키를 대조한다).
 */

/** 기능 순서·이름 — 서버 FEATURES 의 key 와 같다. */
export const FEATURE_LABEL = Object.freeze({
  license: '라이선스 만료일',
  sessions: '실시간 사용자(세션)',
  apps: '앱 목록(앱 풀)',
  desktops: '데스크톱 풀',
  farms: '팜',
});
export const FEATURE_ORDER = Object.freeze(Object.keys(FEATURE_LABEL));

export const FEATURE_KIND_TEXT = Object.freeze({
  ok: '됨',
  'not-found': '이 서버에 없음(HTTP 404)',
  forbidden: '권한 없음(HTTP 403) — 이 계정의 Horizon 역할을 확인하세요',
  unauthorized: '토큰 거부(HTTP 401)',
  unparsed: '응답 형식 미인식(JSON 이 아님)',
  http: 'HTTP 오류',
  timeout: '시한 초과',
  error: '확인 실패',
});

/** 그 기능이 안 될 때 포탈에서 무엇이 안 되는가(조치가 아니라 영향). */
const IMPACT = Object.freeze({
  license: '라이선스 만료일을 볼 수 없습니다 — Horizon 관리 콘솔에서 확인하세요',
  sessions: '실시간 사용자·앱별 사용 수집이 동작하지 않습니다',
  apps: '앱 이름을 몰라 앱별 사용은 팜·데스크톱 풀 단위로만 보입니다',
  desktops: '데스크톱 풀이 이름 대신 ID 로 보입니다',
  farms: '팜이 이름 대신 ID 로 보입니다',
});

const attemptsText = (atts) => (Array.isArray(atts) ? atts : [])
  .map((a) => `${a.path} ${a.status ? `HTTP ${a.status}` : (FEATURE_KIND_TEXT[a.kind] || a.kind)}`).join(' · ');

function featureLine(key, f, r) {
  const label = FEATURE_LABEL[key] || key;
  if (!f) return { tone: 'muted', label, text: '확인하지 않았습니다' };
  if (f.kind === 'ok') {
    const extra = key === 'license' && r.licenses != null ? ` · 라이선스 ${r.licenses}건${r.first ? ` (${r.first})` : ''}` : '';
    return { tone: 'ok', label, text: `됨${extra}` };
  }
  const kindText = f.kind === 'http' && f.status ? `HTTP 오류(${f.status})` : (FEATURE_KIND_TEXT[f.kind] || f.kind);
  // 404 는 '확인한 결과 없다' 이고, 그 밖은 '확인하지 못했다' 다 — 색을 나눈다(없음 = 주황, 실패 = 빨강).
  return { tone: f.kind === 'not-found' ? 'warn' : 'bad', label, text: `${kindText} — ${IMPACT[key] || ''}`.replace(/ — $/, ''), path: f.path };
}

/**
 * 연결 테스트 응답 → { ok, warn, lines:[{tone,label,text}], text }.
 *  · ok(초록)는 로그인 + 라이선스 + 실시간 사용자가 모두 될 때만이다. 로그인만 됐으면 warn(주황).
 *  · `text` 는 줄을 합친 값(호환·테스트용)이다. 화면은 `lines` 를 그린다.
 */
export function hzTestMessage(r) {
  if (!r) return { ok: false, text: '응답이 없습니다.', lines: [] };
  if (!r.ok) {
    const t = `${r.reason || '연결 실패'}${r.hint ? ` · ${r.hint}` : ''}`;
    return { ok: false, text: t, lines: [{ tone: 'bad', label: '연결', text: t }] };
  }
  const lines = [];
  lines.push({ tone: 'ok', label: '로그인', text: `성공 (${r.loginMs ?? r.ms}ms) — 계정·주소는 맞습니다` });
  const versionRead = !!r.csVersion;
  if (versionRead) {
    const others = (r.csVersions || []).filter((v) => v !== r.csVersion);
    lines.push({ tone: 'ok', label: '커넥션 서버', text: `버전 ${r.csVersion}${others.length ? ` · 팟 안의 다른 버전 ${others.join(', ')}` : ''}${r.probe?.path ? ` (출처 ${r.probe.path})` : ''}` });
  } else if (r.versionProbe || r.probe) {
    const atts = r.versionProbe?.attempts || (r.probe ? [r.probe] : []);
    lines.push({ tone: 'warn', label: '커넥션 서버', text: `버전을 읽지 못했습니다${atts.length ? ` — 시도: ${attemptsText(atts)}` : ''}` });
  }
  if (!r.features) {
    // 구버전 서버 응답(기능별 확인 없음) — 확인하지 않은 기능을 '동작할 수 있다' 고 말하지 않는다.
    if (r.licenses != null) lines.push({ tone: 'ok', label: FEATURE_LABEL.license, text: `됨 · 라이선스 ${r.licenses}건${r.first ? ` (${r.first})` : ''}` });
    else lines.push({ tone: 'warn', label: FEATURE_LABEL.license, text: r.licenseError || `조회 실패 (HTTP ${r.licenseStatus})` });
    lines.push({ tone: 'muted', label: FEATURE_LABEL.sessions, text: '확인하지 않았습니다(포탈 서버를 업그레이드하면 연결 테스트가 확인합니다)' });
    return finish({ ok: false, warn: true, lines });
  }
  for (const k of FEATURE_ORDER) lines.push(featureLine(k, r.features[k], r));
  const notFound = FEATURE_ORDER.filter((k) => r.features[k]?.kind === 'not-found');
  if (notFound.length && versionRead) {
    lines.push({ tone: 'info', label: '판정', text: '404 는 같은 로그인으로 받은 응답입니다 — 주소·계정 문제가 아니라 이 커넥션 서버 버전에 그 API 가 없다는 뜻입니다(정확한 최소 버전은 확인하지 못했습니다).' });
  } else if (r.features.license?.kind === 'not-found' && !versionRead && r.licenseError) {
    lines.push({ tone: 'info', label: '판정', text: r.licenseError });
  }
  const ok = r.features.license?.kind === 'ok' && r.features.sessions?.kind === 'ok';
  return finish({ ok, warn: !ok, lines });
}

function finish(m) {
  return { ...m, text: m.lines.map((l) => `${l.label}: ${l.text}`).join('\n') };
}
