import { ExternalLinkIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export function DocsIconLink({
  href,
  label,
  destination,
  className,
}: {
  href: string
  label: string
  destination?: string
  className?: string
}) {
  return (
    <a
      data-slot="docs-icon-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`${destination ?? label}, opens in a new tab`}
      className={cn(
        "focus-knox inline-flex items-center gap-1 rounded-sm text-link outline-hidden hover:underline",
        className,
      )}
    >
      {label}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
    </a>
  )
}
