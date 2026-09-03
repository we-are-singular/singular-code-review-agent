import { useReviewContext } from "../context/review-context.js"

/** Adds the courteous eyes reaction when needed without blocking the review. */
export async function ReviewAcknowledgement() {
  const { github, snapshot } = useReviewContext()
  const trigger = snapshot.trigger.comment

  if (trigger) {
    try {
      const reactions = await github.listIssueCommentReactions(trigger.id)
      const acknowledged = reactions.some(
        reaction => reaction.content === "eyes" && reaction.user?.login === github.request.botLogin
      )
      if (!acknowledged) {
        await github.reactToIssueComment(trigger.id)
      }
    } catch {
      // Acknowledgement is courteous and never blocks the requested review.
    }
  }

  return ""
}
