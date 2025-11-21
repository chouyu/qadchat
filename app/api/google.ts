// 文件路径: app/api/google/route.ts
// 这是一个临时的调试文件

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    // 1. 克隆请求，安全地读取其内容
    const clonedReq = req.clone();
    const bodyAsJson = await clonedReq.json();

    // 2. 在服务器的控制台打印出完整的 JSON 对象
    // JSON.stringify(value, replacer, space) 的第三个参数 '2' 是为了格式化输出，方便阅读
    console.log("================= RECEIVED PAYLOAD START =================");
    console.log(JSON.stringify(bodyAsJson, null, 2));
    console.log("================== RECEIVED PAYLOAD END ==================");

    // 3. 返回一个临时的成功响应，这样前端不会报错，我们只需要关注服务器日志
    return NextResponse.json({
      message: "Payload received and logged to server console. Check your terminal.",
      payload: bodyAsJson, // 也可以在浏览器的网络请求中看到结构
    });

  } catch (error) {
    console.error("Error reading or parsing JSON body:", error);
    return NextResponse.json(
      { error: "Failed to parse request body." },
      { status: 400 }
    );
  }
}
