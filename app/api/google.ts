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
    return NextResponse.json(authResult, { status: 401 });
  }

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
    return await request(req, apiKey, authResult.useServerConfig, subpath);
  } catch (e) {
    console.error("[Google] error:", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;
export const runtime = "edge";

async function request(
  req: NextRequest,
  apiKey: string,
  useServerConfig?: boolean,
  subpath?: string,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  // === 构造最终 URL ===
  let baseUrl = useServerConfig
    ? process.env.GOOGLE_BASE_URL || GEMINI_BASE_URL
    : GEMINI_BASE_URL;

  const customEndpoint = req.headers.get("x-custom-provider-endpoint") || "";
  if (customEndpoint) baseUrl = customEndpoint;
  if (!baseUrl.startsWith("http")) baseUrl = `https://${baseUrl}`;
  if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);

  let path = subpath ?? req.nextUrl.pathname.replaceAll(ApiPath.Google, "");
  if (!subpath && path.startsWith("/api/custom_")) {
    const idx = path.indexOf("/google/");
    if (idx >= 0) path = path.slice(idx + "/google/".length);
  }
  if (!path.startsWith("/")) path = "/" + path;

  const url = new URL(`${baseUrl}${path}`);
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
  if (req.nextUrl.searchParams.get("alt") === "sse") {
    url.searchParams.set("alt", "sse");
  }
  const fetchUrl = url.toString();

  // === 读取并彻底清洗 body ===
  let rawBody = "";
  try {
    rawBody = await req.text();  // 读完就丢掉原来的 stream
  } catch (e) {
    clearTimeout(timeoutId);
    return NextResponse.json({ error: "Failed to read body" }, { status: 400 });
  }

  console.log("[Google] 原始 body:", rawBody.substring(0, 500));

  let jsonBody: any = {};
  if (rawBody) {
    try {
      jsonBody = JSON.parse(rawBody);
    } catch (e) {
      clearTimeout(timeoutId);
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  // 深度删除所有非法字段
  function deepDelete(obj: any, keys: string[]) {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) return obj.forEach(o => deepDelete(o, keys));
    keys.forEach(k => delete (obj as any)[k]);
    Object.keys(obj).forEach(k => deepDelete((obj as any)[k], keys));
  }

  deepDelete(jsonBody, [
    "provider", "path", "model", "stream", "temperature",
    "max_tokens", "top_p", "top_k", "options", "extra", "custom"
  ]);

  console.log("[Google] 发送给官方的干净 payload:", JSON.stringify(jsonBody, null, 2));

  // === 关键：不再使用 req.body，自己生成干净的 body ===
  const fetchOptions: RequestInit = {
    method: req.method,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      "Cache-Control": "no-store",
    },
    body: Object.keys(jsonBody).length === 0 ? null : JSON.stringify(jsonBody),
    signal: controller.signal,
    redirect: "manual",
    duplex: "half" as const,
  };

  try {
    const res = await fetch(fetchUrl, fetchOptions);

    if (!res.ok) {
      const err = await res.text();
      console.error("[Google] 官方错误:", res.status, err);
    }

    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
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
