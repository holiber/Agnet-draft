import type { ApiArgOptions, ApiEndpointOptions } from "./registry.js";
import { registerArg, registerEndpoint, registerHandlerFactory } from "./registry.js";

export const Api = {
  endpoint(id: string, opts: ApiEndpointOptions = {}) {
    return (
      target: object,
      methodName: string | symbol,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      descriptor: PropertyDescriptor
    ) => {
      registerEndpoint({
        id,
        pattern: opts.pattern ?? "unary",
        target,
        methodName
      });
    };
  },

  arg(opts: ApiArgOptions) {
    return (target: object, methodName: string | symbol, parameterIndex: number) => {
      registerArg({
        target,
        methodName,
        meta: { ...opts, parameterIndex }
      });
    };
  },

  /**
   * Internal hook for transport adapters (CLI/IPC/HTTP/WS)
   * to provide DI/factories for API handler classes.
   */
  registerHandlerFactory
};

