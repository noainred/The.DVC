// 결정(76~105 남긴 것 · 2026-11-20) A2: '빈 칸 = 비움' 계약 화면(CVP · Veeam)의 안내 문구 — 계약은 바꾸지 않고 화면이 차이를 말한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CVP_BLANK_NOTE, VEEAM_BLANK_NOTE } from './bulkBlankText.js';

const read = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('A2 대량 등록 빈 칸 안내', () => {
  it('문구는 백틱 없이 agent 를 비우면 중앙 직접임을 말한다', () => {
    for (const t of [CVP_BLANK_NOTE, VEEAM_BLANK_NOTE]) {
      expect(t.includes('`')).toBe(false);
      expect(t).toMatch(/agent 를 비우면 중앙 직접/);
      expect(t).toMatch(/머리말에 없는 열/);
    }
    expect(CVP_BLANK_NOTE).toMatch(/인증 방식 · TLS 검증 · 사용 여부 칸은 비워도 유지/);
    expect(VEEAM_BLANK_NOTE).toMatch(/vCenter 칸은 비워도 유지/);
  });
  it('CVP · Veeam 모달이 blankNote 로 문구를 넘기고, 빈 칸 = 유지 화면(스토리지 · SAN)은 넘기지 않는다', () => {
    expect(read('./CvpBulkIo.jsx')).toMatch(/blankNote=\{CVP_BLANK_NOTE\}/);
    expect(read('../VeeamSettings.jsx')).toMatch(/blankNote=\{VEEAM_BLANK_NOTE\}/);
    expect(read('./BulkDeviceIo.jsx')).toMatch(/!blankKeeps && blankNote/);
    for (const f of ['./SanSwitchTool.jsx', './StorageMonTool.jsx']) expect(read(f)).not.toMatch(/blankNote=/);
  });
});
