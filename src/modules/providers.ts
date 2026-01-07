import { z } from "zod";

import type { ProvidersApiContext } from "../apis/providers-api.js";
import { ProvidersApi } from "../apis/providers-api.js";
import type { WorkbenchContext } from "../workbench-light.js";
import { module, mutate, query } from "../workbench-light.js";

export type ProvidersModuleContext = WorkbenchContext & ProvidersApiContext;

export const providers = module((ctx: ProvidersModuleContext) => {
  const impl = new ProvidersApi(ctx);

  return {
    api: {
      list: query(
        z.object({ json: z.boolean().optional() }).optional(),
        z.object({
          providers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() }))
        }),
        async (input) => {
          return await impl.list(input?.json);
        }
      ),

      describe: query(
        z.object({ providerId: z.string(), json: z.boolean().optional() }),
        z.object({ provider: z.any() }),
        async ({ providerId, json }) => {
          return await impl.describe(providerId, json);
        }
      ),

      register: mutate(
        z
          .object({
            files: z.array(z.string()).optional(),
            file: z.string().optional(),
            json: z.string().optional(),
            bearerEnv: z.string().optional(),
            apiKeyEnv: z.string().optional(),
            headerEnv: z.array(z.string()).optional()
          })
          .optional(),
        z.union([
          z.object({ ok: z.literal(true), providerId: z.string() }),
          z.object({ ok: z.literal(true), providerIds: z.array(z.string()) })
        ]),
        async (input) => {
          return await impl.register(
            input?.files,
            input?.file,
            input?.json,
            input?.bearerEnv,
            input?.apiKeyEnv,
            input?.headerEnv
          );
        }
      )
    }
  };
});

