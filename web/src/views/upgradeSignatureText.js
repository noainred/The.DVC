/**
 * 업그레이드 화면의 '릴리스 서명' 칸 문구 — 순수 모듈(검토 S-10, v2.730).
 *
 * 서버 `/upgrade/status` 의 `signature`(upgrade/signature.js signatureStatus)와 원격 확인 결과의
 * `lastGood`(upgrade/versionsDoc.js rememberRemoteCheck)를 짧은 문장으로 바꾼다. 판정은 서버가 했고
 * 여기서는 **다시 판정하지 않는다** — 모르는 값은 '—' 또는 '알 수 없음' 이다(지어내지 않는다).
 *
 * 문구 규칙: 백틱 금지(BoldText 가 글자로 그린다), 값 인용은 ‘ ’.
 */
import { agoText } from './tools/relTime.js';
import { numOrNull } from '../numOrNull.js';

/** 검증이 일어난 경로 → 사람이 읽는 이름. 모르는 값은 원문 그대로(지어내지 않는다). */
export const WHERE_LABEL = {
  remote: '원격 다운로드',
  'remote-preflight': '원격 사전 확인',
  push: '받은 번들',
  'push-edge': '중앙에서 받은 번들',
  'push-collector': '중앙에서 받은 번들(수집기)',
  watch: '감시 폴더',
  'bundle-source': '엣지 배포용 번들',
  package: '설치 패키지 받기',
  offline: '오프라인 확인 도구',
};

export const whereText = (w) => (w ? (WHERE_LABEL[w] || String(w)) : '—');

const pad2 = (n) => String(n).padStart(2, '0');
/** 브라우저 시각 'YYYY-MM-DD HH:mm'. */
export function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** v2.810 서명 확인 끄기 시한 선택지(시간) — 서버 signatureOverride.js [1, 168] · 기본 24. */
export const OVERRIDE_HOURS = Object.freeze([1, 24, 72, 168]);
export const overrideHoursLabel = (h) => (h >= 24 && h % 24 === 0 ? `${h / 24}일` : `${h}시간`);

/**
 * v2.810 '화면 설정' 줄 — { state, text, tone }. state:
 *   'env'(환경변수가 정해 화면에서 못 바꿈) · 'off'(지금 꺼짐 — 다시 켜기 버튼) · 'on'(켜짐 — 끄기 버튼) · 'unknown'(옛 서버 — 버튼 없음)
 *   override 기록이 있지만 시한이 지났으면 'on' + 지난 기록 한 마디. 정책이 이미 warn(키 미설정)이면 끄기 버튼을 내지 않는다('na').
 */
export function overrideView(sig, now = Date.now()) {
  if (!sig || typeof sig !== 'object' || typeof sig.envLocked !== 'boolean') return { state: 'unknown', text: '', tone: 'muted' };
  if (sig.envLocked) return { state: 'env', text: '서버 환경변수 UPGRADE_SIGNATURE_POLICY 가 정해져 있어 화면에서 바꿀 수 없습니다(환경변수가 우선).', tone: 'muted' };
  // 반증 L-3: 이미 서명 필수가 아니면(키 미설정 설치본 · env warn) 끌 것이 없다 — 남은 기록이 있어도 '서명 필수로 동작' 이라 말하지 않는다
  if (sig.policy !== 'require' && sig.policySource !== 'ui') return { state: 'na', text: '', tone: 'muted' };
  const o = sig.override;
  const until = numOrNull(o?.until);
  if (o && until != null && until > now && sig.policySource === 'ui') {
    return { state: 'off', text: `서명 확인 꺼짐 — ${localStamp(until)} 까지(${o.by || '?'} · ${agoText(numOrNull(o.at), now) || '—'}) · 시한이 지나면 자동으로 다시 켜집니다.`, tone: 'bad' };
  }
  if (o && until != null && until > now) {
    // 기록은 유효한데 판정에 쓰이지 않는다(신뢰 키 파일 오류 · root 실행) — 지어내지 않고 사실만
    return { state: 'off', text: `끄기 기록이 있지만 지금 판정에 쓰이지 않습니다(신뢰 키 파일 오류 또는 root 실행) — 서명 필수로 동작합니다. 기록 ${localStamp(until)} 까지.`, tone: 'warn' };
  }
  const past = o && until != null ? ` 마지막으로 끈 기록: ${o.by || '?'} · ${localStamp(until)} 시한 지나 다시 켜짐.` : '';
  return { state: 'on', text: `켜짐 — 서명을 확인한 번들만 설치합니다.${past}`, tone: 'ok' };
}

/** 정책 한 줄 — { text, tone }. tone: 'ok' | 'warn' | 'bad' | 'muted' */
export function policyText(sig) {
  if (!sig || typeof sig !== 'object') return { text: '알 수 없음(서버가 서명 상태를 보내지 않았습니다)', tone: 'muted' };
  if (sig.policyInvalid) {
    return { text: `서명 필수 — 설정값 ‘${sig.policyInvalid}’ 를 알 수 없어 필수로 봅니다`, tone: 'warn' };
  }
  if (sig.policy === 'warn' && (sig.unconfigured || sig.policySource === 'unconfigured')) {
    // v2.735.1: 서명 공개키가 아직 설정되지 않은 설치본 — 관리자가 끈 것이 아니라 키 등록 전 상태다(조치가 다르다).
    return { text: '경고만(서명 공개키가 아직 설정되지 않은 설치본 — 키가 들어간 릴리스를 설치하면 서명 필수로 바뀝니다)', tone: 'warn' };
  }
  if (sig.policy === 'warn' && sig.policySource === 'ui') {
    // v2.810: 화면에서 시한부로 끈 상태 — env warn 과 같은 판정(틀린 서명은 그대로 거부)
    const until = numOrNull(sig.override?.until);
    return { text: `경고만(화면에서 시한부로 끔${until != null ? ` — ${localStamp(until)} 까지` : ''} · 틀린 서명은 계속 거부)`, tone: 'bad' };
  }
  if (sig.policy === 'warn') {
    return { text: '경고만(서명이 없거나 확인할 수 없는 번들도 설치합니다 — 호스트 portal.env 설정)', tone: 'bad' };
  }
  if (sig.policy === 'require') return { text: '서명 필수(확인되지 않은 번들은 설치하지 않습니다)', tone: 'ok' };
  return { text: `알 수 없음(${String(sig.policy || '—')})`, tone: 'muted' };
}

/** 신뢰 공개키 한 줄 — { text, tone } */
export function trustText(sig) {
  if (!sig || typeof sig !== 'object') return { text: '—', tone: 'muted' };
  if (sig.fatal) return { text: `신뢰 키 파일을 읽지 못했습니다 — ${sig.fatal}`, tone: 'bad' };
  const n = numOrNull(sig.trustedKeys); // Number(null) === 0 — 모르는 개수를 0 으로 지어내지 않는다
  if (n == null) return { text: '—', tone: 'muted' };
  const rv = numOrNull(sig.revokedKeys);
  const revoked = rv > 0 ? ` · 회수 ${rv}개` : '';
  // v2.740(감사 B-05): 키 파일 형식 오류(서버가 버린 항목)를 말한다 — 유효 키가 0개인 이유가 '설정 안 됨' 이 아니라 형식 오류일 수 있다
  //   (서버는 이제 그 상태를 서명 필수로 본다). 첫 오류만 싣는다(서버가 최대 5건을 보낸다).
  const errs = Array.isArray(sig.errors) ? sig.errors.filter((e) => typeof e === 'string' && e) : [];
  const errText = errs.length ? ` · 키 파일 형식 오류 ${errs.length}건(${errs[0].slice(0, 160)})` : '';
  if (n === 0) {
    const tail = sig.policy === 'warn' ? '확인하지 못한 채 경고만 남깁니다' : '어떤 번들도 설치하지 않습니다';
    return { text: `0개${revoked}${errText} — 서명을 확인할 수 없어 ${tail}`, tone: sig.policy === 'warn' ? 'warn' : 'bad' };
  }
  return { text: `${n}개${revoked}${errText}`, tone: errs.length ? 'warn' : 'ok' };
}

/**
 * 검증 기록이 없을 때의 안내(v2.736.1). 예전 문구 '아직 검증한 번들이 없습니다' 는 기록이 메모리에만 있어 업그레이드 재시작마다
 * 지워진 결과였는데, 사람은 '이 포탈이 서명을 확인한 적이 없다' 로 읽었다(앱 안 업그레이드로 설치한 버전이면 설치 때 확인을 거쳤다 —
 * install.sh 설치는 경우에 따라 건너뛴다: packaging/offline/release-verify-lib.sh).
 * 기록은 이제 재시작을 넘어 남지만, 언제 남는지와 남지 않는 경우를 함께 말한다.
 */
export const NO_RECORD_DETAIL = '서명 확인은 받은 번들을 설치하기 직전에 합니다 — 기록이 없으면 서명이 막은 것이 아니라 서명 확인 단계까지 간 번들이 아직 없다는 뜻입니다. '
  + '업그레이드를 시도했더라도 그 앞 단계(버전 확인·다운로드 주소·설치 경로)에서 멈추면 기록이 남지 않습니다 — 이유는 위 ‘자동 업그레이드 동작’ 칸과 ‘최근 적용 결과’ 에 있습니다. '
  + '기록은 이 포탈이 업그레이드 번들을 받거나 적용할 때(원격 다운로드·감시 폴더·중앙에서 받은 번들)와 엣지 배포용 번들·설치 패키지를 받을 때 남깁니다. '
  + '설치 패키지(install.sh)로 설치했다면 확인 여부와 결과는 그 설치 로그에만 있습니다 — 신규 설치·서명 manifest 없음·--skip-signature-check 같은 경우에는 '
  + '확인을 건너뛸 수 있습니다. 2.736.1 보다 이전 버전은 이 기록을 재시작 뒤까지 남기지 않았습니다.';

const verdictOf = (l) => (l.verified ? { word: '확인됨', tone: 'ok' } : l.ok && l.warned ? { word: '확인 못 함(정책상 허용)', tone: 'warn' } : { word: '거부', tone: 'bad' });

/** 마지막 검증 결과 한 줄 — { text, tone, detail } (detail 은 키·사유 — 표 아래 작은 글씨) */
export function lastVerifyText(sig, now = Date.now()) {
  const l = sig && sig.last;
  if (!l || typeof l !== 'object') {
    // 서버가 기록 상태(log)를 보내지 않으면 예전 서버다 — 예전 문구 그대로(지어내지 않는다).
    if (!sig || !sig.log) return { text: '아직 검증한 번들이 없습니다', tone: 'muted', detail: '' };
    return { text: '검증 기록 없음', tone: 'muted', detail: NO_RECORD_DETAIL };
  }
  const when = agoText(l.at, now);
  const where = whereText(l.where);
  const ver = l.version ? ` · v${l.version}` : '';
  const v = verdictOf(l);
  // 지금 실행 중인 버전이라는 표시는 확인된 기록에만 붙인다(거부·미확인 기록에 붙이면 '이 버전이 거부됐다' 로 읽힌다).
  const running = l.verified && l.version && sig.currentVersion && l.version === sig.currentVersion ? ' · 지금 실행 중인 버전' : '';
  const parts = [];
  if (l.verified) { if (l.keyId) parts.push(`키 ${l.keyId}`); } else if (l.reason) parts.push(String(l.reason));
  if (l.beforeStart) parts.push('포탈이 재시작되기 전에 남긴 기록입니다');
  return { text: `${v.word}${ver} · ${where} · ${when}${running}`, tone: v.tone, detail: parts.join(' · ') };
}

/** 최근 검증 기록(최신 먼저) — [{ key, text, tone }]. 2건 이상일 때만 화면이 펼침 목록으로 보인다. */
export function recentVerifyList(sig, now = Date.now()) {
  const list = sig && Array.isArray(sig.recent) ? sig.recent : [];
  return list.filter((e) => e && typeof e === 'object').map((e, i) => {
    const v = verdictOf(e);
    const ver = e.version ? ` · v${e.version}` : '';
    return { key: `${e.at}-${i}`, text: `${agoText(e.at, now)} · ${v.word}${ver} · ${whereText(e.where)}`, tone: v.tone };
  });
}

/** 기록 파일 문제 한 줄 — 없으면 ''. */
export function logIssueText(sig) {
  const lg = sig && sig.log;
  if (!lg || !lg.error) return '';
  return `검증 기록: ${lg.error}${lg.corruptKept ? `(원본은 ${lg.corruptKept} 로 보존)` : ''}`;
}

/** 누적 개수 — '확인 N · 경고 허용 N · 거부 N'. 모두 0 이면 빈 문자열. */
export function countsText(sig) {
  const c = sig && sig.counts;
  if (!c) return '';
  const v = Number(c.verified) || 0;
  const w = Number(c.warned) || 0;
  const r = Number(c.rejected) || 0;
  if (!v && !w && !r) return '';
  return `프로세스 시작 뒤: 확인 ${v} · 경고 허용 ${w} · 거부 ${r}`;
}

/** 원격 확인이 실패했을 때 직전 정상 확인 — 참고만(설치에는 쓰지 않는다). 없으면 null. */
export function remoteLastGoodText(remote, now = Date.now()) {
  const g = remote && remote.lastGood;
  if (!g || typeof g !== 'object') return null;
  const latest = g.latest ? `v${g.latest}` : '버전 미상';
  return `직전 정상 확인: ${latest} · ${agoText(g.checkedAt, now)} — 참고용이며 설치는 새로 받은 정보로만 합니다`;
}

/**
 * v2.809 감시 폴더 새 번들 옆에 서명 manifest 가 없으면 한 줄 경고(적용하면 manifest-missing 으로 거부된다). 있거나 모르면(옛 응답) ''.
 */
export function watchManifestWarn(watch) {
  if (!watch?.available || watch.hasManifest !== false) return '';
  const name = watch.manifest || `vmware-portal-${watch.version || '<버전>'}.manifest.json`;
  return `서명 manifest 없음 — ${name} 을 같은 폴더에 넣어야 적용됩니다(릴리스 downloads 에서 번들과 같은 버전).`;
}

export const TONE_COLOR = { ok: 'var(--green)', warn: '#fbbf24', bad: 'var(--red)', muted: 'var(--text-dim)' };
