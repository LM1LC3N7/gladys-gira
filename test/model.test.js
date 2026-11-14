// -----------------------------------------------------------------------------
// The pure parts: configuration, UI configuration -> devices, values, stops.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseAddress, parseFingerprint } from '../src/config.js';
import {
  applied,
  bit,
  buildModel,
  commandNumber,
  inventoryOf,
  numberOf,
  stopFromDevice,
  valuesOf,
  valuesOfAnswer,
} from '../src/model.js';
import { fixtureConfig } from './helpers/fakeGira.js';

const gladys = createFakeGladys();
const ids = (type, id) => gladys.externalIds(type, id);
const model = (config = fixtureConfig(), language = 'en') =>
  buildModel(ids, inventoryOf(config).functions, { language });
const writer = (m, fid, key) => m.writers.get(`ext:test-integration:function:${fid}:${key}`);

test('address: IP, port, https and /api/v2 accepted; anything else refused', () => {
  assert.deepEqual(parseAddress('192.168.1.40'), {
    host: '192.168.1.40',
    port: 443,
    key: '192.168.1.40:443',
  });
  assert.equal(parseAddress('https://192.168.1.40:8443/api/v2/').key, '192.168.1.40:8443');
  assert.equal(parseAddress('x1.lan').key, 'x1.lan:443');
  for (const [raw, error] of [
    ['', 'empty'],
    ['http://192.168.1.40', 'scheme'],
    ['https://u:p@192.168.1.40', 'credentials'],
    ['192.168.1.40/other', 'path'],
    ['192.168.1.40/api/v2/?token=x', 'path'],
    ['224.0.0.1', 'broadcast'],
    ['255.255.255.255', 'broadcast'],
    ['0.0.0.0', 'broadcast'],
    ['x1.local', 'local-name'],
    ['192.168.1.400', 'invalid'],
    ['192.168.1.40\r\nHost: evil', 'invalid'],
    ['192.168.1.40:0', 'invalid'],
    ['192.168.1.40:70000', 'invalid'],
  ]) {
    assert.equal(parseAddress(raw).error, error, raw);
  }
});

test('fingerprint: SHA-256 hex with or without colons; anything else refused', () => {
  const hex = 'ab'.repeat(32);
  assert.equal(parseFingerprint(hex).fingerprint, 'AB:'.repeat(31) + 'AB');
  assert.equal(parseFingerprint(`SHA256=${hex}`).fingerprint, 'AB:'.repeat(31) + 'AB');
  assert.deepEqual(parseFingerprint(''), {});
  assert.equal(parseFingerprint('ab'.repeat(20)).error, 'fingerprint');
});

test('credentials: a password without a user name (or the reverse) is refused; options off by default', () => {
  const base = { server_address: '192.168.1.40' };
  assert.equal(normalizeConfig(base).error, 'no-credentials');
  assert.equal(normalizeConfig({ ...base, password: 'x' }).error, 'no-username');
  assert.equal(normalizeConfig({ ...base, username: 'u' }).error, 'no-password');
  assert.equal(normalizeConfig({ ...base, username: 'a:b', password: 'x' }).error, 'bad-username');
  assert.equal(normalizeConfig({ ...base, username: 'u', password: 'x\ny' }).error, 'bad-password');
  const c = normalizeConfig({ ...base, username: ' u ', password: ' p ' });
  assert.equal(c.error, undefined);
  assert.equal(c.username, 'u');
  assert.equal(c.password, ' p ', 'a password is never trimmed');
  assert.deepEqual([c.allowControl, c.allowOpen, c.allowScenes], [false, false, false]);
  const on = normalizeConfig({
    ...base,
    username: 'u',
    password: 'p',
    allow_control: 'true',
    allow_open: 1,
    allow_scenes: true,
  });
  assert.deepEqual([on.allowControl, on.allowOpen, on.allowScenes], [true, false, true]);
  assert.equal(normalizeConfig({ ...base, poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ ...base, poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ ...base, poll_interval: 1e9 }).pollInterval, 3600);
});

test('the UI configuration: lights, dimmers, covers offered; scenes listed; others skipped', () => {
  const m = model();
  assert.deepEqual(m.counts, { functions: 7, offered: 5, skipped: 1, scenes: 1 });
  const dimmer = m.devices.find((d) => d.external_id.endsWith(':a029'));
  assert.deepEqual(
    dimmer.features.map((f) => [f.external_id.split(':').pop(), f.category, f.type]),
    [
      ['on', 'light', 'binary'],
      ['brightness', 'light', 'brightness'],
    ],
  );
  assert.deepEqual(
    dimmer.params.map((p) => p.name),
    ['GIRA_FUNCTION', 'GIRA_CHANNEL', 'GIRA_ONOFF'],
  );
  const blind = m.devices.find((d) => d.external_id.endsWith(':a040'));
  assert.deepEqual(
    blind.features.map((f) => [f.external_id.split(':').pop(), f.category, f.type, f.read_only]),
    [
      ['state', 'shutter', 'state', false],
      ['position', 'shutter', 'position', false],
    ],
  );
  assert.equal(blind.features[1].has_feedback, true);
  // Every feature is a light or a shutter: never a switch.
  for (const d of m.devices) for (const f of d.features) assert.notEqual(f.category, 'switch');
  assert.deepEqual([...m.scenes.keys()], ['a060']);
  assert.equal(m.scenes.get('a060').execute.uid, 'a061');
  // French names.
  const fr = model(fixtureConfig(), 'fr').devices.find((d) => d.external_id.endsWith(':a040'));
  assert.deepEqual(
    fr.features.map((f) => f.name),
    ['Mouvement', 'Position'],
  );
});

test('the UI configuration is bounded and never trusted: bad uids, duplicates, prototype keys', () => {
  const config = fixtureConfig();
  config.functions.push(
    { uid: '../x', channelType: 'de.gira.schema.channels.Switch', dataPoints: [] },
    { uid: 'a029', channelType: 'de.gira.schema.channels.Switch', dataPoints: [] },
    JSON.parse(
      '{"uid":"c001","channelType":"de.gira.schema.channels.Switch","__proto__":{"x":1},"dataPoints":[{"uid":"a02a","name":"OnOff"}]}',
    ),
    {
      uid: 'c002',
      channelType: 'de.gira.schema.channels.Switch',
      displayName: 'Read only',
      dataPoints: [{ uid: 'c003', name: 'OnOff', canWrite: false }],
    },
  );
  const inv = inventoryOf(config);
  assert.equal(inv.functions.size, 9);
  assert.equal(inv.functions.get('a029').label, 'Lampe Links', 'the first one kept');
  assert.equal(inv.functions.get('c001').points.size, 0, 'a data point of another function');
  const m = buildModel(ids, inv.functions);
  assert.ok(!m.targetDevices.has('c001') && !m.targetDevices.has('c002'));
  assert.equal(inventoryOf({ uid: 'A', functions: 'x' }).uid, undefined);
  const many = { uid: 'a001', functions: [] };
  for (let i = 0; i < 600; i += 1) many.functions.push({ uid: `f${1000 + i}`, dataPoints: [] });
  assert.equal(inventoryOf(many).functions.size, 500);
});

test('values: strict numbers, bits, percent closed to percent open', () => {
  assert.equal(numberOf('70.196078'), 70.196078);
  for (const junk of ['', ' ', '0x10', '1e3', 'NaN', null, undefined, '12abc']) {
    assert.equal(numberOf(junk), undefined, String(junk));
  }
  assert.equal(bit('1'), 1);
  assert.equal(bit('false'), 0);
  assert.equal(bit('2'), undefined);
  assert.equal(bit(''), undefined);
  const m = model();
  assert.deepEqual(valuesOf(m, 'a02b', '70.196078'), [
    { featureId: 'ext:test-integration:function:a029:brightness', value: 70 },
  ]);
  assert.deepEqual(valuesOf(m, 'a044', '30'), [
    { featureId: 'ext:test-integration:function:a040:position', value: 70 },
  ]);
  assert.deepEqual(valuesOf(m, 'a02b', ''), [], 'empty is unknown, never 0');
  assert.deepEqual(valuesOf(m, 'a02b', '101'), []);
  assert.deepEqual(valuesOf(m, 'a02a', 'on'), []);
  const map = valuesOfAnswer({
    values: [
      { uid: 'a02a', value: '1' },
      { uid: 'a02b', value: 20 },
      { uid: 'BAD', value: '1' },
      { uid: 'a02c', value: { x: 1 } },
      { uid: 'a02d', value: 'x'.repeat(101) },
    ],
  });
  assert.deepEqual(
    [...map],
    [
      ['a02a', '1'],
      ['a02b', '20'],
    ],
  );
  assert.equal(valuesOfAnswer({ values: 'x' }).size, 0);
});

test('writes: off and close protective; on, brightness, open, position need their option', () => {
  const m = model();
  const on = writer(m, 'a029', 'on');
  assert.deepEqual(on.write(0), {
    target: 'a029',
    fid: 'a029',
    dpid: 'a02a',
    key: 'OnOff',
    value: 0,
    protective: true,
    kind: 'state',
  });
  assert.equal(on.write(1).need, 'control');
  assert.equal(on.write('1').need, 'control');
  for (const bad of [2, -1, '', null, true, 'on', NaN, '1 ']) {
    assert.throws(() => on.write(bad), /badValue/, String(bad));
  }
  const bright = writer(m, 'a029', 'brightness');
  assert.equal(bright.write(0.4).key, 'OnOff', 'brightness 0 is a switch-off');
  assert.equal(bright.write(0.4).protective, true);
  assert.deepEqual([bright.write(55.6).value, bright.write(55.6).need], [56, 'control']);
  assert.throws(() => bright.write(100.5), /badValue/);
  const state = writer(m, 'a040', 'state');
  assert.deepEqual(
    [state.write(-1).key, state.write(-1).value, state.write(-1).protective],
    ['Up-Down', 1, true],
  );
  assert.equal(state.write(-1).posDpid, 'a044');
  assert.deepEqual(
    [state.write(0).key, state.write(0).value, state.write(0).protective],
    ['Step-Up-Down', 1, true],
  );
  assert.deepEqual(
    [state.write(1).key, state.write(1).value, state.write(1).need],
    ['Up-Down', 0, 'open'],
  );
  const pos = writer(m, 'a040', 'position');
  assert.deepEqual([pos.write(0).key, pos.write(0).protective], ['Up-Down', true]);
  assert.deepEqual(
    [pos.write(30).key, pos.write(30).value, pos.write(30).need],
    ['Position', 70, 'open'],
  );
  assert.equal(pos.write(100).value, 0);
  assert.throws(() => pos.write(-1), /badValue/);
  assert.equal(commandNumber('1e3'), undefined);
});

test('applied: OnOff exact, brightness within 1, position within 2, write-only never', () => {
  assert.equal(applied({ key: 'OnOff', value: 0 }, '0'), true);
  assert.equal(applied({ key: 'OnOff', value: 0 }, '1'), false);
  assert.equal(applied({ key: 'OnOff', value: 0 }, ''), undefined);
  assert.equal(applied({ key: 'Brightness', value: 70 }, '70.196078'), true);
  assert.equal(applied({ key: 'Brightness', value: 70 }, '20'), false);
  assert.equal(applied({ key: 'Position', value: 60 }, '61.5'), true);
  assert.equal(applied({ key: 'Up-Down', value: 1 }, '1'), undefined);
  assert.equal(applied({ key: 'OnOff', value: 0 }, undefined), undefined);
});

test('stops from the device params (before the first read): only stops, only valid uids', () => {
  const device = (params) => ({
    params: Object.entries(params).map(([name, value]) => ({ name, value })),
  });
  const light = device({ GIRA_FUNCTION: 'a029', GIRA_ONOFF: 'a02a' });
  const f = (key) => ({ external_id: `ext:test-integration:function:a029:${key}` });
  assert.deepEqual(stopFromDevice(light, f('on'), 0), {
    target: 'a029',
    fid: 'a029',
    dpid: 'a02a',
    key: 'OnOff',
    value: 0,
    protective: true,
    kind: 'state',
  });
  assert.equal(stopFromDevice(light, f('brightness'), 0).key, 'OnOff');
  assert.equal(stopFromDevice(light, f('on'), 1), undefined);
  assert.equal(stopFromDevice(light, f('brightness'), 30), undefined);
  const cover = device({
    GIRA_FUNCTION: 'a040',
    GIRA_UPDOWN: 'a042',
    GIRA_STEP: 'a041',
    GIRA_POSITION: 'a044',
  });
  assert.deepEqual(
    [stopFromDevice(cover, f('state'), -1).dpid, stopFromDevice(cover, f('state'), -1).value],
    ['a042', 1],
  );
  assert.equal(stopFromDevice(cover, f('state'), 0).dpid, 'a041');
  assert.equal(stopFromDevice(cover, f('position'), 0).dpid, 'a042');
  assert.equal(stopFromDevice(cover, f('state'), 1), undefined);
  assert.equal(stopFromDevice(cover, f('position'), 40), undefined);
  assert.equal(
    stopFromDevice(device({ GIRA_FUNCTION: '../x', GIRA_ONOFF: 'a02a' }), f('on'), 0),
    undefined,
  );
  assert.equal(
    stopFromDevice(device({ GIRA_FUNCTION: 'a029', GIRA_ONOFF: 'A:B' }), f('on'), 0),
    undefined,
  );
  assert.equal(stopFromDevice({}, f('on'), 0), undefined);
});
