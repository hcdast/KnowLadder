import type { FileResource } from "../content/contracts";
import { CONTENT_COLLECTIONS } from "../content/contracts";
export const isCourseworkFile = (file: FileResource) =>
  String(file.owner_type) === "coursework";
export function fileOwnerCollection(file: FileResource) {
  return isCourseworkFile(file)
    ? "coursework_heads"
    : CONTENT_COLLECTIONS[file.owner_type];
}
