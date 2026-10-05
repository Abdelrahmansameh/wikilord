import test from 'node:test';
import assert from 'node:assert/strict';
import { openIssues } from '../telegram-notifications.js';

test('premium verification creates one actionable notification per blocked API action', () => {
  const summary = {
    bot: { online: true, connected: true }, market: { online: true, collector: {} },
    money: { online: true, connected: true },
    premiumMoney: { online: true, connected: true,
      packs: { blocked: { kind: 'human', detail: 'Verification required' } },
      humanVerifications: [
        { method: 'POST', path: '/api/packs/open', detail: 'Verification required' },
        { method: 'POST', path: '/api/marketplace', detail: 'Verification required' },
      ] },
  };
  const issues = openIssues(summary);
  const premium = [...issues.entries()].filter(([key]) => key.startsWith('premium-money:human:'));
  assert.equal(premium.length, 2);
  assert.match(premium.find(([key]) => key.endsWith('/api/packs/open'))[1], /retry packs/);
  assert.match(premium.find(([key]) => key.endsWith('/api/marketplace'))[1], /POST \/api\/marketplace/);
  assert.equal([...issues.keys()].some((key) => key === 'premium-money:pack-human'), false);
});
