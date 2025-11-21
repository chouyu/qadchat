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

  // 获取 API Key（优先使用服务端配置）
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

/** 修复后的核心转发函数 */
async function request(
  req: NextRequest,
  apiKey: string,
  useServerConfig?: boolean,
  subpath?: string,
) {
  const controller = new AbortController();

  // —— 自定义 endpoint 支持（保持原逻辑不变）——
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

  let baseUrl = customEndpoint
    ? customEndpoint
    : useServerConfig
      ? process.env.GOOGLE_BASE_URL || GEMINI_BASE_URL
      : GEMINI_BASE_URL;

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

  const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  if (!path.startsWith("/")) path = "/" + path;

  const url = new URL(`${baseUrl}${path}`);
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));
  if (req?.nextUrl?.searchParams?.get("alt") === "sse") {
    url.searchParams.set("alt", "sse");
  }
  const fetchUrl = url.toString();

  // —— 关键修复：只转发 Google 官方认可的字段 —— 
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch (e) {
    clearTimeout(timeoutId);
    return NextResponse.json({ error: "Failed to read request body" }, { status: 400 });
  }

  let jsonBody: any = {};
  if (rawBody) {
    try {
      jsonBody = JSON.parse(rawBody);
    } catch (e) {
      clearTimeout(timeoutId);
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
  }

  // 删除 Google 官方完全不认识的所有字段
  const {
    provider,
    path: _path,      // 避免变量名冲突
    model,
    temperature,
    max_tokens,
    top_p,
    top_k,
    stream,           // 官方用 ?alt=sse 控制流式，不需要这个字段
    // 如有其他想删的字段继续加在这里
    ...geminiBody
  } = jsonBody;

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key": apiKey || "",
    },
    method: req.method,
    body: Object.keys(geminiBody).length > 0 ? JSON.stringify(geminiBody) : null,
    redirect: "manual",
    // @ts-ignore - Edge runtime 需要这个
    duplex: "half",
    signal: controller.signal,
  };

  try {
    const res = await fetch(fetchUrl, fetchOptions);

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
