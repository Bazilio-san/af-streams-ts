import EventEmitter from 'events';
import { IEcho, IEmVirtualDateChanged, IEmVirtualHourChanged, IStreamLike } from './interfaces';
import { c, rs } from './utils/color';
import { MILLIS_IN_DAY, MILLIS_IN_HOUR } from './constants';
import { millis2iso } from './utils/utils';

const TIME_FRONT_UPDATE_INTERVAL_MILLIS = 3;

export interface IVirtualTimeObjOptions {
  startTime: number, // timestamp millis
  eventEmitter: EventEmitter,
  speed?: number,
  loopTimeMillis?: number,
  echo?: IEcho,
  exitOnError: Function,
}

export class VirtualTimeObj {
  public speed: number;

  public readonly realStartTs: number;

  public readonly virtualStartTs: number;

  public loopNumber: number;

  public isCurrentTime: boolean;

  public locked: boolean = true;

  private streams: IStreamLike[] = [];

  private options: IVirtualTimeObjOptions;

  public readonly loopTimeMillis: number;

  private readonly loopTimeMillsEnd: 0 | number;

  private timeFront: number = 0;

  private eventEmitter: EventEmitter;

  private readonly debug: Function;

  private prevVirtualDateNumber: number = 0;

  private prevVirtualHourNumber: number = 0;

  constructor (options: IVirtualTimeObjOptions) {
    const { startTime, speed, loopTimeMillis = 0, eventEmitter, echo } = options;

    this.options = options;
    this.speed = Number(speed) || 1;
    this.loopTimeMillis = loopTimeMillis;
    this.virtualStartTs = +startTime; // timestamp millis from which to start uploading data
    this.timeFront = this.virtualStartTs;
    this.loopTimeMillsEnd = loopTimeMillis && (this.virtualStartTs + loopTimeMillis);
    this.realStartTs = Date.now();
    this.loopNumber = 0;
    this.isCurrentTime = false; // flag: virtual time has caught up with real time
    this.eventEmitter = eventEmitter;
    this.debug = echo ? echo.debug.bind(echo) : (m: string) => {
      // eslint-disable-next-line no-console
      console.log(m);
    };
    setInterval(() => {
      if (this.locked) {
        return;
      }
      this.setNextTimeFront();
      this.loopIfNeed();
      this.detectDayChange();
      this.detectHourChange();
    }, TIME_FRONT_UPDATE_INTERVAL_MILLIS);
  }

  private setNextTimeFront () {
    const now = Date.now();
    if (this.isCurrentTime) {
      this.timeFront = now;
      return;
    }

    const timeShift: number = TIME_FRONT_UPDATE_INTERVAL_MILLIS * this.speed;
    if (this.streams.length) {
      const consensusTimeFront = Math.min(...this.streams.map((stream) => stream.getDesiredTimeFront()), this.timeFront + timeShift);
      this.timeFront = Math.max(consensusTimeFront, this.timeFront);
    } else {
      this.timeFront += timeShift;
    }
    if (this.timeFront >= now) {
      this.timeFront = now;
      this.isCurrentTime = true;
      this.eventEmitter.emit('virtual-time-is-synchronized-with-current');
    }
  }

  private loopIfNeed () {
    if (this.loopTimeMillis && this.timeFront >= this.loopTimeMillsEnd) {
      this.timeFront = this.virtualStartTs;
      this.loopNumber++;
      this.debug(`[af-streams]: New cycle from ${this.getString()}`);
      this.eventEmitter.emit('virtual-time-loop-back');
    }
  }

  private detectDayChange () {
    const pvd = this.prevVirtualDateNumber;
    this.prevVirtualDateNumber = Math.floor(this.timeFront / MILLIS_IN_DAY);
    if (pvd && pvd < this.prevVirtualDateNumber) {
      const payload: IEmVirtualDateChanged = {
        prevN: pvd,
        currN: this.prevVirtualDateNumber,
        prevTs: pvd * MILLIS_IN_DAY,
        currTs: this.prevVirtualDateNumber * MILLIS_IN_DAY,
      };
      this.eventEmitter.emit('virtual-date-changed', payload);
    }
  }

  private detectHourChange () {
    const pvh = this.prevVirtualHourNumber;
    this.prevVirtualHourNumber = Math.floor(this.timeFront / MILLIS_IN_HOUR);
    if (pvh && pvh !== this.prevVirtualHourNumber) {
      const payload: IEmVirtualHourChanged = {
        prevN: pvh,
        currN: this.prevVirtualHourNumber,
        prevHZ: pvh % 24,
        currHZ: this.prevVirtualHourNumber % 24,
        prevTs: pvh * MILLIS_IN_HOUR,
        currTs: this.prevVirtualHourNumber * MILLIS_IN_HOUR,
      };
      this.eventEmitter.emit('virtual-hour-changed', payload);
    }
  }

  // noinspection JSUnusedGlobalSymbols
  getActualSpeed () {
    return (this.timeFront - this.virtualStartTs) / (Date.now() - this.realStartTs);
  }

  // noinspection JSUnusedGlobalSymbols
  setVirtualTs (ts: number) {
    this.timeFront = ts;
  }

  // noinspection JSUnusedGlobalSymbols
  registerStream (stream: IStreamLike) {
    this.streams.push(stream);
  }

  lock () {
    if (!this.locked) {
      this.isCurrentTime = false;
      this.locked = true;
    }
  }

  unLock () {
    if (this.locked) {
      this.locked = false;
    }
  }

  // For compatibility
  /** @deprecated */
  setReady (): void {
    this.unLock();
  }

  getVirtualTs (): number {
    return this.timeFront;
  }

  getString (): string {
    return `${c}<${millis2iso(this.getVirtualTs())}${this.isCurrentTime ? '*' : ''}>${rs}`;
  }
}

let virtualTimeObj: VirtualTimeObj;

export const getVirtualTimeObj = (options: IVirtualTimeObjOptions): VirtualTimeObj => {
  if (!virtualTimeObj) {
    virtualTimeObj = new VirtualTimeObj(options);
  }
  return virtualTimeObj;
};
