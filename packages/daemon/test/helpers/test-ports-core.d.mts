// Types for test-ports-core.mjs (workspaces-o9o.81).
export declare const TEST_PORT_HOST: "127.0.0.1";
/** Resolved once: a test that stubs TMPDIR later must not move the claims of this process. */
export declare const TEST_PORT_CLAIMS_DIR: string;
/** The OS's choice of a free loopback port, released at once. */
export declare function probeFreePort(): Promise<number>;
/** Claims `port` for this process; false when another live test process holds it. */
export declare function claimPort(port: number): boolean;
/** Drops this process's claim on `port` (never another process's). */
export declare function releasePort(port: number): void;
export interface ClaimOptions {
  /** Where candidate numbers come from: the OS by default (a test seam). */
  probe?: () => Promise<number>;
  /** How many offers to try before giving up. */
  attempts?: number;
}
/** A loopback port for something that binds it later, or that must stay refused: claimed for this process until it exits or releases it. */
export declare function claimTestPort(opts?: ClaimOptions): Promise<number>;
/** The same, for a caller that cannot await: runs the probe in a child process. */
export declare function claimTestPortSync(): number;
