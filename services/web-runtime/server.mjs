import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { createBrotliCompress, createGzip } from "node:zlib";

const root = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(process.env.YOMU_WEB_DIST_ROOT || path.join(root, "../../dist"));
const clientRoot = path.join(distRoot, "client");
const serverEntry = path.join(distRoot, "server/index.js");
const maxRequestBytes = 1024 * 1024;
let appHandlerPromise;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".svg", ".webmanifest"]);

export function safeClientPath(rawPathname, base = clientRoot) {
  if (typeof rawPathname !== "string" || !rawPathname.startsWith("/") || rawPathname.startsWith("//")) {
    throw new Error("INVALID_PATH");
  }
  for (const rawSegment of rawPathname.split("/")) {
    let segment;
    try { segment = decodeURIComponent(rawSegment); } catch { throw new Error("INVALID_PATH"); }
    if ([".", ".."].includes(segment) || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      throw new Error("INVALID_PATH");
    }
  }
  let decoded;
  try { decoded = decodeURIComponent(rawPathname); } catch { throw new Error("INVALID_PATH"); }
  const candidate = path.resolve(base, `.${decoded}`);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) throw new Error("INVALID_PATH");
  return candidate;
}

async function readLimitedBody(request) {
  const declared = Number(request.headers["content-length"] || 0);
  if (declared > maxRequestBytes) throw new Error("REQUEST_TOO_LARGE");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function copyHeaders(headers, response) {
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
  }
  if (setCookies.length) response.setHeader("set-cookie", setCookies);
}

async function serveStatic(request, response, pathname) {
  if (!["GET", "HEAD"].includes(request.method || "GET") || pathname === "/") return false;
  let candidate;
  try { candidate = safeClientPath(pathname); } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
    response.end("Bad Request");
    return true;
  }
  let metadata;
  try { metadata = await stat(candidate); } catch { return false; }
  if (!metadata.isFile()) return false;
  const etag = `"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`;
  const cacheControl = pathname.startsWith("/_app/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, { etag, "cache-control": cacheControl });
    response.end();
    return true;
  }
  const extension = path.extname(candidate).toLowerCase();
  const acceptedEncoding = String(request.headers["accept-encoding"] || "");
  const encoding = metadata.size >= 1024 && compressibleExtensions.has(extension)
    ? acceptedEncoding.includes("br") ? "br" : acceptedEncoding.includes("gzip") ? "gzip" : ""
    : "";
  const headers = {
    "content-type": contentTypes.get(path.extname(candidate).toLowerCase()) || "application/octet-stream",
    "cache-control": cacheControl,
    etag,
    vary: "Accept-Encoding",
    "x-content-type-options": "nosniff",
  };
  if (encoding) headers["content-encoding"] = encoding;
  else headers["content-length"] = metadata.size;
  response.writeHead(200, headers);
  if (request.method === "HEAD") return response.end(), true;
  const file = createReadStream(candidate).on("error", () => response.destroy());
  if (encoding === "br") file.pipe(createBrotliCompress()).pipe(response);
  else if (encoding === "gzip") file.pipe(createGzip()).pipe(response);
  else file.pipe(response);
  return true;
}

async function loadAppHandler() {
  appHandlerPromise ||= import(pathToFileURL(serverEntry).href).then(({ default: entry }) => {
    const handler = typeof entry === "function"
      ? entry
      : entry && typeof entry.fetch === "function"
        ? (request) => entry.fetch(request, undefined, { waitUntil() {}, passThroughOnException() {} })
        : null;
    if (!handler) throw new Error("Invalid Vinext server bundle");
    return handler;
  });
  return appHandlerPromise;
}

export async function handleWebRequest(request, response) {
  try {
    const rawUrl = request.url || "/";
    const rawPathname = rawUrl.split("?", 1)[0];
    if (rawPathname.startsWith("//") || rawPathname.includes("\\")) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      return response.end("Bad Request");
    }
    let pathname;
    try { pathname = new URL(rawUrl, "http://runtime.invalid").pathname; } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      return response.end("Bad Request");
    }
    if (await serveStatic(request, response, pathname)) return;
    const body = ["GET", "HEAD"].includes(request.method || "GET") ? undefined : await readLimitedBody(request);
    const webRequest = new Request(`http://runtime.invalid${rawUrl}`, {
      method: request.method,
      headers: request.headers,
      body,
    });
    const result = await (await loadAppHandler())(webRequest);
    copyHeaders(result.headers, response);
    response.statusCode = result.status;
    response.statusMessage = result.statusText;
    if (!result.body || request.method === "HEAD") return response.end();
    Readable.fromWeb(result.body).on("error", () => response.destroy()).pipe(response);
  } catch (error) {
    if (response.headersSent) return response.destroy();
    const tooLarge = error instanceof Error && error.message === "REQUEST_TOO_LARGE";
    if (!tooLarge) {
      process.stderr.write(`Yomu web request failed: ${error instanceof Error ? error.stack || error.message : "unknown error"}\n`);
    }
    response.writeHead(tooLarge ? 413 : 500, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(tooLarge ? "Payload Too Large" : "Internal Server Error");
  }
}

export async function start() {
  await loadAppHandler();
  const server = createServer(handleWebRequest);

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => process.stdout.write(`Yomu web listening on ${host}:${port}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Failed to start Yomu web"}\n`);
    process.exit(1);
  });
}
