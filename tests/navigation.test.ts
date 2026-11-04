import { describe, expect, it } from 'vitest';
import { limitSessionTabs, nextTabIndex } from '../src/client/presentation.js';
import { sessionTabs } from '../src/client/ui-model.js';
import { emptySession, metric } from '../src/shared/types.js';

describe('wrapped active-session navigation', () => {
  it('limits many active tabs, preserves selected identity across native renames, and keeps histories out of default tabs', () => {
    const sessions = Array.from({ length: 30 }, (_, i) => { const s = emptySession('codex', 'native', `session-${i}`, 'fixture'); s.runtime.reachable = true; s.runtime.loaded = true; s.state = metric('idle', 'native runtime', 'runtime'); s.name = `Native ${i}`; return s; });
    const historical = emptySession('codex', 'native', 'historical', 'fixture');
    const eligible = sessionTabs([...sessions, historical], sessions[29].id, Date.now());
    const limited = limitSessionTabs(eligible, sessions[29].id, 6);
    expect(limited).toHaveLength(6); expect(limited.at(-1)?.id).toBe(sessions[29].id); expect(new Set(limited.map(s => s.id)).size).toBe(6);
    sessions[29].name = 'Native renamed tab'; expect(limitSessionTabs(eligible, sessions[29].id, 6).at(-1)?.name).toBe('Native renamed tab');
    expect(eligible.some(s => s.id === historical.id)).toBe(false);
    expect(sessionTabs([historical], null, Date.now())).toEqual([]);
  });
  it('preserves arrow, Home and End keyboard navigation across wrapped visible rows', () => {
    expect(nextTabIndex('ArrowRight', 5, 6)).toBe(0); expect(nextTabIndex('ArrowLeft', 0, 6)).toBe(5);
    expect(nextTabIndex('ArrowRight', 2, 6)).toBe(3); expect(nextTabIndex('Home', 4, 6)).toBe(0); expect(nextTabIndex('End', 1, 6)).toBe(5);
    expect(nextTabIndex('Enter', 1, 6)).toBeNull(); expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
  });
});
