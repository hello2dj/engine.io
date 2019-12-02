import Polling from "./polling";

export default class XHR extends Polling {
  /**
   * Overrides `onRequest` to handle `OPTIONS`..
   *
   * @param {http.IncomingMessage} req
   */
  protected onRequest(req) {
    if ("OPTIONS" === req.method) {
      const res = req.res;
      const headers = this.headers(req);
      headers["Access-Control-Allow-Headers"] = "Content-Type";
      res.writeHead(200, headers);
      res.end();
    } else {
      super.onRequest(req);
    }
  }

  /**
   * Returns headers for a response.
   *
   * @param {http.IncomingMessage} req request
   * @param {Object} headers extra headers
   */
  protected headers(req, headers = {}) {
    if (req.headers.origin) {
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Access-Control-Allow-Origin"] = req.headers.origin;
    } else {
      headers["Access-Control-Allow-Origin"] = "*";
    }
    return super.headers(req, headers);
  }
}
