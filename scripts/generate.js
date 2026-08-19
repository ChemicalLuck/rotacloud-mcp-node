// Dev-only codegen: vendor/openapi.json -> server/tools.js
// Run with `npm run generate`. Not shipped in the bundle.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "vendor/openapi.json"), "utf8"));

const METHODS = ["get", "post", "put", "delete", "patch"];

// Time fields carry Unix epoch seconds only where the spec declares them as numbers.
// `start_date`/`end_date` are YYYY-MM-DD strings and must never be coerced.
const TIME_FIELD = /(^|_)(time|start|end|timestamp)(_|$)/;

// Spec bugs: these are marked `in: body` but are plainly query parameters.
const QUERY_PARAM_FIXES = {
  "GET /leave": ["include_requested", "include_expired"],
  "GET /users": ["locations"],
};

// Tags where the `User` impersonation header changes the response.
const IMPERSONATABLE = new Set([
  "Me", "Messages", "Leave_requests", "Swap_requests", "Unavailability_requests",
]);

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const STOPWORDS = /^(a|an|the|all|for|by|and|as|to|of|their|my|s|record|records|currently|authenticated)$/;

// Names where the summary's action verb is itself a tag word, so the derived verb
// comes out empty or ambiguous ("Request leave" under the Leave_requests tag).
const NAME_OVERRIDES = {
  "POST /leave_requests": "leave_requests_create",
  "POST /swap_requests": "swap_requests_create",
  "POST /unavailability_requests": "unavailability_requests_create",
  "POST /users_clocked_in": "users_clocked_in_clock_in",
  "GET /me": "me_retrieve",
  "GET /me/ip": "me_retrieve_ip",
  "GET /settings": "settings_list",
};

/** Candidate singular forms, so `logbook_categories_create_category` collapses to `_create`. */
function singulars(word) {
  const forms = [word];
  if (word.endsWith("ies")) forms.push(`${word.slice(0, -3)}y`);
  if (/(oe|se|xe|ze|che|she)s$/.test(word)) forms.push(word.slice(0, -2));
  if (word.endsWith("s")) forms.push(word.slice(0, -1));
  return forms;
}

function toolName(tag, summary) {
  const tagSlug = slug(tag);
  const tagWords = new Set(tagSlug.split("_").flatMap(singulars));
  const verb = slug(summary)
    .split("_")
    .filter((word) => !tagWords.has(word) && !STOPWORDS.test(word))
    .join("_");
  return `${tagSlug}_${verb || "root"}`;
}

const quote = (value) => JSON.stringify(value);
const key = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
const EPOCH_HINT = "Unix epoch seconds; an ISO 8601 date-time string is also accepted.";
const describe = (schema, expr) => {
  const parts = [];
  if (schema.description) parts.push(schema.description.replace(/\.?$/, "."));
  if (expr === "EPOCH" || expr.startsWith("EPOCH")) parts.push(EPOCH_HINT);
  return parts.length ? `${expr}.describe(${quote(parts.join(" "))})` : expr;
};

/** Query and path parameters are hand-authored in the spec, so they are typed strictly. */
function paramSchema(param) {
  // The params relocated by QUERY_PARAM_FIXES carry their type under `schema`,
  // because the spec (wrongly) declares them as body params.
  const type = param.type ?? param.schema?.type;
  let expr;
  if (type === "number" || type === "integer") {
    expr = TIME_FIELD.test(param.name) ? "EPOCH" : "z.number()";
  } else if (type === "boolean") {
    expr = "z.boolean()";
  } else if (type === "array") {
    expr = "z.array(z.number())";
  } else {
    expr = "z.string()";
  }
  expr = describe(param, expr);
  return param.required ? expr : `${expr}.optional()`;
}

const isNumericKeyed = (properties) =>
  Object.keys(properties).length > 0 && Object.keys(properties).every((key) => /^\d+$/.test(key));

/**
 * Body schemas in this spec are reverse-engineered from example payloads, so they
 * under-describe reality (`final_working_date` is typed `null`; `role_rates` is keyed
 * by the example's literal role IDs). Emit them loose and all-optional.
 */
function bodySchema(schema, name = "") {
  if (!schema || typeof schema !== "object") return "z.unknown()";

  if (schema.type === "array") {
    let items;
    if (schema.items && Object.keys(schema.items).length) items = bodySchema(schema.items);
    // `items: {}` plus an "IDs of…" description means a list of numeric IDs.
    else if (/\bIDs?\b/i.test(schema.description ?? "")) items = "z.number()";
    else items = "z.unknown()";
    return describe(schema, `z.array(${items})`);
  }

  if (schema.type === "object" || schema.properties) {
    const properties = schema.properties ?? {};
    // Keys are example-derived IDs (role_rates: {"3": …}), not a fixed shape.
    if (isNumericKeyed(properties)) return describe(schema, "z.record(z.string(), z.unknown())");

    const required = new Set(schema.required ?? []);
    const fields = Object.entries(properties).map(([keyOfProp, value]) => {
      let expr = bodySchema(value, keyOfProp);
      if (!required.has(keyOfProp)) expr = `${expr}.optional()`;
      return `${INDENT_FIELD}${key(keyOfProp)}: ${expr},`;
    });
    if (!fields.length) return describe(schema, "z.record(z.string(), z.unknown())");
    return describe(schema, `z.looseObject({\n${fields.join("\n")}\n${INDENT_CLOSE}})`);
  }

  // `type: "null"` is an artefact of a null in the example payload — the field is nullable, not void.
  if (schema.type === "null") return describe(schema, "z.any().nullable()");
  if (schema.type === "boolean") return describe(schema, "z.boolean()");
  if (schema.type === "number" || schema.type === "integer") {
    return describe(schema, TIME_FIELD.test(name) ? "EPOCH" : "z.number()");
  }
  if (schema.type === "string") return describe(schema, "z.string()");
  return describe(schema, "z.unknown()");
}

const INDENT_FIELD = "        ";
const INDENT_CLOSE = "      ";

// Multi-line descriptions (those carrying an example payload) read far better as
// template literals than as one long escaped string.
const renderDescription = (text) =>
  text.includes("\n") && !/[`\\]|\$\{/.test(text) ? `\`${text}\`` : JSON.stringify(text);

const operations = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!METHODS.includes(method)) continue;
    const tag = op.tags?.[0] ?? "Misc";
    const key = `${method.toUpperCase()} ${path}`;

    const misplaced = new Set(QUERY_PARAM_FIXES[key] ?? []);
    const parameters = op.parameters ?? [];
    const pathParams = parameters.filter((p) => p.in === "path");
    const queryParams = parameters.filter((p) => p.in === "query" || misplaced.has(p.name));
    const bodyParam = parameters.find((p) => p.in === "body" && !misplaced.has(p.name));

    // Paginate exactly those operations whose 200 response is an array.
    const paginated = op.responses?.["200"]?.schema?.type === "array";

    operations.push({
      tag,
      method: method.toUpperCase(),
      path,
      summary: op.summary ?? "",
      pathParams,
      queryParams,
      bodyParam,
      paginated,
      // Only true creates plausibly accept a batch array. Action endpoints on a
      // collection ("Publish shifts", "Send a message") take one fixed object.
      isCreate: method === "post" && !path.includes("{") && /^Create\b/i.test(op.summary ?? ""),
      impersonatable: IMPERSONATABLE.has(tag),
      name: NAME_OVERRIDES[key] ?? toolName(tag, op.summary ?? `${method} ${path}`),
    });
  }
}

// Fail loudly rather than silently dropping a tool to a duplicate name.
const seen = new Map();
for (const op of operations) {
  if (seen.has(op.name)) {
    throw new Error(`Duplicate tool name ${op.name}: ${seen.get(op.name)} and ${op.method} ${op.path}`);
  }
  seen.set(op.name, `${op.method} ${op.path}`);
}

function render(op) {
  const fields = [];
  const callParts = [];

  for (const param of op.pathParams) fields.push(`      ${param.name}: ${paramSchema({ ...param, required: true })},`);
  if (op.pathParams.length) {
    callParts.push(`pathParams: { ${op.pathParams.map((p) => `${p.name}: p.${p.name}`).join(", ")} }`);
  }

  const queryEntries = op.queryParams.map((p) => `${key(p.name)}: p.${key(p.name)}`);
  for (const param of op.queryParams) fields.push(`      ${key(param.name)}: ${paramSchema(param)},`);
  if (op.paginated) {
    fields.push(`      limit: LIMIT,`);
    fields.push(`      offset: OFFSET,`);
    queryEntries.push("limit: p.limit", "offset: p.offset");
  }
  if (queryEntries.length) callParts.push(`query: { ${queryEntries.join(", ")} }`);

  if (op.bodyParam) {
    const inner = bodySchema(op.bodyParam.schema);
    // Batch variants are undocumented but plausible on creates; accept an array of the same shape.
    const isObject = inner.startsWith("z.looseObject") || inner.startsWith("z.record");
    const expr = op.isCreate && isObject ? `orBatch(${inner})` : inner;
    fields.push(`      body: ${expr}${op.bodyParam.required ? "" : ".optional()"},`);
    callParts.push("body: p.body");
  }

  if (op.impersonatable) {
    fields.push(`      as_user: AS_USER,`);
    callParts.push("asUser: p.as_user");
  }

  let description = op.summary;
  const example = op.bodyParam?.schema?.example;
  if (example !== undefined) {
    description += `\n\nExample body:\n${JSON.stringify(example, null, 2)}`;
  }

  const schema = fields.length ? `z.object({\n${fields.join("\n")}\n    })` : "z.object({})";
  const options = callParts.length ? `, { ${callParts.join(", ")} }` : "";
  return `  makeTool(${quote(op.name)}, ${renderDescription(description)},\n    ${schema},\n    (p) => rc.request(${quote(op.method)}, ${quote(op.path)}${options}));\n`;
}

const byTag = new Map();
for (const op of operations) {
  if (!byTag.has(op.tag)) byTag.set(op.tag, []);
  byTag.get(op.tag).push(op);
}

const banner = (title) => `  // ─── ${title} ${"─".repeat(Math.max(3, 74 - title.length))}`;

const sections = [...byTag.entries()].map(
  ([tag, ops]) => `${banner(tag.replace(/_/g, " "))}\n\n${ops.map(render).join("\n")}`,
);

const output = `// GENERATED by scripts/generate.js from vendor/openapi.json — do not edit by hand.
// ${operations.length} tools across ${byTag.size} RotaCloud resources.
import * as z from "zod/v4";

// Time fields declared as numbers are Unix epoch seconds; also accept an ISO 8601 string.
const EPOCH = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (/^\\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : Math.floor(ms / 1000);
}, z.number().int());

// Documented in the API overview rather than on individual operations.
const LIMIT = z.number().int().positive().optional()
  .describe("Maximum number of results to return in this page");
const OFFSET = z.number().int().nonnegative().optional()
  .describe("Index of the first result to return, for paging");
const AS_USER = z.number().int().optional()
  .describe("Act as this user ID for this request, overriding ROTACLOUD_USER_ID");

// Create endpoints are documented with a single object; accept a batch array too.
const orBatch = (schema) => z.union([schema, z.array(schema)]);

export function registerTools(makeTool, rc) {
${sections.join("\n")}}
`;

writeFileSync(join(root, "server/tools.js"), output);
console.log(`Generated server/tools.js: ${operations.length} tools across ${byTag.size} resources.`);
