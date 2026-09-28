import { watch } from "vue";
import { demo } from "./core";
import {
  blankResource,
  catalogue,
  type Resource,
  type ResourceType,
} from "./catalogue";

const parentVersions = new Map<string, string>();
watch(
  () => demo.epoch,
  () => parentVersions.clear(),
  { flush: "sync" },
);
export function previousResource(id: string) {
  const parentId = parentVersions.get(id);
  return parentId ? resourceById(parentId) : undefined;
}
export type Problems = Record<string, string>;
export class AdminError extends Error {
  constructor(
    message: string,
    public fields: Problems = {},
    public conflict = false,
  ) {
    super(message);
  }
}
export function copyResource(value: Resource): Resource {
  return {
    ...value,
    chapters: value.chapters.map((chapter) => ({ ...chapter })),
    options: [...value.options],
    history: [...value.history],
  };
}
export function resourceById(id: string, type?: ResourceType) {
  return catalogue.resources.find(
    (resource) => resource.id === id && (!type || resource.type === type),
  );
}
function writable() {
  if (demo.role !== "editor")
    throw new AdminError(
      "仅内容编辑身份可以创建或修改草稿。请使用顶部演示身份切换。",
    );
  if (demo.fault === "offline")
    throw new AdminError(
      "模拟网络中断：本次操作未保存，页面草稿仍保留。切换正常流程后重试。",
    );
}
function current(id: string, revision: number, type?: ResourceType) {
  const resource = resourceById(id, type);
  if (!resource)
    throw new AdminError("资源不存在或已随演示重置，请返回工作台。");
  if (resource.revision !== revision || demo.fault === "conflict")
    throw new AdminError(
      "版本冲突：此预览不是最新 revision，请重新加载或明确保留本地草稿。",
      {},
      true,
    );
  return resource;
}
export function validateResource(resource: Resource): Problems {
  const errors: Problems = {};
  if (!resource.title.trim()) errors.title = "请填写内容标题。";
  if (!resource.source.trim()) errors.source = "请填写来源及授权说明。";
  if (!resource.authorized) errors.authorized = "必须确认拥有有效授权。";
  if (resource.fileStatus !== "ready")
    errors.fileStatus =
      "资源必须处于 ready 状态；pending / quarantined / deleting 不可送审或发布。";
  if (resource.type === "textbook") {
    if (!resource.chapters.length) errors.chapters = "至少添加一个章节。";
    const ids = new Set<string>();
    resource.chapters.forEach((chapter, index) => {
      for (const field of ["id", "title", "body", "knowledge"] as const)
        if (!chapter[field].trim())
          errors[`chapter-${index}-${field}`] =
            `第 ${index + 1} 章的${{ id: "章节 ID", title: "标题", body: "正文", knowledge: "知识关联" }[field]}不能为空。`;
      if (ids.has(chapter.id))
        errors[`chapter-${index}-id`] = "章节 ID 不可重复。";
      ids.add(chapter.id);
    });
  } else {
    if (!resource.prompt.trim()) errors.prompt = "请填写题干。";
    if (!resource.knowledge.trim()) errors.knowledge = "请关联知识点。";
    if (!resource.explanation.trim()) errors.explanation = "请填写答案解析。";
    const answer = resource.correctAnswer.trim();
    if (resource.questionType === "numeric") {
      if (!answer || !Number.isFinite(Number(answer)))
        errors.correctAnswer = "数值题答案必须是有效的有限数字。";
    } else {
      if (resource.options.length < 2 || resource.options.length > 6)
        errors.options = "选择题需要 2–6 个选项。";
      resource.options.forEach((option, index) => {
        if (!option.trim())
          errors[`option-${index}`] =
            `请填写选项 ${String.fromCharCode(65 + index)}。`;
      });
      const letters = answer
        .toUpperCase()
        .split(",")
        .map((value) => value.trim());
      if (
        !answer ||
        new Set(letters).size !== letters.length ||
        letters.some(
          (value) =>
            !/^[A-F]$/.test(value) ||
            value.charCodeAt(0) - 65 >= resource.options.length,
        ) ||
        (resource.questionType === "single" && letters.length !== 1) ||
        (resource.questionType === "multiple" && letters.length < 2)
      )
        errors.correctAnswer =
          "单选填写一个选项字母，多选至少两个字母并用英文逗号分隔，且必须对应现有选项。";
    }
  }
  return errors;
}
export function createResource(type: ResourceType, original?: Resource) {
  writable();
  const resource = original
    ? {
        ...copyResource(original),
        id: crypto.randomUUID(),
        version: original.version + 1,
        status: "draft" as const,
        author: demo.role,
        revision: 1,
        notes: "",
        history: [
          `从 ${original.id} / v${original.version} 复制创建新草稿；原版本保持不变。`,
        ],
      }
    : blankResource(type);
  if (original) parentVersions.set(resource.id, original.id);
  catalogue.resources.push(resource);
  return copyResource(resource);
}
export function saveResource(draft: Resource, revision: number) {
  writable();
  const stored = current(draft.id, revision, draft.type);
  if (stored.status !== "draft")
    throw new AdminError("审核中和已发布版本不可编辑。请退回或创建新版本。");
  if (!draft.title.trim())
    throw new AdminError("保存失败，请修正标记的字段。", {
      title: "请填写内容标题。",
    });
  const saved = {
    ...copyResource(draft),
    author: stored.author,
    status: stored.status,
    revision: stored.revision + 1,
    history: [
      ...stored.history,
      `内容编辑保存草稿 · revision ${stored.revision + 1}`,
    ],
  };
  saved.correctAnswer =
    saved.questionType === "numeric"
      ? saved.correctAnswer.trim()
      : saved.correctAnswer
          .toUpperCase()
          .split(",")
          .map((value) => value.trim())
          .sort()
          .join(",");
  if (saved.questionType === "numeric") saved.options = [];
  catalogue.resources.splice(catalogue.resources.indexOf(stored), 1, saved);
  return copyResource(saved);
}
export function submitResource(id: string, revision: number) {
  writable();
  const stored = current(id, revision);
  if (stored.status !== "draft") throw new AdminError("仅草稿可以送审。");
  const fields = validateResource(stored);
  if (Object.keys(fields).length)
    throw new AdminError("送审校验未通过，请返回编辑页修正。", fields);
  stored.status = "review";
  stored.revision++;
  stored.history.push(`内容编辑送审 · revision ${stored.revision} · 内容冻结`);
  return copyResource(stored);
}
export function reviewResource(
  id: string,
  type: ResourceType,
  revision: number,
  action: "publish" | "return",
  reason: string,
) {
  if (demo.role !== "reviewer")
    throw new AdminError("仅内容审核身份可审核。请使用顶部演示身份切换。");
  if (demo.fault === "offline")
    throw new AdminError("模拟网络中断：审核操作未生效。");
  const stored = current(id, revision, type);
  if (stored.author === demo.role)
    throw new AdminError("禁止自审：审核者不能审核自己创建的版本。");
  if (stored.status !== "review")
    throw new AdminError("仅待审核版本可以执行审核。请重新预览当前版本。");
  if (action === "return" && !reason.trim())
    throw new AdminError("请填写退回原因。", { reason: "退回原因必填。" });
  if (action === "publish") {
    const fields = validateResource(stored);
    if (Object.keys(fields).length)
      throw new AdminError(
        "发布校验未通过；请退回编辑修正，不能绕过校验。",
        fields,
      );
  }
  stored.status = action === "publish" ? "published" : "draft";
  stored.revision++;
  stored.notes = reason.trim();
  stored.history.push(
    `内容审核${action === "publish" ? "发布" : "退回"} · revision ${stored.revision}${reason.trim() ? ` · ${reason.trim()}` : ""}`,
  );
  return copyResource(stored);
}
export function simulateRemoteChange(id: string) {
  const stored = resourceById(id);
  if (!stored || stored.status === "published" || stored.status === "retired")
    throw new AdminError("已发布版本不可模拟原地修改。请先创建新版本。");
  stored.revision++;
  stored.notes = "模拟另一位协作者更新了此版本，请重新核对内容。";
  stored.history.push(`模拟协作者更新 · revision ${stored.revision}`);
}
