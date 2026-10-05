import { fail } from "../errors";
export function object(input: unknown, keys: string[]): Record<string, any> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    fail(422, "INVALID_INPUT", "请求字段不符合约定");
  return input as Record<string, any>;
}
export function text(v: unknown, max = 200, empty = false): string {
  if (
    typeof v !== "string" ||
    (!empty && !v.trim()) ||
    v.length > max ||
    /[\u0000-\u0008]/.test(v)
  )
    fail(422, "INVALID_INPUT", "文本长度或格式无效");
  return v as string;
}
export function id(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{24}$/.test(v))
    fail(422, "INVALID_ID", "资源编号须为24位小写十六进制");
  return v as string;
}
export function integer(
  v: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    fail(422, "INVALID_INPUT", "整数范围无效");
  return v as number;
}
export function date(v: unknown): Date {
  const d = new Date(text(v, 40));
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      v as string,
    ) ||
    !Number.isFinite(d.getTime())
  )
    fail(422, "INVALID_DATE", "请提供含时区的ISO时间");
  return d;
}
export function rubric(
  v: unknown,
): { key: string; title: string; weight: number }[] {
  if (!Array.isArray(v) || !v.length || v.length > 20)
    fail(422, "INVALID_RUBRIC", "请提供1至20个评分维度");
  const r = v.map((x) => {
    const o = object(x, ["key", "title", "weight"]);
    return {
      key: text(o.key, 64),
      title: text(o.title),
      weight: integer(o.weight, 0, 100),
    };
  });
  if (
    new Set(r.map((x) => x.key)).size !== r.length ||
    r.reduce((a, x) => a + x.weight, 0) !== 100
  )
    fail(422, "INVALID_RUBRIC", "评分维度不得重复且权重总和须为100");
  return r;
}
