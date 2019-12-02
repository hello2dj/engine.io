import base64id from "base64id";
import cookieMod from "cookie";
import EventEmitter from "events";
import qs from "querystring";
import { parse } from "url";

import Socket from "./socket";
const transports = require("./transports");

const debug = require("debug")("engine");

enum ServerError {
  UnknownTransport,
  UnknownSid,
  BadHandshakeMethod,
  BadRequest,
  Forbidden
}

export interface ICompressionOptions {
  threshold: number;
}

export interface IServerOptions {
  wsEngine: string;
  pingTimeout: number;
  pingInterval: number;
  upgradeTimeout: number;
  maxHttpBufferSize: number;
  transports: [string];
  allowUpgrades: boolean;
  allowRequest: (req, cb) => void;
  cookie: string | boolean;
  cookiePath: string;
  cookieHttpOnly: boolean;
  perMessageDeflate: ICompressionOptions | boolean;
  httpCompression: ICompressionOptions | boolean;
  initialPacket;
}

export interface IAttachOptions {
  path: string;
  destroyUpgrade: boolean;
  destroyUpgradeTimeout: number;
  handlePreflightRequest: boolean | ((req, res) => void);
}

export default class Server extends EventEmitter {
  /**
   * Prepares a request by processing the query string.
   */
  private static prepare(req) {
    // try to leverage pre-existing `req._query` (e.g: from connect)
    if (!req._query) {
      req._query = ~req.url.indexOf("?") ? qs.parse(parse(req.url).query) : {};
    }
  }

  /**
   * Sends an Engine.IO Error Message
   *
   * @param req request
   * @param res response
   * @param code error code
   */
  private static sendErrorMessage(req, res, code) {
    const headers = { "Content-Type": "application/json" };

    const isForbidden = !ServerError[code];
    if (isForbidden) {
      res.writeHead(403, headers);
      res.end(
        JSON.stringify({
          code: ServerError.Forbidden,
          message: code || Server.errorMessage(ServerError.Forbidden)
        })
      );
      return;
    }
    if (req.headers.origin) {
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Access-Control-Allow-Origin"] = req.headers.origin;
    } else {
      headers["Access-Control-Allow-Origin"] = "*";
    }
    if (res !== undefined) {
      res.writeHead(400, headers);
      res.end(
        JSON.stringify({
          code,
          message: Server.errorMessage(code)
        })
      );
    }
  }

  /**
   * Closes the connection
   *
   * @param {Socket} socket
   * @param {code} code error code
   */
  private static abortConnection(socket, code) {
    if (socket.writable) {
      const message = ServerError[code]
        ? Server.errorMessage(code)
        : String(code || "");
      const length = Buffer.byteLength(message);
      socket.write(
        "HTTP/1.1 400 Bad Request\r\n" +
          "Connection: close\r\n" +
          "Content-type: text/html\r\n" +
          "Content-Length: " +
          length +
          "\r\n" +
          "\r\n" +
          message
      );
    }
    socket.destroy();
  }

  private static errorMessage(error: ServerError) {
    switch (error) {
      case ServerError.UnknownTransport:
        return "Transport unknown";
      case ServerError.UnknownSid:
        return "Session ID unknown";
      case ServerError.BadHandshakeMethod:
        return "Bad handshake method";
      case ServerError.BadRequest:
        return "Bad request";
      case ServerError.Forbidden:
        return "Forbidden";
    }
  }
  private readonly opts: IServerOptions;

  private clients = {};
  private clientsCount = 0;
  private ws;

  constructor(opts: Partial<IServerOptions>) {
    super();
    this.opts = Object.assign(
      {
        wsEngine: process.env.EIO_WS_ENGINE || "ws",
        pingTimeout: 5000,
        pingInterval: 25000,
        upgradeTimeout: 10000,
        maxHttpBufferSize: 10e7,
        transports: ["polling", "websocket"],
        allowUpgrades: true,
        allowRequest: (req, cb) => cb(null, true),
        cookie: "io",
        cookiePath: "/",
        cookieHttpOnly: true,
        perMessageDeflate: {
          threshold: 1024
        },
        httpCompression: {
          threshold: 1024
        },
        initialPacket: null
      },
      opts
    );

    this.init();
  }

  /**
   * Returns a list of available transports for upgrade given a certain transport.
   *
   * @return {Array}
   */
  public upgrades(transport) {
    if (!this.opts.allowUpgrades) {
      return [];
    }
    return transports[transport].upgradesTo || [];
  }

  /**
   * Closes all clients.
   */
  public close() {
    debug("closing all open clients");
    for (const i in this.clients) {
      if (this.clients.hasOwnProperty(i)) {
        this.clients[i].close(true);
      }
    }
    if (this.ws) {
      debug("closing webSocketServer");
      this.ws.close();
      // don't delete this.ws because it can be used again if the http server starts listening again
    }
    return this;
  }

  /**
   * Handles an Engine.IO HTTP request.
   *
   * @param {http.IncomingMessage} req request
   * @param {http.ServerResponse|http.OutgoingMessage} res response
   */
  public handleRequest(req, res) {
    debug('handling "%s" http request "%s"', req.method, req.url);
    Server.prepare(req);
    req.res = res;

    this.verify(req, false, (err, success) => {
      if (!success) {
        Server.sendErrorMessage(req, res, err);
        return;
      }

      if (req._query.sid) {
        debug("setting new request for existing client");
        this.clients[req._query.sid].transport.onRequest(req);
      } else {
        this.handshake(req._query.transport, req);
      }
    });
  }

  /**
   * generate a socket id.
   * Overwrite this method to generate your custom socket id
   *
   * @param {Object} req request object
   */
  public generateId(req) {
    return base64id.generateId();
  }

  /**
   * Handles an Engine.IO HTTP Upgrade.
   */
  public handleUpgrade(req, socket, upgradeHead) {
    Server.prepare(req);

    this.verify(req, true, (err, success) => {
      if (!success) {
        Server.abortConnection(socket, err);
        return;
      }

      const head = Buffer.from(upgradeHead); // eslint-disable-line node/no-deprecated-api
      upgradeHead = null;

      // delegate to ws
      this.ws.handleUpgrade(req, socket, head, conn => {
        this.onWebSocket(req, conn);
      });
    });
  }

  /**
   * Captures upgrade requests for a http.Server.
   *
   * @param {http.Server} server
   * @param {Object} [opts]
   */
  public attach(server, opts: Partial<IAttachOptions> = {}) {
    const options: IAttachOptions = Object.assign(
      {
        path: "/engine.io",
        destroyUpgrade: true,
        destroyUpgradeTimeout: 1000,
        handlePreflightRequest: false
      },
      opts
    );

    const self = this;
    // normalize path
    const path = options.path.replace(/\/$/, "") + "/";

    function check(req) {
      if (
        "OPTIONS" === req.method &&
        false === options.handlePreflightRequest
      ) {
        return false;
      }
      return path === req.url.substr(0, path.length);
    }

    // cache and clean up listeners
    const listeners = server.listeners("request").slice(0);
    server.removeAllListeners("request");
    server.on("close", self.close.bind(self));
    server.on("listening", self.init.bind(self));

    // add request handler
    server.on("request", (req, res) => {
      if (check(req)) {
        debug('intercepting request for path "%s"', path);
        if (
          "OPTIONS" === req.method &&
          "function" === typeof options.handlePreflightRequest
        ) {
          options.handlePreflightRequest.call(server, req, res);
        } else {
          self.handleRequest(req, res);
        }
      } else {
        for (let i = 0, l = listeners.length; i < l; i++) {
          listeners[i].call(server, req, res);
        }
      }
    });

    if (~self.opts.transports.indexOf("websocket")) {
      server.on("upgrade", function(req, socket, head) {
        if (check(req)) {
          self.handleUpgrade(req, socket, head);
        } else if (false !== options.destroyUpgrade) {
          // default node behavior is to disconnect when no handlers
          // but by adding a handler, we prevent that
          // and if no eio thing handles the upgrade
          // then the socket needs to die!
          setTimeout(function() {
            if (socket.writable && socket.bytesWritten <= 0) {
              return socket.end();
            }
          }, options.destroyUpgradeTimeout);
        }
      });
    }
  }

  /**
   * Initialize websocket server
   */
  private init() {
    if (!~this.opts.transports.indexOf("websocket")) {
      return;
    }

    if (this.ws) {
      this.ws.close();
    }

    let wsModule;
    switch (this.opts.wsEngine) {
      case "uws":
        wsModule = require("uws");
        break;
      case "ws":
        wsModule = require("ws");
        break;
      default:
        throw new Error("unknown wsEngine");
    }
    this.ws = new wsModule.Server({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: this.opts.perMessageDeflate,
      maxPayload: this.opts.maxHttpBufferSize
    });
  }

  /**
   * Verifies a request.
   *
   * @param {http.IncomingMessage} req
   * @param upgrade
   * @param fn
   * @return {Boolean} whether the request is valid
   */
  private verify(req, upgrade, fn) {
    // transport check
    const transport = req._query.transport;
    if (!~this.opts.transports.indexOf(transport)) {
      debug('unknown transport "%s"', transport);
      return fn(ServerError.UnknownTransport, false);
    }

    // 'Origin' header check
    const isOriginInvalid = checkInvalidHeaderChar(req.headers.origin);
    if (isOriginInvalid) {
      req.headers.origin = null;
      debug("origin header invalid");
      return fn(ServerError.BadRequest, false);
    }

    // sid check
    const sid = req._query.sid;
    if (sid) {
      if (!this.clients.hasOwnProperty(sid)) {
        debug('unknown sid "%s"', sid);
        return fn(ServerError.UnknownSid, false);
      }
      if (!upgrade && this.clients[sid].transport.name !== transport) {
        debug("bad request: unexpected transport without upgrade");
        return fn(ServerError.BadRequest, false);
      }
    } else {
      // handshake is GET only
      if ("GET" !== req.method) {
        return fn(ServerError.BadHandshakeMethod, false);
      }
      if (!this.opts.allowRequest) {
        return fn(null, true);
      }
      return this.opts.allowRequest(req, fn);
    }

    fn(null, true);
  }

  /**
   * Handshakes a new client.
   *
   * @param {String} transportName transport name
   * @param {Object} req request object
   */
  private handshake(transportName, req) {
    const id = this.generateId(req);

    debug('handshaking client "%s"', id);

    let transport;
    try {
      transport = new transports[transportName](req, this.opts);
      if ("polling" === transportName) {
        transport.maxHttpBufferSize = this.opts.maxHttpBufferSize;
        transport.httpCompression = this.opts.httpCompression;
      } else if ("websocket" === transportName) {
        transport.perMessageDeflate = this.opts.perMessageDeflate;
      }

      transport.supportsBinary = !(req._query && req._query.b64);
    } catch (e) {
      debug('error handshaking to transport "%s"', transportName);
      Server.sendErrorMessage(req, req.res, ServerError.BadRequest);
      return;
    }
    const socket = new Socket(id, this, transport, req);

    if (false !== this.opts.cookie) {
      transport.on("headers", headers => {
        headers["Set-Cookie"] = cookieMod.serialize(this.opts.cookie, id, {
          path: this.opts.cookiePath,
          httpOnly: this.opts.cookiePath ? this.opts.cookieHttpOnly : false
        });
      });
    }

    transport.onRequest(req);

    this.clients[id] = socket;
    this.clientsCount++;

    socket.once("close", () => {
      delete this.clients[id];
      this.clientsCount--;
    });

    this.emit("connection", socket);
  }

  /**
   * Called upon a ws.io connection.
   *
   * @param req
   * @param socket
   */
  private onWebSocket(req, socket) {
    socket.on("error", onUpgradeError);

    if (
      transports[req._query.transport] !== undefined &&
      !transports[req._query.transport].prototype.handlesUpgrades
    ) {
      debug("transport doesnt handle upgraded requests");
      socket.close();
      return;
    }

    // get client id
    const id = req._query.sid;

    // keep a reference to the ws.Socket
    req.websocket = socket;

    if (id) {
      const client = this.clients[id];
      if (!client) {
        debug("upgrade attempt for closed client");
        socket.close();
      } else if (client.upgrading) {
        debug("transport has already been trying to upgrade");
        socket.close();
      } else if (client.upgraded) {
        debug("transport had already been upgraded");
        socket.close();
      } else {
        debug("upgrading existing transport");

        // transport error handling takes over
        socket.removeListener("error", onUpgradeError);

        const transport = new transports[req._query.transport](req, this.opts);
        transport.supportsBinary = !(req._query && req._query.b64);
        transport.perMessageDeflate = this.opts.perMessageDeflate;
        client.maybeUpgrade(transport);
      }
    } else {
      // transport error handling takes over
      socket.removeListener("error", onUpgradeError);

      this.handshake(req._query.transport, req);
    }

    function onUpgradeError() {
      debug("websocket error before upgrade");
      // socket.close() not needed
    }
  }
}

/**
 * From https://github.com/nodejs/node/blob/v8.4.0/lib/_http_common.js#L303-L354
 *
 * True if val contains an invalid field-vchar
 *  field-value    = *( field-content / obs-fold )
 *  field-content  = field-vchar [ 1*( SP / HTAB ) field-vchar ]
 *  field-vchar    = VCHAR / obs-text
 *
 * checkInvalidHeaderChar() is currently designed to be inlinable by v8,
 * so take care when making changes to the implementation so that the source
 * code size does not exceed v8's default max_inlined_source_size setting.
 **/
// prettier-ignore
const validHdrChars = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 48 - 63
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 80 - 95
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, // 112 - 127
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 128 ...
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1  // ... 255
];

function checkInvalidHeaderChar(val) {
  val += "";
  if (val.length < 1) {
    return false;
  }
  if (!validHdrChars[val.charCodeAt(0)]) {
    debug('invalid header, index 0, char "%s"', val.charCodeAt(0));
    return true;
  }
  if (val.length < 2) {
    return false;
  }
  if (!validHdrChars[val.charCodeAt(1)]) {
    debug('invalid header, index 1, char "%s"', val.charCodeAt(1));
    return true;
  }
  if (val.length < 3) {
    return false;
  }
  if (!validHdrChars[val.charCodeAt(2)]) {
    debug('invalid header, index 2, char "%s"', val.charCodeAt(2));
    return true;
  }
  if (val.length < 4) {
    return false;
  }
  if (!validHdrChars[val.charCodeAt(3)]) {
    debug('invalid header, index 3, char "%s"', val.charCodeAt(3));
    return true;
  }
  for (let i = 4; i < val.length; ++i) {
    if (!validHdrChars[val.charCodeAt(i)]) {
      debug('invalid header, index "%i", char "%s"', i, val.charCodeAt(i));
      return true;
    }
  }
  return false;
}
