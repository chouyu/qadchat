import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { ApiPath, GEMINI_BASE_URL, ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

export async function handle(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } },
) {
  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  // 获取API密钥（优先使用服务器配置）
  let apiKey = "";
  if (authResult.useServerConfig) {
    apiKey = process.env.GOOGLE_API_KEY || "";
  } else {
    const bearToken =
      req.headers.get("x-goog-api-key") ||
      req.headers.get("Authorization") ||
      "";
    apiKey = bearToken.trim().replaceAll("Bearer ", "").trim();
  }

  const subpath = params.path.join("/");

  try {
    const response = await request(
      req,
      apiKey,
      authResult.useServerConfig,
      subpath,
      params // Pass params to request function
    );
    return response;
  } catch (e) {
    console.error("[Google] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;

export const runtime = "edge";
export const preferredRegion = [
  "bom1",
  "cle1",
  "cpt1",
  "gru1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
];

async function request(
  req: NextRequest,
  apiKey: string,
  useServerConfig?: boolean,
  subpath?: string,
  params?: { provider: string; path: string[] } // Receive params
) {
  const controller = new AbortController();

  // 解析自定义服务商配置（如有）
  const configHeader = req.headers.get("x-custom-provider-config");
  let customEndpoint = req.headers.get("x-custom-provider-endpoint") || "";
  let customApiKey = req.headers.get("x-custom-provider-api-key") || "";
  if (!customEndpoint && configHeader) {
    try {
      const decoded = atob(configHeader);
      const uint8Array = new Uint8Array(
        decoded.split("").map((c) => c.charCodeAt(0)),
      );
      const json = new TextDecoder().decode(uint8Array);
      const cfg = JSON.parse(json || "{}");
      customEndpoint = cfg?.endpoint || customEndpoint;
      customApiKey = cfg?.apiKey || customApiKey;
    } catch {}
  }

  // 允许自定义 endpoint 覆盖（已在上方读取到 customEndpoint）
  let baseUrl = customEndpoint
    ? customEndpoint
    : useServerConfig
      ? process.env.GOOGLE_BASE_URL || GEMINI_BASE_URL
      : GEMINI_BASE_URL;

  // 计算子路径：优先使用路由参数，其次从 URL 中截取
  let path =
    subpath ?? `${req.nextUrl.pathname}`.replaceAll(ApiPath.Google, "");
  if (!subpath && path.startsWith("/api/custom_")) {
    const idx = path.indexOf("/google/");
    if (idx >= 0) {
      path = path.slice(idx + "/google/".length);
    }
  }

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  if (!path.startsWith("/")) {
    path = "/" + path;
  }
  const url = new URL(`${baseUrl}${path}`);
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
  if (req?.nextUrl?.searchParams?.get("alt") === "sse") {
    url.searchParams.set("alt", "sse");
  }
  const fetchUrl = url.toString();

  // Modify request body
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    try {
      // Clone the request to avoid consuming the original body
      const clientJson = await req.clone().json();

      // Recursive function to remove fields
      function removeFields(obj: any, path: string = '') { // Add path parameter
        for (const key in obj) {
          const currentPath = path ? `${path}.${key}` : key; // Build path string
          if (key === 'provider' || key === 'path') {
            console.log(`[DEBUG] Removing property: ${currentPath}`); // Log removal
            delete obj[key];
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            removeFields(obj[key], currentPath); // Recursive call with path
          }
        }
      }

      try {
        // Clone the request to avoid consuming the original body
        const clientJson = await req.clone().json();
      
        console.log("[DEBUG] Original JSON:", JSON.stringify(clientJson)); // Log original JSON
      
        removeFields(clientJson);
      
        console.log("[DEBUG] Cleaned JSON:", JSON.stringify(clientJson)); // Log cleaned JSON
      
        // Convert the cleaned JSON object to a string
        const cleanedBody = JSON.stringify(clientJson);
      
        // Update fetchOptions with the cleaned body
        fetchOptions.body = cleanedBody;
      
        console.log("[DEBUG] fetchOptions:", fetchOptions); // Log fetchOptions
      
      } catch (error) {
        // If the body is not JSON, use the original body
        console.warn("Request body is not JSON, using original body", error);
        console.error("[DEBUG] Error parsing JSON:", error); // Log error details
        fetchOptions.body = req.body;
      }
      // Convert the cleaned JSON object to a string
      const cleanedBody = JSON.stringify(clientJson);

      // Update fetchOptions with the cleaned body
      fetchOptions.body = cleanedBody;
    } catch (error) {
      // If the body is not JSON, use the original body
      console.warn("Request body is not JSON, using original body", error);
      fetchOptions.body = req.body;
    }
  }

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
