ARG BASE_IMAGE=docker.io/cloudflare/sandbox:0.9.2-opencode
FROM ${BASE_IMAGE}

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG CONTEXT7_MCP_VERSION=3.2.0
ARG NODE_VERSION=26.3.0
ARG NPM_MIN_VERSION=11.13.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      gnupg \
      jq \
      python3 \
      ripgrep \
      xz-utils \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @upstash/context7-mcp@${CONTEXT7_MCP_VERSION}

RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}"; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack; \
    rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
    tar -xJf "${node_archive}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "${node_archive}"; \
    node --version; \
    npm --version; \
    node -e 'require("/usr/local/lib/node_modules/npm/node_modules/minipass-flush")'; \
    node -e 'const min = process.argv[1].split(".").map(Number); const got = process.argv[2].split(".").map(Number); const ok = got[0] > min[0] || (got[0] === min[0] && (got[1] > min[1] || (got[1] === min[1] && got[2] >= min[2]))); if (!ok) { console.error(`npm ${got.join(".")} is below required ${min.join(".")}`); process.exit(1); }' "${NPM_MIN_VERSION}" "$(npm --version)"

RUN mkdir -p /root/.config/opencode/skills \
    /root/.local/share/opencode \
    /root/.cache/opencode \
    /root/.local/state/opencode \
    /usr/local/share/singular-code-review \
    /workspace

COPY opencode/opencode.json /root/.config/opencode/opencode.json
COPY opencode/opencode.json /usr/local/share/singular-code-review/opencode.json
COPY opencode/AGENTS.md /root/.config/opencode/AGENTS.md
COPY opencode/AGENTS.md /usr/local/share/singular-code-review/AGENTS.md
COPY opencode/skills/ /root/.config/opencode/skills/
COPY lib/review-tools.js /usr/local/lib/review-tools.js
COPY bin/stage_review_comment /usr/local/bin/stage_review_comment
COPY bin/filter_review_comments /usr/local/bin/filter_review_comments
COPY bin/review_comments /usr/local/bin/review_comments
COPY bin/review_context /usr/local/bin/review_context
COPY bin/review_dry_run /usr/local/bin/review_dry_run
COPY bin/review_ack.sh /usr/local/bin/review_ack.sh
COPY bin/review_guard.sh /usr/local/bin/review_guard.sh
COPY bin/opencode_step /usr/local/bin/opencode_step
COPY bin/review_orchestrator.sh /usr/local/bin/review_orchestrator.sh

RUN chmod +x \
      /usr/local/bin/stage_review_comment \
      /usr/local/bin/filter_review_comments \
      /usr/local/bin/review_comments \
      /usr/local/bin/review_context \
      /usr/local/bin/review_dry_run \
      /usr/local/bin/review_ack.sh \
      /usr/local/bin/review_guard.sh \
      /usr/local/bin/opencode_step \
      /usr/local/bin/review_orchestrator.sh

ENV OPENCODE_DISABLE_CLAUDE_CODE=1 \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    PYTHON=/usr/bin/python3

WORKDIR /workspace
CMD ["/bin/bash"]
