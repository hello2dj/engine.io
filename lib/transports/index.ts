import JSONP from "./polling-jsonp";
import XHR from "./polling-xhr";

export { default as websocket } from "./websocket";

/**
 * Polling polymorphic constructor.
 */
export function polling(req, opts) {
  if ("string" === typeof req._query.j) {
    return new JSONP(req, opts);
  } else {
    return new XHR(opts);
  }
}

/**
 * Export upgrades map.
 */
exports.polling.upgradesTo = ["websocket"];
