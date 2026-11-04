import { metric, emptyUsage, type Session, type Usage, type UsageSlice } from '../shared/types.js';
import type { SourceRoot } from '../shared/adapter.js';
import { command } from './io.js';
import registry from './pricing-registry.json' with { type: 'json' };

export function sumUsage(parts: (Usage | null)[]): Usage | null {
  if (!parts.length || parts.every(p => p === null)) return null;
  const result = emptyUsage();
  for (const key of Object.keys(result) as (keyof Usage)[]) result[key] = parts.every(p => p?.[key] !== null && p?.[key] !== undefined) ? parts.reduce((sum, p) => sum + p![key]!, 0) : null;
  return result;
}
export function calculateAggregates(sessions: Session[]): void {
  const knownSubtotal = (parts: (Usage | null)[]): Usage | null => {
    if (!parts.some(Boolean)) return null;
    const result = emptyUsage();
    for (const field of Object.keys(result) as (keyof Usage)[]) { const known = parts.map(p => p?.[field]).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)); result[field] = known.length ? known.reduce((sum, n) => sum + n, 0) : null; }
    return result;
  };
  const byParent = new Map<string, Session[]>();
  for (const session of sessions) if (session.parentId) byParent.set(session.parentId, [...byParent.get(session.parentId) || [], session]);
  function childrenOf(id: string, seen: Set<string>): Session[] {
    const children: Session[] = [];
    for (const child of byParent.get(id) || []) if (!seen.has(child.id)) { seen.add(child.id); children.push(child, ...childrenOf(child.id, seen)); }
    return children;
  }
  for (const session of sessions) {
    const descendants = childrenOf(session.id, new Set([session.id]));
    const main = session.usage.value;
    const children = descendants.length ? sumUsage(descendants.map(s => s.usage.value)) : null;
    const inclusive = descendants.length ? sumUsage([main, ...descendants.map(s => s.usage.value)]) : main;
    session.aggregates = { main, children, inclusive, childCount: descendants.length, observedChildren: knownSubtotal(descendants.map(s => s.usage.value)), observedInclusive: knownSubtotal([main, ...descendants.map(s => s.usage.value)]), knownChildren: descendants.filter(s => s.usage.value?.total != null).length, partial: descendants.some(s => s.usage.value?.total == null || /partial|backfill/i.test(s.usage.provenance.reason || '')) || main?.total == null || /partial|backfill/i.test(session.usage.provenance.reason || '') };
  }
}
type Price = { input: number; output: number; cached: number; write5m?: number; write1h?: number };
function priceFor(model: string | null): [string, Price] | null {
  if (!model) return null;
  const canonical = model.replace(/-\d{8}$/, '');
  const entry = (registry.models as Record<string, Price>)[canonical]; return entry ? [canonical, entry] : null;
}
export function applyPricing(session: Session): void {
  const slices: UsageSlice[] = session.usageBreakdown || [];
  let usd = 0, priced = 0, pricedCategories = 0; const reasons = new Set<string>();
  function add(value: number | null | undefined, rate: number | undefined, modifier: number): void { if (value != null && Number.isFinite(value) && value >= 0 && rate != null) { usd += value * rate * modifier / 1e6; priced += value; pricedCategories++; } }
  for (const slice of slices) {
    const known = priceFor(slice.model); if (!known) { reasons.add(`No public registry price for ${slice.model || 'unreported model'}`); continue; }
    const [model, rates] = known; const tier = slice.serviceTier?.toLowerCase(); let modifier = 1;
    if (session.provider === 'codex') {
      if (['fast', 'priority'].includes(tier || '')) modifier = 2;
      else if (tier === 'ultrafast') { if (!['gpt-6-astra', 'gpt-6.1-sol'].includes(model)) { reasons.add('Ultrafast price unavailable for this model'); continue; } modifier = 6; }
      else if (['flex', 'batch'].includes(tier || '')) modifier = 0.5;
      else if (tier && !['standard', 'default', 'auto'].includes(tier)) { reasons.add(`Unrecognized service tier ${tier}`); continue; }
      if (!tier) reasons.add('Standard API-equivalent rates; service tier unreported');
      const input = slice.usage.input, cached = slice.usage.cachedInput;
      if (input !== null && cached !== null && cached <= input) { add(input - cached, rates.input, modifier); add(cached, rates.cached, modifier); }
      else if (input === null && cached !== null) { add(cached, rates.cached, modifier); reasons.add('Uncached input unavailable; only reported cache input is priced'); }
      else reasons.add('Cached input breakdown unavailable; input category unpriced');
    } else {
      if (tier === 'fast') { if (!['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'].includes(model)) { reasons.add('Fast-mode price unavailable for this model'); continue; } modifier = 2; }
      else if (tier === 'batch') modifier = 0.5;
      else if (tier && !['standard', 'default', 'auto', 'priority'].includes(tier)) { reasons.add(`Unrecognized service tier ${tier}`); continue; }
      if (!tier) reasons.add('Standard API-equivalent rates; service tier unreported');
      add(slice.usage.input, rates.input, modifier); add(slice.usage.cachedInput, rates.cached, modifier);
      const writeCount = (slice.cacheCreation5m || 0) + (slice.cacheCreation1h || 0);
      if (slice.usage.cacheCreation !== null && writeCount > slice.usage.cacheCreation) reasons.add('Cache-write TTL counts exceed total cache creation; contradictory write categories are unpriced');
      else { add(slice.cacheCreation5m, rates.write5m, modifier); add(slice.cacheCreation1h, rates.write1h, modifier); }
      if ((slice.usage.cacheCreation || 0) > (slice.cacheCreation5m || 0) + (slice.cacheCreation1h || 0)) reasons.add('Cache-write TTL not reported; those tokens are unpriced');
    }
    add(slice.usage.output, rates.output, modifier);
  }
  const observed = session.usage.value?.total ?? null;
  const partial = observed === null || priced !== observed;
  if (observed !== null && priced > observed) reasons.add('Per-model priced coverage exceeds the reported lifetime total; accounting coverage is inconsistent');
  if (!slices.length) reasons.add('No per-model attributable response usage recovered yet; progressive history collection will retry');
  session.cost = metric(pricedCategories > 0 ? { usd, label: partial ? 'Priced API-equivalent subtotal' : 'API-equivalent estimate' } : null, `Official pricing registry ${registry.asOf}`, 'attributable session responses', pricedCategories > 0 ? 'estimated' : 'unavailable', [...reasons].join('; ') || 'Public API-equivalent token estimate; not a subscription invoice', session.lastActivityAt || new Date().toISOString());
  session.costCoverage = { pricedTokens: priced, observedTokens: observed, registryDate: registry.asOf, reason: [...reasons].join('; ') || (partial ? 'Only recovered and priceable categories are included' : 'All attributable token categories priced; tools and subscription billing excluded') };
}
const branches = new Map<string, { checkedAt: number; value: string | null; reason: string }>();
export async function enrichSessions(sessions: Session[], roots: SourceRoot[]): Promise<void> {
  calculateAggregates(sessions);
  let queries = 0;
  for (const session of sessions) {
    applyPricing(session);
    if (!session.cwd) continue;
    const key = `${session.namespace}:${session.cwd}`; let branch = branches.get(key);
    const relevant = session.runtime.reachable || !!session.task && session.task.state === 'active' && Date.now() - Date.parse(session.task.lastActivityAt) < 10 * 60000;
    if (relevant && (!branch || Date.now() - branch.checkedAt > 30000) && queries++ < 4) {
      const root = roots.find(r => r.namespace === session.namespace && r.provider === session.provider);
      const read = await command('git', ['--no-optional-locks', '-C', session.cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], 3000, root);
      if (read.code === 0) branch = { checkedAt: Date.now(), value: read.stdout.trim(), reason: 'Current workspace branch from read-only Git; session last-reported branch is separate' };
      else {
        const head = await command('git', ['--no-optional-locks', '-C', session.cwd, 'rev-parse', '--short', 'HEAD'], 3000, root);
        branch = head.code === 0 ? { checkedAt: Date.now(), value: `Detached HEAD (${head.stdout.trim()})`, reason: 'Workspace HEAD is detached' } : { checkedAt: Date.now(), value: null, reason: /not a git repository/i.test(head.stderr) ? 'Working directory is not a Git repository' : 'Git read unavailable; will retry without changing the workspace' };
      }
      branches.set(key, branch);
    }
    if (branch) {
      const stale = Date.now() - branch.checkedAt > 30000;
      session.workspaceBranch = metric(branch.value, 'Read-only Git in session working directory', 'current workspace', stale ? 'stale' : branch.value ? 'reported' : 'unavailable', stale ? `${branch.reason}; last Git check is older than 30 seconds and will refresh when the session is active` : branch.reason, new Date(branch.checkedAt).toISOString());
    }
  }
}
