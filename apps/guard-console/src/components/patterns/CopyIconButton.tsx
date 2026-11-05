import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { toastError } from "@vibtra/ui/react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const GLYPH = "absolute inset-0 size-4 transition-[opacity,scale,filter] duration-300 ease-[cubic-bezier(0.2,0,0,1)]"
const SHOWN = "scale-100 opacity-100 blur-none"
const HIDDEN = "scale-25 opacity-0 blur-[4px] motion-reduce:scale-100 motion-reduce:blur-none"

export function CopyIconButton({
  text,
  label,
  disabled,
  className,
}: {
  text: string
  label: string
  disabled?: boolean
  className?: string
}) {
  const [done, setDone] = React.useState(false)
  const timer = React.useRef<number | undefined>(undefined)

  React.useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    [],
  )

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      disabled={disabled}
      className={cn("shrink-0", className)}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true)
            if (timer.current !== undefined) window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setDone(false), 1500)
          })
          .catch(() =>
            toastError(
              "This browser would not let the page copy",
              "Select the text and copy it by hand.",
            ),
          )
      }}
    >
      <span aria-hidden className="relative inline-flex size-4">
        <CopyIcon data-slot="copy-glyph" className={cn(GLYPH, done ? HIDDEN : SHOWN)} />
        <CheckIcon data-slot="copy-glyph" className={cn(GLYPH, done ? SHOWN : HIDDEN)} />
      </span>
    </Button>
  )
}
