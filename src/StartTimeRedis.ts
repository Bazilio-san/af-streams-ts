/* eslint-disable no-console */
// noinspection JSUnusedGlobalSymbols

import { createClient, RedisClientType, RedisDefaultModules, RedisModules, RedisScripts } from 'redis';
import { DateTime } from 'luxon';
import { RedisFunctions } from '@redis/client';
import { getTimeParamMillis, intEnv, millisTo, strEnv, timeParamRE } from 'af-tools-ts';
import { echo } from 'af-echo-ts';
import { getStreamKey } from './utils/utils';
import { ICommonConfig, IEmSaveLastTs, IRedisConfig } from './interfaces';
import { PARAMS } from './params';

const prefix = '[af-streams:redis]: ';

export interface StartTimeRedisConstructorOptions {
  commonConfig: ICommonConfig,
  redisConfig?: IRedisConfig
}

export class StartTimeRedis {
  private readonly client: RedisClientType<RedisDefaultModules & RedisModules, RedisFunctions, RedisScripts>;

  private readonly streamKey: string;

  private readonly url: string;

  public eeListeners: { [eventId: string]: (...args: any[]) => any } = {};

  constructor (public options: StartTimeRedisConstructorOptions) {
    const { commonConfig, redisConfig } = options;
    let { port = 0, host = '' } = redisConfig || {};
    const { logger, exitOnError, serviceName, eventEmitter: ee } = commonConfig;
    port = port || intEnv('STREAM_REDIS_PORT', 6379);
    host = host || strEnv('STREAM_REDIS_HOST', '');
    if (!host) {
      exitOnError(`Не указан redis.host при инициализации потока потоков для сервиса ${serviceName}`);
    }

    this.url = `redis://${host}:${port}`;
    this.streamKey = getStreamKey(serviceName);
    logger.info(`${prefix}Redis expected at ${this.url}`);
    this.client = createClient({ url: this.url });
    this.client.on('error', (err: Error | any) => {
      console.error('Redis Client Error');
      exitOnError(err);
    });

    this.eeListeners['save-last-ts'] = async ({ lastTs }: IEmSaveLastTs) => {
      const redisClient = await this.getRedisClient();
      redisClient?.set(this.streamKey, lastTs).catch((err) => logger.error(err));
    };
    Object.entries(this.eeListeners).forEach(([eventId, fn]) => {
      ee.on(eventId, fn);
    });
  }

  async getRedisClient (): Promise<RedisClientType<RedisDefaultModules, RedisFunctions & RedisModules, RedisScripts>> {
    if (this.client.isOpen) {
      return this.client;
    }
    const { logger, exitOnError } = this.options.commonConfig;
    try {
      await this.client.connect();
      logger.info(`${prefix}Connected to REDIS on URL: ${this.url} / streamKey: ${this.streamKey}`);
    } catch (err: Error | any) {
      logger.error('Failed to initialize Redis client');
      exitOnError(err);
    }
    if (!this.client.isOpen) {
      exitOnError('Failed to initialize Redis client');
    }
    return this.client;
  }

  private async getStartTimeFromRedis (): Promise<number> {
    const { logger } = this.options.commonConfig;
    const redisClient = await this.getRedisClient();
    let startTimeMillis: number;
    try {
      startTimeMillis = Number(await redisClient.get(this.streamKey)) || 0;
    } catch (err) {
      logger.error(err);
      return 0;
    }
    if (!startTimeMillis) {
      return 0;
    }
    if (!DateTime.fromMillis(startTimeMillis).isValid) {
      logger.error(`Cache stored data is not a unix timestamp: ${startTimeMillis}`);
      return 0;
    }
    logger.info(`${prefix}Get time of last sent entry: ${millisTo.iso._(startTimeMillis, { includeOffset: true })
    } from the Redis cache using key ${this.streamKey}`);
    return startTimeMillis;
  }

  async defineStartTime (): Promise<void> {
    await this.getRedisClient();
    let startTimeMillis = 0;
    PARAMS.isUsedSavedStartTime = false;
    if (PARAMS.timeStartBeforeMillis) {
      PARAMS.timeStartMillis = Date.now() - PARAMS.timeStartBeforeMillis;
      return;
    }
    if (PARAMS.timeStartMillis) {
      return;
    }
    startTimeMillis = await this.getStartTimeFromRedis();
    if (startTimeMillis) {
      PARAMS.timeStartBeforeMillis = 0;
      PARAMS.timeStartMillis = startTimeMillis;
      PARAMS.isUsedSavedStartTime = true;
      return;
    }
    PARAMS.timeStartMillis = Date.now();
  }

  destroy () {
    Object.entries(this.eeListeners).forEach(([eventId, fn]) => {
      this.options.commonConfig.eventEmitter.removeListener(eventId, fn);
    });
    this.client.disconnect().then(() => 0);
  }
}

let startTimeRedis: StartTimeRedis;

export const getStartTimeRedis = (options: StartTimeRedisConstructorOptions): StartTimeRedis => {
  if (!startTimeRedis) {
    startTimeRedis = new StartTimeRedis(options);
  }
  return startTimeRedis;
};

// !!!Attention!!! STREAM_TIME_START - time in GMT
export const setStartTimeParamsFromENV = () => {
  const { STREAM_TIME_START = '', STREAM_TIME_START_BEFORE = '' } = process.env;
  if (STREAM_TIME_START_BEFORE) {
    if (timeParamRE.test(STREAM_TIME_START_BEFORE)) {
      PARAMS.timeStartBeforeMillis = getTimeParamMillis(STREAM_TIME_START_BEFORE);
      PARAMS.timeStartMillis = Date.now() - PARAMS.timeStartBeforeMillis;
      return;
    }
    echo.error(`Start time is incorrect. STREAM_TIME_START_BEFORE: ${STREAM_TIME_START_BEFORE}`);
  }

  if (STREAM_TIME_START) {
    const dt = DateTime.fromISO(STREAM_TIME_START, { zone: 'GMT' });
    if (dt.isValid) {
      PARAMS.timeStartBeforeMillis = 0;
      PARAMS.timeStartMillis = dt.toMillis();
      return;
    }
    echo.error(`Start time is incorrect. STREAM_TIME_START: ${STREAM_TIME_START}`);
  }
  PARAMS.timeStartBeforeMillis = 0;
  PARAMS.timeStartMillis = 0;
};
