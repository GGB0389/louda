/**
 * 和平账号云端备份
 * POST   /api/account-backup  上传账号压缩包
 * GET    /api/account-backup?username=&device_id=  列出云端账号
 * GET    /api/account-backup?username=&device_id=&backup_id=&download=1  下载
 *
 * 需绑定 R2：FEEDBACK_BUCKET（与 feedback 共用）
 */
const MAX_FILE_BYTES = 5_000_000;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.FEEDBACK_BUCKET) {
    return json({ success: false, message: "云端存储未配置" }, 503);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ success: false, message: "无效的表单数据" }, 400);
  }

  const username = String(formData.get("username") || "").trim();
  const deviceId = String(formData.get("device_id") || "").trim();
  const note = String(formData.get("note") || "").trim().slice(0, 64);
  const file = formData.get("file");

  if (!username || !deviceId) {
    return json({ success: false, message: "缺少用户名或设备 SN" }, 400);
  }
  if (!isUploadFile(file)) {
    return json({ success: false, message: "请上传账号备份文件" }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ success: false, message: "备份文件过大" }, 400);
  }

  const ownerKey = buildOwnerKey(username, deviceId);
  const backupId = crypto.randomUUID();
  const fileName = "account.tar.gz";
  const bytes = await file.arrayBuffer();
  const prefix = `cloud-accounts/${ownerKey}/${backupId}`;

  await env.FEEDBACK_BUCKET.put(`${prefix}/${fileName}`, bytes, {
    httpMetadata: { contentType: "application/gzip" },
  });

  const item = {
    id: backupId,
    note: note || "云端账号",
    created_at: Date.now(),
    size_bytes: file.size || bytes.byteLength,
    file_name: fileName,
  };

  await env.FEEDBACK_BUCKET.put(`${prefix}/meta.json`, JSON.stringify(item, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  const manifest = await loadManifest(env, ownerKey);
  manifest.items = [item, ...manifest.items.filter((row) => row.id !== backupId)].slice(0, 50);
  await saveManifest(env, ownerKey, manifest);

  return json({
    success: true,
    message: "已上传到云端",
    item,
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const username = String(url.searchParams.get("username") || "").trim();
  const deviceId = String(url.searchParams.get("device_id") || "").trim();
  const backupId = String(url.searchParams.get("backup_id") || "").trim();
  const download = String(url.searchParams.get("download") || "").trim() === "1";

  if (!username || !deviceId) {
    return json({ success: false, message: "缺少用户名或设备 SN" }, 400);
  }

  if (!env.FEEDBACK_BUCKET) {
    return json({ success: false, message: "云端存储未配置" }, 503);
  }

  const ownerKey = buildOwnerKey(username, deviceId);

  if (download) {
    if (!backupId || !/^[0-9a-f-]{36}$/i.test(backupId)) {
      return text("缺少或无效的 backup_id", 400);
    }
    const fileName = "account.tar.gz";
    const objectKey = `cloud-accounts/${ownerKey}/${backupId}/${fileName}`;
    const object = await env.FEEDBACK_BUCKET.get(objectKey);
    if (!object) {
      return text("云端备份不存在", 404);
    }
    return new Response(object.body, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
        "Cache-Control": "private, max-age=3600",
        ...corsHeaders(),
      },
    });
  }

  const manifest = await loadManifest(env, ownerKey);
  return json({
    success: true,
    items: manifest.items,
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function loadManifest(env, ownerKey) {
  const key = `cloud-accounts/${ownerKey}/manifest.json`;
  const object = await env.FEEDBACK_BUCKET.get(key);
  if (!object) {
    return { items: [] };
  }
  try {
    const data = JSON.parse(await object.text());
    return { items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { items: [] };
  }
}

async function saveManifest(env, ownerKey, manifest) {
  const key = `cloud-accounts/${ownerKey}/manifest.json`;
  await env.FEEDBACK_BUCKET.put(key, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

function buildOwnerKey(username, deviceId) {
  const user = String(username || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_")
    .slice(0, 48);
  const device = String(deviceId || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 32);
  return `${user || "user"}_${device || "device"}`;
}

function isUploadFile(item) {
  if (item instanceof File) return item.size > 0;
  if (typeof Blob !== "undefined" && item instanceof Blob) return item.size > 0;
  return false;
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, User-Agent",
  };
}
