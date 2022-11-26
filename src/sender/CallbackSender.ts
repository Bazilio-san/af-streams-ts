import { Promise } from 'mssql';
import AbstractSender from './AbstractSender';
import { IRecordsComposite, ISenderConstructorOptions, TEventRecord } from '../@types/interfaces';

class CallbackSender extends AbstractSender {
  public eventCallback: Function;

  constructor (options: ISenderConstructorOptions) {
    super(options);

    const { eventCallback } = options.senderConfig;
    if (typeof eventCallback !== 'function') {
      options.exitOnError(`Missing event callback function when instantiating CallbackSender class`);
    }
    this.eventCallback = eventCallback as Function;
  }

  async connect () {
    this.options.echo.info(`=================== Callback Sender is Ready ===================`);
    return true;
  }

  async sendEvents (recordsComposite: IRecordsComposite): Promise<boolean> {
    const { eventsPacket } = recordsComposite;
    if (!eventsPacket.length) {
      return false;
    }
    const packet = eventsPacket.splice(0, eventsPacket.length);
    const pl = packet.length;
    recordsComposite.sentBufferLength = pl;
    recordsComposite.sendCount = pl;
    recordsComposite.last = packet[pl - 1];

    const fns = packet.map((row: TEventRecord) => this.eventCallback(row));
    await Promise.all(fns);
    return true;
  }
}

export default CallbackSender;
