import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4317', viewport: { width: 1536, height: 1100 }, contextOptions: { reducedMotion: 'reduce' }, headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'npm start', url: 'http://127.0.0.1:4317/api/health', reuseExistingServer: true, timeout: 30000 }
});
