import { Parallel, Workspace } from "@aml-jsx/sdk"

import { ReviewContextFiles } from "./components/review-context-files.js"
import { useReviewContext } from "./components/review-context.js"
import { CodePathBugHunterLane } from "./components/lanes/code-path-bug-hunter.js"
import { CorrectnessRiskTestingLane } from "./components/lanes/correctness-risk-testing.js"
import { DocumentationCommentaryLane } from "./components/lanes/documentation-commentary.js"
import { IntentContractLane } from "./components/lanes/intent-contract.js"
import { MaintainabilityEleganceLane } from "./components/lanes/maintainability-elegance.js"
import { StandardsArchitectureLane } from "./components/lanes/standards-architecture.js"
import { ReviewAcknowledgement } from "./components/phases/review-acknowledgement.js"
import { ReviewAudit } from "./components/phases/review-audit.js"
import { ReviewGate } from "./components/phases/review-gate.js"
import { ReviewPublication } from "./components/phases/review-publication.js"
import { ReviewSynthesis } from "./components/phases/review-synthesis.js"

/** The complete review workflow, including its deterministic publication edge. */
export function Review() {
  const { github } = useReviewContext()
  const workspaceId = `${github.request.repository.replaceAll("/", "-")}-pr-${github.request.prNumber}`

  return (
    <Workspace id={workspaceId} load={false} lock={false} save={false}>
      <ReviewContextFiles />
      <ReviewAcknowledgement />
      <ReviewPublication>
        <ReviewGate>
          <ReviewSynthesis>
            <ReviewAudit>
              <Parallel>
                <>
                  ## Intent
                  <IntentContractLane />
                </>
                <>
                  ## Standards and architecture
                  <StandardsArchitectureLane />
                </>
                <>
                  ## Bug hunting and correctness
                  <CodePathBugHunterLane />
                </>
                <>
                  ## Risk and testing
                  <CorrectnessRiskTestingLane />
                </>
                <>
                  ## Documentation and commentary
                  <DocumentationCommentaryLane />
                </>
                <>
                  ## Maintainability and elegance
                  <MaintainabilityEleganceLane />
                </>
              </Parallel>
            </ReviewAudit>
          </ReviewSynthesis>
        </ReviewGate>
      </ReviewPublication>
    </Workspace>
  )
}
