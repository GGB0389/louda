/**
 * Cloudflare Pages Function — 用户建议反馈
 * 路径: functions/api/feedback.js
 * 访问: https://你的域名/api/feedback
 *
 * 环境变量（Pages → Settings → Environment variables）:
 * - TELEGRAM_BOT_TOKEN  Telegram 机器人 Token（推荐，可直接收图）
 * - TELEGRAM_CHAT_ID    接收消息的 Chat ID
 *
 * 可选 R2 绑定（变量名 FEEDBACK_BUCKET）用于长期存档图片。
 */
const MAX_TEXT_LENGTH = 500;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1_500_000;

export async function onRequestPost(context) {
  const { request, env } = context;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ success: false, message: "无效的表单数据" }, 400);
  }

  const text = String(formData.get("text") || "").trim();
  const username = String(formData.get("username") || "").trim();
  const deviceId = String(formData.get("device_id") || "").trim();
  const appVersion = String(formData.get("app_version") || "").trim();
  const appType = String(formData.get("app_type") || "app").trim();
  const appId = String(formData.get("app_id") || "").trim();
  const images = formData.getAll("images").filter((item) => item instanceof File);

  if (!text && images.length === 0) {
    return json({ success: false, message: "请填写内容或选择图片" }, 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ success: false, message: `文本不能超过 ${MAX_TEXT_LENGTH} 字` }, 400);
  }
  if (images.length > MAX_IMAGES) {
    return json({ success: false, message: `最多上传 ${MAX_IMAGES} 张图片` }, 400);
  }

  for (const image of images) {
    if (image.size > MAX_IMAGE_BYTES) {
      return json({ success: false, message: "单张图片过大，请压缩后重试" }, 400);
    }
  }

  const summary = buildSummary({
    text,
    username,
    deviceId,
    appVersion,
    appType,
    appId,
    imageCount: images.length,
  });

  let delivered = false;

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    delivered = await sendToTelegram(env, summary, images);
  }

  if (env.FEEDBACK_BUCKET) {
    delivered = (await saveToR2(env, summary, images, {
      text,
      username,
      deviceId,
      appVersion,
      appType,
      appId,
    })) || delivered;
  }

  if (!delivered) {
    return json(
      {
        success: false,
        message: "反馈服务未配置，请在 Cloudflare 设置 TELEGRAM_BOT_TOKEN 与 TELEGRAM_CHAT_ID",
      },
      503,
    );
  }

  return json({ success: true, message: "提交成功，感谢反馈" });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function sendToTelegram(env, summary, images) {
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;

    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: summary,
    });

    for (let i = 0; i < images.length; i += 1) {
      const image = images[i];
      const body = new FormData();
      body.append("chat_id", chatId);
      body.append("photo", image, image.name || `feedback_${i + 1}.jpg`);
      if (i === 0 && images.length === 1) {
        body.append("caption", "反馈截图");
      } else {
        body.append("caption", `反馈截图 ${i + 1}/${images.length}`);
      }
      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        body,
      });
    }
    return true;
  } catch (error) {
    console.error("telegram feedback failed", error);
    return false;
  }
}

async function tgRequest(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telegram ${method} failed: ${detail}`);
  }
}

async function saveToR2(env, summary, images, meta) {
  try {
    const id = crypto.randomUUID();
    const prefix = `feedback/${new Date().toISOString().slice(0, 10)}/${id}`;
    const metadata = {
      ...meta,
      summary,
      createdAt: new Date().toISOString(),
      imageCount: images.length,
    };

    await env.FEEDBACK_BUCKET.put(`${prefix}/meta.json`, JSON.stringify(metadata, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });

    for (let i = 0; i < images.length; i += 1) {
      const image = images[i];
      const bytes = await image.arrayBuffer();
      await env.FEEDBACK_BUCKET.put(`${prefix}/image_${i + 1}.jpg`, bytes, {
        httpMetadata: { contentType: image.type || "image/jpeg" },
      });
    }
    return true;
  } catch (error) {
    console.error("r2 feedback failed", error);
    return false;
  }
}

function buildSummary({ text, username, deviceId, appVersion, appType, appId, imageCount }) {
  const lines = [
    "📩 用户反馈",
    "",
    text ? `内容：\n${text}` : "内容：（仅图片）",
    "",
    `用户：${username || "未知"}`,
    `设备码：${deviceId || "未知"}`,
    `应用：${appType}${appVersion ? ` v${appVersion}` : ""}`,
  ];
  if (appId) lines.push(`包名：${appId}`);
  lines.push(`图片：${imageCount} 张`);
  lines.push(`时间：${new Date().toISOString()}`);
  return lines.join("\n");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, User-Agent",
  };
}
