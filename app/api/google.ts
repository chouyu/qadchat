// 文件路径: app/api/google.ts

import { NextRequest, NextResponse } from "next/server";
import { GOOGLE_API_KEY } from "../../constant"; // 确认这个导入路径是否正确

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com";

async function handle(req: NextRequest) {
  const controller = new AbortController();

  try {
    // 1. 从原始请求的 URL 中提取真实的 API 路径
    // 例如: /api/google/v1beta/models/gemini-pro:streamGenerateContent
    // 提取出: v1beta/models/gemini-pro:streamGenerateContent
    const url = new URL(req.url);
    const modelPath = url.pathname.replace("/api/google/", "");

    // 2. 构造要发往 Google 的完整 URL
    const fetchUrl = `${GOOGLE_BASE_URL}/${modelPath}`;

    // 3. 克隆请求以安全地读取和修改 body
    const clonedReq = req.clone();
    const clientJson = await clonedReq.json();

    // ====================== 核心修复点 ======================
    //
    //  删除 qadchat 客户端发送的、Google API 不认识的额外字段。
    //  这正是解决 400 Bad Request 错误的关键。
    //
    // ========================================================
    delete clientJson.provider;
    delete clientJson.path;

    // 4. 准备发往 Google API 的请求
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GOOGLE_API_KEY,
      },
      body: JSON.stringify(clientJson),
      signal: controller.signal,
      // @ts-ignore
      duplex: "half", // 在 Node.js v18+ 中用于流式请求
    };

    // 5. 发送请求到真正的 Google API
    const res = await fetch(fetchUrl, fetchOptions);

    // 6. 处理 Google API 的响应
    // 如果 Google 返回错误，则将错误信息直接透传给客户端，方便调试
    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`Google API Error: ${res.status} ${res.statusText}`, errorBody);
      return new NextResponse(errorBody, {
        status: res.status,
        statusText: res.statusText,
      });
    }

    // 如果成功，将 Google API 的流式响应直接返回给客户端
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers, // 将 Google 的响应头也一并转发
    });

  } catch (error) {
    console.error("Error in Google API proxy:", error);
    if (error instanceof Error && error.name === 'AbortError') {
      return new NextResponse("Request aborted", { status: 499 });
    }
    return new NextResponse(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
}

// 导出 handle 函数，以符合 qadchat 的总路由约定
export { handle };
