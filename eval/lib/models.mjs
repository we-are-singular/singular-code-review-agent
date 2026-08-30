const OPENCODE_GO_PREFIX = "opencode-go/";

export function normalizeEvalModel(model, label = "model") {
  const value = String(model || "").trim();
  if (!value) {
    return "";
  }

  if (/\s/u.test(value)) {
    throw new Error(`${label} ${value} must be an OpenCode model id without whitespace`);
  }

  if (!value.includes("/")) {
    return `${OPENCODE_GO_PREFIX}${value}`;
  }

  return value;
}

export function normalizeEvalModels(models) {
  return models.map((model, index) => normalizeEvalModel(model, `model[${index}]`));
}
