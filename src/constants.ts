export const TS_FIELD = '__ts__';
export const STREAM_ID_FIELD = '__streamId__';
export const MILLIS_IN_DAY = 86_400_000;
export const MILLIS_IN_HOUR = 3_600_000;
export const MIN_WINDOW_MILLIS = 2;

export const DEFAULTS = {
  FETCH_INTERVAL_SEC: 10,
  BUFFER_MULTIPLIER: 2,
  MAX_BUFFER_SIZE: 65_000,
  MAX_RUNUP_FIRST_TS_VT_MILLIS: 2_000,
  STREAM_SEND_INTERVAL_MILLIS: 10,
  TIME_FRONT_UPDATE_INTERVAL_MILLIS: 5,
  SKIP_GAPS: false,
  PRINT_INFO_INTERVAL_SEC: 60,
  RECTIFIER_ACCUMULATION_TIME_MILLIS: 300_000,
  RECTIFIER_SEND_INTERVAL_MILLIS: 10,
  RECTIFIER_FIELD_NAME_TO_SORT: 'ts',
};

const DEBUG = (String(process.env.DEBUG || '')).trim();
const isTotalDebug = DEBUG === '*';
const isTotalStreamDebug = isTotalDebug || /\baf-streams:?\*/i.test(DEBUG);

export const DEBUG_SQL = isTotalStreamDebug || /\baf-streams:sql\b/i.test(DEBUG); // Portion SQL
export const DEBUG_LTR = isTotalStreamDebug || /\baf-streams:ltr\b/i.test(DEBUG); // LastTimeRecords
export const DEBUG_LNP = isTotalStreamDebug || /\baf-streams:lnp\b/i.test(DEBUG); // before & after load next portion
export const DEBUG_STREAM = isTotalStreamDebug || /\baf-streams:stream\b/i.test(DEBUG);
export const DEBUG_ALERTS_BUFFER = isTotalStreamDebug || /\baf-streams:alerts-buffer\b/i.test(DEBUG);

const getBool = (v: any): boolean => /^(true|1|yes)$/i.test(String(v));
const floatEnv = (name: string, def: number) => {
  let v = process.env[name];
  if (!v) {
    return def;
  }
  v = v.replace(/_/g, '');
  const val = parseFloat(v);
  return val || val === 0 ? val : def;
};

const intEnv = (name: string, def: number) => Math.ceil(floatEnv(name, def));

// eslint-disable-next-line no-shadow
export enum EMailSendRule {
  IF_ALERT_NOT_EXISTS = 'IF_ALERT_NOT_EXISTS',
  BLOCK = 'BLOCK',
  FORCE = 'FORCE'
}

export const STREAMS_ENV = {
  EMAIL_SEND_RULE: EMailSendRule.IF_ALERT_NOT_EXISTS,
  NO_SAVE_HISTORY_ALERTS: false,
  PRINT_EVERY_REMOVED_ITEM_FROM_KEYED_SINGLE_EVENT_TIME_WINDOW: false,
  FETCH_INTERVAL_SEC: DEFAULTS.FETCH_INTERVAL_SEC,
  BUFFER_MULTIPLIER: DEFAULTS.BUFFER_MULTIPLIER,
  STREAM_SEND_INTERVAL_MILLIS: DEFAULTS.STREAM_SEND_INTERVAL_MILLIS,
  TIME_FRONT_UPDATE_INTERVAL_MILLIS: DEFAULTS.TIME_FRONT_UPDATE_INTERVAL_MILLIS,
  RECTIFIER_SEND_INTERVAL_MILLIS: DEFAULTS.RECTIFIER_SEND_INTERVAL_MILLIS,
  RECTIFIER_ACCUMULATION_TIME_MILLIS: DEFAULTS.RECTIFIER_ACCUMULATION_TIME_MILLIS,
  MAX_RUNUP_FIRST_TS_VT_MILLIS: DEFAULTS.MAX_RUNUP_FIRST_TS_VT_MILLIS,
};

// Через переменную окружения EMAIL_SEND_RULE Можно управлять правилом отправки
export const reloadStreamsEnv = () => {
  const rule = process.env.EMAIL_SEND_RULE as EMailSendRule;
  STREAMS_ENV.EMAIL_SEND_RULE = Object.values(EMailSendRule).includes(rule)
    ? rule
    : EMailSendRule.IF_ALERT_NOT_EXISTS;
  STREAMS_ENV.NO_SAVE_HISTORY_ALERTS = getBool(process.env.NO_SAVE_HISTORY_ALERTS);
  STREAMS_ENV.PRINT_EVERY_REMOVED_ITEM_FROM_KEYED_SINGLE_EVENT_TIME_WINDOW = getBool(process.env.PRINT_EVERY_REMOVED_ITEM_FROM_KEYED_SINGLE_EVENT_TIME_WINDOW);
  STREAMS_ENV.FETCH_INTERVAL_SEC = intEnv('STREAM_FETCH_INTERVAL_SEC', DEFAULTS.FETCH_INTERVAL_SEC);
  STREAMS_ENV.BUFFER_MULTIPLIER = intEnv('STREAM_FETCH_INTERVAL_SEC', DEFAULTS.BUFFER_MULTIPLIER);
  STREAMS_ENV.STREAM_SEND_INTERVAL_MILLIS = intEnv('STREAM_SEND_INTERVAL_MILLIS', DEFAULTS.STREAM_SEND_INTERVAL_MILLIS);
  STREAMS_ENV.TIME_FRONT_UPDATE_INTERVAL_MILLIS = intEnv('TIME_FRONT_UPDATE_INTERVAL_MILLIS', DEFAULTS.TIME_FRONT_UPDATE_INTERVAL_MILLIS);
  STREAMS_ENV.RECTIFIER_SEND_INTERVAL_MILLIS = intEnv('RECTIFIER_SEND_INTERVAL_MILLIS', DEFAULTS.RECTIFIER_SEND_INTERVAL_MILLIS);
  STREAMS_ENV.RECTIFIER_ACCUMULATION_TIME_MILLIS = intEnv('RECTIFIER_ACCUMULATION_TIME_MILLIS', DEFAULTS.RECTIFIER_ACCUMULATION_TIME_MILLIS);
  STREAMS_ENV.MAX_RUNUP_FIRST_TS_VT_MILLIS = intEnv('STREAM_MAX_RUNUP_FIRST_TS_VT_MILLIS', DEFAULTS.MAX_RUNUP_FIRST_TS_VT_MILLIS);
};

reloadStreamsEnv();

export const isDeprecatedSendAlertsByEmail = () => STREAMS_ENV.EMAIL_SEND_RULE === EMailSendRule.BLOCK;
