import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-medium leading-4 [&_svg]:size-3", {
  variants: {
    variant: {
      default: "bg-primary/15 text-[#8fbaf0]",
      secondary: "bg-secondary text-secondary-foreground",
      outline: "border border-border text-muted-foreground",
      good: "bg-good/15 text-[#6fd36f]",
      warning: "bg-warning/15 text-warning",
      critical: "bg-critical/15 text-[#f08a8a]",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
