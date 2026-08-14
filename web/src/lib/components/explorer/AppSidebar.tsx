import type { MouseEvent } from "react";
import { Folder, Languages, Moon, Settings, Sun, User, X } from "lucide-react";
import { GithubIcon } from "$lib/components/icons/GithubIcon";
import { Button } from "$lib/components/ui/button";
import { Separator } from "$lib/components/ui/separator";
import { navigate, ROUTES, type AppView } from "$lib/router";
import { toggleTheme, useTheme } from "$lib/theme";
import { cn } from "$lib/utils";

type Props = {
  open?: boolean;
  currentView: AppView;
  brand: string;
  projectLabel: string;
  profileLabel: string;
  systemLabel: string;
  langLabel: string;
  languageLabel: string;
  themeLabel: string;
  closeLabel: string;
  onOpenChange?: (open: boolean) => void;
  onLangToggle?: () => void;
};

export function AppSidebar({
  open = false,
  currentView,
  brand,
  projectLabel,
  profileLabel,
  systemLabel,
  langLabel,
  languageLabel,
  themeLabel,
  closeLabel,
  onOpenChange,
  onLangToggle,
}: Props) {
  const theme = useTheme();
  const isDark = theme === "dark";

  function setOpen(next: boolean) {
    onOpenChange?.(next);
  }

  function onNavClick(event: MouseEvent, to: string) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
    setOpen(false);
  }

  function navClass(active: boolean) {
    return cn(
      "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors",
      active
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
    );
  }

  return (
    <>
      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          aria-label={closeLabel}
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "inset-y-0 start-0 z-50 flex h-svh w-64 shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform duration-200",
          "fixed md:sticky md:top-0 md:translate-x-0!",
          open ? "translate-x-0" : "max-md:-translate-x-full max-md:rtl:translate-x-full"
        )}
      >
        <div className="flex items-center gap-2 px-4 py-4">
          <a
            href={ROUTES.home}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg transition-colors hover:opacity-90"
            onClick={(e) => onNavClick(e, ROUTES.home)}
          >
            <img
              src="/opencode-mem-icon.png"
              alt=""
              width={20}
              height={20}
              className="size-5 shrink-0 rounded-sm"
            />
            <span className="truncate text-sm font-medium tracking-wide text-sidebar-primary">
              {brand}
            </span>
          </a>
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden shrink-0"
            onClick={() => setOpen(false)}
            aria-label={closeLabel}
          >
            <X className="size-4" />
          </Button>
        </div>

        <Separator className="bg-sidebar-border" />

        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Main">
          <a
            href={ROUTES.project}
            className={navClass(currentView === "project")}
            aria-current={currentView === "project" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.project)}
          >
            <Folder className="size-4 shrink-0" />
            <span className="truncate text-start">{projectLabel}</span>
          </a>
          <a
            href={ROUTES.profile}
            className={navClass(currentView === "profile")}
            aria-current={currentView === "profile" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.profile)}
          >
            <User className="size-4 shrink-0" />
            <span className="truncate text-start">{profileLabel}</span>
          </a>
          <a
            href={ROUTES.system}
            className={navClass(currentView === "system")}
            aria-current={currentView === "system" ? "page" : undefined}
            onClick={(e) => onNavClick(e, ROUTES.system)}
          >
            <Settings className="size-4 shrink-0" />
            <span className="truncate text-start">{systemLabel}</span>
          </a>
        </nav>

        <div className="mt-auto p-3">
          <div className="flex w-full items-center rounded-lg border border-sidebar-border/80 bg-card/70">
            <button
              type="button"
              className="group flex min-w-0 flex-1 items-center gap-2 rounded-s-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={onLangToggle}
              aria-label={languageLabel}
              title={languageLabel}
            >
              <Languages className="size-3.5 shrink-0" />
              <span className="truncate">{languageLabel}</span>
              <span className="ms-auto text-xs tabular-nums">{langLabel}</span>
            </button>
            <button
              type="button"
              className="inline-flex items-center self-stretch border-s border-sidebar-border px-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={() => toggleTheme()}
              aria-label={themeLabel}
              title={themeLabel}
            >
              {isDark ? (
                <Moon className="size-4 rounded-md p-0.5" />
              ) : (
                <Sun className="size-4 rounded-md p-0.5" />
              )}
            </button>
            <a
              href="https://github.com/tickernelz/opencode-mem"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center self-stretch rounded-e-lg border-s border-sidebar-border px-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              title="GitHub"
              aria-label="GitHub"
            >
              <GithubIcon className="size-4" />
            </a>
          </div>
        </div>
      </aside>
    </>
  );
}
