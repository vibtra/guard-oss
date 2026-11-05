"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "@/components/kit/cn"
import { MOBILE_BREAKPOINT } from "@/hooks/use-mobile"

export const SIDEBAR_COOKIE_NAME = "sidebar_state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_KEYBOARD_SHORTCUT = "b"
export const SIDEBAR_BRACKET_SHORTCUT = "["

const typingInto = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.closest("[role='dialog'], [role='menu'], [role='listbox']") !== null)

type SidebarState = "expanded" | "collapsed"

interface SidebarContextValue {
  state: SidebarState
  open: boolean
  setOpen: (open: boolean) => void
  isMobile: boolean
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

const NOOP_CONTEXT: SidebarContextValue = {
  state: "expanded",
  open: true,
  setOpen: () => undefined,
  isMobile: false,
  openMobile: false,
  setOpenMobile: () => undefined,
  toggleSidebar: () => undefined,
}

export function useSidebar(): SidebarContextValue {
  return React.useContext(SidebarContext) ?? NOOP_CONTEXT
}

const readCookie = (): boolean | undefined => {
  if (typeof document === "undefined") return undefined
  const hit = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SIDEBAR_COOKIE_NAME}=`))
  if (hit === undefined) return undefined
  return hit.slice(SIDEBAR_COOKIE_NAME.length + 1) !== "false"
}

const NARROW_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`
const readNarrow = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : false

export function useNarrow(): boolean {
  const [narrow, setNarrow] = React.useState(readNarrow)
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const list = window.matchMedia(NARROW_QUERY)
    const update = () => setNarrow(list.matches)
    update()
    list.addEventListener?.("change", update)
    return () => list.removeEventListener?.("change", update)
  }, [])
  return narrow
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useNarrow()
  const [own, setOwn] = React.useState<boolean>(() => readCookie() ?? defaultOpen)
  const [openMobile, setOpenMobile] = React.useState(false)
  const open = openProp ?? own

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (onOpenChange) onOpenChange(next)
      else setOwn(next)
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${next}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
    },
    [onOpenChange],
  )

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((was) => !was)
    else setOpen(!open)
  }, [isMobile, open, setOpen])

  React.useEffect(() => {
    if (!isMobile) setOpenMobile(false)
  }, [isMobile])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        toggleSidebar()
        return
      }
      if (
        event.key === SIDEBAR_BRACKET_SHORTCUT &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.defaultPrevented &&
        !typingInto(event.target) &&
        event.target instanceof Element &&
        event.target.closest("[data-slot=sidebar]") !== null
      ) {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggleSidebar])

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      state: open ? "expanded" : "collapsed",
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [open, setOpen, isMobile, openMobile, toggleSidebar],
  )

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        data-state={value.state}
        data-mobile={isMobile ? "" : undefined}
        style={{ "--sidebar-width": "var(--g-sidebar-w)", ...style } as React.CSSProperties}
        className={cn("group/sidebar-wrapper flex min-h-svh w-full", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function Sidebar({ className, children, ...props }: React.ComponentProps<"div">) {
  const { state, isMobile, openMobile, setOpenMobile } = useSidebar()
  if (isMobile) {
    return (
      <DialogPrimitive.Root open={openMobile} onOpenChange={(next) => setOpenMobile(next)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop
            data-slot="sidebar-drawer-overlay"
            className="fixed inset-0 z-50 bg-g-overlay-sheet transition-[opacity] duration-(--g-dur) ease-g data-ending-style:duration-(--g-dur-fast) data-ending-style:opacity-0 data-starting-style:opacity-0"
          />
          <DialogPrimitive.Popup
            data-slot="sidebar"
            data-state="expanded"
            data-mobile=""
            aria-label="Navigation"
            className={cn(
              "fixed inset-y-0 start-0 z-50 flex w-(--g-drawer-w) max-w-[85vw] flex-col overscroll-contain rounded-e-g-shell bg-g-page text-g-nav shadow-g-sheet outline-hidden",
              "transition-[translate,opacity] duration-(--g-dur-sheet) ease-g data-ending-style:duration-(--g-dur-exit) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:-translate-x-full data-starting-style:-translate-x-full rtl:data-ending-style:translate-x-full rtl:data-starting-style:translate-x-full",
              className,
            )}
            {...(props as object)}
          >
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    )
  }
  return (
    <div
      data-slot="sidebar-gap"
      data-state={state}
      className={cn(
        "relative h-full shrink-0 overflow-hidden bg-g-page",
        "w-(--sidebar-width) data-[state=collapsed]:w-(--g-rail-w)",
        "transition-[width] duration-(--g-dur-sheet) ease-g",
      )}
    >
      <div
        data-slot="sidebar"
        data-state={state}
        className={cn(
          "flex h-full w-(--sidebar-width) flex-col text-g-nav data-[state=collapsed]:w-(--g-rail-w)",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </div>
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn("relative flex w-full min-w-0 flex-1 flex-col bg-g-page", className)}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex shrink-0 flex-col", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("mt-auto flex shrink-0 flex-col", className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn("scrollbar-knox flex min-h-0 flex-1 flex-col overflow-auto px-2.5 pb-2", className)}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-group" role="group" className={cn("flex flex-col pt-2", className)} {...props} />
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn("flex h-[18px] items-center px-2 pb-[7px] text-12 font-medium text-g-nav box-content", className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  )
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<"li">) {
  return <li role="separator" data-slot="sidebar-separator" className={cn("h-3 shrink-0", className)} {...props} />
}

const NAV_ROW =
  "flex h-8 w-full items-center gap-2.5 overflow-hidden rounded-g-control py-1 ps-2.5 pe-2 text-start text-14 font-medium text-g-nav outline-hidden focus-knox transition-[background-color,color,box-shadow] duration-(--g-dur) ease-g hover:bg-g-tint active:bg-g-pressed data-active:bg-g-surface data-active:text-g-ink-strong data-active:shadow-g-nav data-active:[&>svg:first-child]:text-g-accent [&_svg]:size-4 [&_svg]:shrink-0 [&>span:first-of-type]:truncate"

function SidebarMenuButton({
  render,
  isActive = false,
  className,
  ref,
  ...props
}: useRender.ComponentProps<"button"> &
  React.ComponentProps<"button"> & {
    isActive?: boolean
  }) {
  return useRender({
    defaultTagName: "button",
    ref,
    props: mergeProps<"button">({ className: cn(NAV_ROW, className) }, props),
    render,
    state: {
      slot: "sidebar-menu-button",
      sidebar: "menu-button",
      active: isActive,
    },
  })
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
}
