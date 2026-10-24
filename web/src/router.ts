import { updateSiteMetadata } from './site/metadata';
import { createRouter, createWebHistory } from "vue-router";

// App owns the session and workspaces; routes select a workspace without creating
// another authentication context. Vite's SPA mode serves index.html for deep links.
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: { render: () => null }, meta: { category: "public" } },
    ...['/explore','/features','/ai-teaching','/solutions','/help','/about','/contact','/verify-certificate','/login','/training'].map(path => ({ path, component: { render: () => null }, meta: { category: path === '/login' ? 'auth' : path === '/training' ? 'organization' : 'public' } })),
    ...["/register", "/verify-email", "/forgot-password", "/reset-password", "/accept-invitation"].map(path => ({ path, component: { render: () => null }, meta: { category: "auth", emailAction: true } })),
    { path: '/courses', redirect: {path:'/training',query:{tab:'courses'}} },
    { path: '/tasks', redirect: {path:'/training',query:{tab:'tasks'}} },
    { path: '/ai', redirect: {path:'/training',query:{tab:'ai'}} },
    { path: "/home", component: { render: () => null } },
    { path: "/account", component: { render: () => null } },
    { path: "/personal", component: { render: () => null }, meta: { category: "account" } },
    { path: "/content", component: { render: () => null } },
    { path: "/assessment", component: { render: () => null } },
    { path: "/learning", component: { render: () => null } },
    { path: "/teaching", component: { render: () => null } },
    { path: "/privacy", component: { render: () => null } },
    { path: "/console", redirect: "/console/overview" },
    { path: "/console/users/new", component: { render: () => null }, meta: { consolePage: "users", consoleMode: "create" } },
    { path: "/console/users/:resourceId/edit", component: { render: () => null }, meta: { consolePage: "users", consoleMode: "edit" } },
    { path: "/console/organizations/:resourceId/members/new", component: { render: () => null }, meta: { consolePage: "organizations", consoleMode: "create" } },
    { path: "/console/organizations/:resourceId/members/:memberId/edit", component: { render: () => null }, meta: { consolePage: "organizations", consoleMode: "edit" } },
    { path: "/console/organizations/:resourceId/invitations", component: { render: () => null }, meta: { consolePage: "organizations", consoleMode: "invitations" } },
    { path: "/console/authorizations/new", component: { render: () => null }, meta: { consolePage: "authorizations", consoleMode: "create" } },
    { path: "/console/authorizations/:resourceId/edit", component: { render: () => null }, meta: { consolePage: "authorizations", consoleMode: "edit" } },
    { path: "/console/business/:module(content|assessment|reports|safety)", component: { render: () => null }, meta: { consolePage: "business" } },
    { path: "/console/:page(overview|users|organizations|authorizations|approvals|audit|business)/:resourceId?", component: { render: () => null } },
    { path: "/:pathMatch(.*)*", component: { render: () => null }, meta: { category: "not-found" } },
  ],
});

for (const record of router.getRoutes()) {
  if (!record.meta.category)
    record.meta.category = record.path.startsWith('/console') ? 'management' : ['/account', '/privacy'].includes(record.path) ? 'account' : 'organization';
}

router.afterEach(to => updateSiteMetadata(to.path));
