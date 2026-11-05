type ZodDef = Record<string, unknown> & { typeName?: unknown };

const defOf = (schema: unknown): ZodDef => {
  const def = (schema as { _def?: ZodDef } | null | undefined)?._def;
  if (def === undefined || typeof def.typeName !== "string") {
    throw new Error(`fieldNamesOf: not a zod schema: ${String(schema)}`);
  }
  return def;
};

const childrenOf = (def: ZodDef): unknown[] => {
  switch (def.typeName) {
    case "ZodString":
    case "ZodNumber":
    case "ZodNaN":
    case "ZodBigInt":
    case "ZodBoolean":
    case "ZodDate":
    case "ZodSymbol":
    case "ZodUndefined":
    case "ZodNull":
    case "ZodAny":
    case "ZodUnknown":
    case "ZodNever":
    case "ZodVoid":
    case "ZodLiteral":
    case "ZodEnum":
    case "ZodNativeEnum":
      return [];
    case "ZodArray":
    case "ZodBranded":
    case "ZodPromise":
      return [def.type];
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      return [def.innerType];
    case "ZodEffects":
      return [def.schema];
    case "ZodLazy":
      return [(def.getter as () => unknown)()];
    case "ZodPipeline":
      return [def.in, def.out];
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return [...(def.options as unknown[])];
    case "ZodIntersection":
      return [def.left, def.right];
    case "ZodRecord":
    case "ZodMap":
      return [def.keyType, def.valueType];
    case "ZodSet":
      return [def.valueType];
    case "ZodTuple":
      return [...(def.items as unknown[]), ...(def.rest == null ? [] : [def.rest])];
    default:
      throw new Error(`fieldNamesOf: unhandled zod kind ${String(def.typeName)}`);
  }
};

export const fieldNamesOf = (schema: unknown): string[] => {
  const names = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const def = defOf(node);
    if (def.typeName === "ZodObject") {
      for (const [name, child] of Object.entries((def.shape as () => Record<string, unknown>)())) {
        names.add(name);
        walk(child);
      }
      return;
    }
    for (const child of childrenOf(def)) walk(child);
  };
  walk(schema);
  return [...names];
};
