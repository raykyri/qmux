import assert from 'node:assert/strict';
import { test, after, afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement as h, useState } from 'react';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
const dom = new JSDOM('<!doctype html><div id="root"></div><button id="outside">Outside</button>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FileReader', 'File', 'Blob']) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class {
    observe() { }
    disconnect() { }
    unobserve() { }
  }
});
dom.window.HTMLElement.prototype.scrollTo = () => { };
dom.window.HTMLElement.prototype.scrollIntoView = () => { };
const { createRoot } = await import('react-dom/client');
const { ComposerDrafts } = await import('../src/lib/composerDrafts');
let composerDrafts: InstanceType<typeof ComposerDrafts>;
const { default: NativeInput } = await import('../src/components/NativeInput');
let root = createRoot(document.getElementById('root')!);
let drafts: Record<string, string>;
let selected = 'A';
let changeAgent: (id: string) => void;
let pending: Array<{
  command: string;
  args: any;
  resolve: (value: any) => void;
  reject?: (error: unknown) => void;
}> = [];
let flushers = new Set<() => void>();
let userInputs: string[] = [];
let queues: Record<string, any[]> = {};
let errors: string[] = [];
const registerFlusher = (fn: () => void) => { flushers.add(fn); return () => { flushers.delete(fn); }; };
function Harness() {
  const [id, setId] = useState('A');
  const [, redraw] = useState(0);
  changeAgent = setId;
  selected = id;
  return h(NativeInput, {
    pane: { id: 'pane-' + id } as any,
    agent: { id, adapter: 'claude', status: 'idle', sessionId: 'session-' + id } as any,
    agentMayBeBackgrounded: false, draft: drafts[id] ?? '', queuedTurns: queues[id] ?? [], waitTargets: [], queueSplit: false,
    requireCmdEnterToSend: false, pasteProtection: { confirmMultiLinePaste: true, confirmPasteOverChars: 250000 },
    hasTranscript: false, transcriptCopyPlainText: () => '', transcriptCopyJsonText: () => '', transcriptCopyHandoffText: () => null,
    onPublishTranscript() { }, composerPolicy: { readyStatuses: ['idle'], queueStatuses: ['idle'], steerStatuses: [], permissionActions: [] },
    shortcutLabelForPane: () => null,
    onQueueChange: (agentId, turns) => { queues[agentId] = turns; redraw(x => x + 1); },
    onQueueDropTargetChange() { }, onMoveQueuedTurn() { },
    composerDrafts, onDraftChange: (agentId, text) => { composerDrafts.set(agentId, text); drafts[agentId] = text; redraw(x => x + 1); }, registerDraftFlusher: registerFlusher,
    onWaitTargetHover() { }, onForkWithPrompt: () => new Promise(resolve => pending.push({ command: 'fork', args: { agentId: id }, resolve })),
    onTurnSubmitted() { }, onUserInput: id => userInputs.push(id), getQueueScroll: () => undefined, saveQueueScroll() { }, onError: message => { errors.push(message); },
  });
}
async function mount(initial: Record<string, string>, initialQueues: Record<string, any[]> = {}) {
  composerDrafts = new ComposerDrafts();
  drafts = { ...initial };
  queues = initialQueues;
  pending = [];
  userInputs = [];
  mockIPC((command, args) => {
    if (command === 'agent_submit_turn' || command === 'agent_remove_queued_turn' || command === 'save_pasted_image' || command === 'agent_queue_delivery_turn')
      return new Promise((resolve, reject) => pending.push({ command, args, resolve, reject }));
    if (command === 'prompt_library_list')
      return { prompts: [] };
    return [];
  });
  await act(() => root.render(h(Harness)));
}
function textarea() { return document.querySelector('textarea')!; }
async function type(text: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), text);
    textarea().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(textarea().value, text);
}
function button(label: string) {
  const result = [...document.querySelectorAll('button')].find(b => b.textContent?.replace(/[↵⌘]/g, '').trim() === label || b.getAttribute('aria-label') === label || b.title === label);
  assert.ok(result, `Missing button ${label}: ${document.body.textContent}`);
  return result;
}
async function click(label: string) { await act(async () => { button(label).click(); await new Promise(r => setTimeout(r, 5)); }); }
async function switchTo(id: string) { await act(() => changeAgent(id)); }
async function finish(index = 0, result: any = { queuedTurns: [], sent: true }) {
  assert.ok(pending[index], `Missing request ${index}`);
  await act(async () => { pending[index].resolve(result); await new Promise(r => setTimeout(r, 5)); });
}
async function flush() {
  await act(() => {
    for (const fn of flushers)
      fn();
  });
}
afterEach(async () => { await act(() => root.unmount()); root = createRoot(document.getElementById('root')!); clearMocks(); });
after(async () => { await act(() => root.unmount()); dom.window.close(); });
test('send A resolves while B is visible: B unchanged, A cleared', async () => {
  await mount({ A: 'sent', B: 'other draft' });
  await click('Send');
  await switchTo('B');
  await finish();
  assert.equal(textarea().value, 'other draft');
  assert.equal(drafts.A, '');
  assert.equal(drafts.B, 'other draft');
});
test('send keeps additions while A remains visible', async () => {
  await mount({ A: 'sent', B: 'other draft' });
  await click('Send');
  await type('sent\nnext');
  await finish();
  await flush();
  assert.equal(textarea().value, 'next');
  assert.equal(drafts.A, 'next');
});
test('send keeps additions after A switches offscreen', async () => {
  await mount({ A: 'sent', B: 'other draft' });
  await click('Send');
  await type('sent\nnext');
  await switchTo('B');
  assert.equal(drafts.A, 'sent\nnext');
  await finish();
  assert.equal(drafts.A, 'next');
});
test('A and B submissions can overlap without clearing B busy state', async () => {
  await mount({ A: 'sent', B: 'other draft' });
  await click('Send');
  await switchTo('B');
  await click('Send');
  assert.equal(pending.length, 2);
  await finish(0);
  assert.equal(button('Queue').disabled, true);
  await switchTo('A');
  assert.equal(button('Queue').disabled, true);
  await type('another');
  assert.equal(button('Queue').disabled, false);
  await switchTo('B');
  assert.equal(button('Queue').disabled, true);
  await finish(1);
  assert.equal(textarea().value, '');
});
test('queued edit in A resolves to A store after switch', async () => {
  await mount({ A: '', B: 'other draft' }, { A: [{ id: 'q1', text: 'removed', createdAt: 0 }] });
  await click('Edit');
  await switchTo('B');
  await finish(0, { queuedTurns: [], removedTurn: 'removed' });
  await type('B new');
  await flush();
  assert.equal(drafts.A, 'removed');
  assert.equal(drafts.B, 'B new');
});
test('image paste in A stays in A when saving resolves after switch', async () => {
  await mount({ A: 'A draft', B: 'B draft' });
  await act(async () => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new dom.window.File(['image'], 'image.png', { type: 'image/png' })] } });
    textarea().dispatchEvent(event);
    await new Promise(r => setTimeout(r, 30));
  });
  await switchTo('B');
  await finish(0, '/tmp/saved.png');
  await flush();
  assert.equal(textarea().value, 'B draft');
  assert.equal(drafts.B, 'B draft');
  assert.match(drafts.A, /Image/);
});
test('confirmed large paste still targets A after switching to B', async () => {
  await mount({ A: 'A draft', B: 'B draft' });
  await act(() => {
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => 'large\npaste' } });
    textarea().dispatchEvent(event);
  });
  await switchTo('B');
  await click('Paste');
  await flush();
  assert.equal(textarea().value, 'B draft');
  assert.equal(drafts.B, 'B draft');
  assert.match(drafts.A, /large/);
});
test('queued edit does not silently replace fresh draft typed while removal is pending', async () => {
  await mount({ A: '', B: 'B draft' }, { A: [{ id: 'q1', text: 'removed', createdAt: 0 }] });
  await click('Edit');
  await type('fresh text');
  await finish(0, { queuedTurns: [], removedTurn: 'removed' });
  await flush();
  assert.match(drafts.A, /fresh text/);
});
test('offscreen completion does not steal focus from outside composer', async () => {
  await mount({ A: 'sent', B: 'other draft' });
  await click('Send');
  await switchTo('B');
  await act(() => document.getElementById('outside')!.focus());
  await finish();
  assert.equal(document.activeElement?.id, 'outside');
});
test('fork completion keeps source edits when fork activates a different agent', async () => {
  await mount({ A: '/fork initial', B: 'fork draft' });
  await click('Fork now');
  assert.equal(pending[0]?.command, 'fork');
  await type('/fork initial\nnext');
  await switchTo('B');
  await finish(0, true);
  assert.equal(drafts.A, 'next');
  assert.equal(textarea().value, 'fork draft');
});
test('delivery queue completion keeps source edits after switching', async () => {
  await mount({ A: 'initial', B: 'B draft' });
  await click('Queue options');
  await click('Queue in new session');
  assert.equal(pending[0]?.command, 'agent_queue_delivery_turn');
  await type('initial\nnext');
  await switchTo('B');
  await finish();
  assert.equal(drafts.A, 'next');
  assert.equal(textarea().value, 'B draft');
});
async function remount() {
  await act(() => root.unmount());
  root = createRoot(document.getElementById('root')!);
  await act(() => root.render(h(Harness)));
}
test('completion reconciles the latest remounted revision, without stale debounce restoring prefix', async () => {
  await mount({ A: 'sent' });
  await click('Send');
  await type('sent\nfirst');
  await remount();
  assert.equal(textarea().value, 'sent\nfirst');
  await type('sent\nfirst\nsecond');
  await finish();
  await flush();
  assert.equal(textarea().value, 'first\nsecond');
  assert.equal(drafts.A, 'first\nsecond');
  await remount();
  assert.equal(textarea().value, 'first\nsecond');
});
test('remount shares pending submission guard and success clears persisted draft', async () => {
  await mount({ A: 'sent' });
  await click('Send');
  await remount();
  assert.equal(button('Queue').disabled, true);
  assert.equal(pending.length, 1);
  await finish();
  assert.equal(textarea().value, '');
  assert.equal(drafts.A, '');
});
test('identical newly typed draft remains after older successful submission', async () => {
  await mount({ A: 'sent' });
  await click('Send');
  await type('');
  await type('sent');
  await switchTo('B');
  await finish();
  assert.equal(drafts.A, 'sent');
  await switchTo('A');
  assert.equal(textarea().value, 'sent');
});
test('false fork result preserves draft and releases shared busy state', async () => {
  await mount({ A: '/fork sent' });
  await click('Fork now');
  await type('/fork edited');
  await remount();
  await finish(0, false);
  await flush();
  assert.equal(textarea().value, '/fork edited');
  assert.equal(button('Fork now').disabled, false);
});
test('queued recovery keeps both texts after removal across remount', async () => {
  await mount({ A: '' }, { A: [{ id: 'q1', text: 'recovered', createdAt: 0 }] });
  await click('Edit');
  await remount();
  await type('new draft');
  await finish(0, { queuedTurns: [], removedTurn: 'recovered' });
  await flush();
  assert.equal(textarea().value, 'new draft\n\nrecovered');
  assert.equal(drafts.A, 'new draft\n\nrecovered');
});
test('image paste appends to revised source instead of replacing stale selection', async () => {
  await mount({ A: 'initial', B: 'other' });
  await act(async () => {
    textarea().setSelectionRange(0, 7);
    const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new dom.window.File(['image'], 'image.png', { type: 'image/png' })] } });
    textarea().dispatchEvent(event);
    await new Promise(r => setTimeout(r, 30));
  });
  await remount();
  await type('replaced');
  await finish(0, '/tmp/saved.png');
  await flush();
  assert.equal(textarea().value, 'replaced[Image: /tmp/saved.png]');
  assert.equal(drafts.A, textarea().value);
});
test('failed send after remount preserves replacement and releases busy for retry', async () => {
  await mount({ A: 'sent' });
  await click('Send');
  await remount();
  await type('new draft');
  await act(() => pending[0].reject!(new Error('delivery failed')));
  await flush();
  assert.equal(textarea().value, 'new draft');
  assert.equal(drafts.A, 'new draft');
  assert.equal(button('Send').disabled, false);
  assert.equal(errors.at(-1), 'delivery failed');
});
