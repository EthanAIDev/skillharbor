import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import ZbModal from '../src/components/ZbModal';

function Example({ conditional }: { conditional: boolean }) {
  const [open, setOpen] = useState(false);
  const modal = <ZbModal open={open} onClose={() => setOpen(false)} label="资源详情"><button onClick={() => setOpen(false)}>关闭详情</button></ZbModal>;
  return <><button onClick={() => setOpen(true)}>查看资源</button>{conditional ? open && modal : modal}</>;
}

test.each([true, false])('closing a %s conditionally mounted modal restores focus to its exact opener', async (conditional) => {
  render(<Example conditional={conditional} />);
  const opener = screen.getByRole('button', { name: '查看资源' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: '资源详情' });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

test('a nested dialog restores the parent control before the outer dialog restores its opener', async () => {
  function Nested() {
    const [parent, setParent] = useState(false);
    const [child, setChild] = useState(false);
    return <><button onClick={() => setParent(true)}>打开父窗口</button>{parent && <ZbModal open onClose={() => setParent(false)} label="父窗口">
      <button onClick={() => setChild(true)}>打开子窗口</button>
      {child && <ZbModal open onClose={() => setChild(false)} label="子窗口"><button>子窗口按钮</button></ZbModal>}
    </ZbModal>}</>;
  }
  render(<Nested />);
  const outerOpener = screen.getByRole('button', { name: '打开父窗口' });
  outerOpener.focus(); fireEvent.click(outerOpener);
  const innerOpener = await screen.findByRole('button', { name: '打开子窗口' });
  innerOpener.focus(); fireEvent.click(innerOpener);
  await screen.findByRole('dialog', { name: '子窗口' });
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(innerOpener));
  expect(screen.getByRole('dialog', { name: '父窗口' })).toBeTruthy();
  fireEvent.keyDown(innerOpener, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(outerOpener));
});
