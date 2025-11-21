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

  // ================= 核心修改部分 =================
  // 1. 异步克隆请求体并解析为 JSON
  // 使用 clone() 是为了防止 "body stream already read" 的错误
  const clientJson = await req.clone().json();

  // 2. 删除 qadchat 内部使用的、Google API 不认识的字段
  delete clientJson.provider;
  delete clientJson.path;
  // 也可以在这里删除其他不需要的字段，例如：
  // delete clientJson.model; 
  // delete clientJson.stream;

  // 3. 将清理后的 JSON 对象转换为字符串，作为新的请求体
  const cleanedBody = JSON.stringify(clientJson);
  // ================= 核心修改结束 =================

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      // 统一使用解析后的 apiKey（当使用服务器配置时来自环境变量，否则来自用户请求）
      "x-goog-api-key": apiKey || "",
    },
    method: req.method,
    // 3. 使用清理过的、纯净的 JSON 对象作为新的请求体
    body: cleanedBody,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

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
