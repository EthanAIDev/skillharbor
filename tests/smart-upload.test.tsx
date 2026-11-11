import { expect, test, vi } from 'vitest';
import { smartUpload, type SmartAnalysis } from '../src/services/smartUpload';

// Service contracts retained after the separate smart-upload screen was removed.
const ready: SmartAnalysis = {
  status: 'ready',
  kind: 'agent',
  resource: {
    name: '项目助理',
    description: '整理项目资料并生成报告',
    functions: [
      { name: '整理资料', source: 'package' },
      { name: '生成报告', source: 'registry' },
    ],
  },
  issues: [],
  repairText: '',
  revision: 1,
  newResource: true,
};
const row = { id: 'draft-x' };

test.each(
  [
    null,
    {},
    7,
    [''],
    ['正常工具', 5],
    ['x\u0085y'],
    ['\uD800'],
    ['\uDFFF'],
    ['\uDC00\uD800'],
    Array(129).fill('工具'),
    ['𠮷'.repeat(257)],
  ].map((value) => [value]),
)(
  'analyze rejects malformed runtime requirements without accepting ready (%j)',
  async (runtimeRequirements) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          analysis: { ...ready, runtimeRequirements },
        }),
      ),
    );
    expect(await smartUpload.analyze(row.id, {})).toMatchObject({
      ok: false,
      message: expect.stringContaining('格式异常'),
    });
  },
);

test('runtime requirements limits count Unicode code points and accept legacy absence', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          analysis: { ...ready, runtimeRequirements: ['𠮷'.repeat(256)] },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, analysis: ready })),
    );
  expect((await smartUpload.analyze(row.id, {})).ok).toBe(true);
  expect((await smartUpload.analyze(row.id, {})).ok).toBe(true);
});


test('analyze service authenticates exact draft and rejects invalid response', async () => {
  localStorage.setItem('skillharbor-token', 'local-session');
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ ok: true, id: row.id, analysis: ready, revision: 1 }),
  } as Response);
  expect(
    (await smartUpload.analyze('draft/with spaces', { revision: 0 })).ok,
  ).toBe(true);
  expect(fetch).toHaveBeenCalledWith(
    '/api/uploads/draft%2Fwith%20spaces/analyze',
    expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer local-session',
      },
      body: '{"revision":0}',
    }),
  );
  vi.mocked(fetch).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ ok: true }),
  } as Response);
  expect((await smartUpload.analyze(row.id, {})).ok).toBe(false);
});
