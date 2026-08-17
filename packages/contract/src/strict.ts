/**
 * Making a request schema reject unknown fields, all the way down.
 *
 * Zod strips an unrecognized key by default, which is the wrong default for a
 * command: a client that misspells `stepTarget` would have its challenge
 * created with the server's own idea of the value and never learn that the
 * field it sent was ignored. Requests therefore reject what they do not
 * recognize, at every level of nesting, and the rejection is stated here once
 * rather than by remembering `strictObject` at forty definition sites.
 *
 * Responses are deliberately left permissive. An older app parsing a newer
 * server's response must tolerate a field it has never heard of, or every
 * additive change to a response would be a forced app update.
 */

import { z } from "zod";

/** Schema types that hold no other schema, and so need no descent. */
const LEAF_TYPES = new Set([
  "string",
  "number",
  "int",
  "bigint",
  "boolean",
  "date",
  "enum",
  "literal",
  "null",
  "undefined",
  "void",
  "any",
  "unknown",
  "never",
]);

/**
 * A copy of `schema` in which every object rejects unknown keys.
 *
 * Throws on a schema construct it has not been taught to walk, so adding one
 * to the contract fails at import rather than quietly leaving a hole through
 * which unknown fields reach a command.
 */
export function deepStrict<T extends z.ZodType>(schema: T): T {
  return walk(schema) as T;
}

/**
 * Rebuilding rather than re-declaring: `clone` carries the original's checks
 * across, so a refinement such as "a weekday appears at most once" survives
 * having its element schema replaced. Declaring a fresh `z.array(...)` or
 * `z.strictObject(...)` would silently drop every such rule.
 */
function walk(schema: z.core.$ZodType): z.ZodType {
  switch (schema._zod.def.type) {
    case "object": {
      const object = schema as unknown as z.ZodObject;
      const def = object._zod.def;
      // A catchall already present is an explicit decision by whoever wrote
      // the schema, and this function does not get to overrule it. The payment
      // webhook is the case: the provider owns that payload and sends far more
      // than the contract names.
      if (def.catchall !== undefined) return object;
      const shape: Record<string, z.ZodType> = {};
      for (const [key, value] of Object.entries(def.shape)) {
        shape[key] = walk(value);
      }
      return z.core.util.clone(object, { ...def, shape, catchall: z.never() });
    }
    case "array": {
      const array = schema as unknown as z.ZodArray;
      const def = array._zod.def;
      return z.core.util.clone(array, { ...def, element: walk(def.element) });
    }
    case "optional": {
      const optional = schema as unknown as z.ZodOptional;
      const def = optional._zod.def;
      return z.core.util.clone(optional, { ...def, innerType: walk(def.innerType) });
    }
    case "nullable": {
      const nullable = schema as unknown as z.ZodNullable;
      const def = nullable._zod.def;
      return z.core.util.clone(nullable, { ...def, innerType: walk(def.innerType) });
    }
    case "union": {
      const union = schema as unknown as z.ZodUnion;
      const def = union._zod.def;
      return z.core.util.clone(union, { ...def, options: def.options.map(walk) });
    }
    default:
      if (LEAF_TYPES.has(schema._zod.def.type)) return schema as z.ZodType;
      throw new Error(
        `deepStrict does not know how to walk a schema of type "${schema._zod.def.type}"`,
      );
  }
}
