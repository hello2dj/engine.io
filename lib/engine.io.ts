import { Server as HttpServer } from "http";
import { Server as HttpsServer } from "https";

/**
 * Invoking the library as a function delegates to attach if the first argument
 * is an `http.Server`.
 *
 * If there are no arguments or the first argument is an options object, then
 * a new Server instance is returned.
 *
 * @param {HttpServer,HttpsServer} server (if specified, will be attached to by the new Server instance)
 * @param {Object} options
 * @return {Server} engine server
 */
exports = module.exports = function createServer(
  server?: HttpServer | HttpsServer,
  options: Partial<IAttachOptions & IServerOptions> = {}
) {
  // backwards compatible use as `.attach`
  // if first argument is an http server
  if (server && server instanceof HttpServer) {
    return attach.apply(this, arguments);
  }

  // if first argument is not an http server, then just make a regular eio server
  // return exports.Server.apply(null, arguments);
  return new Server(options);
};

/**
 * Protocol revision number.
 */
exports.protocol = 1;

/**
 * Expose Server constructor.
 */
import Server, { IAttachOptions, IServerOptions } from "./server";
export { Server };

/**
 * Expose Socket constructor.
 */
export { default as Socket } from "./socket";

/**
 * Expose Transport constructor.
 */
export { default as Transport } from "./transport";

/**
 * Expose mutable list of available transports.
 */
exports.transports = require("./transports");

/**
 * Exports parser.
 */
exports.parser = require("engine.io-parser");

/**
 * Creates an http.Server exclusively used for WS upgrades.
 *
 * @param {Number} port
 * @param {Function} callback
 * @param {Object} options
 * @return {Server} websocket.io server
 */
export function listen(port, options, fn) {
  if ("function" === typeof options) {
    fn = options;
    options = {};
  }

  const server = new HttpServer((req, res) => {
    res.writeHead(501);
    res.end("Not Implemented");
  });

  // create engine server
  const engine = exports.attach(server, options);
  engine.httpServer = server;

  server.listen(port, fn);

  return engine;
}

/**
 * Captures upgrade requests for a http.Server.
 *
 * @param {http.Server} server
 * @param {Object} options
 * @return {Server} engine server
 */
export function attach(
  server: HttpServer | HttpsServer,
  options: Partial<IAttachOptions & IServerOptions>
) {
  const engine = new Server(options);
  engine.attach(server, options);
  return engine;
}
