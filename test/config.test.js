import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';

test('the address: IPv4 or host name, optional port, never broadcast, multicast nor control bytes', () => {
  assert.deepEqual(parseAddress('192.168.1.80'), { host: '192.168.1.80', port: 502 });
  assert.deepEqual(parseAddress(' Wallbox.local:1502 '), { host: 'wallbox.local', port: 1502 });
  for (const bad of [
    '0.0.0.0',
    '192.168.1.255',
    '224.0.0.1',
    '192.168.1.80\r\n',
    'a..b',
    '1.2.3',
    'host:0',
    'host:70000',
    'http://x',
    '',
  ]) {
    assert.equal(parseAddress(bad), undefined, JSON.stringify(bad));
  }
});

test('the configuration: strict numbers, bounded, the commands off unless true', () => {
  const c = normalizeConfig({});
  assert.equal(c.allowCommands, false);
  assert.equal(c.maxCurrent, 16);
  assert.equal(c.apiPort, 80);
  assert.equal(c.pollInterval, 30);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ max_current: 40 }).maxCurrent, 16);
  assert.equal(normalizeConfig({ max_current: 2 }).maxCurrent, 6);
  assert.equal(normalizeConfig({ max_current: '' }).maxCurrent, 16, "'' is not 0");
  assert.equal(normalizeConfig({ max_current: 10.5 }).maxCurrent, 16);
  assert.equal(normalizeConfig({ api_port: 0 }).apiPort, undefined);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({ host: 'bad host' }).invalid, 8);
  assert.equal(normalizeConfig({ host: 'bad host' }).address, undefined);
  assert.equal(normalizeConfig({ gladys_host: 'x' }).address, undefined, 'never a gladys_ key');
});
