/**
 * collectorDcText.js — 설정 › 수집 서버의 '법인 매칭' 칸(v2.971 · 사용자 요청 '수집 서버 agent 와 datacenter id 를 사용자가 매칭하는 기능').
 * 지금 쓰이는 법인과 근거는 서버(/admin/collectors 의 dcMatch — collectorDcMatch)가 정한다. 여기서는 글자만 만든다.
 */
const nameOf = (id, dcs) => (Array.isArray(dcs) ? dcs : []).find((d) => String(d.id) === String(id))?.name || id;

/** '자동' 선택지 글자 — 이름 맞춤으로 잡힌 법인이 있으면 그 이름, 없으면 그 사실. */
export function autoOptionText(match, dcs) {
  if (match?.via === 'name' && match.id) return `자동 — 이름 맞춤: ${nameOf(match.id, dcs)}`;
  return '자동 — 맞는 법인 없음';
}

/** 칸 아래 한 줄(상태). tone: ok | warn | muted. */
export function matchNote(match, dcs) {
  if (!match) return { tone: 'muted', text: '' };
  if (match.via === 'manual') return { tone: 'ok', text: `사용자 매칭 → ${nameOf(match.id, dcs)}` };
  if (match.stale) return { tone: 'warn', text: '매칭한 법인이 지워져 이름 맞춤으로 판정합니다 — 다시 고르세요' };
  if (match.via === 'name') return { tone: 'muted', text: `이름 맞춤 → ${nameOf(match.id, dcs)}` };
  return { tone: 'warn', text: '법인을 모릅니다 — 이 수집 서버가 수집한 서버는 법인 미지정이 됩니다' };
}

/** Select 값 — 사용자 매칭이면 그 법인, 매칭한 법인이 지워졌으면 그 id(선택지로 보여 줘야 '자동' 을 골라 해제할 수 있다 — 반증 F6), 아니면 ''(자동). */
export function selectValue(match) {
  if (match?.via === 'manual' && match.id) return match.id;
  if (match?.stale && match.picked) return match.picked;
  return '';
}

/** 정렬 값 — 지금 쓰이는 법인 이름(없으면 빈 값 — 뒤로). */
export function matchSortText(match, dcs) {
  return match?.id ? nameOf(match.id, dcs) : '';
}

/** 저장 응답 → 알림 글자. 실패 본문은 던진다. */
export function saveText(r, collectorId, dcs) {
  if (!r || r.ok === false) throw new Error(r?.reason || '법인 매칭을 저장하지 못했습니다.');
  if (!r.changed) return `'${collectorId}' — 이미 같은 매칭입니다.`;
  const id = r.collector?.datacenterId;
  return id ? `'${collectorId}' 를 법인 '${nameOf(id, dcs)}' 로 매칭했습니다 — 서버 분석 · 통합 서버 인벤토리 · 전력 분석에 반영됩니다.`
    : `'${collectorId}' 의 법인 매칭을 해제했습니다 — 이름 맞춤으로 판정합니다.`;
}
