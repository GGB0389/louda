/**
 * 备份文件下载 — GET /api/backup?id=提交编号&file=文件名&token=可选密钥
 * 需绑定 R2：FEEDBACK_BUCKET（与 feedback 接口共用）
 *
 * 环境变量：
 * - BACKUP_DOWNLOAD_TOKEN  可选，设置后下载链接须带 ?token= 相同值
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = String(url.searchParams.get("id") || "").trim();
  const file = sanitizeFileName(String(url.searchParams.get("file") || "").trim());
  const token = String(url.searchParams.get("token") || "").trim();

  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return text("缺少或无效的备份编号 id", 400);
  }
  if (!file) {
    return text("缺少 file 参数", 400);
  }

  const requiredToken = String(env.BACKUP_DOWNLOAD_TOKEN || "").trim();
  if (requiredToken && token !== requiredToken) {
    return text("下载密钥无效", 403);
  }

  if (!env.FEEDBACK_BUCKET) {
    return text("备份存储未配置，请在 Telegram 消息附件中下载", 503);
  }

  const objectKey = `archives/${id}/${file}`;
  const object = await env.FEEDBACK_BUCKET.get(objectKey);
  if (!object) {
    return text("备份不存在或已过期", 404);
  }

  const headers = {
    "Content-Type": object.httpMetadata?.contentType || "application/gzip",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(file)}"`,
    "Cache-Control": "private, max-age=3600",
    ...corsHeaders(),
  };
  if (object.size) {
    headers["Content-Length"] = String(object.size);
  }

  return new Response(object.body, { status: 200, headers });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function sanitizeFileName(raw) {
  if (!raw) return "";
  const base = raw.split(/[/\\]/).pop() || "";
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return "";
  return base.slice(0, 128);
}

function text(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, User-Agent",
  };
}
