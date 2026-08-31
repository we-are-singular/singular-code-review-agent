import type { AmlRenderable } from "@aml-jsx/sdk"

/** Separates adjacent text or surrounds one authored AML block with blank lines. */
export function Block({ children }: { children?: AmlRenderable }) {
  if (children === undefined || children === null) {
    return "\n\n"
  }

  return ["\n\n", children, "\n\n"]
}
