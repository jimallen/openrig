// Test-only ambient typing (OF-126/OF-127 review): Node's fetch types (undici-types) declare Response.json()
// as Promise<unknown>; the browser/Hono-client typing is Promise<any>. HTTP-body reads in daemon tests assert on
// the parsed shape with expect(), so they read the body as any. This is what lib "DOM" used to buy, without
// the DOM globals (document, window, HTMLElement) type-checking in Node tests. Not part of the daemon build:
// tsconfig.json excludes test/.
import "undici-types";

declare module "undici-types" {
  interface Response {
    readonly json: () => Promise<any>;
  }
}

// Fetch/WebSocket type names the tests use that Node's types do not declare globally (DOM-only names).
declare global {
  type RequestInfo = string | URL | Request;
  type HeadersInit = ConstructorParameters<typeof Headers>[0];
  type CloseEvent = import("undici-types").CloseEvent;
}
