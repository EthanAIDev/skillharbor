import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import { applyUsageResets, useUsage } from '../src/hooks/useUsage';

function Counter({ name }: { name: string }) {
  const { record, getUsage } = useUsage();
  return <button onClick={() => record('example')}>{name}:{getUsage('example', 10)}</button>;
}
beforeEach(() => localStorage.clear());
test('two mounted counters share clicks and resets without writing stale copies', () => {
  render(<><Counter name="home" /><Counter name="modal" /></>);
  fireEvent.click(screen.getByText('modal:10'));
  expect(screen.getByText('home:11')).toBeTruthy();
  fireEvent.click(screen.getByText('home:11'));
  expect(screen.getByText('modal:12')).toBeTruthy();
  act(() => applyUsageResets({ example: 123 }));
  expect(screen.getByText('home:10')).toBeTruthy();
  expect(screen.getByText('modal:10')).toBeTruthy();
  fireEvent.click(screen.getByText('modal:10'));
  act(() => applyUsageResets({ example: 123 }));
  expect(screen.getByText('home:11')).toBeTruthy();
});

test('storage changes and clears refresh all mounted counters', () => {
  render(<><Counter name="home" /><Counter name="modal" /></>);
  act(() => {
    localStorage.setItem('skillharbor-usage-v2', '{"example":7}');
    window.dispatchEvent(new StorageEvent('storage', { key: 'skillharbor-usage-v2' }));
  });
  expect(screen.getByText('home:17')).toBeTruthy();
  expect(screen.getByText('modal:17')).toBeTruthy();
  act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: null })); });
  expect(screen.getByText('home:10')).toBeTruthy();
});
