/**
 * collectorDcText.js — 설정 › 수집 서버의 '법인 매칭' 칸(v2.972 · 사용자 요청 '수집 서버 agent 와 datacenter id 를 사용자가 매칭하는 기능').
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

/**
 * v2.986(사용자 결정 '불일치가 생기면 사용자가 매칭을 선택' · '버튼으로 한쪽에 맞추기'): 수집 서버 법인(A) ≠ 그 수집 서버 vCenter 의 할당 법인(B).
 * 서버(collectorsDc.js dcConflictsOf)가 준 conflicts 를 문구 · 두 선택지로. 법인 이름은 서버가 준 이름을 쓰고, 없으면 id.
 * @returns {Array<{key:string, text:string, toCollector:{label:string, datacenterId:string}, toVcenter:{label:string, vcenterId:string, datacenterId:string}}>}
 */
export function conflictChoices(match, dcs) {
  const list = Array.isArray(match?.conflicts) ? match.conflicts : [];
  return list.map((x) => {
    // 반증 D1: A 는 서버마다 서버 분석이 실제로 쓰는 법인(serverDatacenterId) — 수집 서버 수준 매칭이 아니다.
    const a = x.serverDatacenterName || nameOf(x.serverDatacenterId, dcs);
    const b = x.datacenterName || nameOf(x.datacenterId, dcs);
    const vc = x.vcenterName && x.vcenterName !== x.vcenterId ? `${x.vcenterName}(${x.vcenterId})` : x.vcenterId;
    const n = Number(x.servers) || 0;
    return {
      key: `${x.vcenterId}|${x.serverDatacenterId}|${x.datacenterId}`,
      text: `불일치 — 서버 ${n}대: 서버 분석은 ‘${a}’, 전력 분석 · 통합 인벤토리는 vCenter ‘${vc}’ 의 할당 법인 ‘${b}’ 로 봅니다. 한쪽으로 맞추세요.`,
      toCollector: { label: `수집 서버를 ‘${b}’ 로 매칭`, datacenterId: x.datacenterId },
      toVcenter: {
        label: `vCenter 를 ‘${a}’ 에 할당`, vcenterId: x.vcenterId, datacenterId: x.serverDatacenterId,
        // 반증 D6: 확인 창에 대상 vCenter 와 바뀌는 법인(B → A)을 밝힌다.
        confirm: `vCenter ‘${vc}’ 의 법인 할당을 ‘${b}’ → ‘${a}’ 로 바꿀까요?\n\n그 vCenter 의 호스트 · VM · 서버가 모두 ‘${a}’ 로 집계됩니다(서버 분석 · 통합 서버 인벤토리 · 전력 분석 · 법인별 화면).`,
      },
    };
  });
}

/** 반증 D3: vCenter 할당 저장 응답 — ok 여도 바뀐 것이 없거나(없는 법인 · 형식) 이면 실패로 말한다. 성공이면 null. */
export function assignFailText(r) {
  if (!r || r.ok === false) return r?.reason || 'vCenter 법인 할당을 저장하지 못했습니다.';
  if (r.unknownDatacenter) return '없는 법인이라 할당하지 않았습니다 — 법인 목록이 바뀌었을 수 있습니다. 새로 고친 뒤 다시 고르세요.';
  if (r.malformed) return 'vCenter 할당 요청 형식이 올바르지 않아 저장하지 않았습니다.';
  if (!r.changed) return '이미 그 법인에 할당돼 있어 바뀐 것이 없습니다.';
  return null;
}

/** 저장 응답 → 알림 글자. 실패 본문은 던진다. */
export function saveText(r, collectorId, dcs) {
  if (!r || r.ok === false) throw new Error(r?.reason || '법인 매칭을 저장하지 못했습니다.');
  if (!r.changed) return `'${collectorId}' — 이미 같은 매칭입니다.`;
  const id = r.collector?.datacenterId;
  return id ? `'${collectorId}' 를 법인 '${nameOf(id, dcs)}' 로 매칭했습니다 — 서버 분석 · 통합 서버 인벤토리 · 전력 분석에 반영됩니다.`
    : `'${collectorId}' 의 법인 매칭을 해제했습니다 — 이름 맞춤으로 판정합니다.`;
}
