/**
 * Tool-argument validation against each tool's inputSchema.
 *
 * Without this, an argument under the wrong name (`pullNumber` for
 * `pull_number`) was silently ignored, the handler interpolated `undefined`
 * into the request URL, and GitHub answered with a 404 that read like an auth
 * failure. Validation turns that into an InvalidParams error naming the key.
 *
 * Only the JSON Schema subset the tool definitions use is supported: type
 * (single or union), properties, required, items, enum, minimum, maximum.
 * Object schemas that declare `properties` are closed: keys outside them are
 * rejected unless the schema sets `additionalProperties: true`.
 */

export interface ArgSchema {
  type?: string | string[];
  properties?: Record<string, ArgSchema>;
  required?: string[];
  items?: ArgSchema;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

/** Folds casing and separators so `pullNumber`, `PullNumber` and `pull-number` all meet `pull_number`. */
function normalizeKey(key: string): string {
  return key.replace(/[_\-\s]/g, "").toLowerCase();
}

export function suggestKey(
  unknownKey: string,
  knownKeys: string[]
): string | undefined {
  const target = normalizeKey(unknownKey);
  return knownKeys.find((known) => normalizeKey(known) === target);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateValue(
  value: unknown,
  schema: ArgSchema,
  path: string,
  errors: string[]
): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      const hint =
        types.includes("number") &&
        typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
          ? ` (pass ${Number(value)} without quotes)`
          : "";
      errors.push(
        `\`${path}\` must be ${types.join(" or ")}, got ${describeValue(value)}${hint}`
      );
      return;
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(
      `\`${path}\` must be one of ${schema.enum
        .map((option) => JSON.stringify(option))
        .join(", ")}, got ${JSON.stringify(value)}`
    );
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`\`${path}\` must be >= ${schema.minimum}, got ${value}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`\`${path}\` must be <= ${schema.maximum}, got ${value}`);
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) =>
      validateValue(item, schema.items as ArgSchema, `${path}[${index}]`, errors)
    );
  }

  if (matchesType(value, "object") && schema.properties !== undefined) {
    validateObject(value as Record<string, unknown>, schema, `${path}.`, errors);
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: ArgSchema,
  prefix: string,
  errors: string[]
): void {
  const properties = schema.properties ?? {};
  const knownKeys = Object.keys(properties);
  const suggested = new Set<string>();

  if (schema.additionalProperties !== true) {
    for (const key of Object.keys(value)) {
      if (key in properties) continue;
      const suggestion = suggestKey(key, knownKeys);
      if (suggestion !== undefined) {
        suggested.add(suggestion);
        errors.push(
          `unknown parameter \`${prefix}${key}\`; did you mean \`${prefix}${suggestion}\`?`
        );
      } else {
        errors.push(
          `unknown parameter \`${prefix}${key}\` (accepted: ${
            knownKeys.length > 0 ? knownKeys.join(", ") : "none"
          })`
        );
      }
    }
  }

  // null on an optional key is treated as omitted: handlers already read
  // `?? default`, and clients commonly send null for "not set".
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) {
      if (suggested.has(key)) continue;
      errors.push(`missing required parameter \`${prefix}${key}\``);
    }
  }

  for (const [key, propertyValue] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema === undefined || propertyValue === null) continue;
    validateValue(propertyValue, propertySchema, `${prefix}${key}`, errors);
  }
}

/** Returns one message per problem; empty when the arguments fit the schema. */
export function validateToolArguments(
  schema: ArgSchema,
  args: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  validateObject(args, schema, "", errors);
  return errors;
}

export function formatArgumentErrors(toolName: string, errors: string[]): string {
  return `Invalid arguments for ${toolName}: ${errors.join("; ")}`;
}
