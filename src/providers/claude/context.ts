import type { AdapterContext } from '../../shared/adapter.js';
import { metric, type Session } from '../../shared/types.js';
import { normalizeTimestamp } from '../../shared/time.js';

interface ModelLimit { model: string; tokens: number; source: string; fetchedAt: string; staleAt: string }

/** Read only the native catalog's model IDs, limits and freshness; never its account/config state. */
export async function readClaudeModelLimits(ctx: AdapterContext): Promise<ModelLimit[]> {
  const directory = ctx.io.join(ctx.root, 'cache', 'model-catalog');
  const files = (await ctx.io.list(directory)).filter(file => !file.isDirectory && file.path.endsWith('.json') && file.size <= 2 * 1024 * 1024)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)).slice(0, 32);
  const limits: ModelLimit[] = [];
  for (const file of files) {
    try {
      const text = await ctx.io.text(file.path, 2 * 1024 * 1024);
      if (!text) continue;
      const value = JSON.parse(text);
      const fetchedAt = normalizeTimestamp(value.fetchedAt), staleAt = normalizeTimestamp(value.staleAt);
      if (value.version !== 2 || value.catalog?.surface !== 'cc' || !fetchedAt || !staleAt || !Array.isArray(value.catalog?.config?.models)) continue;
      for (const model of value.catalog.config.models) {
        const tokens = model?.runtime?.max_input_tokens;
        if (typeof model?.id === 'string' && model.id.length <= 200 && Number.isSafeInteger(tokens) && tokens > 0)
          limits.push({ model: model.id, tokens, source: file.path, fetchedAt, staleAt });
      }
    } catch { /* A concurrently replaced/unreadable catalog is retried at the next bounded refresh. */ }
  }
  return limits;
}

export function applyClaudeModelLimit(session: Session, limits: ModelLimit[], now: string): void {
  // This is an advertised model maximum, not a claim about private per-process overrides.
  if (session.context.capacity.value !== null) return;
  const matches = limits.filter(limit => limit.model === session.model.value)
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || a.source.localeCompare(b.source));
  const limit = matches[0];
  if (!limit) {
    session.context.capacity.provenance.reason = 'No matching context limit in Claude’s local model catalog; retrying as Claude refreshes its catalog.';
    return;
  }
  if (matches.some(other => other.fetchedAt === limit.fetchedAt && other.tokens !== limit.tokens)) {
    session.context.capacity.provenance.reason = 'Claude model catalogs disagree about this model’s limit; waiting for an unambiguous catalog.';
    return;
  }
  const stale = Date.parse(now) >= Date.parse(limit.staleAt);
  session.context.capacity = metric(limit.tokens, limit.source, 'model input limit', stale ? 'stale' : 'reported',
    'Native catalog maximum for the exact response model. Session overrides and automatic compaction may use a lower threshold.' + (stale ? ' Catalog refresh deadline has passed; retaining its last reported limit.' : ''), limit.fetchedAt);
  session.context.capacityBasis = 'model-limit';
}
