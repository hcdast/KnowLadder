import type { Identity } from "../session";
import type { ConsoleContext } from "../administration/types";
import { consoleBusinessModules, type ConsoleBusinessModule } from "../administration/presentation";

export type WorkspacePath = "/teaching" | "/learning" | "/training" | "/content" | "/assessment" | "/console/overview";
export interface Preference { orgId: string; workspace?: WorkspacePath }
export interface TargetOutcome { status: 403 | 404; reason: "permission" | "not-found"; userId?: string }
const workspacePaths: WorkspacePath[] = ["/teaching", "/learning", "/training", "/content", "/assessment", "/console/overview"];
const id = /^[a-f0-9]{24}$/i;
const tabs: Record<string, true> = { workbench: true, discover: true, courses: true, tasks: true, ai: true, site: true, reports: true, phase2: true, knowledge: true };

/** Only existing private routes and their consumer-owned query fields can be restored. */
export function parseReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith("/") || value.startsWith("//") || /[\\\s#]/.test(value)) return;
  const split = value.indexOf("?");
  let path = split < 0 ? value : value.slice(0, split);
  const query = new URLSearchParams(split < 0 ? "" : value.slice(split + 1));
  if (path.includes("%") || path.includes(":") || path.includes("@")) return;
  if (path === "/console") path = "/console/overview";
  const simple = ["/home", "/account", "/privacy", "/personal", ...workspacePaths];
  const consoleRoute = /^\/console\/(overview|users|organizations|authorizations|approvals|audit|business)(?:\/([a-f0-9]{24}))?$/i.test(path) ||
    /^\/console\/(users|authorizations)\/(new|[a-f0-9]{24}\/edit)$/i.test(path) ||
    /^\/console\/organizations\/[a-f0-9]{24}\/members\/(new|[a-f0-9]{24}\/edit)$/i.test(path) ||
    /^\/console\/organizations\/[a-f0-9]{24}\/invitations$/i.test(path) ||
    /^\/console\/business\/(content|assessment|reports|safety)$/.test(path);
  if (!simple.includes(path as WorkspacePath) && !consoleRoute) return;
  const keys = new Set<string>();
  const courseSlug = /^[a-z][a-z0-9-]{0,79}$/;
  for (const [key, field] of query) {
    if (keys.has(key)) return;
    keys.add(key);
    if (path === "/training" && key === "tab" && Object.hasOwn(tabs, field)) continue;
    if (path === "/personal" && ((key === "tab" && ["courses", "notes", "plan"].includes(field)) || (["course", "unit"].includes(key) && courseSlug.test(field)))) continue;
    if (/^\/console\/authorizations(?:\/new|\/[a-f0-9]{24}\/edit)?$/i.test(path) && ["user_id", "member_id"].includes(key) && id.test(field)) continue;
    if (/^\/console\/organizations\/[a-f0-9]{24}\/members\/[a-f0-9]{24}\/edit$/i.test(path) && key === "user_id" && id.test(field)) continue;
    return;
  }
  if (path === "/personal" && query.has("unit") && !query.has("course")) return;
  const suffix = query.toString();
  return path + (suffix ? `?${suffix}` : "");
}

export function readPreference(userId: string): Preference | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(`knowladder-entry:${userId}`) || "null");
    if (!value || typeof value.orgId !== "string" || !id.test(value.orgId)) return;
    return { orgId: value.orgId, ...(workspacePaths.includes(value.workspace) ? { workspace: value.workspace } : {}) };
  } catch { return; }
}
export function writePreference(userId: string, preference: Preference) {
  if (!id.test(preference.orgId)) return;
  try { localStorage.setItem(`knowladder-entry:${userId}`, JSON.stringify({ orgId: preference.orgId, ...(preference.workspace && workspacePaths.includes(preference.workspace) ? { workspace: preference.workspace } : {}) })); } catch { /* Optional convenience; never an authorization source. */ }
}

export function canUseStudentLearning(identity: Identity): boolean {
  const context = identity.context;
  return !!context && !identity.must_change_password && context.capabilities.includes("learning:self") &&
    !context.student_conflict && !context.capabilities.some(cap =>
      ["content:edit", "content:review", "assessment:manage", "assessment:review", "course:edit", "course:review", "coursework:grade", "ai:generate"].includes(cap));
}

export function availableWorkspaces(identity: Identity, consoleContext: ConsoleContext | null): WorkspacePath[] {
  if (!identity.context || identity.must_change_password) return [];
  const caps = identity.context.capabilities;
  const learn = canUseStudentLearning(identity);
  const content = learn || caps.some(cap => ["content:edit", "content:review", "content:retire", "content:revoke", "file:delete"].includes(cap));
  const training = learn || caps.some(cap => (/^(course|task|ai|site|training):/.test(cap) && cap !== "ai:assist") || ["teaching:report", "coursework:grade"].includes(cap));
  const allowed = [caps.includes("teaching:class"), learn, training, content, learn || caps.some(cap => ["assessment:manage", "assessment:review"].includes(cap)), !!consoleContext && consoleContext.actor_org_id === identity.context.org_id && consoleContext.menus.length > 0];
  return workspacePaths.filter((_, index) => allowed[index]);
}
export function targetAllowed(target: string, identity: Identity, context: ConsoleContext | null): boolean {
  const path = target.split("?")[0]!;
  if (["/home", "/account", "/privacy", "/personal"].includes(path)) return true;
  const workspaces = availableWorkspaces(identity, context);
  if (!path.startsWith("/console/")) return workspaces.includes(path as WorkspacePath);
  if (!workspaces.includes("/console/overview") || !context) return false;
  const page = path.split("/")[2]!;
  if (page === "business" && path.split("/")[3])
    return context.menus.includes("business") && consoleBusinessModules(context).includes(path.split("/")[3] as ConsoleBusinessModule);
  return page === "overview" || context.menus.includes(page as ConsoleContext["menus"][number]) ||
    (page === "users" && context.capabilities.includes("platform:govern") && !path.endsWith("/new"));
}

/** Task priority is a landing preference only; it never creates access. */
export function preferredTaskWorkspace(identity: Identity, context: ConsoleContext | null): WorkspacePath | undefined {
  const allowed = availableWorkspaces(identity, context);
  const caps = identity.context?.capabilities || [];
  const priorities: WorkspacePath[] = canUseStudentLearning(identity) && !caps.includes("teaching:class") ? ["/training", "/learning"]
    : caps.includes("content:review") && !caps.includes("content:edit") ? ["/content", "/training"]
      : caps.some(cap => ["assessment:manage", "assessment:review"].includes(cap)) && !caps.includes("course:edit") ? ["/assessment", "/teaching"]
        : caps.includes("content:edit") ? ["/content"]
          : caps.includes("teaching:class") ? ["/teaching", "/training"] : [];
  return priorities.find(path => allowed.includes(path)) || allowed[0];
}

/** A single in-memory intent, bound to the last known account, never a cached permission. */
export function createEntryCoordinator() {
  let intent: { target: string; userId?: string } | undefined;
  let lastUser: string | undefined;
  let outcome: TargetOutcome | undefined;
  let awaitingAccountLanding = false;
  return {
    get outcome() { return outcome; },
    get globalTarget() { return !!intent && ["/personal", "/account", "/privacy"].includes(intent.target.split("?")[0]!); },
    capture(target: unknown) {
      const safe = parseReturnTo(target);
      if (safe && safe !== "/home" && !outcome && !intent && !awaitingAccountLanding) intent = { target: safe, userId: lastUser };
    },
    identify(identity: Identity) {
      const userId = identity.user.id;
      const changed = !!lastUser && lastUser !== userId;
      if (changed) awaitingAccountLanding = true;
      if (intent?.userId && intent.userId !== userId) intent = undefined;
      if (outcome?.userId && outcome.userId !== userId) outcome = undefined;
      lastUser = userId;
      if (intent) intent.userId = userId;
      return changed;
    },
    reject(status: 403 | 404) {
      outcome = { status, reason: status === 403 ? "permission" : "not-found", userId: lastUser };
      intent = undefined;
      return outcome;
    },
    explicitNavigation() { intent = undefined; outcome = undefined; awaitingAccountLanding = false; },
    needsManagementContext(identity: Identity, currentTarget: string, preference: Preference | undefined, useEntryDecision: boolean) {
      if (!identity.context || identity.must_change_password || outcome) return false;
      const candidate = useEntryDecision ? intent?.target : currentTarget;
      if (candidate) return candidate.startsWith("/console");
      const businessWorkspaces = availableWorkspaces(identity, null);
      if (preference?.orgId === identity.context.org_id && preference.workspace) {
        if (preference.workspace === "/console/overview") return true;
        if (businessWorkspaces.includes(preference.workspace)) return false;
      }
      return businessWorkspaces.length === 0;
    },
    decide(identity: Identity, context: ConsoleContext | null, preference?: Preference): { target?: string; denied?: boolean } {
      this.identify(identity);
      if (identity.must_change_password || outcome) return {};
      if (intent && this.globalTarget) { const target = intent.target; intent = undefined; awaitingAccountLanding = false; return { target }; }
      if (!identity.organizations.length) { intent = undefined; awaitingAccountLanding = false; return { target: "/personal" }; }
      if (!identity.context) return {};
      awaitingAccountLanding = false;
      if (intent) {
        const target = intent.target;
        intent = undefined;
        if (targetAllowed(target, identity, context)) return { target };
        return { denied: true };
      }
      const workspaces = availableWorkspaces(identity, context);
      if (preference?.orgId === identity.context.org_id && preference.workspace && workspaces.includes(preference.workspace)) return { target: preference.workspace };
      return { target: preferredTaskWorkspace(identity, context) || "/home" };
    },
  };
}
