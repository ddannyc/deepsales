import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import type { ComponentProps } from 'react'

import { Badge } from '#components/ui/badge'

const statusBadgeVariants = cva('rounded-full', {
  variants: {
    tone: {
      neutral: 'border-transparent bg-muted text-muted-foreground',
      info: 'border-transparent bg-info/10 text-info',
      success: 'border-transparent bg-success/10 text-success',
      warning: 'border-transparent bg-warning/10 text-warning',
      destructive: 'border-transparent bg-destructive/10 text-destructive',
    },
  },
  defaultVariants: {
    tone: 'neutral',
  },
})

type StatusBadgeProps = ComponentProps<typeof Badge> & VariantProps<typeof statusBadgeVariants>

function StatusBadge({ className, tone, children, ...props }: StatusBadgeProps) {
  return (
    <Badge className={cn(statusBadgeVariants({ tone }), className)} {...props}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </Badge>
  )
}

export { StatusBadge, statusBadgeVariants }
