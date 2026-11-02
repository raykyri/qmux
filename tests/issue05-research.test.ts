import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement as h } from 'react';
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'Event', 'MouseEvent', 'KeyboardEvent', 'localStorage', 'Range', 'getComputedStyle'])
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (cb: any) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class {
    observe() { }
    disconnect() { }
    unobserve() { }
  }, CSS: { escape: (x: string) => x, highlights: new Map() }, Highlight: class {
    priority = 0;
    add() { }
    clear() { }
  }
});
dom.window.HTMLElement.prototype.scrollTo = () => { };
dom.window.HTMLElement.prototype.scrollIntoView = () => { };
const rect = { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON() { } };
dom.window.Range.prototype.getBoundingClientRect = () => rect;
dom.window.Range.prototype.getClientRects = () => [rect] as any;
const node = (id: string, overrides: any = {}) => ({ id, treeId: 'tree', prompt: 'Question ' + id, adapter: 'claude', groupId: 'group', worktreeDir: '/tmp', status: 'complete', nativeSessionId: 'session-' + id, createdAt: 1, highlights: [], ...overrides });
let nodes = [node('root'), node('branch', { parentNodeId: 'root' })];
const detail = () => ({ tree: { id: 'tree', title: 'Tree', rootNodeId: 'root', workspaceId: 'workspace', createdAt: 1, updatedAt: 1 }, nodes });
(dom.window as any).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: any) => {
    if (cmd === 'get_research_node_content')
      return { node: nodes.find(n => n.id === args.nodeId), turns: [{ id: 'answer', agentId: 'agent', role: 'assistant', sourceIndex: 0, blocks: [{ type: 'text', text: 'First passage. Second passage.' }] }], children: [], responseRevision: 'rev' }; if (cmd === 'get_research_tree')
      return detail(); if (cmd === 'list_publication_proposals')
      return []; throw Error(cmd);
  }
};
const { createRoot } = await import('react-dom/client');
const { default: ResearchDocument } = await import('../src/components/research/ResearchDocument');
const { researchNavigationStore, saveResearchNavigation } = await import('../src/lib/researchNavigation');
const container = document.getElementById('root')!;
let root = createRoot(container);
let settle: any;
let rejectFork: any;
let calls: any[] = [];
const props: any = { linkActions: {}, archived: false, onFork: (...args: any[]) => { calls.push(args); return new Promise((resolve, reject) => { settle = resolve; rejectFork = reject; }); }, onRemoveBranch: async () => { }, onRemoveTree: async () => { }, onUpdateDocument: async () => { }, onCancel: async () => { }, onRetryNode: async () => { }, onOpenPane: () => { }, onError: console.error, onToast: () => { }, onPublish: () => { }, onPublicationBindingChange: () => { }, publicationBinding: null };
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 5)); }); };
async function reset(saved: any = {}) { await act(() => root.unmount()); root = createRoot(container); Object.keys(researchNavigationStore()).forEach(k => delete researchNavigationStore()[k]); researchNavigationStore().tree = { scrollByNode: {}, ...saved }; calls = []; await act(() => root.render(h(ResearchDocument, { ...props, detail: detail() }))); await flush(); }
const textarea = () => container.querySelector('textarea[aria-label="Follow-up question"]') as HTMLTextAreaElement;
async function type(value: string) { await act(() => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), value); textarea().dispatchEvent(new Event('input', { bubbles: true })); }); assert.equal(textarea().value, value); }
async function send(branch = false) { await act(() => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: branch, bubbles: true }))); assert.equal(calls.length, 1); }
async function resolve() { await act(() => settle(node('child', { parentNodeId: 'root', inline: calls[0][4] }))); }
async function askPassage(start: number, end: number) { const content = container.querySelector('.research-response-content-root')!; const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); const text = walker.nextNode()!; const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end); const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range); await act(() => content.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))); await flush(); const button = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-keyshortcuts') === 'A'); assert.ok(button, 'Ask action exists'); await act(() => button.click()); await flush(); }
after(async () => { await act(() => root.unmount()); dom.window.close(); });
test('inline send retains appended text and persists remainder', async () => { await reset(); await type('Original'); await send(); await type('Original\nNext'); await resolve(); assert.equal(textarea().value, 'Next'); assert.equal(researchNavigationStore().tree.followupDraft?.text, 'Next'); assert.equal(calls[0][4], true); });
test('branch send retains edited text and does not select child', async () => { await reset(); await type('Original'); await send(true); await type('Edited'); await resolve(); assert.equal(textarea().value, 'Edited'); assert.equal(researchNavigationStore().tree.followupDraft?.text, 'Edited'); assert.equal(calls[0][4], false); assert.equal(researchNavigationStore().tree.selectedNodeId, 'root'); });
test('new ask on same node must keep its persisted draft', async () => { await reset(); await askPassage(0, 5); await type('Original'); await send(); await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Cancel the targeted question"]')!.click()); await askPassage(15, 21); await type('Different'); assert.equal(researchNavigationStore().tree.askByNode?.root.text, 'Different'); await resolve(); assert.equal(textarea().value, 'Different'); assert.ok(container.querySelector('[aria-label="Cancel the targeted question"]'), 'new ask remains visible'); assert.equal(researchNavigationStore().tree.askByNode?.root?.text, 'Different'); });
test('new ask with same wording must not have text cleared by old completion', async () => { await reset(); await askPassage(0, 5); await type('Original'); await send(); await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Cancel the targeted question"]')!.click()); await askPassage(15, 21); await resolve(); assert.equal(textarea().value, 'Original'); });
test('in-flight submit after unmount must persist remainder', async () => { await reset(); await type('Original'); await send(); await type('Original\nNext'); await act(() => root.unmount()); root = createRoot(container); await resolve(); assert.equal(researchNavigationStore().tree.followupDraft?.text, 'Next'); });
test('old mounted instance cannot delete a newer draft after remount', async () => { await reset(); await type('Original'); await send(); await act(() => root.unmount()); root = createRoot(container); await act(() => root.render(h(ResearchDocument, { ...props, detail: detail() }))); await flush(); await type('New draft'); await resolve(); assert.equal(textarea().value, 'New draft'); assert.equal(researchNavigationStore().tree.followupDraft?.text, 'New draft'); });
test('restore null detail then detail preserves ordinary saved draft', async () => { await reset({ followupDraft: { text: 'Saved', mode: 'branch', updatedAt: Date.now() } }); await act(() => root.unmount()); root = createRoot(container); await act(() => root.render(h(ResearchDocument, { ...props, detail: null }))); await act(() => root.render(h(ResearchDocument, { ...props, detail: detail() }))); await flush(); assert.equal(textarea().value, 'Saved'); await type('Saved edit'); assert.equal(researchNavigationStore().tree.followupDraft?.text, 'Saved edit'); });
test('node switch while fork is in flight preserves newer ordinary draft', async () => { await reset(); await type('Original'); await send(); const card = container.querySelector<HTMLButtonElement>('.research-followup-card[data-node-id="branch"]')!; assert.ok(card); await act(() => card.click()); await flush(); await type('Branch question'); await resolve(); assert.equal(textarea().value, 'Branch question'); assert.equal(researchNavigationStore().tree.selectedNodeId, 'branch'); assert.equal(researchNavigationStore().tree.followupDraft?.text, 'Branch question'); });
test('untouched successful send clears already-flushed localStorage draft', async () => { await reset(); await type('Original'); await act(async () => { await new Promise(r => setTimeout(r, 300)); }); saveResearchNavigation(); assert.equal(JSON.parse(localStorage.getItem('qmux.research-navigation.v1')!).tree.followupDraft.text, 'Original'); await send(); await resolve(); await act(async () => { await new Promise(r => setTimeout(r, 300)); }); assert.equal(JSON.parse(localStorage.getItem('qmux.research-navigation.v1')!).tree.followupDraft, undefined); });
test('old completion reconciles remainder in remounted UI and persisted storage', async () => {
  await reset();
  await type('Original');
  await send();
  await act(() => root.unmount());
  root = createRoot(container);
  await act(() => root.render(h(ResearchDocument, { ...props, detail: detail() })));
  await flush();
  await type('Original\nNext');
  await resolve();
  assert.equal(textarea().value, 'Next');
  assert.equal(JSON.parse(localStorage.getItem('qmux.research-navigation.v1')!).tree.followupDraft.text, 'Next');
});
test('same-text ordinary replacement is a new revision', async () => {
  await reset();
  await type('Original');
  await send();
  await type('');
  await type('Original');
  await resolve();
  assert.equal(textarea().value, 'Original');
  assert.equal(researchNavigationStore().tree.followupDraft?.text, 'Original');
});
test('remounted unchanged ask clears on success and stays cleared after another remount', async () => {
  await reset();
  await askPassage(0, 5);
  await type('Original');
  await send();
  await act(() => root.unmount());
  root = createRoot(container);
  await act(() => root.render(h(ResearchDocument, { ...props, detail: detail() })));
  await flush();
  assert.ok(container.querySelector('[aria-label="Cancel the targeted question"]'));
  await resolve();
  assert.equal(textarea().value, '');
  assert.equal(researchNavigationStore().tree.askByNode?.root, undefined);
  assert.equal(JSON.parse(localStorage.getItem('qmux.research-navigation.v1')!).tree.askByNode?.root, undefined);
});
test('ask edits persist as a remainder even with the document unmounted', async () => {
  await reset();
  await askPassage(0, 5);
  await type('Original');
  await send();
  await type('Original\nNext');
  await act(() => root.unmount());
  root = createRoot(container);
  await resolve();
  assert.equal(researchNavigationStore().tree.askByNode?.root?.text, 'Next');
  assert.equal(JSON.parse(localStorage.getItem('qmux.research-navigation.v1')!).tree.askByNode.root.text, 'Next');
});
test('document remount cannot submit the same pending draft again', async () => {
  await reset();
  await type('Original');
  await send();
  await act(() => root.unmount());
  root = createRoot(container);
  await act(() => root.render(h(ResearchDocument, { ...props, detail: detail() })));
  await flush();
  await act(() => textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
  assert.equal(calls.length, 1);
  await resolve();
  assert.equal(textarea().value, '');
});
test('failed fork keeps latest persisted text and allows a subsequent submit', async () => {
  await reset();
  await type('Original');
  await send();
  await type('Changed');
  await act(() => rejectFork(new Error('fork failed')));
  assert.equal(textarea().value, 'Changed');
  assert.equal(researchNavigationStore().tree.followupDraft?.text, 'Changed');
  calls = [];
  await send();
  await resolve();
  assert.equal(textarea().value, '');
});
