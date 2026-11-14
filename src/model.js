// -----------------------------------------------------------------------------
// The UI configuration of the Gira server turned into Gladys devices (pure:
// no network). From the official PDF "Gira IoT REST API v2", chapters 5 and 9:
//
//   { uid: "a036", functions: [{ uid: "a029",
//       functionType: "de.gira.schema.functions.KNX.Light",
//       channelType: "de.gira.schema.channels.KNX.Dimmer",
//       displayName: "Lampe Links",
//       dataPoints: [{ uid: "a02a", name: "OnOff", canRead: true, canWrite: true },
//                    { uid: "a02b", name: "Brightness" }] }] }
//
// Values are strings ("1", "70.196078"). Only known keys are copied (no
// prototype from the network), counts and lengths are bounded, numbers are
// strict ('' is unknown).
//
// External ids (frozen, documented in docs/ and CLAUDE.md): device
// `function:<function uid>`. A UID is persistent and never comes back soon
// for something else (PDF 2.1); the pinned certificate tells the server.
//
// KNX conventions: Up-Down 0 is up (open), 1 is down (close); Step-Up-Down
// stops a moving cover (1: the step, if it was not moving, goes down);
// Position is percent CLOSED (100 closed), Gladys position is percent open.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { UID } from './config.js';
import { CHANNELS, COVER_STATE, LIMITS } from './constants.js';
import { featureName } from './i18n.js';

const NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const URN = /^[A-Za-z][A-Za-z0-9.]{0,119}$/;

/** A label from the network: printable, trimmed, bounded; '' when none. */
export function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\x20-\x7e\u00a0-\u024f\u2000-\u206f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** A strict decimal number from a string of the server ('' and junk are unknown). */
export function numberOf(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : undefined;
  if (typeof text !== 'string' || !/^-?\d{1,9}(\.\d{1,9})?$/.test(text.trim())) return undefined;
  return Number(text.trim());
}

/** "0"/"1" (or "false"/"true") -> 0/1, else undefined. */
export const bit = (text) => {
  const t = typeof text === 'string' ? text.trim().toLowerCase() : text;
  if (t === '0' || t === 'false' || t === 0 || t === false) return 0;
  if (t === '1' || t === 'true' || t === 1 || t === true) return 1;
  return undefined;
};

const percent = (text) => {
  const n = numberOf(text);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
};

/** A data point: `{ uid, name, canRead, canWrite }`, or undefined. */
function dataPointOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (typeof raw.uid !== 'string' || !UID.test(raw.uid)) return undefined;
  if (typeof raw.name !== 'string' || !NAME.test(raw.name)) return undefined;
  return {
    uid: raw.uid,
    name: raw.name,
    // Without the flags (older firmware), the channel definition decides.
    canRead: raw.canRead !== false,
    canWrite: raw.canWrite !== false,
  };
}

/** One function: `{ uid, functionType, channelType, label, points: Map<name, dp> }`, or undefined. */
export function functionOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (typeof raw.uid !== 'string' || !UID.test(raw.uid)) return undefined;
  const channelType =
    typeof raw.channelType === 'string' && URN.test(raw.channelType) ? raw.channelType : '';
  const functionType =
    typeof raw.functionType === 'string' && URN.test(raw.functionType) ? raw.functionType : '';
  const points = new Map();
  if (Array.isArray(raw.dataPoints)) {
    for (const entry of raw.dataPoints.slice(0, LIMITS.datapoints)) {
      const dp = dataPointOf(entry);
      if (dp && !points.has(dp.name)) points.set(dp.name, dp);
    }
  }
  return { uid: raw.uid, functionType, channelType, label: cleanText(raw.displayName), points };
}

/** The UI configuration, bounded: `{ uid, functions: Map<uid, function> }`. */
export function inventoryOf(json) {
  const out = { uid: undefined, functions: new Map(), truncated: false };
  if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
  if (typeof json.uid === 'string' && UID.test(json.uid)) out.uid = json.uid;
  if (!Array.isArray(json.functions)) return out;
  // Beyond the bound, the rest is not offered: said in the status.
  out.truncated = json.functions.length > LIMITS.functions;
  const seenPoints = new Set();
  for (const raw of json.functions.slice(0, LIMITS.functions)) {
    const fn = functionOf(raw);
    if (!fn || out.functions.has(fn.uid)) continue;
    // A data point uid belongs to one function only.
    for (const [name, dp] of [...fn.points]) {
      if (seenPoints.has(dp.uid) || dp.uid === fn.uid) fn.points.delete(name);
      else seenPoints.add(dp.uid);
    }
    out.functions.set(fn.uid, fn);
  }
  return out;
}

/** The answer of GET /values/<uid>: Map<data point uid, value string> (bounded). */
export function valuesOfAnswer(json) {
  const out = new Map();
  const list = json && typeof json === 'object' ? json.values : undefined;
  if (!Array.isArray(list)) return out;
  for (const entry of list.slice(0, LIMITS.datapoints)) {
    if (!entry || typeof entry !== 'object' || typeof entry.uid !== 'string') continue;
    if (!UID.test(entry.uid)) continue;
    const v = entry.value;
    if (typeof v === 'string' && v.length <= 100) out.set(entry.uid, v);
    else if (typeof v === 'number' && Number.isFinite(v)) out.set(entry.uid, String(v));
    else if (typeof v === 'boolean') out.set(entry.uid, v ? '1' : '0');
  }
  return out;
}

/** A command value of Gladys: a finite number, never null, '' nor a boolean. */
export function commandNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  // Strict decimal: no blank, hexadecimal, exponent nor surrounding space.
  if (typeof value === 'string' && /^-?\d{1,9}(\.\d{1,6})?$/.test(value)) return Number(value);
  return undefined;
}

export class Refusal extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'Refusal';
    this.refusal = code;
  }
}

const bad = () => {
  throw new Refusal('badValue');
};

/** The role of a function, from its channel and data points; undefined when not offered. */
export function roleOf(fn) {
  const p = (name) => fn.points.get(name);
  const onOff = p('OnOff');
  switch (fn.channelType) {
    case CHANNELS.SWITCH:
      return onOff?.canWrite ? { role: 'light', onOff } : undefined;
    case CHANNELS.DIMMER:
    case CHANNELS.RGBW:
    case CHANNELS.WHITE: {
      if (!onOff?.canWrite) return undefined;
      const brightness = p('Brightness');
      return brightness?.canWrite
        ? { role: 'dimmer', onOff, brightness }
        : { role: 'light', onOff };
    }
    case CHANNELS.BLIND: {
      const upDown = p('Up-Down');
      const step = p('Step-Up-Down');
      if (!upDown?.canWrite || !step?.canWrite) return undefined;
      const position = p('Position');
      // Movement (read, optional): whether the cover is moving now.
      const movement = p('Movement')?.canRead ? p('Movement') : undefined;
      return { role: 'cover', upDown, step, position, movement };
    }
    case CHANNELS.SCENE_SET: {
      const execute = p('Execute');
      return execute?.canWrite ? { role: 'scene', execute } : undefined;
    }
    case CHANNELS.SCENE_CONTROL: {
      const execute = p('Scene');
      return execute?.canWrite ? { role: 'scene', execute } : undefined;
    }
    default:
      return undefined;
  }
}

export function emptyModel() {
  return {
    devices: [],
    /** data point uid -> [{ featureId, read(text) }] */
    readers: new Map(),
    /** feature id -> { target, channelType, write(value) -> op } */
    writers: new Map(),
    /** function uid -> Gladys device external id */
    targetDevices: new Map(),
    /** function uid -> role */
    roles: new Map(),
    /** function uid -> data point uids read (lights, covers) */
    readPoints: new Map(),
    /** scene functions: uid -> { uid, label, execute } */
    scenes: new Map(),
    counts: { functions: 0, offered: 0, skipped: 0, scenes: 0, excluded: 0 },
  };
}

/**
 * @param {(type: string, id: string) => { device: string, feature: (k: string) => string }} idsOf gladys.externalIds
 * @param {Map<string, object>} functions
 * @param {{ language?: 'fr'|'en' }} options
 */
export function buildModel(idsOf, functions, options = {}) {
  const { language = 'fr', excluded = new Set(), awnings = new Set(), gates = new Set() } = options;
  const model = emptyModel();
  const name = (key) => featureName(key, language);

  for (const fn of functions.values()) {
    model.counts.functions += 1;
    // Not offered by the user's choice ("Functions not offered").
    if (excluded.has(fn.uid)) {
      model.counts.excluded += 1;
      continue;
    }
    const found = roleOf(fn);
    if (!found) {
      model.counts.skipped += 1;
      continue;
    }
    if (found.role === 'scene') {
      model.counts.scenes += 1;
      model.scenes.set(fn.uid, { uid: fn.uid, label: fn.label, execute: found.execute });
      continue;
    }
    model.counts.offered += 1;
    const ids = idsOf('function', fn.uid);
    const features = [];
    const reads = new Set();
    const add = (key, spec, { dp, read, write } = {}) => {
      const featureId = ids.feature(key);
      const readable = Boolean(dp && read && dp.canRead);
      features.push({
        name: name(key),
        external_id: featureId,
        category: spec.category,
        type: spec.type,
        min: spec.min ?? 0,
        max: spec.max ?? 1,
        read_only: !write,
        has_feedback: Boolean(write && readable),
        keep_history: spec.history ?? true,
      });
      if (readable) {
        const list = model.readers.get(dp.uid) ?? [];
        list.push({ featureId, read });
        model.readers.set(dp.uid, list);
        reads.add(dp.uid);
      }
      if (write) {
        model.writers.set(featureId, { target: fn.uid, channelType: fn.channelType, write });
      }
      return featureId;
    };
    const { role } = found;
    model.roles.set(fn.uid, role);
    const op = (dp, value, extra) => ({
      target: fn.uid,
      fid: fn.uid,
      dpid: dp.uid,
      key: dp.name,
      value,
      ...extra,
    });

    if (role === 'light' || role === 'dimmer') {
      const off = () => op(found.onOff, 0, { protective: true, kind: 'state' });
      add(
        'on',
        { category: C.LIGHT, type: T.LIGHT.BINARY },
        {
          dp: found.onOff,
          read: bit,
          write: (value) => {
            const v = commandNumber(value);
            if (v === 0) return off();
            if (v === 1)
              return op(found.onOff, 1, { protective: false, kind: 'state', need: 'control' });
            return bad();
          },
        },
      );
      if (role === 'dimmer') {
        add(
          'brightness',
          { category: C.LIGHT, type: T.LIGHT.BRIGHTNESS, max: 100 },
          {
            dp: found.brightness,
            read: (text) => {
              const n = percent(text);
              return n === undefined ? undefined : Math.round(n);
            },
            write: (value) => {
              const v = commandNumber(value);
              if (v === undefined || v < 0 || v > 100) return bad();
              // 0 is "off": the protective path, on OnOff.
              if (Math.round(v) === 0) return off();
              return op(found.brightness, Math.round(v), {
                protective: false,
                kind: 'state',
                need: 'control',
              });
            },
          },
        );
      }
    } else if (role === 'cover') {
      const { upDown, step, position } = found;
      const sense = coverSense(fn.uid, { awnings, gates });
      // KNX: Up-Down 0 up, 1 down. An awning closes (retracts) up; a shutter down.
      const closeValue = sense === 'awning' ? 0 : 1;
      const closedAt = sense === 'awning' ? 0 : 100;
      // A gate (garage door): closing needs the opening option, it is never protective.
      const close = () =>
        sense === 'gate'
          ? op(upDown, closeValue, { protective: false, kind: 'move', need: 'open' })
          : op(upDown, closeValue, {
              protective: true,
              kind: 'move',
              close: true,
              posDpid: position?.uid,
              closedAt,
            });
      // A stop is a step, which moves a cover at rest: towards closed for a
      // shutter, up (in) for an awning. A gate at rest would step: its stop
      // leaves only when Movement does not show it at rest (read first);
      // without Movement, it needs the opening option, then takes the path
      // of every stop (protective).
      const stop = () =>
        op(step, sense === 'awning' ? 0 : 1, {
          protective: true,
          kind: 'move',
          movementDpid: found.movement?.uid,
          gate: sense === 'gate',
          ...(sense === 'gate' && !found.movement ? { need: 'open' } : {}),
        });
      add(
        'state',
        { category: C.SHUTTER, type: T.SHUTTER.STATE, min: -1, max: 1 },
        {
          write: (value) => {
            const v = commandNumber(value);
            if (v === COVER_STATE.CLOSE) return close();
            if (v === COVER_STATE.STOP) return stop();
            if (v === COVER_STATE.OPEN) {
              return op(upDown, 1 - closeValue, { protective: false, kind: 'move', need: 'open' });
            }
            return bad();
          },
        },
      );
      if (position) {
        // Gladys position: percent open (an awning: percent extended).
        const toKnx = (open) => (closedAt === 100 ? 100 - open : open);
        add(
          'position',
          { category: C.SHUTTER, type: T.SHUTTER.POSITION, max: 100 },
          {
            dp: position,
            read: (text) => {
              const knx = percent(text);
              return knx === undefined ? undefined : toKnx(Math.round(knx));
            },
            write: position.canWrite
              ? (value) => {
                  const v = commandNumber(value);
                  if (v === undefined || v < 0 || v > 100) return bad();
                  const open = Math.round(v);
                  // Fully closed is a close (protective but on a gate); any other position may open.
                  if (open === 0) return close();
                  return op(position, toKnx(open), {
                    protective: false,
                    kind: 'move',
                    need: 'open',
                  });
                }
              : undefined,
          },
        );
      }
    }

    model.targetDevices.set(fn.uid, ids.device);
    model.readPoints.set(fn.uid, reads);
    model.devices.push({
      name: fn.label || `Gira ${fn.uid}`,
      external_id: ids.device,
      model: fn.channelType.split('.').slice(-1)[0] || 'Gira',
      features,
      params: [
        { name: 'GIRA_FUNCTION', value: fn.uid },
        { name: 'GIRA_CHANNEL', value: fn.channelType },
        ...(role === 'cover'
          ? [{ name: 'GIRA_SENSE', value: coverSense(fn.uid, { awnings, gates }) }]
          : []),
        // The data points of the stops: a stop leaves even before the first read.
        ...[
          ['GIRA_ONOFF', found.onOff],
          ['GIRA_UPDOWN', found.upDown],
          ['GIRA_STEP', found.step],
          ['GIRA_POSITION', found.position],
          ['GIRA_MOVEMENT', found.movement],
        ]
          .filter(([, dp]) => dp)
          .map(([n, dp]) => ({ name: n, value: dp.uid })),
      ],
    });
  }
  return model;
}

/** How a cover moves: 'shutter', 'awning' (direction reversed) or 'gate' (closing needs the option). */
export function coverSense(uid, { awnings = new Set(), gates = new Set() } = {}) {
  if (gates.has(uid)) return 'gate';
  if (awnings.has(uid)) return 'awning';
  return 'shutter';
}

/** The Gladys values of one data point value: `[{ featureId, value }]`. */
export function valuesOf(model, dpid, text) {
  const out = [];
  for (const { featureId, read } of model.readers.get(dpid) ?? []) {
    const value = read(text);
    if (value !== undefined) out.push({ featureId, value });
  }
  return out;
}

/** Whether a value read shows what `op` asked (undefined when it does not tell). */
export function applied(op, text) {
  if (text === undefined) return undefined;
  if (op.key === 'OnOff') {
    const b = bit(text);
    return b === undefined ? undefined : b === op.value;
  }
  if (op.key === 'Brightness') {
    const n = percent(text);
    return n === undefined ? undefined : Math.abs(n - op.value) <= 1;
  }
  if (op.key === 'Position') {
    const n = percent(text);
    return n === undefined ? undefined : Math.abs(n - op.value) <= 2;
  }
  // Up-Down, Step-Up-Down, scenes: write only (PDF 9.2), never read back.
  return undefined;
}

/**
 * The stop a created device asks for when the UI configuration is not known
 * (yet): after a restart before the first read. Only protective commands,
 * from the device's own params (its data points); undefined for anything else.
 */
export function stopFromDevice(device, feature, value, options = {}) {
  const param = (n) => {
    const found = (Array.isArray(device?.params) ? device.params : []).find((p) => p?.name === n);
    return typeof found?.value === 'string' && UID.test(found.value) ? found.value : undefined;
  };
  const fid = param('GIRA_FUNCTION');
  if (!fid || options.excluded?.has(fid)) return undefined;
  const key = String(feature?.external_id ?? '')
    .split(':')
    .pop();
  const v = commandNumber(value);
  const op = (dpid, k, val, kind, extra = {}) =>
    dpid
      ? { target: fid, fid, dpid, key: k, value: val, protective: true, kind, ...extra }
      : undefined;
  const onOff = param('GIRA_ONOFF');
  const upDown = param('GIRA_UPDOWN');
  const step = param('GIRA_STEP');
  const position = param('GIRA_POSITION');
  const movement = param('GIRA_MOVEMENT');
  if ((key === 'state' || key === 'position') && upDown) {
    // The sense of today's configuration.
    const sense = coverSense(fid, options);
    if (key === 'state' && v === COVER_STATE.STOP) {
      return op(step, 'Step-Up-Down', sense === 'awning' ? 0 : 1, 'move', {
        movementDpid: movement,
        gate: sense === 'gate',
        // A gate without Movement: its stop needs the opening option (checked by the stop path).
        ...(sense === 'gate' && !movement ? { need: 'open' } : {}),
      });
    }
    // A gate never closes without the option.
    if (sense === 'gate') return undefined;
    if ((key === 'state' && v === COVER_STATE.CLOSE) || (key === 'position' && v === 0)) {
      const awning = sense === 'awning';
      return op(upDown, 'Up-Down', awning ? 0 : 1, 'move', {
        close: true,
        posDpid: position,
        closedAt: awning ? 0 : 100,
      });
    }
    return undefined;
  }
  if ((key === 'on' || key === 'brightness') && v === 0) return op(onOff, 'OnOff', 0, 'state');
  return undefined;
}

/** The channel a created device was built from (its param), or undefined. */
export function channelOfDevice(device) {
  const found = (Array.isArray(device?.params) ? device.params : []).find(
    (p) => p?.name === 'GIRA_CHANNEL',
  );
  return typeof found?.value === 'string' ? found.value : undefined;
}
