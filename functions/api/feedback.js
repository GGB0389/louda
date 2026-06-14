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
const MAX_ATTACHMENTS = 6;
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
  const usageDays = String(formData.get("usage_days") || "").trim();
  const deviceInfoRaw = String(formData.get("device_info") || "").trim();
  const images = formData.getAll("images").filter(isUploadFile);
  const clientIp = getClientIp(request);

  if (!text && images.length === 0) {
    return json({ success: false, message: "请填写内容或选择图片" }, 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ success: false, message: `文本不能超过 ${MAX_TEXT_LENGTH} 字` }, 400);
  }
  if (images.length > MAX_ATTACHMENTS) {
    return json({ success: false, message: `最多上传 ${MAX_ATTACHMENTS} 张图片` }, 400);
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
    usageDays,
    imageCount: images.length,
    clientIp,
    deviceInfoRaw,
  });

  const hasToken = Boolean(env.TELEGRAM_BOT_TOKEN);
  const hasChatId = Boolean(env.TELEGRAM_CHAT_ID);

  if (!hasToken || !hasChatId) {
    return json(
      {
        success: false,
        message: "反馈服务未配置，请在 Cloudflare 设置 TELEGRAM_BOT_TOKEN 与 TELEGRAM_CHAT_ID",
        hint: {
          token: hasToken ? "ok" : "missing",
          chatId: hasChatId ? "ok" : "missing",
        },
      },
      503,
    );
  }

  let delivered = false;
  let telegramError = null;

  const telegramResult = await sendToTelegram(env, summary, images);
  delivered = telegramResult.ok;
  telegramError = telegramResult.error;

  if (env.FEEDBACK_BUCKET) {
    delivered = (await saveToR2(env, summary, images, {
      text,
      username,
      deviceId,
      appVersion,
      appType,
      appId,
      clientIp,
      deviceInfoRaw,
    })) || delivered;
  }

  if (!delivered) {
    return json(
      {
        success: false,
        message: "Telegram 推送失败，请检查 Token 与 Chat ID 是否正确",
        hint: { token: "ok", chatId: "ok", telegramError },
      },
      503,
    );
  }

  return json({ success: true, message: "提交成功，感谢反馈" });
}

export async function onRequestGet(context) {
  const { env } = context;
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || "").trim();

  let botUsername = null;
  let botError = null;
  if (token) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await response.json();
      if (data.ok) {
        botUsername = data.result?.username || null;
      } else {
        botError = data.description || "getMe failed";
      }
    } catch (error) {
      botError = String(error?.message || error);
    }
  }

  return json({
    ok: true,
    telegram: {
      token: token ? "configured" : "missing",
      chatId: chatId ? "configured" : "missing",
      chatIdLength: chatId.length,
      botUsername,
      botError,
      expectBot: "GGB0389BOT",
      expectChatId: "6761293131",
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function sendToTelegram(env, summary, images) {
  try {
    const token = String(env.TELEGRAM_BOT_TOKEN).trim();
    const chatId = String(env.TELEGRAM_CHAT_ID).trim();

    await tgRequest(token, "sendMessage", {
      chat_id: chatId,
      text: summary,
    });

    for (let i = 0; i < images.length; i += 1) {
      const image = images[i];
      const body = new FormData();
      body.append("chat_id", chatId);
      body.append("photo", image, image.name || `feedback_${i + 1}.jpg`);
      body.append("caption", images.length === 1 ? "反馈截图" : `反馈截图 ${i + 1}/${images.length}`);
      const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        body,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram sendPhoto failed: ${detail}`);
      }
    }

    return { ok: true, error: null };
  } catch (error) {
    console.error("telegram feedback failed", error);
    return { ok: false, error: String(error?.message || error) };
  }
}

function isUploadFile(item) {
  if (item instanceof File) return item.size > 0;
  if (typeof Blob !== "undefined" && item instanceof Blob) return item.size > 0;
  return false;
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
    const prefix = `feedback/${formatFeedbackTime().slice(0, 10)}/${id}`;
    const metadata = {
      ...meta,
      summary,
      createdAt: formatFeedbackTime(),
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

function formatFeedbackTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

function getClientIp(request) {
  const cfIp = String(request.headers.get("CF-Connecting-IP") || "").trim();
  if (cfIp) return cfIp;

  const realIp = String(request.headers.get("X-Real-IP") || "").trim();
  if (realIp) return realIp;

  const forwarded = String(request.headers.get("X-Forwarded-For") || "").trim();
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  return "未知";
}

function formatDeviceInfoLines(raw) {
  if (!raw) return [];
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    return ["", "📱 设备信息", raw];
  }
  if (!info || typeof info !== "object") return [];

  const fields = [
    ["device_name", "名称"],
    ["model", "型号"],
    ["manufacturer", "厂商"],
    ["brand", "品牌"],
    ["device", "设备代号"],
    ["product", "产品"],
    ["hardware", "硬件"],
    ["android", "安卓版本"],
    ["api_level", "API 等级"],
    ["system_build", "系统版本"],
    ["kernel", "内核"],
    ["cpu", "CPU"],
    ["network", "网络"],
    ["local_ip", "局域网 IP"],
    ["uptime", "开机时长"],
    ["screen", "屏幕分辨率"],
    ["density_dpi", "屏幕 DPI"],
    ["abis", "CPU 架构"],
    ["timezone", "时区"],
    ["location_status", "定位状态"],
    ["location_address", "地理位置"],
    ["location_latitude", "纬度"],
    ["location_longitude", "经度"],
    ["location_accuracy_m", "定位精度(米)"],
    ["location_provider", "定位来源"],
    ["location_maps_url", "地图链接"],
    ["usage_days", "累计使用"],
    ["app_version", "应用版本"],
    ["app_package", "包名"],
  ];

  const lines = ["", "📱 设备信息"];
  for (const [key, label] of fields) {
    let value = info[key];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    if (key === "location_status") {
      value = formatLocationStatus(value);
    }
    lines.push(`${label}：${value}`);
  }
  return lines;
}

function formatLocationStatus(value) {
  const raw = String(value).trim();
  if (raw === "ok") return "已获取";
  if (raw === "permission_denied") return "用户未授权";
  if (raw === "unavailable") return "定位不可用";
  return raw;
}

function buildSummary({ text, username, deviceId, appVersion, appType, appId, usageDays, imageCount, clientIp, deviceInfoRaw }) {
  const lines = [
    "📩 用户反馈",
    "",
    text ? `内容：\n${text}` : "内容：（仅图片）",
    "",
    `用户：${username || "未知"}`,
  ];

  if (!deviceInfoRaw) {
    lines.push(`设备码：${deviceId || "未知"}`);
    lines.push(`应用：${appType}${appVersion ? ` v${appVersion}` : ""}`);
    if (appId) lines.push(`包名：${appId}`);
    if (usageDays) lines.push(`累计使用：${usageDays} 天`);
  }

  lines.push(`公网 IP：${clientIp || "未知"}`);
  lines.push(...formatDeviceInfoLines(deviceInfoRaw));

  if (imageCount > 0) lines.push(`图片：${imageCount} 张`);
  lines.push(`时间：${formatFeedbackTime()}`);
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
