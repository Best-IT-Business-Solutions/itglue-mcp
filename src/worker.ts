/**
 * Cloudflare Worker entry point for IT Glue MCP Server.
 *
 * Exports a default fetch handler so Wrangler recognises this as an
 * ES Module format Worker, which is required for nodejs_compat.
 */

import { createMcpServer } from "./index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

/**
 * Adapt a Workers Request into a minimal Node.js IncomingMessage
 * that StreamableHTTPServerTransport.handleRequest() can consume.
 */
async function toNodeRequest(request: Request): Promise<IncomingMessage> {
  const url = new URL(request.url);
  const body = await request.text();

  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = {};
  request.headers.forEach((value, key) => {
    req.headers[key.toLowerCase()] = value;
  });

  // Push body data so the transport can read it
  req.push(body);
  req.push(null);

  return req;
}

/**
 * Wrap a Workers-style response collector around a Node.js ServerResponse.
 * Returns a promise that resolves to a Workers Response once the response is finished.
 */
function createNodeResponse(): { res: ServerResponse; promise: Promise<Response> } {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  const res = new ServerResponse(req);

  const promise = new Promise<Response>((resolve) => {
    const chunks: Buffer[] = [];
    let statusCode = 200;
    let headers: Record<string, string> = {};

    // Capture writeHead
    const originalWriteHead = res.writeHead.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.writeHead = function (code: number, ...args: any[]) {
      statusCode = code;
      // writeHead can be called as (code, headers) or (code, statusMessage, headers)
      const hdrs = typeof args[0] === "object" ? args[0] : args[1];
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      return originalWriteHead(code, ...args);
    };

    // Capture writes
    const originalWrite = res.write.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.write = function (chunk: any, ...args: any[]) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return originalWrite(chunk, ...args);
    };

    const originalEnd = res.end.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.end = function (chunk?: any, ...args: any[]) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString();
      resolve(new Response(body, { status: statusCode, headers }));
      return originalEnd(chunk, ...args);
    };
  });

  return { res, promise };
}

export default {
  async fetch(request: Request, env: Record<string, string | undefined>): Promise<Response> {
    const url = new URL(request.url);

    // Map worker env bindings to process.env so getCredentialsFromEnv() works
    if (env.ITGLUE_API_KEY) process.env.ITGLUE_API_KEY = env.ITGLUE_API_KEY;
    if (env.X_API_KEY) process.env.X_API_KEY = env.X_API_KEY;
    if (env.ITGLUE_REGION) process.env.ITGLUE_REGION = env.ITGLUE_REGION;
    if (env.ITGLUE_BASE_URL) process.env.ITGLUE_BASE_URL = env.ITGLUE_BASE_URL;

    // Health endpoint
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          transport: "cloudflare-worker",
          timestamp: new Date().toISOString(),
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // MCP endpoint – accept GET (SSE), POST (RPC), and DELETE (session close)
    if (url.pathname === "/mcp") {
      if (!["GET", "POST", "DELETE"].includes(request.method)) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          }),
          { status: 405, headers: { "Content-Type": "application/json" } }
        );
      }

      // Gateway-mode credentials from headers
      const apiKey =
        request.headers.get("x-itglue-api-key") ||
        request.headers.get("x-api-key");
      if (apiKey) process.env.ITGLUE_API_KEY = apiKey;

      const baseUrl = request.headers.get("x-itglue-base-url");
      if (baseUrl) {
        try {
          const parsed = new URL(baseUrl);
          if (parsed.protocol !== "https:" || !parsed.hostname.endsWith("itglue.com")) {
            return new Response(
              JSON.stringify({ error: "Invalid base URL. Must be an HTTPS itglue.com domain." }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
          process.env.ITGLUE_BASE_URL = baseUrl;
        } catch {
          return new Response(
            JSON.stringify({ error: "Invalid base URL format." }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      const VALID_REGIONS = ["us", "eu", "au"];
      const region = request.headers.get("x-itglue-region");
      if (region) {
        if (!VALID_REGIONS.includes(region)) {
          return new Response(
            JSON.stringify({ error: `Invalid region. Must be one of: ${VALID_REGIONS.join(", ")}` }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }
        process.env.ITGLUE_REGION = region;
      }

      try {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        await server.connect(transport as unknown as Transport);

        const nodeReq = await toNodeRequest(request);
        const { res: nodeRes, promise: responsePromise } = createNodeResponse();

        await transport.handleRequest(nodeReq, nodeRes);

        const response = await responsePromise;

        transport.close();
        await server.close();

        return response;
      } catch (err) {
        console.error("MCP transport error:", err);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 404 for everything else
    return new Response(
      JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  },
};
