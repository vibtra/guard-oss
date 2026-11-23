const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);
const SIGNING_MODULE = /^@vibtra\/guard-contract\/signing$|(^|\/)guard-contract\/src\/signing(\.[cm]?[jt]s)?$/;
const KEY_NAMES = new Set(["privateKeyPem", "sealedPrivateKey"]);
const KEY_CALLS = new Set(["sign", "createSign", "createPrivateKey", "generateKeyPair", "generateKeyPairSync"]);
const SIGNING_KEY_EXPORTS = new Set(["generateGuardSigningKey", "signEs256", "GuardSigningKeyPair"]);
const ENVELOPE_PREFIX = /(?<![\w.])[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.v\d+\./;

const allowOption = [{ type: "object", properties: { allow: { type: "array", items: { type: "string" } } }, additionalProperties: false }];
const allowedOf = (context) => new Set(context.options[0]?.allow ?? []);

const keyMaterialMessage =
  "Ask GuardSigner.sign() for a signature; never hold a private key outside LocalSigner (apps/registry/src/guard/local-signer.ts). " +
  "{{what}} is allowed only in the files listed for vibtra/no-key-material in tools/eslint/guardrails.json.";

const staticString = (node) => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

const propertyName = (member) => {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return staticString(member.property);
};

const keyName = (property) => {
  if (property.type !== "Property") return undefined;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  return staticString(property.key);
};

const importedName = (specifier) => (specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value);

const TS_WRAPPERS = new Set(["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion"]);
const unwrap = (node) => (node !== null && node !== undefined && TS_WRAPPERS.has(node.type) ? unwrap(node.expression) : node);

const moduleLoaded = (node) => {
  const unwrapped = unwrap(node);
  const target = unwrapped?.type === "AwaitExpression" ? unwrap(unwrapped.argument) : unwrapped;
  if (target?.type === "ImportExpression") return staticString(target.source);
  if (target?.type === "CallExpression" && target.callee.type === "Identifier" && target.callee.name === "require") return staticString(target.arguments[0]);
  return undefined;
};

const isTopLevel = (variable) => variable === undefined || variable.scope.type === "global" || variable.scope.type === "module";

const namespaceTracker = (context, isModule, initial) => {
  const names = new Set(initial);
  const variables = new Set();
  const variableOf = (identifier) => {
    for (let scope = context.sourceCode.getScope(identifier); scope !== null; scope = scope.upper) {
      const variable = scope.set.get(identifier.name);
      if (variable !== undefined) return variable;
    }
    return undefined;
  };
  const add = (identifier) => {
    const variable = variableOf(identifier);
    if (isTopLevel(variable)) names.add(identifier.name);
    else variables.add(variable);
  };
  const is = (node) => {
    const unwrapped = unwrap(node);
    if (unwrapped?.type === "Identifier") {
      const variable = variableOf(unwrapped);
      return variables.has(variable) || (isTopLevel(variable) && names.has(unwrapped.name));
    }
    const loaded = moduleLoaded(unwrapped);
    return loaded !== undefined && isModule(loaded);
  };
  return { names, add, is };
};

const PRIVATE_KEY_FORMATS = new Set(["pkcs8", "jwk"]);

const generatesExtractableSigningKey = (call) => {
  const [, extractable, usages] = call.arguments;
  if (unwrap(extractable)?.type !== "Literal" || unwrap(extractable).value !== true) return false;
  const list = unwrap(usages);
  return list?.type === "ArrayExpression" && list.elements.some((element) => staticString(element) === "sign");
};

export const noKeyMaterial = {
  meta: {
    type: "problem",
    docs: { description: "Keep private keys and raw signing inside the key modules" },
    schema: allowOption,
    messages: { keyMaterial: keyMaterialMessage },
  },
  create(context) {
    const allowed = allowedOf(context);
    const crypto = namespaceTracker(context, (source) => CRYPTO_MODULES.has(source), ["crypto"]);
    const signing = namespaceTracker(context, (source) => SIGNING_MODULE.test(source), []);
    const seen = new Set();
    const report = (node, name, what = name) => {
      if (allowed.has(name)) return;
      const key = node.range.join(":");
      if (seen.has(key)) return;
      seen.add(key);
      context.report({ node, messageId: "keyMaterial", data: { what } });
    };
    const bannedFrom = (source) => {
      if (CRYPTO_MODULES.has(source)) return KEY_CALLS;
      if (SIGNING_MODULE.test(source)) return SIGNING_KEY_EXPORTS;
      return undefined;
    };
    const checkSpecifiers = (source, specifiers, pick) => {
      const banned = bannedFrom(source);
      if (banned === undefined) return;
      for (const specifier of specifiers) {
        const name = pick(specifier);
        if (name !== undefined && banned.has(name)) report(specifier, name, `${name} from ${source}`);
      }
    };
    const trackNamespace = (identifier, init) => {
      if (crypto.is(init)) crypto.add(identifier);
      if (signing.is(init)) signing.add(identifier);
    };
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        checkSpecifiers(source, node.specifiers, (specifier) => (specifier.type === "ImportSpecifier" ? importedName(specifier) : undefined));
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") continue;
          if (CRYPTO_MODULES.has(source)) crypto.names.add(specifier.local.name);
          if (SIGNING_MODULE.test(source)) signing.names.add(specifier.local.name);
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null && node.source !== undefined) checkSpecifiers(node.source.value, node.specifiers, (specifier) => (specifier.local.type === "Identifier" ? specifier.local.name : specifier.local.value));
      },
      VariableDeclarator(node) {
        if (node.init === null || node.init === undefined) return;
        if (node.id.type === "Identifier") {
          trackNamespace(node.id, node.init);
          return;
        }
        if (node.id.type !== "ObjectPattern") return;
        const source = crypto.is(node.init) ? "node:crypto" : signing.is(node.init) ? "@vibtra/guard-contract/signing" : undefined;
        if (source !== undefined) checkSpecifiers(source, node.id.properties, keyName);
      },
      AssignmentExpression(node) {
        if (node.left.type === "Identifier") trackNamespace(node.left, node.right);
      },
      AssignmentPattern(node) {
        if (node.left.type === "Identifier") trackNamespace(node.left, node.right);
      },
      Identifier(node) {
        if (KEY_NAMES.has(node.name)) report(node, node.name);
      },
      Literal(node) {
        if (typeof node.value === "string" && KEY_NAMES.has(node.value)) report(node, node.value);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === "Identifier" && callee.name === "createPrivateKey") report(callee, "createPrivateKey", "createPrivateKey()");
        if (callee.type !== "MemberExpression") return;
        const name = propertyName(callee);
        if (name === undefined) return;
        if (name === "createPrivateKey") report(callee, name, "createPrivateKey()");
        else if (name === "exportKey" && PRIVATE_KEY_FORMATS.has(staticString(node.arguments[0]) ?? "")) report(callee, name, `exportKey(${JSON.stringify(staticString(node.arguments[0]))})`);
        else if (name === "generateKey" && generatesExtractableSigningKey(node)) report(callee, name, "generateKey() of an extractable signing key");
        else if (KEY_CALLS.has(name) && crypto.is(callee.object)) report(callee, name, `crypto.${name}()`);
        else if (SIGNING_KEY_EXPORTS.has(name) && signing.is(callee.object)) report(callee, name, `${name}() from the signing module`);
      },
    };
  },
};

const isGlobalProcess = (node) =>
  node?.type === "MemberExpression" && unwrap(node.object)?.type === "Identifier" && unwrap(node.object).name === "globalThis" && propertyName(node) === "process";

const isReflectGet = (callee) =>
  callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "Reflect" && propertyName(callee) === "get";

export const noProcessEnv = {
  meta: {
    type: "problem",
    docs: { description: "Read environment variables only in the registry config" },
    schema: allowOption,
    messages: {
      processEnv:
        "Read process.env only in apps/registry/src/config.ts (or the CLI entry). Add the variable to loadRegistryConfig and the known-variable list there, " +
        "and pass the parsed value in, so an unknown or ineffective variable is refused at boot instead of silently ignored.",
    },
  },
  create(context) {
    const allowed = allowedOf(context);
    const processes = namespaceTracker(context, (source) => PROCESS_MODULES.has(source), ["process"]);
    const isProcess = (node) => processes.is(node) || isGlobalProcess(unwrap(node));
    const report = (node) => context.report({ node, messageId: "processEnv" });
    const bind = (target, value) => {
      if (!isProcess(value)) return;
      if (target.type === "Identifier") processes.add(target);
      if (target.type !== "ObjectPattern") return;
      for (const property of target.properties) {
        if (keyName(property) === "env") report(property);
      }
    };
    const readsAllowedVariable = (envMember) => {
      const parent = envMember.parent;
      if (allowed.size === 0 || parent?.type !== "MemberExpression" || parent.object !== envMember) return false;
      const variable = propertyName(parent);
      return variable !== undefined && allowed.has(variable);
    };
    return {
      ImportDeclaration(node) {
        if (!PROCESS_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") processes.names.add(specifier.local.name);
          else if (importedName(specifier) === "env") report(specifier);
        }
      },
      MemberExpression(node) {
        if (isProcess(node.object) && propertyName(node) === "env" && !readsAllowedVariable(node)) report(node);
      },
      VariableDeclarator(node) {
        if (node.init !== null && node.init !== undefined) bind(node.id, node.init);
      },
      AssignmentPattern(node) {
        bind(node.left, node.right);
      },
      AssignmentExpression(node) {
        if (node.left.type === "Identifier" && isProcess(node.right)) processes.add(node.left);
      },
      CallExpression(node) {
        if (isReflectGet(node.callee) && node.arguments[0] !== undefined && isProcess(node.arguments[0]) && staticString(node.arguments[1]) === "env") report(node);
      },
    };
  },
};

const concatenationParts = (node) => {
  if (node.type === "BinaryExpression" && node.operator === "+") return [...concatenationParts(node.left), ...concatenationParts(node.right)];
  return [node];
};

const shapeOf = (parts) =>
  parts
    .map((part) => {
      const text = staticString(part);
      if (text !== undefined) return text;
      if (part.type === "TemplateLiteral") return part.quasis.map((quasi) => quasi.value.cooked ?? "").join("x");
      return "x";
    })
    .join("");

const isConcatenation = (node) => node?.type === "BinaryExpression" && node.operator === "+";

const regexText = (pattern) =>
  pattern
    .replaceAll("\\.", ".")
    .replaceAll("[.]", ".")
    .replace(/\\d\+?|\[0-9\]\+?/g, "1")
    .replace(/\(\?(?:[:=!]|<[=!])/g, "")
    .replace(/[()^$?*+]/g, "")
    .replaceAll("|", " ");

const isRegExpSource = (node) => {
  const parent = node.parent;
  if (parent?.type !== "NewExpression" && parent?.type !== "CallExpression") return false;
  return parent.callee.type === "Identifier" && parent.callee.name === "RegExp" && parent.arguments[0] === node;
};

export const noEnvelopePrefixLiteral = {
  meta: {
    type: "problem",
    docs: { description: "Take sealed-envelope prefixes from the sealer, never from a literal" },
    schema: [],
    messages: {
      prefix:
        "Do not hard-code the envelope prefix {{prefix}}. Read it from VaultSealer.envelopePrefix (or envelopePrefixes for every prefix a ring opens), " +
        "so a new sealer (a KMS one, say) is covered without editing this file.",
    },
  },
  create(context) {
    const report = (node, prefix) => context.report({ node, messageId: "prefix", data: { prefix: JSON.stringify(prefix) } });
    const check = (node, text) => {
      const match = ENVELOPE_PREFIX.exec(text);
      if (match !== null) report(node, match[0]);
    };
    return {
      Literal(node) {
        if (isConcatenation(node.parent)) return;
        if (node.regex !== undefined) check(node, regexText(node.regex.pattern));
        else if (typeof node.value === "string") check(node, isRegExpSource(node) ? regexText(node.value) : node.value);
      },
      TemplateLiteral(node) {
        if (isConcatenation(node.parent) || node.parent?.type === "TaggedTemplateExpression") return;
        check(node, isRegExpSource(node) ? regexText(shapeOf([node])) : shapeOf([node]));
      },
      BinaryExpression(node) {
        if (!isConcatenation(node) || isConcatenation(node.parent)) return;
        const text = shapeOf(concatenationParts(node));
        check(node, isRegExpSource(node) ? regexText(text) : text);
      },
    };
  },
};

const LOCKED_TX = "OrgLockedTx";

const rightmostName = (name) => {
  if (name?.type === "Identifier") return name.name;
  if (name?.type === "TSQualifiedName") return name.right.name;
  return undefined;
};

const namesLockedTx = (type, aliases) => {
  if (type?.type === "TSTypeReference") return type.typeName.type === "Identifier" ? aliases.has(type.typeName.name) : rightmostName(type.typeName) === LOCKED_TX;
  if (type?.type === "TSImportType") return rightmostName(type.qualifier) === LOCKED_TX;
  if (type?.type === "TSIntersectionType" || type?.type === "TSUnionType") return type.types.some((member) => namesLockedTx(member, aliases));
  return false;
};

export const noOrgLockedTxCast = {
  meta: {
    type: "problem",
    docs: { description: "Get an OrgLockedTx only from withOrgLock, never from a cast" },
    schema: [],
    messages: {
      cast:
        "Do not cast to OrgLockedTx. Only withOrgLock(orgId, fn) in apps/registry/src/store/org-lock.ts makes one, after it takes the org lock, and the stores trust it. " +
        "Take the tx that withOrgLock passes to fn and pass it down. A cast is allowed only in the files listed for vibtra/no-org-locked-tx-cast in tools/eslint/guardrails.json.",
    },
  },
  create(context) {
    const aliases = new Set([LOCKED_TX]);
    const typeAliases = [];
    const casts = [];
    return {
      ImportSpecifier(node) {
        if (importedName(node) === LOCKED_TX) aliases.add(node.local.name);
      },
      TSTypeAliasDeclaration(node) {
        typeAliases.push(node);
      },
      TSAsExpression(node) {
        casts.push(node);
      },
      TSTypeAssertion(node) {
        casts.push(node);
      },
      "Program:exit"() {
        for (let grew = true; grew; ) {
          grew = false;
          for (const alias of typeAliases) {
            if (aliases.has(alias.id.name) || !namesLockedTx(alias.typeAnnotation, aliases)) continue;
            aliases.add(alias.id.name);
            grew = true;
          }
        }
        for (const cast of casts) if (namesLockedTx(cast.typeAnnotation, aliases)) context.report({ node: cast, messageId: "cast" });
      },
    };
  },
};
