/** Minimal surface used by the long-connection starter. The package is optional until a live bot is run. */
declare module "@larksuiteoapi/node-sdk" {
  export class WSClient {
    constructor(config: { appId: string; appSecret: string; loggerLevel?: unknown });
    start(args: { eventDispatcher: unknown }): void;
    close?: () => void;
  }
  export class EventDispatcher {
    constructor(options: object);
    register(handlers: Record<string, (data: unknown) => Promise<unknown>>): this;
  }
  export const LoggerLevel: { info: unknown };
}
