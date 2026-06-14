/**
 * Cloudflare Pages Function
 * 部署: 复制到 Pages 项目根目录 functions/api/verify.js
 * 访问: https://你的域名/api/verify
 */
export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ success: false, message: "Invalid JSON" }, 400);
  }

  const cardKey = String(body.card_key || "").trim();
  const deviceId = String(body.device_id || "").trim();

  if (!cardKey) {
    return json({ success: false, message: "卡密不能为空" }, 400);
  }

  if (!/^[A-Z0-9]{12}$/.test(deviceId)) {
    return json({ success: false, message: "设备 ID 格式无效（需 12 位大写字母或数字）" }, 400);
  }

  const VALID_KEYS = {
    "TEST-8888-AAAA": { days: 30 },
    "VIP-2026-DEMO": { days: 365 },
  };

  const entry = VALID_KEYS[cardKey];
  if (!entry) {
    return json({ success: false, message: "卡密无效" }, 200);
  }

  const expireAt = Date.now() + entry.days * 24 * 3600 * 1000;
  const token = crypto.randomUUID();

  return json({
    success: true,
    message: "验证成功",
    token,
    expire_at: expireAt,
    device_id: deviceId,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
