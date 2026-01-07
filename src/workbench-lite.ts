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

type Kind = "query" | "mutation";

export type Op<K extends Kind, I extends z.ZodTypeAny, O extends z.ZodTypeAny> =
  ((input: z.infer<I>) => Promise<z.infer<O>> | z.infer<O>) & {
    kind: K;
    input: I;
    output: O;
    meta?: Record<string, unknown>;
  };

const define =
  <K extends Kind>(kind: K) =>
  <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    input: I,
    output: O,
    handler: (i: z.infer<I>) => Promise<z.infer<O>> | z.infer<O>,
    meta?: Record<string, unknown>
  ): Op<K, I, O> =>
    Object.assign(handler, { kind, input, output, meta });

export const query = define("query");
export const mutate = define("mutation");

/** =========================
 *  Schema tree (what getApiSchema returns)
 *  ========================= */
export type ApiSchemaNode =
  | {
      kind: Kind;
      input: z.ZodTypeAny;
      output: z.ZodTypeAny;
      meta?: Record<string, unknown>;
    }
  | { [key: string]: ApiSchemaNode };

const WB_SCHEMA = Symbol("workbench-light.schema");

type ModuleLike = {
  getApiSchema: () => ApiSchemaNode;
};

function isOp(x: unknown): x is Op<any, any, any> {
  const y = x as any;
  return typeof y === "function" && !!y.kind && !!y.input && !!y.output;
}

function isModule(x: unknown): x is ModuleLike & { [WB_SCHEMA]: ApiSchemaNode } {
  const y = x as any;
  return !!y && typeof y === "object" && typeof y.getApiSchema === "function" && !!y[WB_SCHEMA];
}

function buildSchema(node: any): ApiSchemaNode {
  if (isOp(node)) {
    return { kind: node.kind, input: node.input, output: node.output, meta: node.meta };
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
  [key: string]: Op<any, any, any> | ApiDef | ModuleLike;
}

type ApiFromDef<D> =
  D extends Op<any, infer I, infer O>
    ? (input: z.infer<I>) => Promise<z.infer<O>>
    : D extends ModuleLike
      ? D
    : D extends Record<string, any>
      ? { [K in keyof D]: ApiFromDef<D[K]> }
      : never;

export function module<const D extends ApiDef>(def: D): ApiFromDef<D> & ModuleLike {
  const schema = buildSchema(def);

  const buildRuntime = (node: any): any => {
    if (isOp(node)) {
      return async (input: unknown) => {
        const parsed = node.input.parse(input);
        const out = await node(parsed);
        return node.output.parse(out);
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

