import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { discoverRoots } from '../src/server/discovery.js';

afterEach(() => vi.unstubAllEnvs());

describe('default and discoverable custom root namespaces', () => {
  it('environment roots supplement default histories instead of hiding them', async () => {
    const customCodex = path.resolve('fixtures/custom Codex home');
    const customClaude = path.resolve('fixtures/custom Claude home');
    vi.stubEnv('CODEX_HOME', customCodex);
    vi.stubEnv('CLAUDE_CONFIG_DIR', customClaude);
    const { roots } = await discoverRoots({ wsl: false });
    expect(roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'codex', root: path.join(os.homedir(), '.codex') }),
      expect.objectContaining({ provider: 'codex', root: customCodex }),
      expect.objectContaining({ provider: 'claude', root: path.join(os.homedir(), '.claude') }),
      expect.objectContaining({ provider: 'claude', root: customClaude }),
    ]));
    expect(roots).toHaveLength(4);
  });

  it('equivalent explicit roots do not duplicate a provider namespace', async () => {
    const defaultCodex = path.join(os.homedir(), '.codex');
    const defaultClaude = path.join(os.homedir(), '.claude');
    vi.stubEnv('CODEX_HOME', defaultCodex);
    vi.stubEnv('CLAUDE_CONFIG_DIR', defaultClaude);
    const { roots } = await discoverRoots({ wsl: false, roots: [{ provider: 'codex', path: path.join(defaultCodex, '.') }, { provider: 'claude', path: defaultClaude }] });
    expect(roots.filter(r => r.provider === 'codex')).toHaveLength(1);
    expect(roots.filter(r => r.provider === 'claude')).toHaveLength(1);
    expect(roots[0].namespace).toContain('native:');
  });

  it('provider identity stays separate when both providers use one configured folder', async () => {
    const common = path.resolve('fixtures/shared configuration folder');
    vi.stubEnv('CODEX_HOME', common);
    vi.stubEnv('CLAUDE_CONFIG_DIR', common);
    const { roots } = await discoverRoots({ wsl: false });
    const shared = roots.filter(root => root.root === common);
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map(root => root.provider))).toEqual(new Set(['codex', 'claude']));
  });
});
