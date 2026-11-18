const http = require("node:http");
const { Prisma } = require("@prisma/client");

const database = require("./database");

const defaultPort = 8080;
const maximumBodyBytes = 64 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJSON(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendNoContent(response) {
  response.writeHead(204);
  response.end();
}

async function readJSONBody(request) {
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    receivedBytes += chunk.length;
    if (receivedBytes > maximumBodyBytes) {
      throw new HttpError(413, "request body is too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function requireItemName(payload) {
  if (typeof payload.name !== "string" || payload.name.trim() === "") {
    throw new HttpError(400, "name is required and must be a non-empty string");
  }
  return payload.name.trim();
}

function optionalItemNote(payload) {
  if (payload.note === undefined) {
    return undefined;
  }
  if (typeof payload.note !== "string") {
    throw new HttpError(400, "note must be a string");
  }
  return payload.note;
}

function parseItemIdentifier(value) {
  const itemIdentifier = Number(value);
  if (!Number.isSafeInteger(itemIdentifier) || itemIdentifier < 1) {
    throw new HttpError(400, "item id must be a positive integer");
  }
  return itemIdentifier;
}

async function healthHandler(request, response) {
  try {
    await database.$queryRaw`SELECT 1`;
  } catch (databaseError) {
    console.error("health: database unreachable:", databaseError.message);
    return sendJSON(response, 503, { status: "error", database: "error" });
  }
  return sendJSON(response, 200, { status: "ok", database: "ok" });
}

async function plansHandler(request, response) {
  const plans = await database.plan.findMany({ orderBy: { id: "asc" } });
  return sendJSON(
    response,
    200,
    plans.map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      priceCents: plan.priceCents,
      createdAt: plan.createdAt,
    })),
  );
}

async function metaHandler(request, response) {
  const [appliedMigrations, seedState, planCount] = await Promise.all([
    database.$queryRaw`
      SELECT migration_name, finished_at
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `,
    database.seedState.findUnique({ where: { id: 1 } }),
    database.plan.count(),
  ]);
  const lastMigration = appliedMigrations[0];
  return sendJSON(response, 200, {
    lastMigration: lastMigration ? lastMigration.migration_name : null,
    lastMigrationAt: lastMigration ? lastMigration.finished_at : null,
    seedRuns: seedState ? seedState.runCount : 0,
    lastSeedAt: seedState ? seedState.lastRunAt : null,
    plans: planCount,
  });
}

async function listItemsHandler(request, response) {
  const items = await database.item.findMany({ orderBy: { id: "asc" } });
  return sendJSON(response, 200, items);
}

async function createItemHandler(request, response) {
  const payload = await readJSONBody(request);
  const item = await database.item.create({
    data: { name: requireItemName(payload), note: optionalItemNote(payload) ?? "" },
  });
  return sendJSON(response, 201, item);
}

async function readItemHandler(request, response, match) {
  const itemIdentifier = parseItemIdentifier(match[1]);
  const item = await database.item.findUnique({ where: { id: itemIdentifier } });
  if (!item) {
    return sendJSON(response, 404, { error: "item not found" });
  }
  return sendJSON(response, 200, item);
}

async function updateItemHandler(request, response, match) {
  const itemIdentifier = parseItemIdentifier(match[1]);
  const payload = await readJSONBody(request);
  const data = {};
  if (payload.name !== undefined) {
    data.name = requireItemName(payload);
  }
  const note = optionalItemNote(payload);
  if (note !== undefined) {
    data.note = note;
  }
  if (Object.keys(data).length === 0) {
    throw new HttpError(400, "at least one of name or note is required");
  }
  try {
    const item = await database.item.update({ where: { id: itemIdentifier }, data });
    return sendJSON(response, 200, item);
  } catch (updateError) {
    if (updateError instanceof Prisma.PrismaClientKnownRequestError && updateError.code === "P2025") {
      return sendJSON(response, 404, { error: "item not found" });
    }
    throw updateError;
  }
}

async function deleteItemHandler(request, response, match) {
  const itemIdentifier = parseItemIdentifier(match[1]);
  const deleted = await database.item.deleteMany({ where: { id: itemIdentifier } });
  if (deleted.count === 0) {
    return sendJSON(response, 404, { error: "item not found" });
  }
  return sendNoContent(response);
}

const routes = [
  { method: "GET", pattern: /^\/health$/, handler: healthHandler },
  { method: "GET", pattern: /^\/plans$/, handler: plansHandler },
  { method: "GET", pattern: /^\/meta$/, handler: metaHandler },
  { method: "GET", pattern: /^\/items$/, handler: listItemsHandler },
  { method: "POST", pattern: /^\/items$/, handler: createItemHandler },
  { method: "GET", pattern: /^\/items\/([0-9]+)$/, handler: readItemHandler },
  { method: "PUT", pattern: /^\/items\/([0-9]+)$/, handler: updateItemHandler },
  { method: "DELETE", pattern: /^\/items\/([0-9]+)$/, handler: deleteItemHandler },
];

function normalizePath(pathname) {
  let path = pathname.replace(/\/+$/, "");
  if (path.startsWith("/api/")) {
    path = path.slice("/api".length);
  }
  return path === "" ? "/" : path;
}

function parseRequestURL(request) {
  try {
    return new URL(request.url, "http://placeholder.invalid");
  } catch {
    throw new HttpError(400, "invalid request url");
  }
}

async function handleRequest(request, response) {
  const url = parseRequestURL(request);
  const path = normalizePath(url.pathname);
  for (const route of routes) {
    if (route.method !== request.method) {
      continue;
    }
    const match = route.pattern.exec(path);
    if (match) {
      return route.handler(request, response, match);
    }
  }
  return sendJSON(response, 404, { error: "not found" });
}

function createServer() {
  return http.createServer((request, response) => {
    handleRequest(request, response).catch((requestError) => {
      if (requestError instanceof HttpError) {
        if (requestError.status === 400) {
          console.warn(`${request.method} ${JSON.stringify(request.url)}: 400 ${requestError.message}`);
        }
        return sendJSON(response, requestError.status, { error: requestError.message });
      }
      console.error(`${request.method} ${request.url}:`, requestError);
      return sendJSON(response, 500, { error: "internal server error" });
    });
  });
}

function shutdown(server, signal) {
  console.log(`${signal}: shutting down`);
  server.close(() => {
    database.$disconnect().finally(() => process.exit(0));
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || defaultPort);
  const server = createServer();
  server.listen(port, () => {
    console.log(`listening on port ${port}`);
  });
  process.on("SIGTERM", () => shutdown(server, "SIGTERM"));
  process.on("SIGINT", () => shutdown(server, "SIGINT"));
}

module.exports = { createServer };
