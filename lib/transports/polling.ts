import accepts from "accepts";
import parser from "engine.io-parser";
import zlib from "zlib";
import Transport from "../transport";

const debug = require("debug")("engine:polling");

const compressionMethods = {
  gzip: zlib.createGzip,
  deflate: zlib.createDeflate
};

export default abstract class Polling extends Transport {
  public get name() {
    return "polling";
  }
  public get handlesUpgrades() {
    return false;
  }
  public get supportsFraming() {
    return false;
  }
  public get upgradesTo() {
    return ["websocket"];
  }
  private closeTimeout: number = 30 * 1000;
  private res = null;
  private dataReq = null;
  private dataRes = null;

  private shouldClose: () => void = null;

  public constructor(readonly opts) {
    super();
  }

  /**
   * Overrides onRequest.
   *
   * @param {http.IncomingMessage} req
   */
  protected onRequest(req) {
    const res = req.res;

    if ("GET" === req.method) {
      this.onPollRequest(req, res);
    } else if ("POST" === req.method) {
      this.onDataRequest(req, res);
    } else {
      res.writeHead(500);
      res.end();
    }
  }

  /**
   * Processes the incoming data payload.
   *
   * @param {String} data encoded payload
   */
  protected onData(data) {
    debug('received "%s"', data);

    parser.decodePayload(data, packet => {
      if ("close" === packet.type) {
        debug("got xhr close packet");
        this.onClose();
        return false;
      }

      this.onPacket(packet);
    });
  }

  /**
   * Overrides onClose.
   */
  protected onClose() {
    if (this.writable) {
      // close pending poll request
      this.send([{ type: "noop" }]);
    }
    super.onClose();
  }

  /**
   * Writes a packet payload.
   *
   * @param {Object} packets
   */
  protected send(packets) {
    this.writable = false;

    if (this.shouldClose) {
      debug("appending close packet to payload");
      packets.push({ type: "close" });
      this.shouldClose();
      this.shouldClose = null;
    }

    parser.encodePayload(packets, this.supportsBinary, data => {
      const compress = packets.some(packet => {
        return packet.options && packet.options.compress;
      });
      this.write(data, { compress });
    });
  }

  /**
   * Performs the write.
   */
  protected doWrite(data, options, callback) {
    const self = this;

    // explicit UTF-8 is required for pages not served under utf
    const isString = typeof data === "string";
    const contentType = isString
      ? "text/plain; charset=UTF-8"
      : "application/octet-stream";

    const headers = {
      "Content-Type": contentType
    };

    if (!this.opts.httpCompression || !options.compress) {
      respond(data);
      return;
    }

    const len = isString ? Buffer.byteLength(data) : data.length;
    if (
      this.opts.httpCompression !== true &&
      len < this.opts.httpCompression.threshold
    ) {
      respond(data);
      return;
    }

    const encoding = accepts(this.req).encodings(["gzip", "deflate"]);
    if (!encoding) {
      respond(data);
      return;
    }

    this.compress(data, encoding, function(err, data) {
      if (err) {
        self.res.writeHead(500);
        self.res.end();
        callback(err);
        return;
      }

      headers["Content-Encoding"] = encoding;
      respond(data);
    });

    function respond(data) {
      headers["Content-Length"] =
        "string" === typeof data ? Buffer.byteLength(data) : data.length;
      self.res.writeHead(200, self.headers(self.req, headers));
      self.res.end(data);
      callback();
    }
  }

  /**
   * Closes the transport.
   */
  protected doClose(fn) {
    debug("closing");

    const self = this;
    let closeTimeoutTimer;

    if (this.dataReq) {
      debug("aborting ongoing data request");
      this.dataReq.destroy();
    }

    if (this.writable) {
      debug("transport writable - closing right away");
      this.send([{ type: "close" }]);
      onClose();
    } else if (this.discarded) {
      debug("transport discarded - closing right away");
      onClose();
    } else {
      debug("transport not writable - buffering orderly close");
      this.shouldClose = onClose;
      closeTimeoutTimer = setTimeout(onClose, this.closeTimeout);
    }

    function onClose() {
      clearTimeout(closeTimeoutTimer);
      fn && fn();
      self.onClose();
    }
  }

  /**
   * Returns headers for a response.
   *
   * @param {http.IncomingMessage} req request
   * @param {Object} headers extra headers
   */
  protected headers(req, headers = {}) {
    // prevent XSS warnings on IE
    // https://github.com/LearnBoost/socket.io/pull/1333
    const ua = req.headers["user-agent"];
    if (ua && (~ua.indexOf(";MSIE") || ~ua.indexOf("Trident/"))) {
      headers["X-XSS-Protection"] = "0";
    }

    this.emit("headers", headers);
    return headers;
  }

  /**
   * The client sends a request awaiting for us to send data.
   */
  private onPollRequest(req, res) {
    if (this.req) {
      debug("request overlap");
      // assert: this.res, '.req and .res should be (un)set together'
      this.onError("overlap from client");
      res.writeHead(500);
      res.end();
      return;
    }

    debug("setting request");

    this.req = req;
    this.res = res;

    const self = this;

    function onClose() {
      self.onError("poll connection closed prematurely");
    }

    function cleanup() {
      req.removeListener("close", onClose);
      self.req = self.res = null;
    }

    req.cleanup = cleanup;
    req.on("close", onClose);

    this.writable = true;
    this.emit("drain");

    // if we're still writable but had a pending close, trigger an empty send
    if (this.writable && this.shouldClose) {
      debug("triggering empty send to append close packet");
      this.send([{ type: "noop" }]);
    }
  }

  /**
   * The client sends a request with data.
   */
  private onDataRequest(req, res) {
    if (this.dataReq) {
      // assert: this.dataRes, '.dataReq and .dataRes should be (un)set together'
      this.onError("data request overlap from client");
      res.writeHead(500);
      res.end();
      return;
    }

    const isBinary = "application/octet-stream" === req.headers["content-type"];

    this.dataReq = req;
    this.dataRes = res;

    let chunks = isBinary ? Buffer.concat([]) : "";
    const self = this;

    function cleanup() {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("close", onClose);
      self.dataReq = self.dataRes = chunks = null;
    }

    function onClose() {
      cleanup();
      self.onError("data request connection closed prematurely");
    }

    function onData(data) {
      let contentLength;
      if (isBinary) {
        chunks = Buffer.concat([chunks, data]);
        contentLength = chunks.length;
      } else {
        chunks += data;
        contentLength = Buffer.byteLength(chunks);
      }

      if (contentLength > self.opts.maxHttpBufferSize) {
        chunks = isBinary ? Buffer.concat([]) : "";
        req.connection.destroy();
      }
    }

    function onEnd() {
      self.onData(chunks);

      const headers = {
        // text/html is required instead of text/plain to avoid an
        // unwanted download dialog on certain user-agents (GH-43)
        "Content-Type": "text/html",
        "Content-Length": 2
      };

      res.writeHead(200, self.headers(req, headers));
      res.end("ok");
      cleanup();
    }

    req.on("close", onClose);
    if (!isBinary) {
      req.setEncoding("utf8");
    }
    req.on("data", onData);
    req.on("end", onEnd);
  }

  /**
   * Writes data as response to poll request.
   *
   * @param {String} data
   * @param {Object} options
   */
  private write(data, options) {
    debug('writing "%s"', data);
    this.doWrite(data, options, () => {
      this.req.cleanup();
    });
  }

  /**
   * Compresses data.
   */
  private compress(data, encoding, callback) {
    debug("compressing");

    const buffers = [];
    let nread = 0;

    compressionMethods[encoding](this.opts.httpCompression)
      .on("error", callback)
      .on("data", function(chunk) {
        buffers.push(chunk);
        nread += chunk.length;
      })
      .on("end", function() {
        callback(null, Buffer.concat(buffers, nread));
      })
      .end(data);
  }
}
