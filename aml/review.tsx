import { Parallel, Sandbox, Workspace } from "@aml-jsx/sdk"

import { ReviewContextFiles } from "./components/review-context-files.js"
import { ReviewPublication } from "./components/review-publication.js"
import { CodePathBugHunterLane } from "./lanes/code-path-bug-hunter.js"
import { CorrectnessRiskTestingLane } from "./lanes/correctness-risk-testing.js"
import { DocumentationCommentaryLane } from "./lanes/documentation-commentary.js"
import { IntentContractLane } from "./lanes/intent-contract.js"
import { MaintainabilityEleganceLane } from "./lanes/maintainability-elegance.js"
import { StandardsArchitectureLane } from "./lanes/standards-architecture.js"
import { ReviewAcknowledgement } from "./phases/review-acknowledgement.js"
import { ReviewAudit } from "./phases/review-audit.js"
import { ReviewGate } from "./phases/review-gate.js"
import { ReviewSynthesis } from "./phases/review-synthesis.js"
import { ReviewValidation } from "./phases/review-validation.js"

/** The complete review workflow, including its deterministic publication edge. */
export function Review({
  sandboxed = false,
  workspaceId = "singular-review"
}: {
  sandboxed?: boolean
  workspaceId?: string
}) {
  const investigation = (
    <ReviewGate>
      <>
        <Parallel>
          <IntentContractLane />
          <StandardsArchitectureLane />
          <CodePathBugHunterLane />
          <CorrectnessRiskTestingLane />
          <DocumentationCommentaryLane />
          <MaintainabilityEleganceLane />
        </Parallel>

        <ReviewAudit>
          <ReviewValidation>
            <ReviewSynthesis />
          </ReviewValidation>
        </ReviewAudit>
      </>
    </ReviewGate>
  )

  // The packaged CLI already runs inside the outer reviewer container. Managed
  // callers set `sandboxed` only when their runtime supplies an AML SandboxProvider.
  return (
    <Workspace id={workspaceId} load={false} lock={false} save={false}>
      <ReviewContextFiles />
      <ReviewAcknowledgement />
      {sandboxed ? <Sandbox access="read-only">{investigation}</Sandbox> : investigation}
      <ReviewPublication />
    </Workspace>
  )
}
