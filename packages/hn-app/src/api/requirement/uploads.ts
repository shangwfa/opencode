import { requirementApiFetch, requirementApiBase, errorFromJson } from "./client";
import { uploadOssFile } from "./ossUpload";
import { uuid } from "@/utils/uuid";

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("无法读取文件"));
      }
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export async function uploadEditorImageDataUrl(
  imageBase64: string,
): Promise<string> {
  const res = await requirementApiFetch(
    `${requirementApiBase}/uploads/editor-image`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64 }),
    },
  );
  const data = (await res.json()) as { url?: string; error?: string };
  if (!res.ok) {
    throw new Error(errorFromJson(data, "图片上传失败"));
  }
  if (!data.url) {
    throw new Error("上传成功但未返回地址");
  }
  return data.url;
}

export async function uploadEditorImage(file: File): Promise<string> {
  const imageBase64 = await readFileAsDataURL(file);
  return uploadEditorImageDataUrl(imageBase64);
}

export async function uploadEditorImageFromRemoteUrl(
  imageUrl: string,
): Promise<string> {
  const res = await requirementApiFetch(
    `${requirementApiBase}/uploads/editor-image-from-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: imageUrl }),
    },
  );
  const data = (await res.json()) as { url?: string; error?: string };
  if (!res.ok) {
    throw new Error(errorFromJson(data, "远程图片上传失败"));
  }
  if (!data.url) {
    throw new Error("上传成功但未返回地址");
  }
  return data.url;
}

export async function uploadAttachmentFile(file: File): Promise<string> {
  const safeName = file.name.replace(/[^\w.-]/g, "_") || "file";
  const key = `chat-attachments/${uuid()}/${safeName}`;
  const result = await uploadOssFile({
    key,
    file,
    name: file.name,
    type: file.type || undefined,
  });
  return result.linkUrl;
}
