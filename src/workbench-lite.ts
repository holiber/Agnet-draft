import { z } from "zod";

/**
 * Workbench-lite (investigation utility)
 * ------------------------------------
 *
 * This is a small "schema-first" API builder that:
 * - composes nested modules (plain objects or other modules)
 * - validates inputs/outputs at runtime via Zod
 * - exposes an introspectable schema tree via `getApiSchema()`
 *
 * Migration notes (initial investigation; DO NOT migrate yet):
 * - Our current API layer is decorator/registry-based (`@Api.endpoint`, `@Api.arg`) and supports
 *   endpoint patterns (unary vs server stream), CLI arg metadata, and handler factories/DI.
 * - Workbench-lite can represent unary request/response endpoints nicely, and the schema tree
 *   could replace/augment parts of doc generation.
 * - Gaps to address before migration:
 *   - streaming endpoints: need a first-class `kind` or pattern type for AsyncIterable outputs
 *   - CLI metadata: current system has rich per-arg CLI mapping; would need a standardized `meta`
 *     schema (or a parallel registry) to preserve existing UX and backwards compatibility flags
 *   - DI/factories: current registry supports handler factories; workbench-lite is functional.
 *     We'd need an adapter layer or a convention to create handler instances.
 * - Likely path (if we proceed): introduce adapters to bridge current registry <-> workbench-lite
 *   schema, validate feasibility for streaming + CLI, then migrate incrementally.
 */

type UnaryKind = "query" | "mutation";
type Kind = UnaryKind | "stream";

export type Op<K extends UnaryKind, I extends z.ZodTypeAny, O extends z.ZodTypeAny> =
  ((input: z.infer<I>) => Promise<z.infer<O>> | z.infer<O>) & {
    kind: K;
    input: I;
    output: O;
    meta?: Record<string, unknown>;
  };

export type StreamOp<I extends z.ZodTypeAny, C extends z.ZodTypeAny> =
  ((input: z.infer<I>) => AsyncIterable<z.infer<C>>) & {
    kind: "stream";
    input: I;
    chunk: C;
    meta?: Record<string, unknown>;
  };

type AnyOp = Op<any, any, any> | StreamOp<any, any>;

const define =
  <K extends UnaryKind>(kind: K) =>
  <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    input: I,
    output: O,
    handler: (i: z.infer<I>) => Promise<z.infer<O>> | z.infer<O>,
    meta?: Record<string, unknown>
  ): Op<K, I, O> =>
    Object.assign(handler, { kind, input, output, meta });

export const query = define("query");
export const mutate = define("mutation");

export const stream = <I extends z.ZodTypeAny, C extends z.ZodTypeAny>(
  input: I,
  chunk: C,
  handler: (i: z.infer<I>) => AsyncIterable<z.infer<C>>,
  meta?: Record<string, unknown>
): StreamOp<I, C> => Object.assign(handler, { kind: "stream" as const, input, chunk, meta });

/** =========================
 *  Schema tree (what getApiSchema returns)
 *  ========================= */
export type ApiSchemaNode =
  | {
      kind: UnaryKind;
      input: z.ZodTypeAny;
      output: z.ZodTypeAny;
      meta?: Record<string, unknown>;
    }
  | {
      kind: "stream";
      input: z.ZodTypeAny;
      chunk: z.ZodTypeAny;
      meta?: Record<string, unknown>;
    }
  | { [key: string]: ApiSchemaNode };

const WB_SCHEMA = Symbol("workbench-light.schema");

type ModuleLike = {
  getApiSchema: () => ApiSchemaNode;
};

function isOp(x: unknown): x is AnyOp {
  const y = x as any;
  return typeof y === "function" && !!y.kind && !!y.input && (!!y.output || !!y.chunk);
}

function isModule(x: unknown): x is ModuleLike & { [WB_SCHEMA]: ApiSchemaNode } {
  const y = x as any;
  return !!y && typeof y === "object" && typeof y.getApiSchema === "function" && !!y[WB_SCHEMA];
}

function buildSchema(node: any): ApiSchemaNode {
  if (isOp(node)) {
    if (node.kind === "stream") {
      return { kind: "stream", input: node.input, chunk: (node as any).chunk, meta: node.meta };
    }
    return { kind: node.kind, input: node.input, output: (node as any).output, meta: node.meta };
  }
  if (isModule(node)) {
    return node.getApiSchema();
  }
  const out: Record<string, ApiSchemaNode> = {};
  for (const k of Object.keys(node)) out[k] = buildSchema(node[k]);
  return out;
}

/** =========================
 *  module()
 *  ========================= */
interface ApiDef {
  [key: string]: AnyOp | ApiDef | ModuleLike;
}

type ApiFromDef<D> =
  D extends Op<any, infer I, infer O>
    ? (input: z.infer<I>) => Promise<z.infer<O>>
    : D extends StreamOp<infer I, infer C>
      ? (input: z.infer<I>) => AsyncIterable<z.infer<C>>
    : D extends ModuleLike
      ? D
    : D extends Record<string, any>
      ? { [K in keyof D]: ApiFromDef<D[K]> }
      : never;

export function module<const D extends ApiDef>(def: D): ApiFromDef<D> & ModuleLike {
  const schema = buildSchema(def);

  const buildRuntime = (node: any): any => {
    if (isOp(node)) {
      if (node.kind === "stream") {
        return (input: unknown) => {
          const parsed = (node as any).input.parse(input);
          const iter = (node as any)(parsed) as AsyncIterable<unknown>;
          return (async function* () {
            for await (const chunk of iter) {
              yield (node as any).chunk.parse(chunk);
            }
          })();
        };
      }

      return async (input: unknown) => {
        const unary = node as Op<any, any, any>;
        const parsed = unary.input.parse(input);
        const out = await unary(parsed);
        return unary.output.parse(out);
      };
    }
    if (isModule(node)) {
      // already built module -> just reuse it as a submodule
      return node;
    }
    const out: any = {};
    for (const k of Object.keys(node)) out[k] = buildRuntime(node[k]);
    return out;
  };

  const apiObj: any = buildRuntime(def);

  Object.defineProperty(apiObj, WB_SCHEMA, {
    value: schema,
    enumerable: false,
    configurable: false,
    writable: false
  });

  Object.defineProperty(apiObj, "getApiSchema", {
    value: () => apiObj[WB_SCHEMA] as ApiSchemaNode,
    enumerable: false,
    configurable: false,
    writable: false
  });

  return apiObj;
}

