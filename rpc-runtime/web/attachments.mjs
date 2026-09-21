// Pi RPC supports images and text, not native document/audio/video blocks.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const imageTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export async function readAttachments(files, existing = []) {
  const size = existing.reduce((sum, file) => sum + (file.size ?? Math.floor((file.data?.length || 0) * 3 / 4)), 0);
  if (size + files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) {
    throw new Error("Keep attachments below 5 MiB total (before base64 encoding).");
  }
  return Promise.all(files.map(async (file) => {
    const extension = file.name.split(".").pop().toLowerCase();
    const mimeType = /^image\/(png|jpeg|webp|gif)$/.test(file.type) ? file.type : (Object.hasOwn(imageTypes, extension) ? imageTypes[extension] : undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (mimeType) {
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { name: file.name, size: file.size, mimeType, data: btoa(binary) };
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { type: "file", name: file.name, size: file.size, data: btoa(binary) };
  }));
}

export function attachmentMessage(text, attachments) {
  return [text, ...attachments.filter((file) => file.type === "file").map((file) => {
    if (!file.path) throw new Error("Attachment has not been uploaded.");
    return `Attached file ${JSON.stringify(file.name)} saved at ${JSON.stringify(file.path)}. Use filesystem tools to inspect it; this is not a native model attachment.`;
  })].filter(Boolean).join("\n\n");
}

// Keep completed uploads on the original draft for safe retries, never another session.
export async function uploadAttachments(attachments, nativeId, upload, isCurrent) {
  for (const file of attachments.filter((item) => item.type === "file")) {
    if (!isCurrent()) throw new Error("Conversation changed; draft kept.");
    if (file.nativeSessionId !== nativeId) {
      const result = await upload(file.data);
      if (result.nativeSessionId !== nativeId) throw new Error("Upload conversation mismatch.");
      file.path = result.path; file.nativeSessionId = nativeId;
    }
  }
  if (!isCurrent()) throw new Error("Conversation changed; draft kept.");
}
