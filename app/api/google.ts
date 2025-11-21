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

  // ---------- 1. 拼装请求 URL ----------
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

  // ---------- 2. 读取并清洗请求体 ----------
  let rawBody = "";
  try {
    rawBody = await req.text(); // 读完后原来的 req.body 就失效了
  } catch (e) {
    clearTimeout(timeoutId);
    return NextResponse.json({ error: "Failed to read body" }, { status: 400 });
  }

  console.log("[Google Debug] 原始 body:", rawBody.slice(0, 500));

  let jsonBody: any = {};
  if (rawBody) {
    try {
      jsonBody = JSON.parse(rawBody);
    } catch (e) {
      clearTimeout(timeoutId);
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  // 深度删除 Google 官方不认识的所有字段（不管在哪一层）
  const deepDelete = (obj: any, keys: string[]): void => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => deepDelete(item, keys));
      return;
    }
    keys.forEach((k) => delete (obj as any)[k]);
    Object.keys(obj).forEach((k) => deepDelete((obj as any)[k], keys));
  };

  deepDelete(jsonBody, [
    "provider",
    "path",
    "model",
    "stream",
    "temperature",
    "max_tokens",
    "top_p",
    "top_k",
    "options",
    "extra",
    "custom",
  ]);

  console.log("[Google Debug] 发送给官方的干净 payload:");
  console.log(JSON.stringify(jsonBody, null, 2));

  // ---------- 3. 真正发起请求 ----------
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
      console.error("[Google] 官方返回错误:", res.status, err);
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
