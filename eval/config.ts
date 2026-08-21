export default {
  concurrency: 1,
  reviewTimeoutMs: 600_000,
  bootTimeoutMs: 90_000,
  keepScratch: false,
  models: ["opencode-go/minimax-m3", "opencode/deepseek-v4-flash-free"],
  input: [
    {
      pr: "https://github.com/vercel/next.js/pull/31936",
      ignoreHistory: true,
      label: "beforeInteractive streaming",
    },
    {
      pr: "https://github.com/TanStack/query/pull/7988",
      ignoreHistory: true,
      label: "React use promise support",
    },
    {
      pr: "https://github.com/trpc/trpc/pull/7262",
      ignoreHistory: true,
      label: "batch stream call index",
    },
    // Private repositories work with a token that can read them. Replace this
    // placeholder locally; do not commit private repository or PR identifiers.
    // {
    //   pr: "https://github.com/example-org/private-repository/pull/123",
    //   ignoreHistory: true,
    //   label: "private calibration case",
    // },
  ],
  judge: {
    model: "opencode-go/deepseek-v4-flash",
    timeoutMs: 120_000,
  },
}
