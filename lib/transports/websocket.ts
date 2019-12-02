import parser from "engine.io-parser";
import Transport from "../transport";

const debug = require("debug")("engine:ws");

export default class WebSocket extends Transport {
  private readonly socket;

  constructor(req, readonly opts) {
    super();
    this.socket = req.websocket;
    this.socket.on("message", this.onData.bind(this));
    this.socket.once("close", this.onClose.bind(this));
    this.socket.on("error", this.onError.bind(this));
    this.socket.on("headers", headers => {
      this.emit("headers", headers);
    });
    this.writable = true;
  }

  public get name() {
    return "websocket";
  }
  public get handlesUpgrades() {
    return true;
  }
  public get supportsFraming() {
    return true;
  }
  public get upgradesTo() {
    return [];
  }

  /**
   * Processes the incoming data.
   *
   * @param {String} data encoded packet
   */
  protected onData(data) {
    debug('received "%s"', data);
    super.onData(data);
  }

  /**
   * Writes a packet payload.
   *
   * @param {Array} packets
   */
  protected send(packets) {
    const self = this;

    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i];
      parser.encodePacket(packet, self.supportsBinary, send);
    }

    function send(data) {
      debug('writing "%s"', data);

      // always creates a new object since ws modifies it
      const opts = {
        compress: packets[0].options && packets[0].options.compress
      };

      if (self.opts.perMessageDeflate) {
        const len =
          "string" === typeof data ? Buffer.byteLength(data) : data.length;
        if (
          self.opts.perMessageDeflate !== true &&
          len < self.opts.perMessageDeflate.threshold
        ) {
          opts.compress = false;
        }
      }

      self.writable = false;
      self.socket.send(data, opts, onEnd);
    }

    function onEnd(err) {
      if (err) {
        return self.onError("write error", err.stack);
      }
      self.writable = true;
      self.emit("drain");
    }
  }

  /**
   * Closes the transport.
   */
  protected doClose(fn) {
    debug("closing");
    this.socket.close();
    fn && fn();
  }
}
