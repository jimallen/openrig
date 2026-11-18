// workspaces-o9o.125: the terminal WebSocket on @hono/node-server 2's built-in support (it replaced the deprecated
// @hono/node-ws). The adapter handles an upgrade only on a server that `serve()` created with `websocket: { server }`,
// so the daemon hands each listener its own option. One WebSocketServer per listener: closing a listener closes its
// WebSocketServer, which must not end the upgrades of the others (index.ts can bind several hosts).
//
// An upgrade request runs the app's whole fetch first: the browser boundary (Host and Origin, read from the request's
// raw headers through `c.env.incoming`) and the terminal guard answer before `upgradeWebSocket` is reached, and a
// refusal there is written back on the socket with its status.
//
// Except where the adapter cannot build the request at all (verify-sec, o9o.125 review): it turns the Host into a URL before
// the app runs and answers 400 or 500 itself when it cannot (an empty or malformed Host), so the boundary made no decision there.
// The listener's createServer therefore looks at each upgrade first: one whose Host the adapter cannot carry
// (upgradeHostNeedsEarlyDecision) goes through the app's own fetch, with the raw request as `env.incoming`, and its answer is
// written on the socket; every other upgrade goes to the adapter as before. The adapter stays the only `upgrade` listener, so its
// own rejections still go out (it writes one only when it is the sole listener).
import http, { type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { rawHeaderOf, upgradeHostNeedsEarlyDecision } from "../middleware/browser-boundary.js";

/** The `websocket` option for one `serve()` call. */
export interface NodeWebSocketOption {
  server: WebSocketServer;
}

/** A fresh option for one listener. */
export function newNodeWebSocketOption(): NodeWebSocketOption {
  return { server: new WebSocketServer({ noServer: true }) };
}

type AppFetch = (request: Request, env: { incoming: IncomingMessage; outgoing: undefined }) => Response | Promise<Response>;

/** The `serve()` options one listener needs for the terminal WebSocket: its own WebSocketServer, and a server that lets the app
 *  decide an upgrade the adapter cannot carry. */
export interface NodeListenerOptions {
  websocket: NodeWebSocketOption;
  createServer: typeof http.createServer;
}

export function newNodeListenerOptions(fetch: AppFetch): NodeListenerOptions {
  return { websocket: newNodeWebSocketOption(), createServer: serverDecidingUncarriedUpgrades(fetch) };
}

function serverDecidingUncarriedUpgrades(fetch: AppFetch): typeof http.createServer {
  const create = (options: http.ServerOptions, listener?: http.RequestListener): http.Server => {
    const server = http.createServer(options, listener);
    const emit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean;
    server.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event === "upgrade") {
        const [request, socket] = args as [IncomingMessage, Duplex];
        if (upgradeHostNeedsEarlyDecision(rawHeaderOf(request.rawHeaders, "host"))) {
          void answerOnSocket(fetch, request, socket);
          return true;
        }
      }
      return emit(event, ...args);
    }) as typeof server.emit;
    return server;
  };
  return create as typeof http.createServer;
}

async function answerOnSocket(fetch: AppFetch, request: IncomingMessage, socket: Duplex): Promise<void> {
  socket.on("error", () => { /* the client went away; nothing to answer */ });
  let status = 500;
  let type = "text/plain; charset=utf-8";
  let body = "";
  try {
    // The URL only carries the path to the router: the boundary reads Host and Origin from the raw request (env.incoming).
    const path = request.url?.startsWith("/") ? request.url : "/";
    const response = await fetch(new Request(`http://localhost${path}`, { headers: { upgrade: "websocket" } }), { incoming: request, outgoing: undefined });
    status = response.status;
    type = response.headers.get("content-type") ?? type;
    body = await response.text();
  } catch { /* status 500, empty body */ }
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
