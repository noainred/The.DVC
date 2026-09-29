/**
 * cvpBulkText.test.js — CVP 대량 등록 화면 경로·문구(v2.641).
 *  · 경로는 서버 routes/api/cvpBulk.js 와 1:1(서버 소스를 읽어 대조 — 한쪽만 바뀌면 404 가 된다)
 *  · 비밀 포함 경고는 '평문'·'토큰'·'설정 소유' 를 말하고 백틱이 없다(BoldText 는 **강조** 만 해석)
 *  · 403 문구는 소유자 게이트와 권한 부족을 나눈다
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CVP_BULK_BASE, CVP_BULK_RESOURCE, cvpExportUrl, SECRET_EXPORT_WARNING, PLAIN_EXPORT_NOTE, IMPORT_NOTE, exportErrorText,
} from './cvpBulkText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROUTE = path.resolve(HERE, '../../../../server/src/routes/api/cvpBulk.js');

describe('CVP 대량 등록 경로', () => {
  it('서버 라우트의 BASE 와 같다', () => {
    const src = fs.readFileSync(SERVER_ROUTE, 'utf8');
    expect(src).toContain(`const BASE = '${CVP_BULK_BASE}/${CVP_BULK_RESOURCE}';`);
  });
  it('내보내기 경로 — 기본은 비밀 없음, secrets 만 ?secrets=1', () => {
    expect(cvpExportUrl()).toBe('/tools/cvp/bulk/servers/export.csv');
    expect(cvpExportUrl({ secrets: true })).toBe('/tools/cvp/bulk/servers/export.csv?secrets=1');
  });
  it('기존 /tools/cvp/servers/:id 경로와 겹치지 않는다', () => {
    expect(CVP_BULK_BASE).not.toBe('/tools/cvp');
  });
});

describe('문구', () => {
  it('비밀 포함 경고는 평문·토큰·설정 소유·감사를 말한다', () => {
    for (const w of ['평문', '토큰', '비밀번호', '설정 소유', '감사']) expect(SECRET_EXPORT_WARNING).toContain(w);
  });
  it('백틱이 없다(BoldText 는 **강조** 만 해석)', () => {
    for (const t of [SECRET_EXPORT_WARNING, PLAIN_EXPORT_NOTE, IMPORT_NOTE]) expect(t.includes('`')).toBe(false);
  });
  it('403 — 비밀 포함은 소유자 안내, 일반은 권한 안내', () => {
    expect(exportErrorText({ status: 403 }, { secrets: true })).toMatch(/설정 소유 계정/);
    expect(exportErrorText({ status: 403 }, { secrets: false })).toMatch(/권한이 없습니다/);
    expect(exportErrorText(new Error('boom'))).toBe('내보내기 실패: boom');
    expect(exportErrorText(null)).toBe('내보내기 실패: 알 수 없는 오류');
  });
});
