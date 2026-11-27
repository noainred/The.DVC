/**
 * rack/project.js — 랙 실장도 응답에 싣는 칸 목록(화이트리스트 투영 · 순수).
 *
 * 설계 docs/design/rack-mask-redesign(J1): **조회 계정 응답은 여기에 적힌 칸만 싣는다.** 원장 행을 펼쳐(`...p`) 싣지 않는다 —
 * 2026-11-27 실측에서 '가릴 칸을 하나씩 지정' 하던 예전 방식은 장비의 메모 · 모델, 랙의 이름 · 줄 · 용도, 전산실 · 데이터센터 이름,
 * 랙 종류 이름, 판 차이의 위치 글, 시리얼 칸에 적힌 주소를 가림 없이 내보냈다(잊은 칸 = 원문). 새 칸은 이 파일에 등급을 적기 전에는 응답에 없다.
 *
 * 보는 눈(viewer) `v` 는 라우트(`routes/api/rack.js viewerOf`)가 요청마다 만든다:
 *   · `admin`      관리자 판본(전부 원문) — `isAdminDetailUser`
 *   · `showSerial` 시리얼을 보는 판본(관리자 또는 전체 조회 범위)
 *   · `name(글, 그 장비의 시리얼?)` · `text(글, 시리얼?)`  자유 글 가림(관리자는 그대로) — 지금은 `textMaskOf`(찾아 지우기), 다음 단계에서 통째 판정으로 바뀐다
 *   · `serial(글)`  시리얼 칸의 값 — 주소 꼴이면 ''(관리자는 그대로)
 *
 * 칸의 등급:
 *   모두        id · 위치 · 종류 · 크기 · 수치(전력 · 무게) · 시각 — 사람이 적은 글이 아니다
 *   가림을 거쳐  표시 이름 · 모델 · 랙의 이름 · 줄 · 용도 · 전산실 · 데이터센터 · 랙 종류 이름 · 판 차이의 이름 · 위치 글
 *   시리얼 판본  serial · extraSerials(주소 꼴은 비운다)
 *   관리자만     메모(note — 2026-11-27 사용자 결정 '메모는 관리자 전용') · 등록부 서버 이름 · OS 호스트 이름 · 관리 주소 · 미배치 서버 목록 · 되돌리기 미리 보기 · 작업자
 * ⚠ 가림 함수를 거친 글도 '찾아 지우기' 의 한계(표기를 바꾼 식별자)는 그대로다 — 그 한계는 통째 판정 + 사람의 결정으로 넘어가며 다룬다.
 */

/** 데이터센터(site). */
export function projectSite(s, v) {
  return { id: s.id, corpId: s.corpId, name: v.name(s.name), sort: s.sort };
}

/** 전산실. 목록(`listTree`)이 붙인 랙 · 장비 수는 있으면 싣는다. */
export function projectRoom(r, v) {
  const out = { id: r.id, siteId: r.siteId, name: v.name(r.name), sort: r.sort, rev: r.rev, updatedAt: r.updatedAt };
  if (r.racks !== undefined) out.racks = r.racks;
  if (r.places !== undefined) out.places = r.places;
  return out;
}

/** 랙 종류(전 법인 공용). */
export function projectType(t, v) {
  return { id: t.id, name: v.name(t.name), heightU: t.heightU, widthMm: t.widthMm ?? null, depthMm: t.depthMm ?? null };
}

/** 랙. */
export function projectRack(r, v) {
  return {
    id: r.id, roomId: r.roomId, name: v.name(r.name), row: v.text(r.row), typeId: r.typeId, heightU: r.heightU, role: v.text(r.role),
    pduA: r.pduA, pduB: r.pduB, sort: r.sort,
  };
}

/** 장비(배치). 연결 정보(`link` · `linkState`)는 라우트가 붙인다. */
export function projectPlace(p, v) {
  const own = [p.serial, ...(p.extraSerials || [])].filter(Boolean);
  const out = {
    id: p.id, rackId: p.rackId, face: p.face, uStart: p.uStart, uSize: p.uSize, kind: p.kind,
    label: v.name(p.label, own), model: v.text(p.model, own),
    ratedW: p.ratedW ?? null, opW: p.opW ?? null, weightKg: p.weightKg ?? null, updatedAt: p.updatedAt,
  };
  if (v.admin) { out.serial = p.serial; out.extraSerials = p.extraSerials || []; out.note = p.note; }
  else if (v.showSerial) { out.serial = v.serial(p.serial); out.extraSerials = (p.extraSerials || []).map((x) => v.serial(x)).filter(Boolean); }
  else { out.serial = ''; out.extraSerials = []; out.serialHidden = true; }
  return out;
}

/** 연결된 서버의 하드웨어 요약 — 비관리자에게는 화면이 쓰는 칸만(호스트 이름 · OS 는 관리자만). */
export function projectHw(hw, v) {
  if (!hw || v.admin) return hw || null;
  return {
    cpu: hw.cpu ? { sockets: hw.cpu.sockets ?? null, model: v.text(String(hw.cpu.model || '')) } : null,
    mem: hw.mem ? { gib: hw.mem.gib ?? null } : null,
    fw: v.text(String(hw.fw || '')),
  };
}

/**
 * 판 차이 한 묶음(`changes` · `restore`)의 항목 — 이름은 db 층이 이미 가렸다(`versionDetail maskItem` — 그 장비의 시리얼을 함께 본다).
 * 여기서는 위치 글(`where` — 랙 이름이 들어 있다)을 가리고, 관리자 전용 칸의 이름을 `fields` 에서 뺀다.
 */
const ADMIN_ONLY_FIELDS = new Set(['note']);
export function projectDiff(part, v) {
  if (!part || v.admin) return part || null;
  return {
    counts: part.counts,
    omitted: part.omitted,
    items: (part.items || []).map((it) => {
      const o = { type: it.type, op: it.op, id: it.id, name: it.name };
      if (it.where !== undefined) o.where = v.text(String(it.where || ''));
      if (it.fields !== undefined) o.fields = (it.fields || []).filter((f) => !ADMIN_ONLY_FIELDS.has(f));
      return o;
    }),
  };
}
