import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDashboardConfig } from './config.js';

// Portability D12: outward URLs must come from explicit configuration — an unset
// DASHBOARD_PUBLIC_URL yields null (features degrade loudly), never a fallback to
// a personal domain this machine doesn't own.
describe('loadDashboardConfig publicUrl', () => {
  const saved = process.env.DASHBOARD_PUBLIC_URL;
  beforeEach(() => delete process.env.DASHBOARD_PUBLIC_URL);
  afterEach(() => {
    if (saved === undefined) delete process.env.DASHBOARD_PUBLIC_URL;
    else process.env.DASHBOARD_PUBLIC_URL = saved;
  });

  it('is null when DASHBOARD_PUBLIC_URL is unset (no personal-domain fallback)', () => {
    expect(loadDashboardConfig().publicUrl).toBeNull();
  });

  it('uses the configured URL, trailing slashes trimmed', () => {
    process.env.DASHBOARD_PUBLIC_URL = 'https://sunny.example.com///';
    expect(loadDashboardConfig().publicUrl).toBe('https://sunny.example.com');
  });
});
