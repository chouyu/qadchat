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

/**
 * 递归移除对象中指定的 key (用于清理 provider 和 path 等路由参数)
 */
function cleanRequestBody(obj: any, keysToRemove: string[]) {
  if (typeof obj !== "object" || obj === null) return;

  if (Array.isArray(obj)) {
    obj.forEach((item) => cleanRequestBody(item, keysToRemove));
    return;
  }

  keysToRemove.forEach((key) => {
    if (key in obj) {
      delete obj[key];
    }
  });

  Object.keys(obj).forEach((key) => {
    cleanRequestBody(obj[key], keysToRemove);
  });
}

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

  // ---------------------------------------------------------
  // 关键修正 1: 过滤 URL 查询参数 (Search Params)
  // ---------------------------------------------------------
  // 这里的 provider 和 path 是被 Next.js 注入或客户端误传的，必须剔除
  const keyBlacklist = ["provider", "path", "slug"]; 
  
  req.nextUrl.searchParams.forEach((v, k) => {
    if (!keyBlacklist.includes(k)) {
      url.searchParams.set(k, v);
    }
  });

  if (req?.nextUrl?.searchParams?.get("alt") === "sse") {
    url.searchParams.set("alt", "sse");
  }

  const fetchUrl = url.toString();

  // ---------------------------------------------------------
  // 关键修正 2: 拦截 POST 请求并清洗 Body
  // ---------------------------------------------------------
  let body: BodyInit | null = req.body;
  
  if (req.method === "POST") {
    try {
      // 尝试解析 JSON，如果失败则回退到原始 body (Stream)
      const jsonBody = await req.json();
      
      // 递归清洗数据
      cleanRequestBody(jsonBody, keyBlacklist);
      
      // 重新序列化
      body = JSON.stringify(jsonBody);
    } catch (e) {
      // 如果不是 JSON (例如文件上传) 或 body 为空，忽略错误，继续使用流
      // 注意：如果 req.json() 报错，流可能已被读取，这里是一个潜在风险点
      // 但对于 Chat 接口，通常都是标准 JSON。
      console.error("[Google] Body parse/clean failed, fallback to original body", e);
      // 如果解析失败，body 变量保持为 req.body (stream)，希望它还能用
    }
  }

  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key": apiKey || "",
    },
    method: req.method,
    body: body,
    redirect: "manual",
    // @ts-ignore
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
