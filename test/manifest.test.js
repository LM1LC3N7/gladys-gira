// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. The version is
// never pinned (the Release workflow bumps it): only its shape and agreement.
// The select options follow the core's rules (a single bad option makes the
// core refuse the whole Discovery list).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, POLL_INTERVAL, SCENE_ACTION, SCENE_NUMBER } from '../src/constants.js';
import { buildModel, inventoryOf } from '../src/model.js';
import { fixtureConfig } from './helpers/fakeGira.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics; one version everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  // `countries` needs 5.3.0 (Louis, 2026-11-12); scene_actions 5.1.0.
  assert.match(manifest.gladys_version, /^>=5\.3\.0$/);
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-gira');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-gira:${manifest.version}`);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.transports, ['local']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Gira|sans\s+lien\s+avec\s+Gira/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real\s+device|jamais\s+testé\s+avec\s+un\s+vrai\s+appareil/i,
      'say it was never tested',
    );
  }
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai appareil/);
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real device/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the password: a secret field without default, described as the rules ask', () => {
  const secrets = manifest.config_schema.filter((f) => f.type === 'secret');
  assert.deepEqual(
    secrets.map((f) => f.key),
    ['password'],
  );
  for (const field of secrets) {
    assert.ok(!('default' in field), 'never a default on a secret');
    assert.match(field.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
    assert.match(field.description.en, /Kept by Gladys in its database, never shown again/);
    assert.doesNotMatch(JSON.stringify(field), /chiffr|encrypt|hach|hash/i);
  }
  for (const key of [
    'network_discovery',
    'network_wake',
    'containers',
    'scene_triggers',
    'widgets',
  ]) {
    assert.equal(manifest[key], undefined, key);
  }
});

test('the configuration matches the code; the commands are off by default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default ?? '', value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  for (const key of ['allow_control', 'allow_open', 'allow_scenes']) {
    assert.equal(fields[key].type, 'boolean');
    assert.equal(fields[key].default, false, `${key} off by default`);
  }
  assert.equal(fields.username.required, true);
  assert.equal(fields.password.required, true);
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max, fields.poll_interval.default],
    [POLL_INTERVAL.min, POLL_INTERVAL.max, POLL_INTERVAL.default],
  );
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
});

test('the actions are the ones the code handles', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
});

test('the manifest names no app and asks for nothing beyond the local network', () => {
  const text = JSON.stringify(manifest);
  assert.doesNotMatch(text, /user[-_ ]?agent|firmware update|mise à jour du micrologiciel/i);
  assert.ok(!manifest.config_schema.some((f) => f.key.startsWith('gladys_')), 'no gladys_ key');
  assert.ok(Array.isArray(manifest.categories) && manifest.categories.length >= 1);
  assert.ok(manifest.categories.length <= 3);
  assert.equal(manifest.keywords, undefined);
});

test('countries: Germany, Austria and Switzerland (Gira country sites), ISO codes', () => {
  assert.deepEqual(manifest.countries, ['DE', 'AT', 'CH']);
  for (const code of manifest.countries) assert.match(code, /^[A-Z]{2}$/);
});

test('the scene action is the one the code handles, with the bounds of the code', () => {
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    [SCENE_ACTION],
  );
  assert.ok(handlers.includes('onSceneAction(SCENE_ACTION'));
  const [action] = manifest.scene_actions;
  const fields = Object.fromEntries(action.fields.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['function', 'scene']);
  assert.deepEqual([fields.scene.min, fields.scene.max], [SCENE_NUMBER.min, SCENE_NUMBER.max]);
  assert.ok(action.timeout_seconds >= 5);
});

// --- The select options: the core's rules ----------------------------------------

// The core's own validator, when a Gladys clone is at hand (not on GitHub CI).
const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

// The core's rules (server/utils/normalizeSupportedOptions.js), copied so that
// GitHub CI applies them too: a non-blank trimmed string label, a non-blank
// trimmed string (text/select only) or integer value, an integer sort_order,
// no other key, no two values alike in string form.
const OPTION_KEYS = ['id', 'value', 'label', 'sort_order'];
function checkOptions(options, where, allowStringValues) {
  assert.ok(Array.isArray(options) && options.length > 0, `${where}: options`);
  for (const [i, option] of options.entries()) {
    const at = `${where}[${i}]`;
    assert.equal(typeof option.label, 'string', `${at}.label must be a string`);
    assert.ok(option.label.trim().length > 0, `${at}.label is blank`);
    assert.equal(option.label, option.label.trim(), `${at}.label has surrounding whitespace`);
    assert.ok(
      Number.isInteger(option.value) ||
        (allowStringValues &&
          typeof option.value === 'string' &&
          option.value.length > 0 &&
          option.value === option.value.trim()),
      `${at}.value`,
    );
    assert.ok(
      option.sort_order === undefined || Number.isInteger(option.sort_order),
      `${at}.sort_order`,
    );
    assert.deepEqual(
      Object.keys(option).filter((k) => !OPTION_KEYS.includes(k)),
      [],
      `${at}: unknown key`,
    );
  }
  const values = options.map((o) => `${o.value}`);
  assert.equal(new Set(values).size, values.length, `${where}: duplicate values`);
  if (normalizeSupportedOptions) {
    assert.doesNotThrow(() => normalizeSupportedOptions(options, { allowStringValues }), where);
  }
}

test('the option rules reject what the core rejects (the regression guard itself)', () => {
  const bad = [{ value: 0, label: { en: 'Off', fr: 'Arrêt' }, sort_order: 0 }];
  assert.throws(() => checkOptions(bad, 'bad', false), /label must be a string/);
  assert.throws(() => checkOptions([{ value: 0, label: ' ' }], 'bad', false), /blank/);
  assert.throws(() => checkOptions([{ value: 0, label: 'a ' }], 'bad', false), /whitespace/);
  assert.throws(() => checkOptions([{ value: ' a', label: 'a' }], 'bad', true), /value/);
  assert.throws(
    () =>
      checkOptions(
        [
          { value: 1, label: 'a' },
          { value: '1', label: 'b' },
        ],
        'bad',
        true,
      ),
    /duplicate/,
  );
  if (normalizeSupportedOptions) {
    assert.throws(() => normalizeSupportedOptions(bad), /label/);
  }
});

test('every supported_options of the devices, in both languages, is accepted by the core', () => {
  const gladys = createFakeGladys();
  for (const language of ['en', 'fr']) {
    {
      const model = buildModel(
        (type, id) => gladys.externalIds(type, id),
        inventoryOf(fixtureConfig()).functions,
        { language },
      );
      assert.ok(model.devices.length >= 5);
      for (const device of model.devices) {
        for (const feature of device.features) {
          if (feature.supported_options !== undefined) {
            checkOptions(feature.supported_options, feature.external_id, feature.type === 'select');
          }
          assert.equal(typeof feature.name, 'string');
          assert.ok(
            feature.name.trim().length > 0 && feature.name === feature.name.trim(),
            feature.external_id,
          );
        }
      }
    }
  }
  // The select of the manifest follows the same rules once labels are read in one language.
  for (const field of manifest.config_schema.filter((f) => f.type === 'select')) {
    for (const lang of ['en', 'fr']) {
      checkOptions(
        field.options.map((o) => ({ value: o.value, label: o.label[lang] })),
        `${field.key}.${lang}`,
        true,
      );
    }
  }
});
