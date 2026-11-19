/**
 * sshAccessParts.jsx — 설정 › 보안 › 서버 접속 화면 두 파일(SshAccessSettings · ServerAccessHier)이 함께 쓰는 작은 조각(v3.24 — 같은 것을 두 벌 두지 않게 옮겼다).
 *  · must: 쓰기 응답의 ok:false(400 · 409 를 던지지 않는 api.js 경로)를 오류로 바꾼다(5축 점검 E-H1).
 *  · FeaturePicker 는 렌더 밖 컴포넌트(안에서 정의하면 누를 때마다 다시 마운트돼 포커스를 잃는다 · E-L1).
 */
import React from 'react';
import { toneVar } from './tools/toneVar.js';

export const errText = (e) => e?.body?.reason || e?.message || String(e);
/** 쓰기 응답 — ok:false(400 · 409 를 던지지 않는 api.js 경로)를 오류로 바꾼다. */
export function must(r) {
  if (r && r.ok === false) { const e = new Error(r.reason || r.code || '실패했습니다'); e.body = r; throw e; }
  return r;
}
export const Chip = ({ tone = 'muted', children, title }) => <span className="ssa-chip" style={{ color: toneVar(tone), borderColor: 'currentColor' }} title={title}>{children}</span>;
export const Otp = ({ value, onChange }) => (
  <label className="ssa-otp">본인 OTP <input className="input" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} maxLength={8} autoComplete="one-time-code" /></label>
);
/**
 * 쓸 수 있는 기능 고르기. allowAll: ‘제한 없음(예전 방식)’ 칸을 보인다(값 null). 예전 키 · 계정을 편집 폼에서 저장만 해도 기능이 비는 사고를 막는다(E-H3).
 */
export function FeaturePicker({ catalog, value, onChange, allowAll = false }) {
  const all = value == null;
  const list = Array.isArray(value) ? value : [];
  return (
    <div className="ssa-feats" role="group" aria-label="쓸 수 있는 기능">
      {allowAll && <label><input type="checkbox" checked={all} onChange={() => onChange(all ? [] : null)} /> 제한 없음(예전 방식 — 모든 기능)</label>}
      {(catalog || []).map((f) => (
        <label key={f.id}><input type="checkbox" disabled={all} checked={all || list.includes(f.id)} onChange={() => onChange(list.includes(f.id) ? list.filter((x) => x !== f.id) : [...list, f.id])} /> {f.label}{f.ready === false ? ' (다음 단계)' : ''}</label>
      ))}
    </div>
  );
}
export const featuresChosen = (v) => v == null || (Array.isArray(v) && v.length > 0);
