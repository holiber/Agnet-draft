export type ApiArgType = "string" | "boolean" | "string[]";
export type ApiEndpointPattern = "unary" | "serverStream";

export interface ApiCliArgOptions {
  /**
   * CLI flag name, e.g. "--json" or "--files".
   *
   * If omitted, the arg can still be provided via positionalIndex.
   */
  flag?: `--${string}`;
  /**
   * Repeatable flags collect multiple values.
   *
   * Tier1: primarily used with type "string[]".
   */
  repeatable?: boolean;
  /**
   * Optional flag aliases to preserve backwards compatibility, e.g. "--file".
   * Parsed identically to `flag`.
   */
  aliases?: Array<`--${string}`>;
  /**
   * Positional index in the argv tail after the command path.
   * For example, `agentinterop agents describe <agentId>` => positionalIndex: 0.
   */
  positionalIndex?: number;
}

export interface ApiArgOptions {
  name: string;
  type: ApiArgType;
  required?: boolean;
  description?: string;
  cli?: ApiCliArgOptions;
}

export interface ApiEndpointOptions {
  pattern?: ApiEndpointPattern;
}

export interface ApiArgMeta extends ApiArgOptions {
  parameterIndex: number;
}

export interface ApiEndpointMeta {
  id: string;
  pattern: ApiEndpointPattern;
  handlerClass: Function;
  handlerMethodName: string | symbol;
  args: ApiArgMeta[];
}

type MethodKey = string | symbol;

const argsByMethod = new WeakMap<object, Map<MethodKey, ApiArgMeta[]>>();
const endpointsById = new Map<string, ApiEndpointMeta>();
const factoriesByClass = new Map<Function, () => unknown>();

function getOrCreateArgsFor(
  target: object,
  methodName: MethodKey
): ApiArgMeta[] {
  let byMethod = argsByMethod.get(target);
  if (!byMethod) {
    byMethod = new Map();
    argsByMethod.set(target, byMethod);
  }
  let list = byMethod.get(methodName);
  if (!list) {
    list = [];
    byMethod.set(methodName, list);
  }
  return list;
}

export function registerArg(params: {
  target: object;
  methodName: MethodKey;
  meta: ApiArgMeta;
}): void {
  const list = getOrCreateArgsFor(params.target, params.methodName);
  // Replace if same parameter index already exists (defensive).
  const existingIdx = list.findIndex((a) => a.parameterIndex === params.meta.parameterIndex);
  if (existingIdx !== -1) list.splice(existingIdx, 1);
  list.push(params.meta);
}

export function registerEndpoint(params: {
  id: string;
  pattern: ApiEndpointPattern;
  target: object;
  methodName: MethodKey;
}): void {
  const handlerClass = (params.target as { constructor: Function }).constructor;
  const args = [...(getOrCreateArgsFor(params.target, params.methodName) ?? [])].sort(
    (a, b) => a.parameterIndex - b.parameterIndex
  );

  const meta: ApiEndpointMeta = {
    id: params.id,
    pattern: params.pattern,
    handlerClass,
    handlerMethodName: params.methodName,
    args
  };

  const existing = endpointsById.get(params.id);
  if (existing) {
    throw new Error(`Duplicate @Api.endpoint id "${params.id}"`);
  }
  endpointsById.set(params.id, meta);
}

export function registerHandlerFactory<T>(handlerClass: new (...args: never[]) => T, factory: () => T): void {
  factoriesByClass.set(handlerClass, factory);
}

export function getRegisteredEndpoints(): ApiEndpointMeta[] {
  return [...endpointsById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveHandlerInstance(handlerClass: Function): unknown {
  const factory = factoriesByClass.get(handlerClass);
  if (factory) return factory();
  // Default: attempt no-arg construction.
  return new (handlerClass as unknown as new () => unknown)();
}

