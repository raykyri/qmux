import assert from 'node:assert/strict';
import { test, after, afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage', 'navigator']) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 0, cancelAnimationFrame: () => { } });
const { createRoot } = await import('react-dom/client');
const { default: Launcher } = await import('../src/components/GlobalTaskLauncher');
const container = document.getElementById('root')!;
const draftKey = 'qmux.interface-draft.global-task-launcher';
let finish!: (value?: unknown) => void;
let fail!: (error: unknown) => void;
const { emit } = await import('@tauri-apps/api/event');
let root = createRoot(container);
afterEach(async () => { await act(() => root.unmount()); root = createRoot(container); });
after(async () => { await act(() => root.unmount()); dom.window.close(); });
let backendDraft: string | null = null;
let dismissCount = 0;
mockWindows('global-task-launcher');
mockIPC((cmd, args: any) => {
  if (cmd === 'get_runtime_config')
    return { adapters: [], remotes: [] };
  if (cmd === 'list_panes')
    return [{ id: 'p', title: 'Test target', kind: 'agent', groupId: 'g', cwd: '/tmp', status: 'running' }];
  if (cmd === 'list_agents')
    return [{ id: 'a', paneId: 'p', groupId: 'g', adapter: 'claude', status: 'idle', createdAt: 1 }];
  if (['list_groups', 'list_shell_agent_jobs', 'list_agent_turn_queue', 'list_turns'].includes(cmd))
    return [];
  if (cmd === 'interface_draft_get')
    return backendDraft;
  if (cmd === 'interface_draft_set') {
    backendDraft = args.value;
    return;
  }
  if (cmd === 'agent_submit_turn')
    return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  if (cmd === 'global_task_launcher_dismiss') {
    dismissCount++;
    throw new Error('hide failed');
  }
  return undefined;
}, { shouldMockEvents: true });
async function type(text: string) {
  const input = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
test('replacement draft remains persisted after successful pending send', async () => {
  await act(() => root.render(h(Launcher)));
  await type('First question');
  assert.match(sessionStorage.getItem(draftKey)!, /First question/);
  const send = [...container.querySelectorAll('button')].find(button => button.querySelector('span')?.textContent === 'Send')!;
  await act(() => send.click());
  assert.equal(typeof finish, 'function');
  await type('Different question');
  assert.match(sessionStorage.getItem(draftKey)!, /Different question/);
  assert.match(backendDraft!, /Different question/);
  await act(() => finish({}));
  assert.equal(container.querySelector('textarea')!.value, 'Different question');
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(dismissCount, 1);
  console.log({ uiValue: container.querySelector('textarea')!.value, localDraft: sessionStorage.getItem(draftKey), backendDraft });
  assert.match(backendDraft!, /Different question/);
});
async function mountAndSend() {
  await act(() => root.render(h(Launcher)));
  await type('Original');
  const send = [...container.querySelectorAll('button')].find(button => button.querySelector('span')?.textContent === 'Send')!;
  await act(() => send.click());
}
async function remount() {
  await act(() => root.unmount());
  root = createRoot(container);
  await act(() => root.render(h(Launcher)));
}
test('untouched send clears both persistent copies', async () => {
  await mountAndSend();
  await act(() => finish({}));
  assert.equal(container.querySelector('textarea')!.value, '');
  assert.equal(sessionStorage.getItem(draftKey), null);
  assert.equal(backendDraft, null);
});
test('appended remainder survives remount and old completion', async () => {
  await mountAndSend();
  await remount();
  await type('Original\nNext');
  await act(() => finish({}));
  assert.equal(container.querySelector('textarea')!.value, 'Next');
  assert.match(backendDraft!, /Next/);
  await remount();
  assert.equal(container.querySelector('textarea')!.value, 'Next');
});
test('same-text replacement survives old successful submission', async () => {
  await mountAndSend();
  await type('');
  await type('Original');
  await act(() => finish({}));
  assert.equal(container.querySelector('textarea')!.value, 'Original');
  assert.match(backendDraft!, /Original/);
});
test('failed delivery preserves replacement and permits retry', async () => {
  await mountAndSend();
  await type('Changed');
  await act(() => fail(new Error('dispatch failed')));
  assert.equal(container.querySelector('textarea')!.value, 'Changed');
  assert.match(backendDraft!, /Changed/);
  assert.ok(container.querySelector('[role="alert"]'));
  const send = [...container.querySelectorAll('button')].find(button => button.querySelector('span')?.textContent === 'Send')!;
  assert.equal(send.disabled, false);
});
test('an old summon cannot dismiss the reopened launcher', async () => {
  await mountAndSend();
  const count = dismissCount;
  await act(() => emit('tauri://blur', false));
  await act(() => emit('tauri://focus', true));
  await type('New summon');
  await act(() => finish({}));
  assert.equal(dismissCount, count);
  assert.equal(container.querySelector('textarea')!.value, 'New summon');
  assert.match(backendDraft!, /New summon/);
});
