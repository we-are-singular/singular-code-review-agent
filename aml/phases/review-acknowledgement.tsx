import { useReview } from "../review-context.js"
import { createReactionTool } from "../tools/github.js"

/** Adds the courteous eyes reaction when needed without blocking the review. */
export async function ReviewAcknowledgement() {
  const { actions, github, snapshot } = useReview()
  const trigger = snapshot.context.run.trigger_comment

  if (trigger) {
    try {
      const reactions = await github.listIssueCommentReactions(trigger.id)
      const acknowledged = reactions.some(
        reaction => reaction.content === "eyes" && reaction.user?.login === github.request.botLogin
      )
      if (!acknowledged) {
        await createReactionTool(actions, trigger.id)({})
      }
    } catch {
      // Acknowledgement is courteous and never blocks the requested review.
    }
  }

  return ""
}
