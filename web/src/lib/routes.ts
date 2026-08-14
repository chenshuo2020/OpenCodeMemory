export const ROUTES = {
  home: "/",
  project: "/project-memories",
  profile: "/user-profile",
  system: "/system",
} as const;

export type AppView = "project" | "profile" | "system";

export function normalizePath(pathname: string): string {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function viewFromPath(pathname: string): AppView {
  const path = normalizePath(pathname);
  if (path === ROUTES.profile) return "profile";
  if (path === ROUTES.system) return "system";
  return "project";
}

export function pathForView(view: AppView): string {
  if (view === "profile") return ROUTES.profile;
  if (view === "system") return ROUTES.system;
  return ROUTES.project;
}

export function isAppPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return (
    path === ROUTES.home ||
    path === ROUTES.project ||
    path === ROUTES.profile ||
    path === ROUTES.system
  );
}

/** Canonical app path — `/` redirects to project memories. */
export function resolveAppPath(pathname: string): string {
  const path = normalizePath(pathname);
  if (path === ROUTES.home) return ROUTES.project;
  if (path === ROUTES.project || path === ROUTES.profile || path === ROUTES.system) return path;
  return ROUTES.project;
}
