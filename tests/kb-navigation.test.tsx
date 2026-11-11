import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import KbExplorer from '../src/pages/KbExplorer';
import { StrictMode } from 'react';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve!: (value: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; };
const repos = [{ id: '1', name: '甲库', tier: 'dept', canWrite: true }, { id: '2', name: '乙库', tier: 'private', canWrite: false }];
const file = (name: string) => ({ name, type: 'file', docId: name, path: '', size: 1 });
function setup(route: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined, strict = false) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const custom = route(url, init);
    if (custom) return custom;
    if (url.pathname.endsWith('/repos')) return json({ ok: true, v2: true, hasPrivate: true, repos });
    if (url.pathname.endsWith('/stats')) return json({ ok: true, total: 0, byRepo: [] });
    if (url.pathname.endsWith('/perm')) return json({ ok: true, canWrite: url.searchParams.get('reposId') === '1', tier: 'dept' });
    return json({ ok: true, entries: [] });
  });
  render(strict ? <StrictMode><KbExplorer meName="测试" /></StrictMode> : <KbExplorer meName="测试" />);
}
async function open(name: string) { fireEvent.click(await screen.findByText(name)); }
function home() { fireEvent.click(screen.getByRole('button', { name: '知识库' })); }

test('late list and permission results cannot replace the newly opened library', async () => {
  const list = deferred(), perm = deferred();
  setup(url => url.searchParams.get('reposId') === '1' ? url.pathname.endsWith('/list') ? list.promise : url.pathname.endsWith('/perm') ? perm.promise : undefined : url.pathname.endsWith('/list') ? json({ entries: [file('乙文件.txt')] }) : undefined);
  await open('甲库'); home(); await open('乙库');
  await screen.findByText('乙文件.txt');
  await act(async () => { list.resolve(json({ entries: [file('甲文件.txt')] })); perm.resolve(json({ canWrite: true })); });
  expect(screen.queryByText('甲文件.txt')).toBeNull();
  expect(screen.getByText('乙文件.txt')).toBeTruthy();
  expect(screen.queryByText('上传文件')).toBeNull();
});

test('R1 a pending create keeps its original target and cannot refresh a new library', async () => {
  const write = deferred(); let body: any;
  setup((url, init) => url.pathname.endsWith('/mkdir') ? (body = JSON.parse(String(init?.body)), write.promise) : url.pathname.endsWith('/list') ? json({ entries: [file(url.searchParams.get('reposId') === '1' ? '甲.txt' : '乙.txt')] }) : undefined);
  await open('甲库'); fireEvent.click(await screen.findByText('新建目录'));
  fireEvent.change(screen.getByRole('dialog').querySelector('input')!, { target: { value: '新目录' } });
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' })); home(); await open('乙库'); await screen.findByText('乙.txt');
  await act(async () => write.resolve(json({ ok: true })));
  expect(body).toEqual({ reposId: '1', path: '', name: '新目录' });
  expect(screen.queryByText('甲.txt')).toBeNull();
  expect(screen.getByText('乙.txt')).toBeTruthy();
});

test('R4 a delayed document handoff cannot open after the user leaves', async () => {
  const search = deferred(); localStorage.setItem('kb-open-doc', JSON.stringify({ q: '开发指南' }));
  setup(url => url.pathname.endsWith('/search') ? search.promise : undefined);
  await open('甲库'); home();
  await act(async () => search.resolve(json({ items: [{ reposId: '1', name: '开发指南.txt', path: '' }] })));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('R4 an untouched document handoff still opens under StrictMode', async () => {
  const search = deferred(); localStorage.setItem('kb-open-doc', JSON.stringify({ q: '开发指南' }));
  setup(url => url.pathname.endsWith('/search') ? search.promise.then(r => r.clone()) : url.pathname.endsWith('/preview') ? new Response('safe', { headers: { 'content-type': 'text/html' } }) : undefined, true);
  await act(async () => search.resolve(json({ items: [{ reposId: '1', name: '开发指南.txt', path: '' }] })));
  await screen.findByTitle('开发指南.txt');
});

test.each([200, 503])('R3 a closed configuration response (%i) cannot replace another library configuration', async status => {
  const old = deferred(); let saved: any;
  setup((url, init) => {
    if (url.pathname.endsWith('/repos')) return json({ v2: true, hasPrivate: true, repos: repos.map(r => ({ ...r, tier: 'dept', canManage: true })) });
    if (url.pathname.endsWith('/people')) return json({ groups: [], depts: ['本部', '甲共享', '乙共享'] });
    if (url.pathname.endsWith('/repo-config')) {
      if (init?.method === 'POST') { saved = JSON.parse(String(init.body)); return json({ ok: true }); }
      return url.searchParams.get('reposId') === '1' ? old.promise : json({ maintainers: [], readDepts: ['乙共享'], isAdmin: true, dept: '本部' });
    }
  });
  fireEvent.click((await screen.findAllByRole('button', { name: '权限' }))[0]);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.click(screen.getAllByRole('button', { name: '权限' })[1]);
  await screen.findByRole('button', { name: /乙共享/ });
  await act(async () => old.resolve(json({ maintainers: [{ username: 'old' }], readDepts: ['甲共享'], isAdmin: false, dept: '本部' }, status)));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(saved).toEqual({ reposId: '2', maintainers: [], readDepts: ['乙共享'] }));
});

test.each(['directory', 'modal'])('R1 a stale create cannot affect a new %s in the same library', async destination => {
  const write = deferred();
  setup(url => url.pathname.endsWith('/mkdir') ? write.promise : url.pathname.endsWith('/list') ? json({ entries: url.searchParams.has('docId') ? [file('子文件.txt')] : [{ name: '子目录', type: 'dir', docId: 9, path: '' }] }) : undefined);
  await open('甲库'); fireEvent.click(await screen.findByText('新建目录'));
  fireEvent.change(screen.getByRole('dialog').querySelector('input')!, { target: { value: '旧创建' } });
  fireEvent.click(screen.getByRole('button', { name: '创建' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  if (destination === 'directory') { fireEvent.click(screen.getByTitle('打开目录')); await screen.findByText('子文件.txt'); }
  else { fireEvent.click(screen.getByText('新建目录')); fireEvent.change(screen.getByRole('dialog').querySelector('input')!, { target: { value: '新草稿' } }); }
  await act(async () => write.resolve(json({ ok: true })));
  if (destination === 'directory') expect(screen.getByText('子文件.txt')).toBeTruthy();
  else expect(screen.getByDisplayValue('新草稿')).toBeTruthy();
});

test('R1 an old configuration save cannot close a newly opened configuration', async () => {
  const save = deferred();
  setup((url, init) => {
    if (url.pathname.endsWith('/repos')) return json({ v2: true, repos: repos.map(r => ({ ...r, canManage: true })) });
    if (url.pathname.endsWith('/people')) return json({ groups: [], depts: [] });
    if (url.pathname.endsWith('/repo-config')) return init?.method === 'POST' ? save.promise : json({ maintainers: [], whitelist: [], isAdmin: true });
  });
  fireEvent.click((await screen.findAllByRole('button', { name: '权限' }))[0]);
  fireEvent.click(await screen.findByRole('button', { name: '保存' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '共享' }));
  await screen.findByRole('button', { name: '保存' });
  await act(async () => save.resolve(json({ ok: true })));
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('R2 failed target loading blocks move and can retry without changing the target', async () => {
  let failed = true;
  setup(url => url.pathname.endsWith('/list') ? url.searchParams.has('docId') ? failed ? json({ message: '目标失败' }, 503) : json({ entries: [] }) : json({ entries: [{ name: 'X', type: 'dir', docId: 11, path: '', level: 0 }, { ...file('源.txt'), pid: 99 }] }) : undefined);
  await open('甲库'); fireEvent.click((await screen.findAllByTitle('更多')).at(-1)!); fireEvent.click(screen.getByText('移动到…'));
  fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'X' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: '移动到这里' }) as HTMLButtonElement).disabled).toBe(true);
  failed = false; fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '移动到这里' }) as HTMLButtonElement).disabled).toBe(false));
});

test.each([false, true])('R2 move target and POST stay aligned after X returns late (batch=%s)', async batch => {
  const old = deferred(); let saved: any;
  setup((url, init) => {
    if (url.pathname.endsWith('/move')) { saved = JSON.parse(String(init?.body)); return json({ ok: true }); }
    if (url.pathname.endsWith('/list')) return url.searchParams.get('docId') === '11' ? old.promise : json({ entries: url.searchParams.has('docId') ? [] : [{ name: 'X', type: 'dir', docId: 11, level: 0, path: '' }, { name: 'Y', type: 'dir', docId: 22, level: 0, path: '' }, { ...file('源.txt'), pid: 99 }] });
  });
  await open('甲库'); await screen.findByText('上传文件');
  if (batch) {
    fireEvent.click(screen.getByText('批量操作'));
    fireEvent.click(screen.getByTitle('源.txt').closest('tr')!.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: '移动' }));
  } else { fireEvent.click(screen.getAllByTitle('更多').at(-1)!); fireEvent.click(screen.getByText('移动到…')); }
  fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'X' }));
  expect((screen.getByRole('button', { name: batch ? '移动 1 项到这里' : '移动到这里' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '甲库' }));
  fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Y' }));
  await act(async () => old.resolve(json({ entries: [{ name: '旧目标', type: 'dir', docId: 33 }] })));
  expect(screen.queryByText('旧目标')).toBeNull();
  await waitFor(() => expect((screen.getByRole('button', { name: batch ? '移动 1 项到这里' : '移动到这里' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: batch ? '移动 1 项到这里' : '移动到这里' }));
  await waitFor(() => expect(saved).toMatchObject({ reposId: '1', srcName: '源.txt', dstPid: '22', dstPath: 'Y/' }));
});

test('R2 closing and reopening move for a different file invalidates old target loading', async () => {
  const old = deferred();
  setup(url => url.pathname.endsWith('/list') ? url.searchParams.has('docId') ? old.promise : json({ entries: [{ name: 'X', type: 'dir', docId: 11, level: 0, path: '' }, file('甲.txt'), file('乙.txt')] }) : undefined);
  await open('甲库'); await screen.findByText('上传文件');
  const more = (name: string) => fireEvent.click(screen.getByTitle(name).closest('tr')!.querySelector('button[title="更多"]')!);
  more('甲.txt'); fireEvent.click(screen.getByText('移动到…'));
  fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'X' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  more('乙.txt'); fireEvent.click(screen.getByText('移动到…'));
  await within(screen.getByRole('dialog')).findByRole('button', { name: 'X' });
  await act(async () => old.resolve(json({ entries: [{ name: '旧目标', type: 'dir', docId: 33 }] })));
  expect(screen.queryByText('旧目标')).toBeNull();
  expect(screen.getByText('对象：乙.txt')).toBeTruthy();
});

test('R1 an old batch completes writes in its original library without refreshing the new one', async () => {
  const first = deferred(); const writes: any[] = [];
  setup((url, init) => url.pathname.endsWith('/delete') ? (writes.push(JSON.parse(String(init?.body))), writes.length === 1 ? first.promise : json({ ok: true })) : url.pathname.endsWith('/list') ? json({ entries: url.searchParams.get('reposId') === '1' ? [file('甲.txt'), file('乙.txt')] : [file('新库.txt')] }) : undefined);
  await open('甲库'); fireEvent.click(await screen.findByText('批量操作')); fireEvent.click(screen.getByText('全选')); fireEvent.click(screen.getByRole('button', { name: '删除' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /删除/ }));
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }); home(); await open('乙库'); await screen.findByText('新库.txt');
  await act(async () => first.resolve(json({ ok: true })));
  expect(writes).toEqual([{ reposId: '1', path: '', name: '甲.txt', type: 'file' }, { reposId: '1', path: '', name: '乙.txt', type: 'file' }]);
  expect(screen.getByText('新库.txt')).toBeTruthy();
  expect(screen.queryByText('已删除 2 项', { exact: false })).toBeNull();
});

test('R1 stale upload progress and completion cannot clear a newer upload', async () => {
  const requests: any[] = [];
  vi.stubGlobal('XMLHttpRequest', class {
    upload = {} as any; status = 200; responseText = '{"ok":true}'; onload!: () => void;
    open(_method: string, url: string) { (this as any).url = url; }
    setRequestHeader() {} send(body: FormData) { requests.push(this); (this as any).body = body; }
  });
  setup(url => url.pathname.endsWith('/perm') ? json({ canWrite: true }) : undefined);
  await open('甲库'); await screen.findByText('上传文件');
  const pick = (name: string) => fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], name)] } });
  pick('旧上传.txt'); home(); await open('乙库'); await screen.findByText('上传文件'); pick('新上传.txt');
  await act(async () => { requests[0].upload.onprogress({ lengthComputable: true, loaded: 1, total: 1 }); requests[0].onload(); });
  expect(requests[0].url).toContain('reposId=1'); expect(requests[1].url).toContain('reposId=2');
  expect(screen.getByText('新上传.txt')).toBeTruthy(); expect(screen.queryByText('旧上传.txt')).toBeNull();
  await act(async () => requests[1].onload());
});

test('R1 a delayed private-library deletion cannot leave the newly opened library', async () => {
  const deletion = deferred(); vi.spyOn(window, 'prompt').mockReturnValue('甲库');
  setup(url => {
    if (url.pathname.endsWith('/repos')) return json({ v2: true, hasPrivate: true, repos: repos.map(r => ({ ...r, tier: 'private', canManage: true })) });
    if (url.pathname.endsWith('/perm')) return json({ canWrite: true, tier: 'private', canManage: true, isPrivateMine: true });
    if (url.pathname.endsWith('/people')) return json({ groups: [], depts: [] });
    if (url.pathname.endsWith('/repo-config')) return json({ whitelist: [] });
    if (url.pathname.endsWith('/priv-delete')) return deletion.promise;
    if (url.pathname.endsWith('/list')) return json({ entries: [file('当前库.txt')] });
  });
  await open('甲库'); fireEvent.click(await screen.findByRole('button', { name: /共享设置/ }));
  fireEvent.click(await screen.findByRole('button', { name: '删除私有库…' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' })); home(); await open('乙库'); await screen.findByText('当前库.txt');
  await act(async () => deletion.resolve(json({ ok: true })));
  expect(screen.getByText('当前库.txt')).toBeTruthy(); expect(screen.getByRole('button', { name: '乙库' })).toBeTruthy();
});

test('R5 deleting the current private library refreshes home and restores the create entry', async () => {
  let deleted = false; vi.spyOn(window, 'prompt').mockReturnValue('甲库');
  setup(url => {
    if (url.pathname.endsWith('/repos')) return json({ v2: true, hasPrivate: !deleted, repos: deleted ? [repos[1]] : [{ ...repos[0], tier: 'private', canManage: true }, repos[1]] });
    if (url.pathname.endsWith('/perm')) return json({ canWrite: true, tier: 'private', canManage: true, isPrivateMine: true });
    if (url.pathname.endsWith('/people')) return json({ groups: [], depts: [] });
    if (url.pathname.endsWith('/repo-config')) return json({ whitelist: [] });
    if (url.pathname.endsWith('/priv-delete')) { deleted = true; return json({ ok: true }); }
  });
  await open('甲库'); fireEvent.click(await screen.findByRole('button', { name: /共享设置/ }));
  fireEvent.click(await screen.findByRole('button', { name: '删除私有库…' }));
  await screen.findByRole('button', { name: '＋ 新建我的私有库' });
  expect(screen.queryByText('甲库')).toBeNull();
  expect(screen.getByText('乙库')).toBeTruthy();
});

test('R6 a pending batch freezes every target control and completes at its original target', async () => {
  const first = deferred(); const writes: any[] = [];
  setup((url, init) => {
    if (url.pathname.endsWith('/move')) { writes.push(JSON.parse(String(init?.body))); return writes.length === 1 ? first.promise : json({ ok: true }); }
    if (url.pathname.endsWith('/list')) return json({ entries: url.searchParams.has('docId') ? [{ name: 'Y', type: 'dir', docId: 22, level: 1, path: 'X/' }] : [{ name: 'X', type: 'dir', docId: 11, level: 0, path: '' }, { ...file('甲.txt'), pid: 99 }, { ...file('乙.txt'), pid: 99 }] });
  });
  await open('甲库'); fireEvent.click(await screen.findByText('批量操作'));
  for (const name of ['甲.txt', '乙.txt']) fireEvent.click(screen.getByTitle(name).closest('tr')!.querySelector('input')!);
  fireEvent.click(screen.getByRole('button', { name: '移动' }));
  fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'X' }));
  await within(screen.getByRole('dialog')).findByRole('button', { name: 'Y' });
  fireEvent.click(screen.getByRole('button', { name: '移动 2 项到这里' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  for (const name of ['甲库', 'X', 'Y']) {
    const target = within(screen.getByRole('dialog')).getByRole('button', { name }) as HTMLButtonElement;
    expect(target.disabled).toBe(true);
    fireEvent.click(target);
  }
  await act(async () => first.resolve(json({ ok: true })));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(writes.map(w => ({ reposId: w.reposId, dstPid: w.dstPid, dstPath: w.dstPath, srcName: w.srcName }))).toEqual([
    { reposId: '1', dstPid: '11', dstPath: 'X/', srcName: '甲.txt' },
    { reposId: '1', dstPid: '11', dstPath: 'X/', srcName: '乙.txt' },
  ]);
  expect(screen.queryByText(/移动中|处理中/)).toBeNull();
});

test('R2 a delayed move target cannot replace root after returning', async () => {
  const old = deferred();
  const dirs = [{ name: 'X', type: 'dir', docId: 11, level: 0, path: '' }];
  setup(url => url.pathname.endsWith('/list') ? url.searchParams.get('docId') === '11' ? old.promise : json({ entries: [...dirs, { ...file('源.txt'), pid: 99, level: 0 }] }) : undefined);
  await open('甲库'); fireEvent.click((await screen.findAllByTitle('更多')).at(-1)!);
  fireEvent.click(screen.getByText('移动到…'));
  fireEvent.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'X' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '甲库' }));
  await within(screen.getByRole('dialog')).findByRole('button', { name: 'X' });
  await act(async () => old.resolve(json({ entries: [{ name: 'X内旧节点', type: 'dir', docId: 12, level: 1, path: 'X/' }] })));
  expect(screen.queryByText('X内旧节点')).toBeNull();
});

test('switching library clears write controls while permission is pending or fails', async () => {
  const perm = deferred();
  setup(url => url.pathname.endsWith('/perm') && url.searchParams.get('reposId') === '2' ? perm.promise : undefined);
  await open('甲库'); await screen.findByText('上传文件');
  home(); await open('乙库');
  expect(screen.queryByText('上传文件')).toBeNull();
  await act(async () => perm.resolve(json({ message: '权限查询失败' }, 503)));
  expect(screen.queryByText('上传文件')).toBeNull();
});

test('search location at root resets the previous path and loads destination permissions', async () => {
  setup(url => url.pathname.endsWith('/search') ? json({ items: [{ reposId: '2', repos: '乙库', name: '命中文件.txt', path: '', size: 1 }] }) : url.pathname.endsWith('/list') ? json({ entries: url.searchParams.get('reposId') === '2' ? [file('根文件.txt')] : [{ name: '旧目录', type: 'dir', docId: 9, path: '' }] }) : undefined);
  await open('甲库'); await screen.findByText('上传文件');
  fireEvent.click(await screen.findByTitle('打开目录'));
  fireEvent.change(screen.getByPlaceholderText('搜索全部知识库…'), { target: { value: '命中' } });
  fireEvent.keyDown(screen.getByPlaceholderText('搜索全部知识库…'), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: '定位' }));
  await screen.findByText('根文件.txt');
  expect(screen.queryByText('上传文件')).toBeNull();
  expect(screen.queryByRole('button', { name: '旧目录' })).toBeNull();
  expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/perm?reposId=2'))).toBe(true);
});

test('closing a pending preview prevents reopening and permits another preview', async () => {
  const preview = deferred();
  setup(url => url.pathname.endsWith('/list') ? json({ entries: [file('预览.txt')] }) : url.pathname.endsWith('/preview') ? preview.promise : undefined);
  await open('甲库');
  fireEvent.click(await screen.findByTitle('预览'));
  fireEvent.click(screen.getByRole('button', { name: '✕' }));
  await act(async () => preview.resolve(new Response('text', { headers: { 'content-type': 'text/html' } })));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByTitle('预览'));
  await screen.findByTitle('预览.txt');
});

test('a late child directory result cannot replace root after navigating back', async () => {
  const child = deferred();
  setup(url => url.pathname.endsWith('/list') ? url.searchParams.has('docId') ? child.promise : json({ entries: [{ name: '子目录', type: 'dir', docId: 9, path: '' }] }) : undefined);
  await open('甲库'); fireEvent.click(await screen.findByTitle('打开目录'));
  fireEvent.click(screen.getAllByRole('button', { name: '甲库' })[0]);
  await screen.findByTitle('打开目录');
  await act(async () => child.resolve(json({ entries: [file('迟到子文件.txt')] })));
  expect(screen.queryByText('迟到子文件.txt')).toBeNull();
});

test('a late tree expansion from the old library cannot contaminate the new tree', async () => {
  const tree = deferred();
  setup(url => url.pathname.endsWith('/list') ? url.searchParams.has('docId') ? url.searchParams.get('reposId') === '1' ? tree.promise : json({ entries: [] }) : json({ entries: [{ name: '分支', type: 'dir', docId: 9, path: '' }] }) : undefined);
  await open('甲库');
  await screen.findByTitle('打开目录');
  const branch = document.querySelector('[data-node="9"]')!;
  fireEvent.click(branch.querySelector('button')!);
  home(); await open('乙库');
  await screen.findByTitle('打开目录');
  await act(async () => tree.resolve(json({ entries: [{ name: '旧树节点', type: 'dir', docId: 10, path: '分支/' }] })));
  fireEvent.click(document.querySelector('[data-node="9"] button')!);
  await waitFor(() => expect(screen.queryByText('正在加载子目录…')).toBeNull());
  expect(screen.queryByText('旧树节点')).toBeNull();
});

test('leaving a search location in flight prevents its remaining path traversal', async () => {
  const root = deferred();
  setup(url => url.pathname.endsWith('/search') ? json({ items: [{ reposId: '2', repos: '乙库', name: '命中.txt', path: '目标/', size: 1 }] }) : url.pathname.endsWith('/list') ? url.searchParams.get('reposId') === '2' ? root.promise : json({ entries: [file('甲文件.txt')] }) : undefined);
  await open('甲库'); await screen.findByText('甲文件.txt');
  fireEvent.change(screen.getByPlaceholderText('搜索全部知识库…'), { target: { value: '命中' } });
  fireEvent.keyDown(screen.getByPlaceholderText('搜索全部知识库…'), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: '定位' }));
  home(); await open('甲库'); await screen.findByText('甲文件.txt');
  await act(async () => root.resolve(json({ entries: [{ name: '目标', type: 'dir', docId: 7, path: '' }] })));
  expect(screen.queryByText('目标')).toBeNull();
  expect(screen.getByText('甲文件.txt')).toBeTruthy();
});
