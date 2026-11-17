const CRYPTO_MODULES = new Set(["crypto", "node:crypto"]);
const KEY_NAMES = new Set(["privateKeyPem", "sealedPrivateKey"]);
const KEY_CALLS = new Set(["sign", "createSign", "createPrivateKey"]);
const ENVELOPE_PREFIX = /^[a-z]+\.v\d+\.$/;

const keyMaterialMessage =
  "Ask GuardSigner.sign() for a signature; never hold a private key outside LocalSigner (apps/registry/src/guard/local-signer.ts). " +
  "{{what}} is allowed only in the files listed for vibtra/no-key-material in tools/eslint/guardrails.json.";

const isRequireOf = (node) =>
  node?.type === "CallExpression" &&
  node.callee.type === "Identifier" &&
  node.callee.name === "require" &&
  node.arguments[0]?.type === "Literal" &&
  CRYPTO_MODULES.has(node.arguments[0].value);

const propertyName = (member) => {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.property.type === "Literal" && typeof member.property.value === "string") return member.property.value;
  return undefined;
};

export const noKeyMaterial = {
  meta: {
    type: "problem",
    docs: { description: "Keep private keys and raw signing inside the key modules" },
    schema: [],
    messages: { keyMaterial: keyMaterialMessage },
  },
  create(context) {
    const cryptoNamespaces = new Set(["crypto"]);
    const seen = new Set();
    const report = (node, what) => {
      const key = node.range.join(":");
      if (seen.has(key)) return;
      seen.add(key);
      context.report({ node, messageId: "keyMaterial", data: { what } });
    };
    return {
      ImportDeclaration(node) {
        if (!CRYPTO_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
            if (KEY_CALLS.has(imported)) report(specifier, `${imported} from ${node.source.value}`);
          } else {
            cryptoNamespaces.add(specifier.local.name);
          }
        }
      },
      VariableDeclarator(node) {
        if (!isRequireOf(node.init)) return;
        if (node.id.type === "Identifier") cryptoNamespaces.add(node.id.name);
        if (node.id.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          if (property.type === "Property" && property.key.type === "Identifier" && KEY_CALLS.has(property.key.name)) report(property, `${property.key.name} from ${node.init.arguments[0].value}`);
        }
      },
      Identifier(node) {
        if (KEY_NAMES.has(node.name)) report(node, node.name);
      },
      Literal(node) {
        if (typeof node.value === "string" && KEY_NAMES.has(node.value)) report(node, node.value);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === "Identifier" && callee.name === "createPrivateKey") report(callee, "createPrivateKey()");
        if (callee.type !== "MemberExpression") return;
        const name = propertyName(callee);
        if (name === "createPrivateKey") report(callee, "createPrivateKey()");
        else if (KEY_CALLS.has(name) && callee.object.type === "Identifier" && cryptoNamespaces.has(callee.object.name)) report(callee, `${callee.object.name}.${name}()`);
      },
    };
  },
};

const isProcess = (node) =>
  (node.type === "Identifier" && node.name === "process") ||
  (node.type === "MemberExpression" && node.object.type === "Identifier" && node.object.name === "globalThis" && propertyName(node) === "process");

export const noProcessEnv = {
  meta: {
    type: "problem",
    docs: { description: "Read environment variables only in the registry config" },
    schema: [],
    messages: {
      processEnv:
        "Read process.env only in apps/registry/src/config.ts (or the CLI entry). Add the variable to loadRegistryConfig and the known-variable list there, " +
        "and pass the parsed value in, so an unknown or ineffective variable is refused at boot instead of silently ignored.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (isProcess(node.object) && propertyName(node) === "env") context.report({ node, messageId: "processEnv" });
      },
      VariableDeclarator(node) {
        if (node.init === null || !isProcess(node.init) || node.id.type !== "ObjectPattern") return;
        for (const property of node.id.properties) {
          if (property.type === "Property" && property.key.type === "Identifier" && property.key.name === "env") context.report({ node: property, messageId: "processEnv" });
        }
      },
    };
  },
};

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
    const check = (node, value) => {
      if (ENVELOPE_PREFIX.test(value)) context.report({ node, messageId: "prefix", data: { prefix: JSON.stringify(value) } });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0) check(node, node.quasis[0]?.value.cooked ?? "");
      },
    };
  },
};
