"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  Menu,
  Settings,
  UserRound,
  Users,
  X,
} from "lucide-react";

import { LogoutButton } from "@/components/shared/logout-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type ProjectSidebarProps = {
  project: {
    id: string;
    name: string;
    websiteUrl: string;
    description: string;
  };
};

const NAV_ITEMS = [
  { href: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "leads", label: "Leads", icon: Users },
  { href: "settings", label: "Settings", icon: Settings },
] as const;

function BrandMark({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", collapsed && "justify-center")}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-600">
        <Activity className="size-4 text-white" strokeWidth={2.5} />
      </span>
      {!collapsed && (
        <p className="truncate text-base font-semibold tracking-tight text-white">LeadFinder</p>
      )}
    </div>
  );
}

function ProjectDetailsTrigger({
  project,
  collapsed,
  touchFriendly,
  onNavigate,
}: {
  project: ProjectSidebarProps["project"];
  collapsed: boolean;
  touchFriendly?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex w-full items-center gap-1 rounded-lg px-1 py-1.5 text-left text-sm text-neutral-200 hover:bg-white/5",
            collapsed && "justify-center px-0",
            touchFriendly && "min-h-11",
          )}
          aria-label={`${project.name} campaign details`}
        >
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
          )}
          <ChevronDown className="size-4 shrink-0 text-neutral-400" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-1.5rem)]">
        <DropdownMenuLabel className="font-normal">
          <p className="font-medium text-foreground">{project.name}</p>
          <p className="mt-0.5 break-all text-xs text-muted-foreground">{project.websiteUrl}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={`/projects/${project.id}`} onClick={onNavigate}>
            Edit campaign details
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavLinks({
  projectId,
  collapsed,
  onNavigate,
  touchFriendly,
}: {
  projectId: string;
  collapsed: boolean;
  onNavigate?: () => void;
  touchFriendly?: boolean;
}) {
  const pathname = usePathname();
  const accountActive = pathname === "/settings";

  return (
    <nav className="flex flex-1 flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const href = `/projects/${projectId}/${item.href}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
              collapsed && "justify-center px-0",
              touchFriendly && "min-h-11",
              active
                ? "bg-orange-600 text-white"
                : "text-neutral-300 hover:bg-white/5 hover:text-white",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {!collapsed && item.label}
          </Link>
        );
      })}
      <Link
        href="/settings"
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
          collapsed && "justify-center px-0",
          touchFriendly && "min-h-11",
          accountActive
            ? "bg-orange-600 text-white"
            : "text-neutral-300 hover:bg-white/5 hover:text-white",
        )}
      >
        <UserRound className="size-4 shrink-0" />
        {!collapsed && "Account"}
      </Link>
    </nav>
  );
}

function SidebarBody({
  project,
  collapsed,
  onNavigate,
  headerEnd,
  touchFriendly,
}: {
  project: ProjectSidebarProps["project"];
  collapsed: boolean;
  onNavigate?: () => void;
  headerEnd?: ReactNode;
  touchFriendly?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-4",
        touchFriendly ? "min-h-full" : "h-full min-h-0 overflow-hidden",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-2",
          headerEnd ? "justify-between" : collapsed && "justify-center",
        )}
      >
        <BrandMark collapsed={collapsed} />
        {headerEnd}
      </div>
      <ProjectDetailsTrigger
        project={project}
        collapsed={collapsed}
        touchFriendly={touchFriendly}
        onNavigate={onNavigate}
      />
      <NavLinks
        projectId={project.id}
        collapsed={collapsed}
        onNavigate={onNavigate}
        touchFriendly={touchFriendly}
      />
      <div className="mt-auto min-w-0 shrink-0">
        <LogoutButton iconOnly={collapsed} />
      </div>
    </div>
  );
}

export function ProjectSidebar({ project }: ProjectSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <div className="relative hidden h-full shrink-0 md:block">
        <aside
          className={cn(
            "flex h-full flex-col overflow-hidden border-r border-white/10 bg-neutral-900 transition-[width] duration-200 ease-out",
            collapsed ? "w-[4.5rem] px-2 py-4" : "w-60 p-4",
          )}
        >
          <SidebarBody project={project} collapsed={collapsed} />
        </aside>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-1/2 right-0 z-10 hidden size-6 -translate-y-1/2 translate-x-1/2 rounded-full border border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800 hover:text-white md:inline-flex"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronLeft className="size-3.5" />}
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b border-white/10 bg-neutral-900 px-3 py-2.5 md:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 text-neutral-200 hover:bg-white/5 hover:text-white"
              aria-label="Open menu"
            >
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="h-full max-h-dvh w-72 max-w-[100vw] overflow-y-auto border-white/10 bg-neutral-900 p-4 text-white data-[side=left]:w-72"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Navigation</SheetTitle>
            </SheetHeader>
            <SidebarBody
              project={project}
              collapsed={false}
              onNavigate={() => setMobileOpen(false)}
              touchFriendly
              headerEnd={
                <SheetClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 shrink-0 text-neutral-200 hover:bg-white/5 hover:text-white"
                    aria-label="Close menu"
                  >
                    <X />
                  </Button>
                </SheetClose>
              }
            />
          </SheetContent>
        </Sheet>
        <span className="flex size-8 items-center justify-center rounded-lg bg-orange-600">
          <Activity className="size-4 text-white" strokeWidth={2.5} />
        </span>
        <p className="truncate text-sm font-semibold text-white">{project.name}</p>
      </div>
    </>
  );
}
