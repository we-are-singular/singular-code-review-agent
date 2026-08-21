export const JUDGE_RUBRIC = [
  {
    id: "prompt_adherence",
    question: "How well does the review body follow the requested final-review shape and verdict contract?",
  },
  {
    id: "verdict_quality",
    question: "How well calibrated is the verdict to the evidence in the review body, comments, transcript, and diff?",
  },
  {
    id: "actionability",
    question: "How actionable is the feedback for the PR author, with concrete risks, next steps, and merge guidance?",
  },
  {
    id: "coverage",
    question: "How well does the review cover the important themes from the diff and reviewer investigation without omitting material issues?",
  },
  {
    id: "behavioral_edge_cases",
    question:
      "How well does the review reason about realistic behavioral edge cases introduced or changed by the PR, such as lifecycle ordering, race/cancellation paths, protocol variants, null/empty states, cache/staleness, SSR/client differences, or compatibility modes?",
  },
  {
    id: "public_api_contracts",
    question:
      "How well does the review inspect user-facing contracts such as exports, import paths, type signatures, generics, option names, feature flags, required/optional fields, and copy-paste compile/runtime behavior?",
  },
  {
    id: "test_scenario_adequacy",
    question:
      "How well does the review evaluate whether tests cover the behavior that matters, including regression scenarios, negative paths, integration boundaries, and changed examples, instead of only noting that tests exist?",
  },
  {
    id: "docs_examples_release_surface",
    question:
      "How well does the review verify docs, examples, package exports, release-facing names, and setup snippets against the actual implementation that users will consume?",
  },
  {
    id: "release_migration_strategy",
    question:
      "How well does the review evaluate rollout and migration constraints for user-facing changes, such as staged warnings before errors, backwards compatibility, experimental or unstable naming, default behavior changes, preserved docs/error links, and whether strict enforcement should happen now or in a future breaking release?",
  },
  {
    id: "severity_prioritization",
    question:
      "How well does the review separate blocking correctness or contract issues from nits, style preferences, speculative concerns, and acceptable follow-up work?",
  },
  {
    id: "hallucination_control",
    question:
      "How well does the review avoid unsupported claims, invented issues, stale-history references, or conclusions not grounded in the supplied artifacts?",
  },
  {
    id: "documentation_diligence",
    question:
      "When the PR touches library, framework, SDK, API, CLI, or cloud-service behavior, how well did the reviewer consult Context7 or official docs before judging those details? Score high if docs were not needed and local context was enough.",
  },
  {
    id: "repo_guidance_diligence",
    question:
      "How well did the reviewer consult repository guidance and local documentation such as AGENTS.md, README files, PRDs, plans, ADRs, or other relevant markdown files beyond the diff?",
  },
  {
    id: "blast_radius_exploration",
    question:
      "How well did the reviewer inspect surrounding code, call sites, tests, config, schemas, generated files, and downstream/upstream contracts needed to understand the change's blast radius?",
  },
  {
    id: "research_before_assessment",
    question:
      "How well does the transcript show the reviewer researched context before making judgments, instead of assessing only from the diff or jumping to conclusions?",
  },
  {
    id: "internal_leakage",
    question:
      "How well does the output avoid runner internals such as artifact names, JSON fields, file paths, counters, raw logs, and permission/tool diagnostics?",
  },
  {
    id: "thought_process_hygiene",
    question:
      "How well does the output avoid verbose thought process, step-by-step reasoning, process notes, or meta-commentary?",
  },
  {
    id: "structure_concision",
    question: "How well structured, scannable, and concise is the body for a GitHub PR review?",
  },
  {
    id: "inline_body_balance",
    question:
      "How well does the body summarize themes without duplicating line-by-line inline comments or burying important findings?",
  },
  {
    id: "tone",
    question: "How direct, professional, and author-facing is the language without sugar coating or unnecessary elaboration?",
  },
];
