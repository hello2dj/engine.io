import parser from "engine.io-parser";
import EventEmitter from "events";
import { IncomingMessage } from "http";

const debug = require("debug")("engine:transport");

enum TransportState {
  Open = "open",
  Closing = "closing",
  Closed = "closed"
}

export default abstract class Transport extends EventEmitter {
  abstract get name(): string;

  /**
   * Advertise upgrade support.
   */
  abstract get handlesUpgrades(): boolean;

  /**
   * Advertise framing support.
   */
  abstract get supportsFraming(): boolean;

  abstract get upgradesTo(): string[];

  protected writable: boolean = false;
  protected discarded: boolean = false;
  protected req = null;
  protected supportsBinary: boolean = false;
  private readyState: TransportState = TransportState.Open;

  /**
   * Flags the transport as discarded.
   */
  public discard() {
    this.discarded = true;
  }

  /**
   * Called with an incoming HTTP request.
   *
   * @param {http.IncomingMessage} req request
   */
  protected onRequest(req) {
    debug("setting request");
    this.req = req;
    this.supportsBinary = !(req._query && req._query.b64);
  }

  /**
   * Closes the transport.
   */
  protected close(fn) {
    if (
      this.readyState === TransportState.Closed ||
      this.readyState === TransportState.Closing
    ) {
      return;
    }

    this.readyState = TransportState.Closing;
    this.doClose(fn);
  }

  /**
   * Called with a transport error.
   *
   * @param {String} msg message error
   * @param {Object} desc error description
   */
  protected onError(msg, desc?) {
    if (this.listeners("error").length) {
      const err = new Error(msg);
      // err.type = 'TransportError';
      // err.description = desc;
      this.emit("error", err);
    } else {
      debug("ignored transport error %s (%s)", msg, desc);
    }
  }

  /**
   * Called with parsed out a packets from the data stream.
   *
   * @param {Object} packet
   */
  protected onPacket(packet) {
    this.emit("packet", packet);
  }

  /**
   * Called with the encoded packet data.
   *
   * @param {String} data
   */
  protected onData(data) {
    this.onPacket(parser.decodePacket(data));
  }

  /**
   * Called upon transport close.
   */
  protected onClose() {
    this.readyState = TransportState.Closed;
    this.emit("close");
  }

  protected abstract doClose(fn: () => {});

  protected abstract send(packets);
}
