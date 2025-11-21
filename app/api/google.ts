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
    const response = await request(
      req,
      apiKey,
      authResult.useServerConfig,
      subpath,
    );
    return response;
  } catch (e) {
    console.error("[Google] 转发异常:", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;
export const runtime = "edge";

/** 调试 + 彻底根治版 request */
async function request(
  req: NextRequest,
  apiKey: string,
  useServerConfig?: boolean,
  subpath?: string,
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  // === 1. 构造 baseUrl 和 path（保持原逻辑）===
  let baseUrl = useServerConfig
    ? process.env.GOOGLE_BASE_URL || GEMINI_BASE_URL
    : GEMINI_BASE_URL;

  // 自定义 endpoint 支持（保持原样，略）
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

  // === 2. 读取并深度清洗 body ===
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch (e) {
    clearTimeout(timeoutId);
    return NextResponse.json({ error: "无法读取请求体" }, { status: 400 });
  }

  console.log("[Google] 原始收到的 body:", rawBody);

  let originalJson: any = {};
  try {
    originalJson = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    clearTimeout(timeoutId);
    return NextResponse.json({ error: "非法的 JSON" }, { status: 400 });
  }

  // 深度删除所有可能出现的 provider / path 字段（不管在第几层）
  function deepDelete(obj: any, keysToDelete: string[]) {
    if (Array.isArray(obj)) {
      obj.forEach(item => deepDelete(item, keysToDelete));
    } else if (obj && typeof obj === "object") {
      for (const key of keysToDelete) {
        delete obj[key];
      }
      for (const key of Object.keys(obj)) {
        deepDelete(obj[key], keysToDelete);
      }
    }
  }

  // 这些字段 Google 官方一个都不认，全部干掉
  const forbiddenKeys = [
    "provider",
    "path",
    "model",           // Google 用 URL 指定模型
    "stream",          // 官方用 alt=sse
    "temperature",
    "max_tokens",
    "top_p",
    "top_k",
    "options",
    "custom",
    "extra",
  ];

  deepDelete(originalJson, forbiddenKeys);

  // 额外保险：如果还有残留，直接删
  const { provider, path, model, stream, ...finalBody } = originalJson;

  console.log("[Google] 删除非法字段后发给官方的 payload:");
  console.log(JSON.stringify(finalBody, null, 2));

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey || "",
    },
    method: req.method,
    body: Object.keys(finalBody).length > 0 ? JSON.stringify(finalBody) : null,
    redirect: "manual",
    duplex: "half",
    signal: controller.signal,
  };

  try {
    const res = await fetch(fetchUrl, fetchOptions);

    // 把 Google 返回的错误也打出来，方便继续调试
    if (!res.ok) {
      const errText = await res.text();
      console.error("[Google] 官方返回错误:", res.status, errText);
    }

    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } catch (e: any) {
    console.error("[Google] fetch 异常:", e);
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}
