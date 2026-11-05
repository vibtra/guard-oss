import { cva, type VariantProps } from "class-variance-authority"
import {
  Button as SharedButton,
  buttonVariants as shared,
  type ButtonProps as SharedButtonProps,
} from "@vibtra/ui/react"

import { cn } from "@/lib/utils"

const SHARED_BASE = shared({ variant: null, size: null })

const withoutBase = (whole: string): string =>
  whole.startsWith(SHARED_BASE) ? whole.slice(SHARED_BASE.length).trim() : whole

const buttonVariants = cva(
  [
    SHARED_BASE,
    "in-data-[slot=button-group]:rounded-sm",
    "has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
    "aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)]",
  ],
  {
    variants: {
      variant: {
        default: withoutBase(shared({ variant: "solid", size: null })),
        outline: withoutBase(shared({ variant: "neutral", size: null })),
        secondary: withoutBase(shared({ variant: "quiet", size: null })),
        ghost: cn(
          withoutBase(shared({ variant: "ghost", size: null })),
          "text-foreground hover:text-foreground",
        ),
        destructive: cn(
          withoutBase(shared({ variant: "danger", size: null })),
          "hover:bg-critical-hover active:bg-critical-pressed",
        ),
        link: withoutBase(shared({ variant: "link", size: null })),
        inverse: withoutBase(shared({ variant: "inverse", size: null })),
      },
      size: {
        default: withoutBase(shared({ size: "md", variant: null })),
        sm: withoutBase(shared({ size: "sm", variant: null })),
        lg: withoutBase(shared({ size: "lg", variant: null })),
        icon: withoutBase(shared({ size: "icon", variant: null })),
        "icon-sm": withoutBase(shared({ size: "icon-sm", variant: null })),
        "icon-lg": cn(
          withoutBase(shared({ size: "icon", variant: null })),
          "size-(--v-control-h-lg)",
        ),
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = Omit<SharedButtonProps, "variant" | "size"> &
  VariantProps<typeof buttonVariants>

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <SharedButton
      variant={null}
      size={null}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants, type ButtonProps }
