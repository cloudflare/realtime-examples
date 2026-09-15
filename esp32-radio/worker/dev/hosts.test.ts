import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedProxyRequest, developmentHosts } from './hosts.ts';

test('phone hosts are explicit and shared with the proxy', () => {
  const defaults = developmentHosts();
  assert.equal(allowedProxyRequest('192.168.1.20:11880', undefined, undefined, defaults), false);
  const hosts = developmentHosts('radio.local,192.168.1.20,radio.local');
  assert.equal(hosts.filter((host) => host === 'radio.local').length, 1);
  assert.equal(
    allowedProxyRequest('radio.local:11880', 'http://radio.local:11880', 'same-origin', hosts),
    true,
  );
  assert.equal(allowedProxyRequest('192.168.1.20:11880', undefined, undefined, hosts), true);
  assert.equal(allowedProxyRequest('[::1]:11880', undefined, undefined, hosts), true);
});

test('cross-origin requests stay blocked for an allowed development host', () => {
  const hosts = developmentHosts('radio.local');
  assert.equal(
    allowedProxyRequest('radio.local:11880', 'http://untrusted.example', undefined, hosts),
    false,
  );
  assert.equal(allowedProxyRequest('radio.local:11880', undefined, 'cross-site', hosts), false);
  assert.equal(allowedProxyRequest('untrusted.example:11880', undefined, undefined, hosts), false);
});

test('development host configuration cannot broaden into URLs or wildcard domains', () => {
  for (const host of [
    'https://radio.local',
    'radio.local:11880',
    '.example.com',
    '*',
    'user@radio.local',
    'radio.local/path',
    'radio.local?query',
    'radio.local#hash',
  ]) {
    assert.throws(() => developmentHosts(host));
  }
});
