/* eslint-disable no-await-in-loop */
// noinspection JSUnusedGlobalSymbols

import EventEmitter from 'events';
import { Stream } from '../Stream';
import { echoSimple } from '../utils/echo-simple';
import { VirtualTimeObj, getVirtualTimeObj, IVirtualTimeObjOptions } from '../VirtualTimeObj';
import {
  ICommonConfig, IEmAfterLoadNextPortion, IEmBeforeLoadNextPortion, IOFnArgs, ISenderConfig, IStartTimeConfig, IStreamConfig, IVirtualTimeConfig, TEventRecord,
} from '../interfaces';
import { cloneDeep, intEnv, timeParamRE } from '../utils/utils';
import { DEFAULTS, STREAMS_ENV, reloadStreamsEnv, STREAM_ID_FIELD, EMailSendRule } from '../constants';
import { IRectifierOptions, Rectifier } from '../classes/applied/Rectifier';
import localEventEmitter from '../ee-scoped';
import { AlertsBuffer } from '../alerts-buffer/AlertsBuffer';
import { IAlertEmailSettings, TAlert, TMergeResult } from '../alerts-buffer/i-alert';
import { toUTC_ } from '../utils/date-utils';

const findLast = require('array.prototype.findlast');

const STATISTICS_SEND_INTERVAL = { SLOW: 1000, QUICK: 200 };

export interface IPrepareRectifierOptions {
  /**
   * Периодичность отправки ts-объектов,
   * время которых старше <virtualTs> - <accumulationTimeMillis>
   */
  sendIntervalMillis?: number,

  /**
   * Имя свойства ts-объектов, содержащих метку времени,
   * по которому нужно производить упорядочивание внутри аккумулятора.
   * Если не передано, используется "ts"
   */
  fieldNameToSort?: string,

  /**
   * Время, в пределах которого происходит аккумуляция и выпрямление событий
   */
  accumulationTimeMillis?: number,

  /**
   * Callback, которому передается массив ts-объектов, упорядоченный по возрастанию
   * значения поля fieldNameToSort (или ts)
   */
  sendFunction: (_rectifierItemsArray: TEventRecord[]) => number,
}

export interface IPrepareAlertsBufferOptions {
  /**
   * Настройки для отправки E-Mail
   */
  emailSettings: IAlertEmailSettings,

  /**
   * Функция сохранения/обновления сигналов
   */
  mergeAlerts: (alerts: TAlert[]) => Promise<TMergeResult>;

  /**
   * Функция проверки наличия сохраненного сигнала в БД
   */
  checkAlertExists: (guid: string) => Promise<boolean>,

  /**
   * Функция сохранения признаков "обработан"
   */
  mergeAlertsActions: (guids: string[], operationIds: number[]) => Promise<void>

  /**
   * Время, в течение которого храним состояние отправки/сохранения сигнала
   */
  trackAlertsStateMillis?: number, // Default = MILLIS_IN_HOUR

  /**
   * Периодичность очистки кеша состояний сигналов
   */
  removeExpiredItemsFromAlertsStatesCacheIntervalMillis?: number, // Default = 60_000

  /**
   * Период вывода сигналов из буфера на отправку по Email и сохранение в БД
   */
  flushBufferIntervalSeconds?: number, // Default = 3

  /**
   * Массив идентификаторов операторов, для которых нужно устанавливать флажки - признаки новых сигналов
   */
  setFlagToProcForOperators?: number[],
}

export interface IPrepareStreamOptions {
  streamConfig: IStreamConfig,
  senderConfig: ISenderConfig,
}

const changeStreamParams = (stream: Stream, params: any) => {
  Object.entries(params).forEach(([key, value]: [string, any]) => {
    let isSetEnv = true;
    switch (key) {
      case 'STREAM_BUFFER_MULTIPLIER':
        stream.setBufferMultiplier(value);
        break;
      case 'STREAM_FETCH_INTERVAL_SEC':
        stream.setFetchIntervalSec(value);
        break;
      case 'STREAM_MAX_BUFFER_SIZE':
        stream.setMaxBufferSize(value);
        break;
      case 'STREAM_MAX_RUNUP_FIRST_TS_VT_MILLIS':
        stream.setMaxRunUpFirstTsVtMillis(value);
        break;
      case 'STREAM_PRINT_INFO_INTERVAL_SEC':
        stream.setPrintInfoIntervalSec(value);
        break;
      case 'STREAM_SEND_INTERVAL_MILLIS':
        stream.setStreamSendIntervalMillis(value);
        break;
      case 'STREAM_SKIP_GAPS':
        stream.setSkipGaps(value);
        break;
      default:
        isSetEnv = false;
    }
    if (isSetEnv) {
      process.env[key] = String(value);
    }
  });
};

export class StreamsManager {
  public map: { [streamId: string]: Stream };

  public rectifier: Rectifier = null as unknown as Rectifier;

  public virtualTimeObj: VirtualTimeObj = null as unknown as VirtualTimeObj;

  public alertsBuffer: AlertsBuffer = null as unknown as AlertsBuffer;

  private _statLoopTimerId: any;

  private _locked: boolean = true;

  private _connectedSockets: Set<string>;

  private statisticsSendIntervalMillis: number = STATISTICS_SEND_INTERVAL.QUICK;

  constructor (public commonConfig: ICommonConfig) {
    this.map = {};
    this._locked = true;
    this._connectedSockets = new Set();
    this.checkCommonConfig(true);
  }

  checkCommonConfig (isInit: boolean = false) {
    const t = `${isInit ? 'passed to' : 'found in'} stream manager`;
    const { exitOnError, logger, echo, eventEmitter } = this.commonConfig || {};
    if (!exitOnError) {
      // eslint-disable-next-line no-console
      console.error(`No 'exitOnError' function ${t}`);
      process.exit(1);
    }
    if (!echo) {
      exitOnError(`No 'echo' object ${t}`);
    }
    if (!logger) {
      exitOnError(`No 'logger' object ${t}`);
    }
    if (!eventEmitter) {
      exitOnError(`No 'eventEmitter' object ${t}`);
    }
  }

  checkVirtualTimeObject () {
    if (!this.virtualTimeObj) {
      this.commonConfig.exitOnError(`No 'echo' object found in stream manager`);
    }
  }

  async prepareVirtualTimeObj (
    args: {
      virtualTimeConfig: IVirtualTimeConfig,
      startTimeConfig: IStartTimeConfig,
    },
  ): Promise<VirtualTimeObj> {
    this.checkCommonConfig();
    const { commonConfig } = this;
    this.virtualTimeObj = await getVirtualTimeObj({ commonConfig, ...args });
    return this.virtualTimeObj;
  }

  prepareAlertsBuffer (prepareAlertsBufferOptions: IPrepareAlertsBufferOptions): AlertsBuffer {
    this.checkCommonConfig();
    const { commonConfig: { logger, echo, eventEmitter }, virtualTimeObj } = this;
    this.alertsBuffer = new AlertsBuffer({ logger, echo, eventEmitter, virtualTimeObj, ...prepareAlertsBufferOptions });
    return this.alertsBuffer;
  }

  async prepareStreams (
    optionsArray: IPrepareStreamOptions | IPrepareStreamOptions[],
    prepareRectifierOptions?: IPrepareRectifierOptions,
  ): Promise<Stream[]> {
    this.checkCommonConfig();
    this.checkVirtualTimeObject();
    const { commonConfig, virtualTimeObj } = this;
    if (!Array.isArray(optionsArray)) {
      optionsArray = [optionsArray];
    }
    if (prepareRectifierOptions) {
      const { sendIntervalMillis, fieldNameToSort, accumulationTimeMillis, sendFunction } = prepareRectifierOptions;
      const rectifierOptions: IRectifierOptions = {
        virtualTimeObj,
        accumulationTimeMillis: accumulationTimeMillis || intEnv('RECTIFIER_ACCUMULATION_TIME_MILLIS', DEFAULTS.RECTIFIER_ACCUMULATION_TIME_MILLIS),
        sendIntervalMillis: sendIntervalMillis || intEnv('RECTIFIER_SEND_INTERVAL_MILLIS', DEFAULTS.RECTIFIER_SEND_INTERVAL_MILLIS),
        fieldNameToSort: fieldNameToSort || DEFAULTS.RECTIFIER_FIELD_NAME_TO_SORT,
        sendFunction,
      };
      // Подготавливаем "Выпрямитель". Он будет получать все события потоков
      this.rectifier = new Rectifier(rectifierOptions);
    }
    return optionsArray.map((options: IPrepareStreamOptions) => {
      if (prepareRectifierOptions) {
        options.senderConfig.type = 'callback';
        // Заглушка. Поскольку инициализируется Выпрямитель, сюда будет
        // прописана функция передачи событий в выпрямитель
        options.senderConfig.eventCallback = (eventRecord: TEventRecord) => this.rectifier.add(eventRecord);
      }
      const { streamId } = options.streamConfig;
      if (this.map[streamId]) {
        echoSimple(`Stream '${streamId}' already exists`);
        return this.map[streamId];
      }
      const stream = new Stream({ ...options, commonConfig, virtualTimeObj });
      this.map[streamId] = stream;
      return stream;
    });
  }

  async initStreams (): Promise<Stream[]> {
    const streams: Stream[] = [];

    for (let i = 0; i < this.streams.length; i++) {
      const stream = await this.streams[i].init();
      streams.push(stream);
    }
    return streams;
  }

  get streamIds (): string[] {
    return Object.keys(this.map);
  }

  get streams (): Stream[] {
    return Object.values(this.map);
  }

  has (streamId: string): boolean {
    return Boolean(this.map[streamId]);
  }

  getStream (streamId: string): Stream | undefined {
    return this.map[streamId];
  }

  get eventEmitter (): EventEmitter {
    return this.commonConfig.eventEmitter;
  }

  changeStreamsParams (data: any) {
    const { params, env } = data || {};
    if (typeof env === 'object') {
      Object.entries(env).forEach(([envName, envValue]) => {
        process.env[envName] = String(envValue);
      });
    }
    if (typeof params !== 'object') {
      return;
    }
    const { virtualTimeObj } = this;
    if (!virtualTimeObj) {
      return;
    }

    Object.entries(params).forEach(([key, value]: [string, any]) => {
      let isSetEnv = true;
      switch (key) {
        case 'STREAM_LOOP_TIME_MILLIS':
          virtualTimeObj.setLoopTimeMillis(value);
          break;
        case 'STREAM_SPEED_CALC_INTERVAL_SEC':
          virtualTimeObj.setSpeedCalcIntervalSec(value);
          break;
        case 'STREAM_TIME_FRONT_UPDATE_INTERVAL_MILLIS':
          virtualTimeObj.setTimeFrontUpdateIntervalMillis(value);
          break;
        // #################################################
        case 'startFromLastStop': {
          process.env.STREAM_USE_START_TIME_FROM_REDIS_CACHE = value ? '1' : '0';
          virtualTimeObj.options.startTimeRedis.options.startTimeConfig.useStartTimeFromRedisCache = !!value;
          break;
        }
        case 'streamStartTime': {
          process.env.STREAM_START_TIME = value;
          break;
        }
        case 'streamStartBefore': {
          if (timeParamRE.test(String(value || ''))) {
            process.env.STREAM_START_BEFORE = value;
          }
          break;
        }
        case 'speed': {
          const speed = Math.floor(parseFloat(String(value)) || 0);
          if (speed < 1) {
            return;
          }
          process.env.STREAM_SPEED = String(speed);
          virtualTimeObj.setSpeed(value);
          break;
        }
        case 'emailSendRule': {
          if (Object.values(EMailSendRule).includes(value)) {
            process.env.EMAIL_SEND_RULE = value;
          }
          break;
        }
        case 'saveHistoricalAlerts': {
          if (typeof value === 'boolean') {
            process.env.NO_SAVE_HISTORY_ALERTS = value ? '0' : '1';
          }
          break;
        }
        default:
          isSetEnv = false;
      }
      if (isSetEnv) {
        process.env[key] = String(value);
      }
    });
    reloadStreamsEnv();

    let { streamIds } = data;
    if (!Array.isArray(streamIds)) {
      ({ streamIds } = this);
    }
    streamIds.forEach((streamId: string) => {
      if (this.has(streamId)) {
        const stream = this.getStream(streamId);
        if (stream) {
          changeStreamParams(stream, params);
        }
      }
    });
  }

  getConfigs (): { virtualTimeConfig: IVirtualTimeObjOptions, streamConfigs: { streamConfig: IStreamConfig, senderConfig: ISenderConfig }[] } {
    const streamConfigs = this.streams.map((stream) => (stream.getActualConfig() as { streamConfig: IStreamConfig, senderConfig: ISenderConfig }));
    const virtualTimeConfig = cloneDeep<IVirtualTimeObjOptions>(this.virtualTimeObj.options);
    // @ts-ignore
    delete virtualTimeConfig.commonConfig;
    return { virtualTimeConfig, streamConfigs };
  }

  getConfigsParams (): { [paramName: string]: string | number | boolean | undefined } {
    let streamStartBefore: string | undefined = process.env.STREAM_START_BEFORE;
    if (!timeParamRE.test(String(streamStartBefore || ''))) {
      streamStartBefore = undefined;
    }

    return {
      startFromLastStop: this.virtualTimeObj?.options.startTimeRedis.options.startTimeConfig.useStartTimeFromRedisCache,
      streamStartTime: toUTC_(this.virtualTimeObj?.options.startTimeMillis || 0),
      streamStartBefore,
      speed: this.virtualTimeObj?.speed,
      emailSendRule: STREAMS_ENV.EMAIL_SEND_RULE,
      saveHistoricalAlerts: !STREAMS_ENV.NO_SAVE_HISTORY_ALERTS,
      isStopped: this.isStopped(),
      isSuspended: this._locked,
    };
  }

  suspend () {
    this._locked = true;
    this.slowDownStatistics();
    this.streams.forEach((stream) => {
      stream.lock(true);
    });
  }

  continue () {
    this.streams.forEach((stream) => {
      stream.unLock(true);
    });
    this._locked = false;
    this.startIO(true);
  }

  async start (): Promise<Stream[]> {
    reloadStreamsEnv();
    await this.virtualTimeObj?.resetWithStartTime();
    this.virtualTimeObj?.startUpInfo();
    const streams = await Promise.all(this.streams.map((stream) => stream.start()));
    this._locked = false;
    this.startIO(true);
    return streams;
  }

  collectAndEmitStatistics () {
    /*
    виртуальное время
    диапазон запроса потока 1
    диапазон запроса потока 2

    ширина окна выпрямителя
    мин-макс события в выпрямителе
     - первого потока
     - второго потока
    мин-макс события в буфере 1 потока + количество
    мин-макс события в буфере 2 потока + количество
    */
    const isSuspended = this._locked;
    const isStopped = this.isStopped();
    let data: any = { isSuspended, isStopped };

    if (!isStopped) {
      const { rectifier, virtualTimeObj, streams } = this;
      const { accumulator } = rectifier || {};
      const { length = 0 } = accumulator || {};

      data = {
        isSuspended,
        isStopped,
        vt: virtualTimeObj?.virtualTs || 0,
        isCurrentTime: !!virtualTimeObj?.isCurrentTime,
        rectifier: {
          widthMillis: rectifier?.options.accumulationTimeMillis || 0,
          rectifierItemsCount: length,
        },
        streams: streams.map((stream) => {
          const { options: { streamConfig: { streamId } }, recordsBuffer: rb } = stream;
          return {
            buf: {
              firstTs: rb.firstTs,
              lastTs: rb.lastTs,
              len: rb.length,
            },
            rec: {
              firstTs: length && accumulator.find((d: TEventRecord) => d[STREAM_ID_FIELD] === streamId)?.tradeTime,
              lastTs: length && findLast(accumulator, (d: TEventRecord) => d[STREAM_ID_FIELD] === streamId)?.tradeTime,
              len: length && accumulator.reduce((accum, d) => accum + (d[STREAM_ID_FIELD] === streamId ? 1 : 0), 0),
            },
          };
        }),
      };
    }
    localEventEmitter.emit('time-stat', data);
  }

  streamsSocketIO ({ socket }: IOFnArgs) {
    const socketId = socket.id;

    this._connectedSockets.add(socketId);

    const listeners: { [eventId: string]: (...args: any[]) => any } = {};
    listeners['before-lnp'] = (data: IEmBeforeLoadNextPortion) => {
      const { heapUsed, rss } = process.memoryUsage();
      socket.volatile.emit('before-lnp', { ...data, heapUsed, rss });
    };
    listeners['after-lnp'] = (data: IEmAfterLoadNextPortion) => {
      const { heapUsed, rss } = process.memoryUsage();
      socket.volatile.emit('after-lnp', { ...data, heapUsed, rss });
    };
    listeners['time-stat'] = (data: any) => {
      socket.volatile.emit('time-stat', data);
    };

    Object.entries(listeners).forEach(([eventId, fn]) => {
      localEventEmitter.on(eventId, fn);
    });
    this.startIO();

    socket.on('disconnect', () => {
      echoSimple.warn(`SOCKET DISCONNECTED: ${socketId}`);
      this._connectedSockets.delete(socketId);
      if (!this._connectedSockets.size) {
        this.stopIO();
      }
      Object.entries(listeners).forEach(([eventId, fn]) => {
        localEventEmitter.removeListener(eventId, fn);
      });
    });

    socket.on('sm-suspend', (...args) => {
      this.suspend();
      socket.applyFn(args, this._locked);
    });

    socket.on('sm-continue', (...args) => {
      this.continue();
      socket.applyFn(args, this._locked);
    });

    socket.on('change-streams-params', (data, ...args) => {
      this.changeStreamsParams(data);
      // Все указанные свойства в data.env перечитываем после обновления и возвращаем новые значения
      const { env } = data || {};
      const result: any = {};
      if (typeof env === 'object') {
        result.env = {};
        Object.entries(env).forEach(([envName]) => {
          result.env[envName] = process.env[envName];
        });
      }
      result.params = this.getConfigsParams();
      result.actualConfigs = this.getConfigs();
      if (!socket.applyFn(args, result)) {
        socket.emit('actual-streams-configs', result);
      }
    });
  }

  isLocked (): boolean {
    return this._locked;
  }

  stopIO () {
    clearTimeout(this._statLoopTimerId);
  }

  startIO (speedUp: boolean = false) {
    if (speedUp) {
      this.speedUpStatistics();
    }
    if (!this._connectedSockets.size) {
      return;
    }
    const statLoop = () => {
      this.stopIO();
      if (!this._connectedSockets.size) {
        return;
      }
      this.collectAndEmitStatistics();
      this._statLoopTimerId = setTimeout(() => {
        statLoop();
      }, this.statisticsSendIntervalMillis);
    };
    statLoop();
  }

  slowDownStatistics () {
    this.statisticsSendIntervalMillis = STATISTICS_SEND_INTERVAL.SLOW;
  }

  speedUpStatistics () {
    this.statisticsSendIntervalMillis = STATISTICS_SEND_INTERVAL.QUICK;
  }

  isStopped () {
    return this._locked
      && (
        !this.alertsBuffer
        || !Object.keys(this.map).length
      );
  }

  async destroy () {
    this._locked = true;
    // this.slowDownStatistics();
    await Promise.all(this.streams.map((stream) => stream.destroy()));
    this.map = {};
    this.rectifier?.destroy();
    this.rectifier = null as unknown as Rectifier;
    this.virtualTimeObj?.lock();
    this.virtualTimeObj?.reset();
    this.alertsBuffer?.destroy();
    this.alertsBuffer = null as unknown as AlertsBuffer;
    this.commonConfig.echo.warn('DESTROYED: [StreamsManager]');
  }
}
