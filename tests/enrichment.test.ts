import { describe, expect, it, vi } from 'vitest';
import { emptySession, metric, type Usage } from '../src/shared/types.js';
import { applyPricing, calculateAggregates, enrichSessions, sumUsage } from '../src/server/enrichment.js';
import { command } from '../src/server/io.js';
vi.mock('../src/server/io.js', () => ({ command: vi.fn() }));
const usage = (input = 1000, output = 100): Usage => ({ input, output, cachedInput: 500, cacheCreation: 0, reasoning: 20, total: input + output });
function base(id: string) { const s = emptySession('codex', 'fixture', id, 'native'); s.usage = metric(usage(), 'native response', 'main agent'); return s; }
describe('attributable aggregate accounting', () => {
  it('sums main, nested child-only and inclusive usage once with cycle protection', () => {
    const parent = base('parent'), child = base('child'), grandchild = base('grandchild'); child.parentId = parent.id; grandchild.parentId = child.id;
    calculateAggregates([parent, child, grandchild]);
    expect(parent.aggregates).toMatchObject({ main: { total: 1100 }, children: { total: 2200 }, inclusive: { total: 3300 }, childCount: 2, partial: false });
    expect(child.aggregates?.inclusive?.total).toBe(2200); expect(grandchild.aggregates?.children).toBeNull();
  });
  it('preserves unknown child breakdown instead of manufacturing a complete total', () => {
    const parent = base('unknown-parent'), child = base('unknown-child'); child.parentId = parent.id; child.usage.value = null;
    calculateAggregates([parent, child]); expect(parent.aggregates?.inclusive?.total).toBeNull(); expect(parent.aggregates?.partial).toBe(true);
    expect(parent.aggregates?.observedInclusive?.total).toBe(1100); expect(parent.aggregates?.knownChildren).toBe(0);
    expect(sumUsage([])).toBeNull(); expect(sumUsage([null])).toBeNull();
  });
});
describe('dated public API-equivalent pricing', () => {
  it('prices Codex cache as an input subset and reasoning as an output subset', () => {
    const s = base('codex-price'); s.usageBreakdown = [{ model: 'gpt-6.1-sol', usage: usage(), serviceTier: 'standard' }]; applyPricing(s);
    expect(s.cost.value?.usd).toBeCloseTo((500 * 2 + 500 * .1 + 100 * 10) / 1e6); expect(s.costCoverage?.pricedTokens).toBe(1100); expect(s.cost.value?.label).toBe('API-equivalent estimate');
  });
  it('applies a reported Codex fast tier and never invents an internal-model price', () => {
    const s = base('codex-tier'); s.usageBreakdown = [{ model: 'gpt-6.1-sol', usage: usage(), serviceTier: 'priority' }, { model: 'internal-unpublished-model', usage: usage(), serviceTier: null }]; s.usage.value = usage(2000, 200); applyPricing(s);
    expect(s.cost.value?.usd).toBeCloseTo(4100 / 1e6); expect(s.cost.value?.label).toContain('subtotal'); expect(s.costCoverage?.reason).toContain('No public');
  });
  it('prices Claude uncached input, cache read and TTL writes as separate categories', () => {
    const s = emptySession('claude', 'fixture', 'claude-price', 'native'); const u: Usage = { input: 1000, output: 100, cachedInput: 500, cacheCreation: 200, reasoning: null, total: 1800 }; s.usage.value = u;
    s.usageBreakdown = [{ model: 'claude-sonnet-4-6', usage: u, serviceTier: 'standard', cacheCreation5m: 100, cacheCreation1h: 100 }]; applyPricing(s);
    expect(s.cost.value?.usd).toBeCloseTo((1000 * 3 + 500 * .3 + 100 * 3.75 + 100 * 6 + 100 * 15) / 1e6); expect(s.costCoverage?.pricedTokens).toBe(1800);
  });
  it('keeps useful priced subtotal when Claude cache-write TTL is unknown', () => {
    const s = emptySession('claude', 'fixture', 'partial-price', 'native'); const u: Usage = { input: 1000, output: 100, cachedInput: 500, cacheCreation: 200, reasoning: null, total: 1800 }; s.usage.value = u;
    s.usageBreakdown = [{ model: 'claude-sonnet-4-6', usage: u, serviceTier: null }]; applyPricing(s);
    expect(s.cost.value?.label).toContain('subtotal'); expect(s.costCoverage?.pricedTokens).toBe(1600); expect(s.costCoverage?.reason).toContain('TTL');
  });
  it('does not strip unknown model modifiers into a fabricated public price', () => {
    const s = base('unknown-modifier'); s.usageBreakdown = [{ model: 'gpt-6.1-sol[unknown-mode]', usage: usage(), serviceTier: null }]; applyPricing(s);
    expect(s.cost.value).toBeNull(); expect(s.costCoverage?.reason).toContain('No public');
  });
  it('does not overcharge a contradictory Claude TTL write breakdown', () => {
    const s = emptySession('claude', 'fixture', 'bad-ttl', 'native'); const u: Usage = { input: 1000, output: 100, cachedInput: 500, cacheCreation: 100, reasoning: null, total: 1700 }; s.usage.value = u;
    s.usageBreakdown = [{ model: 'claude-sonnet-4-6', usage: u, serviceTier: 'standard', cacheCreation5m: 200, cacheCreation1h: 100 }]; applyPricing(s);
    expect(s.costCoverage?.pricedTokens).toBe(1600); expect(s.cost.value?.label).toContain('subtotal'); expect(s.costCoverage?.reason).toContain('contradictory');
  });
  it('distinguishes a known zero-token priced observation from missing usage', () => {
    const s = base('known-zero'); const zero: Usage = { input: 0, output: 0, cachedInput: 0, cacheCreation: 0, reasoning: 0, total: 0 }; s.usage.value = zero; s.usageBreakdown = [{ model: 'gpt-6.1-sol', usage: zero, serviceTier: 'standard' }]; applyPricing(s);
    expect(s.cost.value).toEqual({ usd: 0, label: 'API-equivalent estimate' });
  });
});
describe('read-only workspace branch supplement', () => {
  it('keeps the native reported branch separate from the current workspace branch', async () => {
    const s = base('branch-fixture'); s.cwd = 'C:\\Fixture\\Git project'; s.branch = 'session-start-branch'; s.runtime.reachable = true;
    vi.mocked(command).mockResolvedValueOnce({ stdout: 'current-feature\n', stderr: '', code: 0 }); await enrichSessions([s], []);
    expect(s.branch).toBe('session-start-branch'); expect(s.workspaceBranch?.value).toBe('current-feature'); expect(command).toHaveBeenCalledWith('git', ['--no-optional-locks', '-C', s.cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], 3000, undefined);
  });
  it('represents detached HEAD and a non-Git folder without zero or guessed branches', async () => {
    const detached = base('detached'); detached.cwd = '/fixture/detached'; detached.runtime.reachable = true;
    vi.mocked(command).mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 }).mockResolvedValueOnce({ stdout: 'abcd123\n', stderr: '', code: 0 }); await enrichSessions([detached], []); expect(detached.workspaceBranch?.value).toBe('Detached HEAD (abcd123)');
    const nongit = base('nongit'); nongit.cwd = '/fixture/not-git'; nongit.runtime.reachable = true;
    vi.mocked(command).mockResolvedValueOnce({ stdout: '', stderr: 'not a git repository', code: 128 }).mockResolvedValueOnce({ stdout: '', stderr: 'not a git repository', code: 128 }); await enrichSessions([nongit], []); expect(nongit.workspaceBranch?.value).toBeNull(); expect(nongit.workspaceBranch?.provenance.reason).toContain('not a Git repository');
  });
});
