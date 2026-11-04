import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { emptySession, metric } from '../../src/shared/types.js';
import type { Session, Snapshot } from '../../src/shared/types.js';

const observed = '2026-11-03T18:00:00.000Z';
function fixtureSession(id: string, name: string, provider: 'codex' | 'claude' = 'codex'): Session {
  const session = emptySession(provider, 'fixture:native', id, 'isolated browser fixture', observed);
  session.name = name;
  session.nameSource = 'native title';
  session.cwd = 'C:\\Fixture project\\Same working directory';
  session.project = 'Same working directory';
  session.model = metric(provider === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6', 'fixture', 'session', 'reported', undefined, observed);
  session.startedAt = '2026-11-03T17:45:00.000Z';
  session.lastActivityAt = observed;
  session.runtime = { reachable: true, loaded: true, attachment: 'known', pid: 123, processStartedAt: session.startedAt, observedAt: observed };
  session.state = metric('idle', 'fixture runtime', 'runtime', 'reported', undefined, observed);
  session.latestActivity = 'Completed a turn';
  session.timing.elapsedMs = metric(900000, 'fixture', 'session', 'derived', undefined, observed);
  return session;
}
function fixtureSnapshot(sessions: Session[], revision = 1): Snapshot {
  return { revision, observedAt: new Date(Date.parse(observed) + revision * 1000).toISOString(), sessions, allowances: [], diagnostics: [], collecting: false };
}
async function installFixture(page: Page, initial: Snapshot) {
  const state = { snapshot: initial };
  await page.route('**/api/snapshot', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.snapshot) }));
  await page.addInitScript(() => {
    // This replacement exists in the browser test only. It exercises the production
    // EventSource listeners without opening or mutating native provider sessions.
    class FixtureEventSource extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readonly url: string; readyState = 0; withCredentials = false;
      constructor(url: string | URL) {
        super(); this.url = String(url);
        (window as unknown as { __monitorStream: FixtureEventSource }).__monitorStream = this;
        setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0);
      }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: FixtureEventSource, configurable: true });
  });
  return state;
}
async function sendSnapshot(page: Page, snapshot: Snapshot) {
  await page.evaluate(value => {
    const stream = (window as unknown as { __monitorStream: EventTarget }).__monitorStream;
    stream.dispatchEvent(new MessageEvent('snapshot', { data: JSON.stringify(value) }));
  }, snapshot);
}

test('preexisting conversations in one directory are separate and native renames preserve selection', async ({ page }) => {
  const a = fixtureSession('conversation-a', 'Review application orchestration');
  const b = fixtureSession('conversation-b', 'Inspect Claude transcripts', 'claude');
  const child = fixtureSession('child-a', 'Usage accounting worker'); child.parentId = a.id;
  const state = await installFixture(page, fixtureSnapshot([a, b, child]));
  await page.goto('/');
  await expect(page.getByRole('tab', { name: a.name, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: b.name, exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab', { name: b.name, exact: true }).click();
  await expect(page).toHaveTitle(b.name);
  const renamed = { ...b, name: 'Native renamed conversation' };
  const startedLater = fixtureSession('conversation-c', 'Newly started conversation');
  startedLater.state = metric('running', 'fixture runtime', 'runtime', 'reported', undefined, observed);
  state.snapshot = fixtureSnapshot([a, renamed, child, startedLater], 2);
  await sendSnapshot(page, state.snapshot);
  await expect(page.getByRole('tab', { name: renamed.name, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: startedLater.name, exact: true })).toBeVisible();
  await expect(page).toHaveTitle(renamed.name);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole('tab', { name: renamed.name, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveTitle(renamed.name);
});

test('keyboard tabs update title and distinguish idle live sessions from transcript history', async ({ page }) => {
  const a = fixtureSession('a', 'A live idle session');
  const b = fixtureSession('b', 'B historical session');
  b.runtime.reachable = false; b.runtime.loaded = false;
  b.state = metric('historical', 'fixture transcript', 'runtime', 'derived', 'Runtime is unconfirmed', observed);
  await installFixture(page, fixtureSnapshot([a, b]));
  await page.goto('/');
  const first = page.getByRole('tab', { name: a.name, exact: true });
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveTitle(b.name);
  await expect(page.getByRole('tab', { name: b.name, exact: true })).toBeFocused();
  await expect(page.getByLabel('Session summary')).toContainText('runtime activity is unconfirmed');
  await page.keyboard.press('Home');
  await expect(page).toHaveTitle(a.name);
  await expect(page.getByLabel('Session summary')).toContainText('Live runtime evidence available');
  await expect(page.getByRole('tab', { name: a.name, exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('unreported context, quotas and ETA are empty and hostile titles remain plain text', async ({ page }) => {
  const hostile = '<img src="https://invalid.example/x" onerror="window.__executed=1">';
  const session = fixtureSession('hostile', hostile);
  let remoteRequests = 0;
  page.on('request', request => { if (request.url().includes('invalid.example')) remoteRequests++; });
  await installFixture(page, fixtureSnapshot([session]));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(hostile);
  await expect(page).toHaveTitle(hostile);
  await expect(page.getByLabel('Context window', { exact: true }).getByRole('img')).toHaveAttribute('aria-label', 'Not reported: —, unavailable');
  await expect(page.getByLabel('Context window', { exact: true }).locator('.gauge-fill')).toHaveAttribute('stroke-dasharray', '0 100');
  await expect(page.getByLabel('Account allowance', { exact: true })).toContainText('No allowance snapshot');
  await expect(page.getByLabel('Timing & progress', { exact: true })).toContainText('Not enough data yet');
  expect(await page.evaluate(() => (window as unknown as { __executed?: number }).__executed)).toBeUndefined();
  expect(remoteRequests).toBe(0);
  await expect(page.locator('h1 img')).toHaveCount(0);
});

test('stream reconnection retains selection and resynchronizes after backend revisions restart', async ({ page }) => {
  const a = fixtureSession('a', 'First conversation');
  const b = fixtureSession('b', 'Selected conversation');
  const state = await installFixture(page, fixtureSnapshot([a, b], 10));
  await page.goto('/');
  await page.getByRole('tab', { name: b.name, exact: true }).click();
  await page.evaluate(() => (window as unknown as { __monitorStream: EventTarget }).__monitorStream.dispatchEvent(new Event('error')));
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting' }).first()).toBeVisible();
  const renamed = { ...b, name: 'Renamed during reconnect' };
  state.snapshot = { ...fixtureSnapshot([a, renamed], 1), observedAt: '2026-11-03T18:01:00.000Z' };
  await page.evaluate(() => (window as unknown as { __monitorStream: EventTarget }).__monitorStream.dispatchEvent(new Event('open')));
  await sendSnapshot(page, state.snapshot);
  await expect(page).toHaveTitle(renamed.name);
  await expect(page.getByRole('tab', { name: renamed.name, exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('history search selects older native sessions without overcrowding tabs', async ({ page }) => {
  const sessions = Array.from({ length: 30 }, (_, i) => {
    const session = fixtureSession(`historical-${i}`, `Historical conversation ${i}`);
    session.runtime.reachable = false; session.runtime.loaded = false;
    session.lastActivityAt = new Date(Date.parse(observed) - i * 3600000).toISOString();
    return session;
  });
  await installFixture(page, fixtureSnapshot(sessions));
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(8);
  await page.getByRole('button', { name: 'History 30' }).click();
  await page.getByRole('searchbox', { name: 'Search session history' }).fill('Historical conversation 29');
  await page.getByRole('button').filter({ hasText: 'Historical conversation 29' }).click();
  await expect(page).toHaveTitle('Historical conversation 29');
  await expect(page.getByRole('tab', { name: 'Historical conversation 29', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('mobile layout fits viewport and waiting state has no connection workflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const session = fixtureSession('mobile', 'Review the local monitoring implementation');
  const state = await installFixture(page, fixtureSnapshot([session]));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Context window', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  state.snapshot = fixtureSnapshot([], 2);
  await sendSnapshot(page, state.snapshot);
  await expect(page.getByRole('heading', { name: 'Waiting for your agents' })).toBeVisible();
  await expect(page.getByRole('button', { name: /connect session/i })).toHaveCount(0);
});
