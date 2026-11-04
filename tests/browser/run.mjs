import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A standalone alternative for restricted Windows tokens that cannot spawn
// Playwright workers with anonymous pipes. Connect to a separately started,
// isolated Chromium profile; this file never launches or controls an agent.
const baseURL = process.env.AGENT_MONITOR_BASE_URL || 'http://127.0.0.1:4317';
const cdp = process.env.AGENT_MONITOR_CDP || 'http://127.0.0.1:9333';
const artifacts = path.resolve('artifacts/browser');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.connectOverCDP(cdp);
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'failed', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}

const context = await browser.newContext({ viewport: { width: 1536, height: 1100 }, reducedMotion: 'reduce' });
const live = await context.newPage();
let realSnapshot;
await check('actual localhost application discovers current Codex conversation', async () => {
  await live.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await expect(live.locator('.connection.live')).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => {
    const response = await live.request.get(`${baseURL}/api/snapshot`);
    realSnapshot = await response.json();
    return realSnapshot.sessions?.some(s => s.nativeId === process.env.CODEX_THREAD_ID && s.provider === 'codex');
  }, { timeout: 120000, message: 'The already-running current conversation must be discoverable without resume or restart' }).toBe(true);
  const current = realSnapshot.sessions.find(s => s.nativeId === process.env.CODEX_THREAD_ID && s.provider === 'codex');
  await live.getByRole('button', { name: /^History/ }).click();
  await live.getByRole('searchbox', { name: 'Search session history' }).fill(current.nativeId);
  await expect(live.locator('.history-item')).toHaveCount(1);
  await live.locator('.history-item').click();
  await expect(live).toHaveTitle(current.name);
  await expect(live.getByRole('tab', { selected: true })).toHaveText(current.name);
  const noOverflow = await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(noOverflow).toBe(true);
  await live.screenshot({ path: path.join(artifacts, 'live-desktop.png'), fullPage: true });
  await live.getByRole('button', { name: /^Sources/ }).click();
  await expect(live.getByLabel('Source diagnostics', { exact: true })).toBeVisible();
  await live.screenshot({ path: path.join(artifacts, 'live-diagnostics.png'), fullPage: false });
  await live.getByRole('button', { name: 'Close source diagnostics' }).click();
  await live.setViewportSize({ width: 375, height: 812 });
  expect(await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await live.screenshot({ path: path.join(artifacts, 'live-mobile.png'), fullPage: true });
  results.push({ name: 'live coverage evidence', status: 'observed', currentConversation: true, runtimeConfirmed: current.runtime.reachable, state: current.state.value, quality: current.state.provenance.quality, providers: [...new Set(realSnapshot.sessions.map(s => s.provider))], sessionCount: realSnapshot.sessions.length });
});
await context.close();

const observed = Date.now();
const metric = (value, reason, quality = value === null ? 'unavailable' : 'reported') => ({ value, provenance: { source: 'isolated browser fixture', observedAt: new Date(observed).toISOString(), scope: 'session', quality, reason } });
function session(nativeId, name, provider = 'codex') {
  return {
    id: `${provider}:fixture:${nativeId}`, provider, namespace: 'fixture', nativeId, name, nameSource: 'native title', model: metric(provider === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6'), effort: metric(null, 'Effort not reported'),
    cwd: 'C:\\Fixture project\\Same directory', project: 'Same directory', branch: 'main', startedAt: new Date(observed - 600000).toISOString(), lastActivityAt: new Date(observed).toISOString(), parentId: null, forkedFromId: null, archived: false,
    runtime: { reachable: true, loaded: true, attachment: 'known', pid: 123, processStartedAt: new Date(observed - 600000).toISOString(), observedAt: new Date(observed).toISOString() },
    state: metric('idle'), latestActivity: 'Completed a turn', usage: metric(null, 'Usage not reported'), turnUsage: metric(null, 'Current-turn usage not reported'), context: { used: metric(null, 'Context occupancy not reported'), capacity: metric(null, 'Capacity not reported') }, allowanceIds: [], tools: [], activities: [], trends: [],
    timing: { elapsedMs: metric(600000), completedTurns: 0, lastTurnMs: metric(null), averageTurnMs: metric(null), eta: metric(null, 'Not enough data yet'), checklist: null }, edits: metric(null, 'No attributable edit evidence'), cost: metric(null, 'Known pricing and complete usage categories are required'), diagnostics: []
  };
}
function snapshot(sessions, revision = 1) { return { revision, observedAt: new Date(observed + revision * 1000).toISOString(), sessions, allowances: [], diagnostics: [], collecting: false }; }
async function fixturePage(initial) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const state = { snapshot: initial };
  await page.route('**/api/snapshot', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.snapshot) }));
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      constructor() { super(); window.__monitorStream = this; setTimeout(() => this.dispatchEvent(new Event('open')), 0); }
      close() {}
    }
    window.EventSource = FixtureEventSource;
  });
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  return { context, page, state };
}
async function emit(page, value) { await page.evaluate(value => window.__monitorStream.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(value) })), value); }

await check('separate same-directory tabs, later discovery, native rename, title and refresh', async () => {
  const a = session('a', 'Observe Codex usage'), b = session('b', 'Inspect Claude source', 'claude'), child = session('child', 'Accounting worker'); child.parentId = a.id;
  const { context, page, state } = await fixturePage(snapshot([a, b, child]));
  try {
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.getByRole('tab', { name: b.name, exact: true }).click();
    await expect(page).toHaveTitle(b.name);
    const renamed = { ...b, name: 'Native renamed session' }, later = session('new', 'New normal CLI session'); later.state = metric('running');
    state.snapshot = snapshot([a, renamed, child, later], 2);
    await emit(page, state.snapshot);
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect(page.getByRole('tab', { name: later.name, exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: renamed.name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveTitle(renamed.name);
    await page.reload();
    await expect(page.getByRole('tab', { name: renamed.name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveTitle(renamed.name);
    await page.screenshot({ path: path.join(artifacts, 'fixture-desktop.png'), fullPage: true });
  } finally { await context.close(); }
});
await check('keyboard navigation and live idle versus history', async () => {
  const a = session('a', 'Live idle'), b = session('b', 'Stored history'); b.runtime.reachable = false; b.runtime.loaded = false; b.state = metric('historical', 'Runtime is unconfirmed', 'derived');
  const { context, page } = await fixturePage(snapshot([a, b]));
  try {
    await page.getByRole('tab', { name: a.name, exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveTitle(b.name);
    await expect(page.getByRole('tab', { name: b.name, exact: true })).toBeFocused();
    await expect(page.getByLabel('Session summary')).toContainText('runtime activity is unconfirmed');
    await page.keyboard.press('Home');
    await expect(page).toHaveTitle(a.name);
    await expect(page.getByLabel('Session summary')).toContainText('Live runtime evidence available');
  } finally { await context.close(); }
});
await check('hostile native title, truthful missing metrics and no remote content', async () => {
  const name = '<img src="https://invalid.example/private" onerror="window.__executed=1">';
  const { context, page } = await fixturePage(snapshot([session('hostile', name)]));
  let remote = 0; page.on('request', req => { if (req.url().includes('invalid.example')) remote++; });
  try {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page.locator('h1 img')).toHaveCount(0);
    expect(await page.evaluate(() => window.__executed)).toBeUndefined();
    await expect(page.getByLabel('Context window', { exact: true }).locator('.gauge-fill')).toHaveAttribute('stroke-dasharray', '0 100');
    await expect(page.getByLabel('Account allowance', { exact: true })).toContainText('No allowance snapshot');
    await expect(page.getByLabel('Timing & progress', { exact: true })).toContainText('Not enough data yet');
    expect(remote).toBe(0);
  } finally { await context.close(); }
});
await check('reconnection, revision reset and older HTTP snapshot do not change selection', async () => {
  const a = session('a', 'First conversation'), b = session('b', 'Selected conversation');
  const { context, page, state } = await fixturePage(snapshot([a, b], 10));
  try {
    await page.getByRole('tab', { name: b.name, exact: true }).click();
    await page.evaluate(() => window.__monitorStream.dispatchEvent(new Event('error')));
    await expect(page.locator('.connection.reconnecting')).toBeVisible();
    const renamed = { ...b, name: 'Renamed during reconnect' };
    state.snapshot = { ...snapshot([a, renamed], 1), observedAt: new Date(observed + 60000).toISOString() };
    await page.evaluate(() => window.__monitorStream.dispatchEvent(new Event('open')));
    await emit(page, state.snapshot);
    await expect(page).toHaveTitle(renamed.name);
    await emit(page, snapshot([a, b], 2));
    await expect(page).toHaveTitle(renamed.name);
    await expect(page.getByRole('tab', { name: renamed.name, exact: true })).toHaveAttribute('aria-selected', 'true');
  } finally { await context.close(); }
});
await check('history search, mobile viewport and automatic waiting state', async () => {
  const sessions = Array.from({ length: 30 }, (_, i) => { const s = session(`old-${i}`, `Historical conversation ${i}`); s.runtime.reachable = false; s.runtime.loaded = false; s.lastActivityAt = new Date(observed - i * 3600000).toISOString(); return s; });
  const { context, page, state } = await fixturePage(snapshot(sessions));
  try {
    await expect(page.getByRole('tab')).toHaveCount(8);
    await page.getByRole('button', { name: /^History/ }).click();
    await page.getByRole('searchbox', { name: 'Search session history' }).fill('Historical conversation 29');
    await expect(page.locator('.history-item')).toHaveCount(1);
    await page.locator('.history-item').click();
    await expect(page).toHaveTitle('Historical conversation 29');
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, 'fixture-mobile.png'), fullPage: true });
    state.snapshot = snapshot([], 2); await emit(page, state.snapshot);
    await expect(page.getByRole('heading', { name: 'Waiting for your agents' })).toBeVisible();
    await expect(page.getByRole('button', { name: /connect session/i })).toHaveCount(0);
  } finally { await context.close(); }
});

await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(results, null, 2));
await browser.close();
if (results.some(result => result.status === 'failed')) process.exitCode = 1;
