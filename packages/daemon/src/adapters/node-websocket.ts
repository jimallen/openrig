// workspaces-o9o.125: the terminal WebSocket on @hono/node-server 2's built-in support (it replaced the deprecated
// @hono/node-ws). The adapter handles an upgrade only on a server that `serve()` created with `websocket: { server }`,
// so the daemon hands each listener its own option. One WebSocketServer per listener: closing a listener closes its
// WebSocketServer, which must not end the upgrades of the others (index.ts can bind several hosts).
//
// An upgrade request runs the app's whole fetch first: the browser boundary (Host and Origin, read from the request's
// raw headers through `c.env.incoming`) and the terminal guard answer before `upgradeWebSocket` is reached, and a
// refusal there is written back on the socket with its status.
import { WebSocketServer } from "ws";

/** The `websocket` option for one `serve()` call. */
export interface NodeWebSocketOption {
  server: WebSocketServer;
}

/** A fresh option for one listener. */
export function newNodeWebSocketOption(): NodeWebSocketOption {
  return { server: new WebSocketServer({ noServer: true }) };
}
