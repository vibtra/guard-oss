const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);
const PROCESS_MODULES = new Set(["process", "node:process"]);
const SIGNING_MODULE = /^@vibtra\/guard-contract\/signing$|(^|\/)guard-contract\/src\/signing(\.[cm]?[jt]s)?$/;
const KEY_NAMES = new Set(["privateKeyPem", "sealedPrivateKey"]);
const KEY_CALLS = new Set(["sign", "createSign", "createPrivateKey", "generateKeyPair", "generateKeyPairSync"]);
const SIGNING_KEY_EXPORTS = new Set(["generateGuardSigningKey", "signEs256", "GuardSigningKeyPair"]);
const ENVELOPE_PREFIX = /^[a-z]+\.v\d+\.$/;
const REGEX_ENVELOPE_PREFIX = /^[a-z]+\.v\d+\./;

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

const moduleLoaded = (node) => {
  const target = node?.type === "AwaitExpression" ? node.argument : node;
  if (target?.type === "ImportExpression") return staticString(target.source);
  if (target?.type === "CallExpression" && target.callee.type === "Identifier" && target.callee.name === "require") return staticString(target.arguments[0]);
  return undefined;
};

const namespaceTracker = (isModule, initial) => {
  const names = new Set(initial);
  const is = (node) => {
    if (node?.type === "Identifier") return names.has(node.name);
    const loaded = moduleLoaded(node);
    return loaded !== undefined && isModule(loaded);
  };
  return { names, is };
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
    const crypto = namespaceTracker((source) => CRYPTO_MODULES.has(source), ["crypto"]);
    const signing = namespaceTracker((source) => SIGNING_MODULE.test(source), []);
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
    const trackNamespace = (name, init) => {
      if (crypto.is(init)) crypto.names.add(name);
      if (signing.is(init)) signing.names.add(name);
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
          trackNamespace(node.id.name, node.init);
          return;
        }
        if (node.id.type !== "ObjectPattern") return;
        const source = crypto.is(node.init) ? "node:crypto" : signing.is(node.init) ? "@vibtra/guard-contract/signing" : undefined;
        if (source !== undefined) checkSpecifiers(source, node.id.properties, keyName);
      },
      AssignmentExpression(node) {
        if (node.left.type === "Identifier") trackNamespace(node.left.name, node.right);
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
        else if (KEY_CALLS.has(name) && crypto.is(callee.object)) report(callee, name, `crypto.${name}()`);
        else if (SIGNING_KEY_EXPORTS.has(name) && signing.is(callee.object)) report(callee, name, `${name}() from the signing module`);
      },
    };
  },
};

const isGlobalProcess = (node) =>
  node.type === "MemberExpression" && node.object.type === "Identifier" && node.object.name === "globalThis" && propertyName(node) === "process";

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
    const processes = namespaceTracker((source) => PROCESS_MODULES.has(source), ["process"]);
    const isProcess = (node) => processes.is(node) || isGlobalProcess(node);
    const report = (node) => context.report({ node, messageId: "processEnv" });
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
        if (node.init === null || node.init === undefined) return;
        if (node.id.type === "Identifier" && isProcess(node.init)) processes.names.add(node.id.name);
        if (node.id.type !== "ObjectPattern" || !isProcess(node.init)) return;
        for (const property of node.id.properties) {
          if (keyName(property) === "env") report(property);
        }
      },
      AssignmentExpression(node) {
        if (node.left.type === "Identifier" && isProcess(node.right)) processes.names.add(node.left.name);
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

export const noEnvelopePrefixLiteral = {
  meta: {
    type: "problem",
    docs: { description: "Take sealed-envelope prefixes from the sealer, never from a literal" },
    schema: [],
    messages: {
      prefix:
        "Do not hard-code the envelope prefix {{prefix}}. Read it from VaultSealer.envelopePrefix (or envelopePrefixes for every prefix a ring opens), " +
        "so a new sealer such as kms.v1. is covered without editing this file.",
    },
  },
  create(context) {
    const report = (node, prefix) => context.report({ node, messageId: "prefix", data: { prefix: JSON.stringify(prefix) } });
    const check = (node, value) => {
      if (ENVELOPE_PREFIX.test(value)) report(node, value);
    };
    return {
      Literal(node) {
        if (isConcatenation(node.parent)) return;
        if (typeof node.value === "string") check(node, node.value);
        if (node.regex !== undefined) {
          const unescaped = node.regex.pattern.replace(/^\^/, "").replaceAll("\\.", ".");
          const match = REGEX_ENVELOPE_PREFIX.exec(unescaped);
          if (match !== null) report(node, match[0]);
        }
      },
      TemplateLiteral(node) {
        if (isConcatenation(node.parent) || node.parent?.type === "TaggedTemplateExpression") return;
        check(node, shapeOf([node]));
      },
      BinaryExpression(node) {
        if (!isConcatenation(node) || isConcatenation(node.parent)) return;
        check(node, shapeOf(concatenationParts(node)));
      },
    };
  },
};
