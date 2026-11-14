// -----------------------------------------------------------------------------
// The fixed values of the integration: the Gira IoT REST API v2 (official PDF
// "Gira IoT REST API v2", Gira, 01.07.2020), the timings and the bounds.
// Changing a key here changes what users stored: never rename.
// -----------------------------------------------------------------------------

/** The actions of the configuration screen (manifest `actions`). */
export const ACTIONS = {
  TEST: 'test_connection',
  TRUST: 'trust_certificate',
  LIST_SCENES: 'list_scenes',
};

/** The scene action (manifest `scene_actions`). */
export const SCENE_ACTION = 'run_scene';

/**
 * The client identifier Gladys registers under (PDF 4.1: a URN within the
 * organization of the client). With the same user, the server gives back the
 * same token at every registration (PDF 4.2): nothing to keep.
 */
export const CLIENT_ID = 'io.github.lm1lc3n7.gladys-gira';

/** REST paths, under https://<server>/api/v2 (PDF 2.2). */
export const API_BASE = '/api/v2';
export const PATHS = {
  info: '/',
  clients: '/clients',
  uiconfigUid: '/uiconfig/uid',
  uiconfig: '/uiconfig?expand=dataPointFlags',
  values: (uid) => `/values/${uid}`,
};
export const DEFAULT_PORT = 443;

/** Read interval (s) of the values. */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

/** Scene numbers sent as typed (Execute / Scene data point, Integer). */
export const SCENE_NUMBER = { min: 0, max: 64 };

export const LANGUAGES = ['fr', 'en'];

/** The channel types offered (PDF 9.1, 9.2). */
export const CHANNELS = {
  SWITCH: 'de.gira.schema.channels.Switch',
  DIMMER: 'de.gira.schema.channels.KNX.Dimmer',
  RGBW: 'de.gira.schema.channels.DimmerRGBW',
  WHITE: 'de.gira.schema.channels.DimmerWhite',
  BLIND: 'de.gira.schema.channels.BlindWithPos',
  SCENE_SET: 'de.gira.schema.channels.SceneSet',
  SCENE_CONTROL: 'de.gira.schema.channels.SceneControl',
};

export const TIMINGS = {
  /** Gladys cuts a command at 5 s: a non-protective one leaves within 3.5 s or not at all. */
  commandDeadline: 3500,
  /** One stop request: connection, TLS check and answer. */
  stopTimeout: 3000,
  /** The quick retries of a stop that did not reach the server (the ~250 ms budget). */
  stopQuickRetries: [80, 170],
  /** A kept guard is worked on at this pace, within its age limit. */
  stopRetry: 5000,
  /** A switch-off never sent is given up this long after the click (also across a restart). */
  stateMaxAge: 10 * 60_000,
  /** A cover stop that never left: tried again at this pace, within 3 s (10 s on a read of Movement at 1). */
  stopRetryStep: 1000,
  stopWindow: 3000,
  stopWindowMovement: 10_000,
  /** The read of Movement before a stop is sent again (or before a gate stop). */
  movementRead: 1000,
  /** A close never sent (or refused unexecuted) is given up this long after the click. */
  moveMaxAge: 20_000,
  /** An answered switch-off: reads at these delays; a contradiction counts only in the window. */
  confirmReads: [0, 2000, 5000],
  confirmWindow: 10_000,
  /** Read back of a command after its answer. */
  followUps: [5000, 20_000],
  /** One request (TLS + request + answer), and the longest silence inside it. */
  readTimeout: 15_000,
  idleTimeout: 5000,
  connectTimeout: 5000,
  /** Failure of a read: next try after this, doubling, at most retryMax (never under the interval). */
  retryMin: 30_000,
  retryMax: 15 * 60_000,
  /** 429: a pause between these bounds (Retry-After when given). */
  rateLimitMin: 60_000,
  rateLimitMax: 6 * 3600_000,
  /** A secondary route (values of one function) refused: tried again doubling up to this. */
  secondaryMax: 3600_000,
  /** getConfig() failed: tried again after these, then every minute, without end. */
  configRetry: [5000, 15_000, 30_000, 60_000],
  /** A value read longer ago than this is not sent to a device just created. */
  freshness: 2 * 60_000,
  /** Test button: one real test per this delay, else the last result. */
  testSpacing: 10_000,
  /** Second click of "Trust the certificate" within this delay. */
  trustWindow: 120_000,
  /** The time of the last read is written to /data at most this often. */
  attemptWriteEvery: 60_000,
  /** Longest wait on /data where a wait is allowed (start, shutdown, a pin). */
  dataWait: 2000,
  /** /data unreadable or slow: read again this often, one read at a time. */
  dataRetry: 10_000,
  /** States sent to Gladys every second, within the budget. */
  flushInterval: 1000,
  stateHeartbeat: 3600_000,
};

export const LIMITS = {
  /** The UI configuration of a large project. */
  uiconfigBytes: 4 * 1024 * 1024,
  responseBytes: 256 * 1024,
  functions: 500,
  datapoints: 40,
  /** Functions whose values are read in one cycle (the others at the next ones, in turn). */
  readsPerCycle: 150,
  text: 100,
  statesPerMinute: 300,
  /** Non-protective requests at the same time (reads aside); stops never wait for a slot. */
  commandSlots: 4,
  /** Protective requests at the same time (their own lot of connections). */
  stopSlots: 8,
  /** Kept stops in /data. */
  guards: 64,
  /** Answered sends of one stop: the first and three resends. */
  stopSends: 4,
  /** Of the budget, kept for the states, and for the (unused) events. */
  statesReserve: 50,
  eventsReserve: 10,
  /** Scene functions listed by the "List the scenes" button. */
  scenesListed: 60,
};

/** Gladys COVER_STATE (shutter `state`). */
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
