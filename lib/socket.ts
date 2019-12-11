import EventEmitter from "events";

const debug = require("debug")("engine:socket");

export type SocketId = string;

enum SocketState {
  Opening = "opening",
  Open = "open",
  Closing = "closing",
  Closed = "closed"
}

export default class Socket extends EventEmitter {
  private transport = null;
  private upgrading: boolean = false;
  private upgraded: boolean = false;
  private readyState: SocketState = SocketState.Opening;
  private writeBuffer = [];
  private packetsFn = [];
  private sentCallbackFn = [];
  private cleanupFn = [];
  private remoteAddress;

  private checkIntervalTimer = null;
  private upgradeTimeoutTimer = null;
  private pingTimeoutTimer = null;

  constructor(
    readonly id: SocketId,
    readonly server,
    transport,
    readonly request
  ) {
    super();
    // Cache IP since it might not be in the req later
    if (request.websocket && request.websocket._socket) {
      this.remoteAddress = request.websocket._socket.remoteAddress;
    } else {
      this.remoteAddress = request.connection.remoteAddress;
    }
    this.setTransport(transport);
    this.onOpen();
  }

  /**
   * Setup and manage send callback
   */
  public setupSendCallback() {
    const self = this;
    this.transport.on("drain", onDrain);

    this.cleanupFn.push(function() {
      self.transport.removeListener("drain", onDrain);
    });

    // the message was sent successfully, execute the callback
    function onDrain() {
      if (self.sentCallbackFn.length > 0) {
        const seqFn = self.sentCallbackFn.splice(0, 1)[0];
        if ("function" === typeof seqFn) {
          debug("executing send callback");
          seqFn(self.transport);
        } else if (Array.isArray(seqFn)) {
          debug("executing batch send callback");
          for (let l = seqFn.length, i = 0; i < l; i++) {
            if ("function" === typeof seqFn[i]) {
              seqFn[i](self.transport);
            }
          }
        }
      }
    }
  }

  /**
   * Sends a message packet.
   *
   * @param {String} data
   * @param {Object} options
   * @param {Function} callback
   * @return {Socket} for chaining
   */
  public send(data, options, callback) {
    this.sendPacket("message", data, options, callback);
    return this;
  }

  /**
   * Sends a message packet.
   *
   * @param {String} data
   * @param {Object} options
   * @param {Function} callback
   * @return {Socket} for chaining
   */
  public write(data, options, callback) {
    this.sendPacket("message", data, options, callback);
    return this;
  }

  /**
   * Closes the socket and underlying transport.
   *
   * @param {Boolean} [discard]
   * @return {Socket} for chaining
   */
  public close(discard) {
    if (this.readyState !== SocketState.Open) {
      return;
    }

    this.readyState = SocketState.Closing;

    if (this.writeBuffer.length) {
      this.once("drain", this.closeTransport.bind(this, discard));
      return;
    }

    this.closeTransport(discard);
  }

  /**
   * Upgrades socket to the given transport
   *
   * @param {Transport} transport
   */
  protected maybeUpgrade(transport) {
    debug(
      'might upgrade socket transport from "%s" to "%s"',
      this.transport.name,
      transport.name
    );

    this.upgrading = true;

    const self = this;

    // set transport upgrade timer
    self.upgradeTimeoutTimer = setTimeout(function() {
      debug("client did not complete upgrade - closing transport");
      cleanup();
      if ("open" === transport.readyState) {
        transport.close();
      }
    }, this.server.opts.upgradeTimeout);

    function onPacket(packet) {
      if ("ping" === packet.type && "probe" === packet.data) {
        transport.send([{ type: "pong", data: "probe" }]);
        self.emit("upgrading", transport);
        clearInterval(self.checkIntervalTimer);
        self.checkIntervalTimer = setInterval(check, 100);
      } else if (
        "upgrade" === packet.type &&
        self.readyState !== SocketState.Closed
      ) {
        debug("got upgrade packet - upgrading");
        cleanup();
        self.transport.discard();
        self.upgraded = true;
        self.clearTransport();
        self.setTransport(transport);
        self.emit("upgrade", transport);
        self.setPingTimeout();
        self.flush();
        if (self.readyState === SocketState.Closing) {
          transport.close(function() {
            self.onClose("forced close");
          });
        }
      } else {
        cleanup();
        transport.close();
      }
    }

    // we force a polling cycle to ensure a fast upgrade
    function check() {
      if ("polling" === self.transport.name && self.transport.writable) {
        debug("writing a noop packet to polling for fast upgrade");
        self.transport.send([{ type: "noop" }]);
      }
    }

    function cleanup() {
      self.upgrading = false;

      clearInterval(self.checkIntervalTimer);
      self.checkIntervalTimer = null;

      clearTimeout(self.upgradeTimeoutTimer);
      self.upgradeTimeoutTimer = null;

      transport.removeListener("packet", onPacket);
      transport.removeListener("close", onTransportClose);
      transport.removeListener("error", onError);
      self.removeListener("close", onClose);
    }

    function onError(err) {
      debug("client did not complete upgrade - %s", err);
      cleanup();
      transport.close();
      transport = null;
    }

    function onTransportClose() {
      onError("transport closed");
    }

    function onClose() {
      onError("socket closed");
    }

    transport.on("packet", onPacket);
    transport.once("close", onTransportClose);
    transport.once("error", onError);

    self.once("close", onClose);
  }

  /**
   * Called upon transport considered open.
   */
  private onOpen() {
    this.readyState = SocketState.Open;

    // sends an `open` packet
    this.transport.sid = this.id;
    this.sendPacket(
      "open",
      JSON.stringify({
        sid: this.id,
        upgrades: this.getAvailableUpgrades(),
        pingInterval: this.server.opts.pingInterval,
        pingTimeout: this.server.opts.pingTimeout
      })
    );

    if (this.server.opts.initialPacket) {
      this.sendPacket("message", this.server.opts.initialPacket);
    }

    this.emit("open");
    this.setPingTimeout();
  }

  /**
   * Called upon transport packet.
   *
   * @param {Object} packet
   */
  private onPacket(packet) {
    if (this.readyState !== SocketState.Open) {
      debug("packet received with closed socket");
      return;
    }
    // export packet event
    debug("packet");
    this.emit("packet", packet);

    // Reset ping timeout on any packet, incoming data is a good sign of
    // other side's liveness
    this.setPingTimeout();

    switch (packet.type) {
      case "ping":
        debug("got ping");
        this.sendPacket("pong");
        this.emit("heartbeat");
        break;

      case "error":
        this.onClose("parse error");
        break;

      case "message":
        this.emit("data", packet.data);
        this.emit("message", packet.data);
        break;
    }
  }

  /**
   * Called upon transport error.
   *
   * @param {Error} err error object
   */
  private onError(err) {
    debug("transport error");
    this.onClose("transport error", err);
  }

  /**
   * Sets and resets ping timeout timer based on client pings.
   */
  private setPingTimeout() {
    clearTimeout(this.pingTimeoutTimer);
    this.pingTimeoutTimer = setTimeout(() => {
      this.onClose("ping timeout");
    }, this.server.opts.pingInterval + this.server.opts.pingTimeout);
  }

  /**
   * Attaches handlers for the given transport.
   *
   * @param {Transport} transport
   */
  private setTransport(transport) {
    const onError = this.onError.bind(this);
    const onPacket = this.onPacket.bind(this);
    const flush = this.flush.bind(this);
    const onClose = this.onClose.bind(this, "transport close");

    this.transport = transport;
    this.transport.once("error", onError);
    this.transport.on("packet", onPacket);
    this.transport.on("drain", flush);
    this.transport.once("close", onClose);
    // this function will manage packet events (also message callbacks)
    this.setupSendCallback();

    this.cleanupFn.push(function() {
      transport.removeListener("error", onError);
      transport.removeListener("packet", onPacket);
      transport.removeListener("drain", flush);
      transport.removeListener("close", onClose);
    });
  }

  /**
   * Clears listeners and timers associated with current transport.
   */
  private clearTransport() {
    let cleanup;

    const toCleanUp = this.cleanupFn.length;

    for (let i = 0; i < toCleanUp; i++) {
      cleanup = this.cleanupFn.shift();
      cleanup();
    }

    // silence further transport errors and prevent uncaught exceptions
    this.transport.on("error", function() {
      debug("error triggered by discarded transport");
    });

    // ensure transport won't stay open
    this.transport.close();

    clearTimeout(this.pingTimeoutTimer);
  }

  /**
   * Called upon transport considered closed.
   * Possible reasons: `ping timeout`, `client error`, `parse error`,
   * `transport error`, `server close`, `transport close`
   *
   * @param reason
   * @param [description]
   */
  private onClose(reason, description?) {
    if (this.readyState === SocketState.Closed) {
      return;
    }
    this.readyState = SocketState.Closed;
    clearTimeout(this.pingTimeoutTimer);
    clearInterval(this.checkIntervalTimer);
    this.checkIntervalTimer = null;
    clearTimeout(this.upgradeTimeoutTimer);
    // clean writeBuffer in next tick, so developers can still
    // grab the writeBuffer on 'close' event
    process.nextTick(() => {
      this.writeBuffer = [];
    });
    this.packetsFn = [];
    this.sentCallbackFn = [];
    this.clearTransport();
    this.emit("close", reason, description);
  }

  /**
   * Sends a packet.
   *
   * @param {String} type
   * @param {String} [data]
   * @param {Object} [options]
   * @param {Function} [callback]
   */
  private sendPacket(type, data?, options?, callback?) {
    if ("function" === typeof options) {
      callback = options;
      options = null;
    }

    options = options || {};
    options.compress = false !== options.compress;

    const isReady =
      this.readyState !== SocketState.Closing &&
      this.readyState !== SocketState.Closed;
    if (isReady) {
      debug('sending packet "%s" (%s)', type, data);

      const packet = {
        type,
        options,
        data
      };

      // exports packetCreate event
      this.emit("packetCreate", packet);

      this.writeBuffer.push(packet);

      // add send callback to object, if defined
      if (callback) {
        this.packetsFn.push(callback);
      }

      this.flush();
    }
  }

  /**
   * Attempts to flush the packets buffer.
   */
  private flush() {
    const isFlushable =
      this.readyState !== SocketState.Closed &&
      this.transport.writable &&
      this.writeBuffer.length;
    if (!isFlushable) {
      return;
    }
    debug("flushing buffer to transport");
    this.emit("flush", this.writeBuffer);
    this.server.emit("flush", this, this.writeBuffer);
    const wbuf = this.writeBuffer;
    this.writeBuffer = [];
    if (!this.transport.supportsFraming) {
      this.sentCallbackFn.push(this.packetsFn);
    } else {
      this.sentCallbackFn.push.apply(this.sentCallbackFn, this.packetsFn);
    }
    this.packetsFn = [];
    this.transport.send(wbuf);
    this.emit("drain");
    this.server.emit("drain", this);
  }

  /**
   * Get available upgrades for this socket.
   */
  private getAvailableUpgrades() {
    const availableUpgrades = [];
    const allUpgrades = this.server.upgrades(this.transport.name);
    for (let i = 0, l = allUpgrades.length; i < l; ++i) {
      const upg = allUpgrades[i];
      if (this.server.opts.transports.indexOf(upg) !== -1) {
        availableUpgrades.push(upg);
      }
    }
    return availableUpgrades;
  }

  /**
   * Closes the underlying transport.
   *
   * @param {Boolean} discard
   */
  private closeTransport(discard) {
    if (discard) {
      this.transport.discard();
    }
    this.transport.close(this.onClose.bind(this, "forced close"));
  }
}
