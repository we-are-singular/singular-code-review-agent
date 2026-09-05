import { defineMcpServer, Mcp, type AML } from "@aml-jsx/sdk"

// Provider web tools stay disabled; this portable MCP is the review's only
// external library and platform documentation boundary.
const CONTEXT7 = defineMcpServer({
  name: "context7",
  transport: { command: "context7-mcp", type: "stdio" }
})

/** Makes current external documentation available at a deliberate Agent boundary. */
export const Context7: AML.Component = () => {
  return <Mcp use={CONTEXT7} />
}
